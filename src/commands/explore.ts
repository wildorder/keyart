import path from "node:path";
import { loadConfig, directionsRoot } from "../config.js";
import {
  hasApiKey,
  chatJson,
  analyzeReferenceForTokens,
  detectContradictionsLLM,
} from "../openai.js";
import {
  detectContradictions,
  type ContradictionReport,
  type ContradictionInput,
  type ContradictionDeps,
} from "../brand/conflict-guard.js";
import { generateDirections } from "../explore/generate-directions.js";
import { briefIntentToSeed } from "../explore/token-intent.js";
import { writeDirectionVersion } from "../explore/write-direction-version.js";
import {
  proposeDivergentBriefs,
  type ProposeBriefsAdapter,
} from "../explore/propose-briefs.js";
import {
  mintDirectionId,
  listDirectionIds,
  readHead,
  readHeadOrNull,
  resolveDirection,
} from "../direction/store.js";
import type { DirectionVersion, KeyartConfig } from "../types.js";
import type { PaletteLock } from "../brand/palette.js";
import type { BrandBrief } from "../direction/schema.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import {
  assembleContext,
  renderContextBlock,
  MAX_CONTEXT_REFERENCES,
  type ReferenceItem,
} from "../brand/assemble-context.js";
import { renderArtDirectionPrecedence } from "../explore/compose-art-direction.js";
import {
  splitByIntent,
  analysisToLocks,
  type RunReference,
} from "../explore/reference-intent.js";
import { CommandError } from "../errors.js";
import { loadEnvFiles } from "../env.js";

const BRIEF_SIZE_WARN = 32_000;

/** Matches `#rgb`/`#rrggbb` — the same convention as `brief-map.ts`'s HEX_RE
 * (module-local there), so a "hex" means the same thing everywhere. */
const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

const FORMS_USAGE =
  "Use `explore <directionId>` (generate v1 into an existing draft), " +
  '`explore --describe "<seed>" [--count N]`, or `explore --from <directionId> [--count N]`.';

export interface ExploreResult {
  /** Positional mode: the target id; `--from`: the source id; `--describe`: "". */
  direction: string;
  /** Positional: [target]; divergent: the N minted drafts. */
  directionIds: string[];
  filesWritten: string[]; // cwd-relative, forward slashes
  /** True when the run had no OPENAI_API_KEY (after `.env*` load) and wrote
   * deterministic placeholders instead of calling the model. Lets the studio
   * say "ran without a key." */
  dryRun: boolean;
  /** Human-readable reasons for any image generations that were skipped (never
   * thrown) — e.g. capability/entitlement failures. Empty when all wrote or on dry-run. */
  imageSkips: string[];
  /** Advisory contradiction report — never edits the compiled block. */
  contradictionReport: ContradictionReport;
  /** How many divergent briefs came from the keyless/degraded floor. 0 in
   * positional mode; ProposalResult.floorCount in divergent mode. */
  floorCount: number;
}

export async function runExplore(opts: {
  cwd: string;
  /** Positional target: an EXISTING draft to write v1 into. Mutually exclusive
   * with describe/from; `--count` alongside it is a teaching error. */
  directionId?: string;
  /** Divergent seed text (`--describe`). */
  describe?: string;
  /** Divergent source direction whose brief seeds the proposal (`--from`). */
  from?: string;
  /** Divergent-only. Default 3. */
  count?: number;
  /** One-shot steering for THIS run only — folded into the model prompt and
   * recorded in the run's context-snapshot for provenance, but NOT written to
   * any direction's memory (deliberately ephemeral). */
  instructions?: string;
  /**
   * Run-level, EPHEMERAL references for THIS run only — NOT written to any
   * direction. Each path is resolved under cwd. `inspire` refs feed the image
   * model + context; `extract` refs are vision-analyzed into palette-engine
   * seeds. Merged with the direction's own image assets under the shared
   * {@link MAX_CONTEXT_REFERENCES} cap. Absent `intent` ⇒ `"inspire"`.
   */
  references?: { path: string; intent?: "inspire" | "extract" }[];
}): Promise<ExploreResult> {
  const cwd = path.resolve(opts.cwd);

  // Load `.env*` FIRST — before loadConfig or any hasApiKey() read — so a
  // serve-triggered run with a key in `.env.local` no longer silently dry-runs.
  loadEnvFiles(cwd);

  const config = await loadConfig(opts.cwd);

  const divergent = opts.describe !== undefined || opts.from !== undefined;
  if (opts.directionId !== undefined && (divergent || opts.count !== undefined)) {
    throw new CommandError(
      `\`explore <directionId>\` writes v1 into that draft and takes no --describe/--from/--count. ${FORMS_USAGE}`,
    );
  }
  if (opts.directionId === undefined && !divergent) {
    throw new CommandError(`Nothing to explore. ${FORMS_USAGE}`);
  }

  if (opts.directionId !== undefined) {
    return runPositionalExplore(cwd, config, { ...opts, directionId: opts.directionId });
  }
  return runDivergentExplore(cwd, config, opts);
}

/** Positional mode: generate v1 INTO an existing draft (SC-04). */
async function runPositionalExplore(
  cwd: string,
  config: KeyartConfig,
  opts: {
    cwd: string;
    directionId: string;
    instructions?: string;
    references?: { path: string; intent?: "inspire" | "extract" }[];
  },
): Promise<ExploreResult> {
  const root = directionsRoot(opts.cwd, config);

  // Resolve first so an unknown id teaches (lists available ids).
  await resolveDirection(opts.cwd, config, opts.directionId);

  // A direction that already has versions gets `regenerate`, never a silent append.
  const existingHead = await readHeadOrNull(root, opts.directionId);
  if (existingHead !== null) {
    throw new CommandError(
      `Direction "${opts.directionId}" already has versions — run \`keyart regenerate ${opts.directionId}\` to append a new version.`,
    );
  }

  const generated = await generateV1IntoExistingDirection(cwd, config, {
    cwd: opts.cwd,
    directionId: opts.directionId,
    instructions: opts.instructions,
    references: opts.references,
  });

  console.log(`\nExplore complete! Generated v1 into "${opts.directionId}".`);
  console.log(`\nTo approve: keyart approve ${opts.directionId}`);

  const dryRun = !hasApiKey();
  if (dryRun) {
    console.log(`\nRan without OPENAI_API_KEY — wrote a placeholder version.`);
  }

  return {
    direction: opts.directionId,
    directionIds: [opts.directionId],
    filesWritten: generated.filesWritten,
    dryRun,
    imageSkips: generated.imageSkips,
    contradictionReport: generated.contradictionReport,
    floorCount: 0,
  };
}

/** Divergent modes: `--describe`/`--from` mint N drafts from N DISTINCT briefs
 * and generate v1 for each (SC-05). */
async function runDivergentExplore(
  cwd: string,
  config: KeyartConfig,
  opts: {
    cwd: string;
    describe?: string;
    from?: string;
    count?: number;
    instructions?: string;
    references?: { path: string; intent?: "inspire" | "extract" }[];
  },
): Promise<ExploreResult> {
  const root = directionsRoot(opts.cwd, config);
  const core = createDirectionCore(opts.cwd, config);
  const brand = createBrandCore(opts.cwd, config);
  const count = opts.count ?? 3;

  // Resolve the source (--from) FIRST so an unknown id teaches, then carry the
  // id WITH the brief — BrandBrief itself carries no id (Replan #13).
  let source: { directionId: string; brief: BrandBrief } | undefined;
  if (opts.from !== undefined) {
    await resolveDirection(opts.cwd, config, opts.from);
    source = { directionId: opts.from, brief: await core.getBrief(opts.from) };
  }
  const seedText =
    opts.describe ?? (await core.getRenderedBrief(source!.directionId));

  // GLOBAL-ONLY proposal context: a divergent run is not scoped to one
  // direction, so no per-direction memory assembles here; global hard rules win.
  const global = await brand.read();
  const proposalContext = renderContextBlock(
    assembleContext({ brief: seedText, global, memory: [], references: [] }),
  );

  // The key-gated adapter — built ONLY when a key is present; the keyless path
  // is the floor. A keyed read yielding nothing usable throws inside
  // proposeDivergentBriefs (a keyed run that read nothing is a failure).
  const adapter: ProposeBriefsAdapter | undefined = hasApiKey()
    ? async (input) => {
        const system = [
          `You propose ${input.count} EXPLICITLY CONTRASTING brand-brief payloads — genuinely different directions, not renders of one brief.`,
          "Each brief must differ in positioning, personality, and aesthetic intent.",
          'Return ONLY a JSON object: { "briefs": [ ... ] } — each element uses brand-brief field names (positioning, colorIntent, typeIntent, tone, oneLiner, otherNotes, ...).',
          "colorIntent and typeIntent are SOFT INTENT WORDS ONLY — never hex codes and never specific font family names.",
        ].join("\n");
        const user = [
          `SEED:\n${input.seed}`,
          input.source
            ? `\nSOURCE BRIEF (direction "${input.source.directionId}"):\n${JSON.stringify(input.source.brief)}`
            : "",
          `\nCONTEXT:\n${input.context}`,
        ].join("\n");
        const result = await chatJson<{ briefs?: unknown }>({
          model: config.models.text,
          system,
          user,
        });
        return (result.data as { briefs?: unknown } | null)?.briefs;
      }
    : undefined;

  const proposal = await proposeDivergentBriefs({
    seed: seedText,
    source,
    context: proposalContext,
    count,
    adapter,
  });

  // A hex typed into the seed routes to a per-direction color-lock DECISION,
  // never a brief field (the sanitizer already stripped it from every field).
  const seedHexes = [
    ...new Set(
      Array.from((opts.describe ?? "").matchAll(HEX_RE), (m) =>
        m[0].toLowerCase(),
      ),
    ),
  ];

  const filesWritten: string[] = [];
  const imageSkips: string[] = [];
  const directionIds: string[] = [];
  let contradictionReport: ContradictionReport | undefined;

  for (const brief of proposal.briefs) {
    const base = brief.oneLiner ?? brief.positioning ?? "direction";
    const directionId = await mintDirectionId(root, base);
    await core.create({
      id: directionId,
      name: brief.positioning ?? directionId,
      brief,
      status: "active",
    });
    for (const hex of seedHexes) {
      await core.recordColorLock(directionId, {
        hex,
        author: "explore",
        source: "explore --describe",
      });
    }
    const generated = await generateV1IntoExistingDirection(cwd, config, {
      cwd: opts.cwd,
      directionId,
      instructions: opts.instructions,
      references: opts.references,
    });
    filesWritten.push(...generated.filesWritten);
    imageSkips.push(...generated.imageSkips);
    contradictionReport ??= generated.contradictionReport;
    directionIds.push(directionId);
  }

  console.log(`\nExplore complete!`);
  console.log(`\nDirections seeded:`);
  for (const directionId of directionIds) {
    console.log(`  - ${directionId}`);
  }
  console.log(`\nTo approve a direction:\n  keyart approve <directionId>`);

  const dryRun = !hasApiKey();
  if (dryRun) {
    console.log(`\nRan without OPENAI_API_KEY — wrote placeholder directions.`);
  }

  return {
    direction: opts.from ?? "",
    directionIds,
    filesWritten,
    dryRun,
    imageSkips,
    contradictionReport: contradictionReport ?? {
      items: [],
      warnings: [],
      detector: "deterministic",
    },
    floorCount: proposal.floorCount,
  };
}

/**
 * Generate ONE DirectionContent from an EXISTING direction's own brief +
 * memory + moodboard references + the global layer, and write it as that
 * direction's v1 through the untouched `write-direction-version.ts` path.
 * SC-04's snapshot isolation follows from `memoryEntries(id)` /
 * `imageAssetPaths(id)` being single-direction.
 */
async function generateV1IntoExistingDirection(
  cwd: string,
  config: KeyartConfig,
  opts: {
    cwd: string;
    directionId: string;
    instructions?: string;
    references?: { path: string; intent?: "inspire" | "extract" }[];
  },
): Promise<{
  filesWritten: string[];
  imageSkips: string[];
  contradictionReport: ContradictionReport;
}> {
  const root = directionsRoot(opts.cwd, config);
  const core = createDirectionCore(opts.cwd, config);
  const brand = createBrandCore(opts.cwd, config);
  const rel = (abs: string): string =>
    path.relative(cwd, abs).split(path.sep).join("/");
  const filesWritten: string[] = [];
  const imageSkips: string[] = [];

  // Read the brief as the RENDERED PROJECTION of the structured brief (the
  // single chokepoint) — NEVER the on-disk `brief.md` as an authored source.
  const briefText = await core.getRenderedBrief(opts.directionId);

  // Soft aesthetic-intent seed: colorIntent/typeIntent words become a
  // palette-engine bias — never a lock, never a hex/font spec.
  const brief = await core.getBrief(opts.directionId);
  const intentDefaults = briefIntentToSeed({
    colorIntent: brief.colorIntent,
    typeIntent: brief.typeIntent,
  });

  if (briefText.length > BRIEF_SIZE_WARN) {
    console.warn(
      `Warning: brief is ${briefText.length} characters (>${BRIEF_SIZE_WARN}). Consider trimming for better results.`,
    );
  }

  // Assemble context from THIS direction's own memory + the global brand layer
  // through the single chokepoint — global hard rules win.
  const memory = await core.memoryEntries(opts.directionId); // ONE direction only
  const global = await brand.read(); // never writes

  const imageRefs = await core.imageAssetPaths(opts.directionId);
  const runRefs: ReferenceItem[] = (opts.references ?? []).map((r) => ({
    path: rel(path.resolve(cwd, r.path)),
    intent: r.intent ?? "inspire",
  }));
  const combinedRefs: ReferenceItem[] = [...imageRefs, ...runRefs].slice(
    0,
    MAX_CONTEXT_REFERENCES,
  );

  const assembled = assembleContext({
    brief: briefText,
    global,
    memory,
    references: combinedRefs,
  });
  const contextBlock = renderContextBlock(assembled);

  // Route each reference by intent: `inspire` → the image model; `extract` →
  // vision-analyzed into palette-engine locks (never a direct image source).
  const resolvedRefs: RunReference[] = combinedRefs.map((r) => ({
    path: path.resolve(cwd, r.path),
    intent: r.intent ?? "inspire",
    note: r.note,
  }));
  const { inspire, extract } = splitByIntent(resolvedRefs);
  const refAbs = inspire.map((r) => r.path);

  let extractLocks: PaletteLock[] = [];
  if (extract.length > 0) {
    const { analysis } = await analyzeReferenceForTokens({
      model: config.models.vision,
      imagePaths: extract.map((r) => r.path),
    });
    extractLocks = analysisToLocks(analysis);
  }
  const lockedColors = extractLocks.map((l) => l.hex);

  const instructions = opts.instructions?.trim() || undefined;
  // Fresh per-run seed so repeated explores yield different-but-coherent
  // palettes; recorded in tokens.provenance.seed for reproducibility.
  const seedValue = Date.now();

  // Advisory detection pass — never edits the compiled block.
  const detectInput: ContradictionInput = {
    liveInstruction: instructions ?? "",
    liveInstructionId: `live:explore:${opts.directionId}:${seedValue}`,
    hardRules: assembled.hardRules,
    guidelines: assembled.guidelines,
    memory,
  };
  const detectionDeps: ContradictionDeps | undefined = hasApiKey()
    ? {
        semantic: async (i) =>
          (
            await detectContradictionsLLM({
              model: config.models.text,
              liveInstruction: i.liveInstruction,
              hardRules: i.hardRules.map((r) => ({ id: r.id, text: r.text })),
              guidelines: i.guidelines.map((r) => ({ id: r.id, text: r.text })),
              memory: i.memory.map((m) => ({ id: m.id, kind: m.kind, body: m.body })),
            })
          ).contradictions,
      }
    : undefined;
  const contradictionReport = await detectContradictions(
    detectInput,
    detectionDeps,
  );
  for (const w of contradictionReport.warnings) console.warn(w.message);

  // Feed every existing direction's head palette as anti-examples so
  // consecutive explores actively diverge. Best-effort; never throws.
  const priorPalettes = await loadPriorPalettesFromDirections(root);
  const directions = await generateDirections(
    briefText,
    { text: config.models.text, vision: config.models.vision },
    {
      contextBlock,
      referenceImagePaths: refAbs,
      count: 1,
      instructions,
      seed: seedValue,
      priorPalettes,
      locks: extractLocks,
      intentDefaults,
    },
  );

  const snapshotContext = instructions
    ? `## One-shot instructions (this run only)\n\n${instructions}\n\n${contextBlock}`
    : contextBlock;

  // Exactly one generated content is written as v1 into the EXISTING record —
  // no core.create here; the record must already exist.
  const { id: _slug, ...content } = directions[0];
  const version: DirectionVersion = {
    ...content,
    id: "", // the writer mints a collision-safe versionId
    createdAt: new Date().toISOString(),
    producedBy: instructions ?? "explore",
    briefSnapshot: briefText,
    contextSnapshot: snapshotContext,
  };
  const precedence = renderArtDirectionPrecedence(assembled, {
    oneShot: instructions,
  });
  const snapshotSeparator = version.contextSnapshot.endsWith("\n\n")
    ? ""
    : version.contextSnapshot.endsWith("\n")
      ? "\n"
      : "\n\n";
  const versionWithSnapshot: DirectionVersion = {
    ...version,
    contextSnapshot: `${version.contextSnapshot}${snapshotSeparator}${precedence}`,
  };
  const res = await writeDirectionVersion({
    cwd,
    directionsDir: root,
    directionId: opts.directionId,
    version: versionWithSnapshot,
    config,
    referenceImagePaths: refAbs,
    assembled,
    lockedColors,
  });
  filesWritten.push(...res.filesWritten);
  imageSkips.push(...res.imageSkips);

  return { filesWritten, imageSkips, contradictionReport };
}

/**
 * Best-effort palettes from EVERY EXISTING direction (each direction's head
 * version tokens), as `string[][]` hex arrays fed to the palette engine as
 * anti-examples so the next explore's colors diverge. Returns `[]` when there
 * are no directions or no tokened heads — never throws (variety is a nicety,
 * not a gate).
 */
async function loadPriorPalettesFromDirections(
  directionsRootDir: string,
): Promise<string[][]> {
  const ids = await listDirectionIds(directionsRootDir);
  const palettes: string[][] = [];
  for (const id of ids) {
    try {
      const head = await readHead(directionsRootDir, id);
      const hexes = head.tokens?.palette.map((p) => p.hex) ?? [];
      if (hexes.length > 0) palettes.push(hexes);
    } catch {
      // Skip a draft/unreadable direction — best-effort only.
    }
  }
  return palettes;
}

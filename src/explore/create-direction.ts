import path from "node:path";
import { loadConfig, directionsRoot } from "../config.js";
import { hasApiKey } from "../openai.js";
import { writeDirectionVersion } from "./write-direction-version.js";
import { mintDirectionId, resolveDirection } from "../direction/store.js";
import type { DirectionVersion, AuthoredDirectionContent } from "../types.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import {
  assembleContext,
  renderContextBlock,
  MAX_CONTEXT_REFERENCES,
} from "../brand/assemble-context.js";
import {
  briefIntentToSeed,
  deriveLocksFromContext,
  buildTokens,
} from "./token-intent.js";
import {
  parseAuthoredDirection,
  assertNoHexOrFontInProse,
} from "./authored-direction.js";
import { loadEnvFiles } from "../env.js";

export interface CreateDirectionResult {
  seedDirection: string;  // the existing direction whose brief seeded this create
  directionId: string;    // the minted, collision-safe id
  versionId: string;      // v1 (the writer-minted version id)
  filesWritten: string[]; // cwd-relative, forward slashes
  dryRun: boolean;        // true when no OPENAI_API_KEY — but the path is keyless either way
}

/**
 * Compose a deterministic style tile prompt from authored direction content +
 * a brief snippet, used when the agent omits `styleTilePrompt`. Pure string
 * assembly — no model call, no I/O.
 */
function composeStyleTilePrompt(
  content: AuthoredDirectionContent,
  briefText: string,
): string {
  const snippet = briefText.slice(0, 100).trim();
  const evoke = [content.character.mood, content.character.imagery]
    .filter(Boolean)
    .join(", ");
  let out = `Create a style tile for ${content.name}: ${content.summary}.`;
  if (evoke) out += ` Evoke: ${evoke}.`;
  if (snippet) out += ` Inspired by: ${snippet}`;
  return out;
}

/**
 * Compose a deterministic homepage mockup prompt when the agent omits it.
 * Pure string assembly — no model call, no I/O.
 */
function composeHomepagePrompt(
  content: AuthoredDirectionContent,
  briefText: string,
): string {
  const snippet = briefText.slice(0, 100).trim();
  const layout = [content.character.layout, content.character.composition]
    .filter(Boolean)
    .join(", ");
  let out = `Design a homepage mockup for ${content.name}: ${content.summary}.`;
  if (layout) out += ` Layout / composition: ${layout}.`;
  if (snippet) out += ` Inspired by: ${snippet}`;
  return out;
}

/**
 * Keyless core: turn host-agent-authored direction content into a real Direction
 * at v1. No model call is ever made — `writeDirectionVersion` is called with
 * `skipImages: true`, which fully bypasses the model-generation/extraction path.
 *
 * **Validation-ownership contract:** this function is the SINGLE authoritative
 * validation entry point for all three front-ends (CLI, MCP, studio). It accepts
 * a RAW payload (`unknown`) and runs `parseAuthoredDirection` +
 * `assertNoHexOrFontInProse` itself, so any caller that passes an unvalidated
 * object is safe: a `tokens` key, unknown keys, missing required fields, and
 * hex/font-in-prose are ALL rejected inside the core. Front-ends MUST NOT
 * re-implement validation.
 *
 * **Seed tokens (SC-04):** built deterministically from the brief's soft intent
 * (`briefIntentToSeed` → `buildTokens`) with `seed = 0` for stable, reproducible
 * output, honoring memory color-locks verbatim (`deriveLocksFromContext`). A
 * `Color locked: #rrggbb` decision in the concept memory therefore appears
 * unchanged in the seed palette. Tokens become EXTRACTED the first time the user
 * runs `regenerate` on the created direction — they are never hand-authored.
 *
 * **Per-direction isolation:** only `core.memoryEntries(seed.id)` /
 * `core.imageAssetPaths(seed.id)` are read; sibling directions are never touched.
 */
export async function createAuthoredDirection(opts: {
  cwd: string;
  /** The EXISTING direction whose brief seeds this create. Must already exist
   * (`resolveDirection` never scaffolds). */
  directionId: string;
  /** The RAW authored payload — the core is the single validation owner (parse + guard here). */
  content: unknown;
}): Promise<CreateDirectionResult> {
  const cwd = path.resolve(opts.cwd);

  // Load .env* before any hasApiKey() read (idempotent — real env always wins).
  // The dryRun flag is accurate either way since this path is keyless regardless.
  loadEnvFiles(cwd);

  const config = await loadConfig(cwd);

  // Resolve the seed direction. Throws CommandError for an unknown id.
  const seed = await resolveDirection(cwd, config, opts.directionId);
  const root = directionsRoot(cwd, config);

  // ── Validate: the CORE is the single validation owner ─────────────────────
  // parseAuthoredDirection: rejects a `tokens` key, unknown keys, and missing
  // required fields with field-naming CommandErrors.
  // assertNoHexOrFontInProse: rejects a hex / catalog font family in the
  // evocative character/usage prose fields.
  const content = parseAuthoredDirection(opts.content);
  assertNoHexOrFontInProse(content);

  // ── Freeze the brief snapshot (RENDERED PROJECTION only) ──────────────────
  // Never reads brief.md as an authored source — always the deterministic
  // renderBrief() projection of the structured seed direction's brief record.
  const core = createDirectionCore(cwd, config);
  const briefText = await core.getRenderedBrief(seed.id);

  // ── Derive the soft intent seed from the brief's words (SC-04) ────────────
  // WORDS ONLY → { baseHue?, scheme?, fontPairingId? }. No hex or font spec.
  const brief = await core.getBrief(seed.id);
  const intentDefaults = briefIntentToSeed({
    colorIntent: brief.colorIntent,
    typeIntent: brief.typeIntent,
  });

  // ── Assemble + freeze context (per-direction isolation enforced) ──────────
  const brand = createBrandCore(cwd, config);
  const memory = await core.memoryEntries(seed.id); // ONE direction — isolation preserved
  const global = await brand.read();                // read-only
  const imageRefs = await core.imageAssetPaths(seed.id);

  const assembled = assembleContext({
    brief: briefText,
    global,
    memory,
    references: imageRefs.slice(0, MAX_CONTEXT_REFERENCES),
  });
  const contextBlock = renderContextBlock(assembled);

  // ── Build deterministic seed tokens honoring memory color-locks verbatim ───
  // seed = 0: stable / reproducible (unlike explore's Date.now() seed for
  // per-run variety). A `Color locked: #rrggbb` decision entry in the seed
  // direction's memory is rendered into contextBlock and picked up by
  // deriveLocksFromContext → passed to buildTokens as a PaletteLock → held
  // VERBATIM in the seed palette. The engine finishes surface/muted + WCAG AA
  // around the locks.
  const locks = deriveLocksFromContext(contextBlock);
  const seedValue = 0;
  const tokens = buildTokens({ raw: intentDefaults, seed: seedValue, locks });

  // ── Compose prompts deterministically when the agent omitted them (SC-05) ──
  const styleTilePrompt =
    (content.styleTilePrompt ?? "").trim() ||
    composeStyleTilePrompt(content, briefText);
  const homepageMockupPrompt =
    (content.homepageMockupPrompt ?? "").trim() ||
    composeHomepagePrompt(content, briefText);

  // ── Mint the direction id + build the v1 DirectionVersion ─────────────────
  // mintDirectionId slugifies content.name and disambiguates with a numeric
  // suffix against existing siblings (bold → bold-2 → bold-3, …) — the same
  // collision-safe guarantee explore already relies on.
  const directionId = await mintDirectionId(root, content.name);

  // Create the direction record (a draft) BEFORE writing v1 — `appendVersion`
  // (called inside `writeDirectionVersion`) requires the record to already
  // exist. Carries a COPY of the seed direction's brief, mirroring explore's
  // sibling-birth convention.
  await createDirectionCore(cwd, config).create({
    id: directionId,
    name: content.name,
    brief: seed.record.brief,
    status: "active",
  });

  // `positioning` is optional in AuthoredDirectionContent but required as a
  // non-empty string by DirectionContent/assertValid. Default to content.summary
  // so a later in-place edit's assertValid never rejects an empty positioning.
  const positioning = (content.positioning ?? "").trim() || content.summary;

  const version: DirectionVersion = {
    name: content.name,
    summary: content.summary,
    positioning,
    character: content.character,
    usage: content.usage,
    copyExamples: content.copyExamples,
    styleTilePrompt,
    homepageMockupPrompt,
    tokens,
    id: "",                  // writer mints the versionId (v1)
    createdAt: new Date().toISOString(),
    producedBy: "authored",  // distinguishes from "explore" / "manual edit"
    briefSnapshot: briefText,
    contextSnapshot:
      `## Authored direction\n\nCreated from host-agent-authored content (keyless, no model call).\n\n${contextBlock}`,
  };

  // ── Write v1 (no generation, no extraction) ────────────────────────────────
  const written = await writeDirectionVersion({
    cwd,
    directionsDir: root,
    directionId,
    version,
    config,
    referenceImagePaths: [],  // no image generation on this path
    assembled,                // directives reach written prompt files (provenance)
    skipImages: true,         // the whole path is keyless; no model is touched
  });

  return {
    seedDirection: seed.id,
    directionId,
    versionId: written.versionId,
    filesWritten: written.filesWritten,
    dryRun: !hasApiKey(),
  };
}

import path from "node:path";
import { ensureDir, writeJsonFile, writeTextFile } from "../fs.js";
import { hasApiKey, generateImage, describeImageBrand } from "../openai.js";
import type { KeyartConfig, DirectionVersion } from "../types.js";
import { composeContentLock } from "./token-intent.js";
import { composeArtDirection } from "./compose-art-direction.js";
import { tokensFromRoledColors } from "../brand/extract-tokens.js";
import { mapTypeRead } from "../brand/extract-type.js";
import type { AssembledContext } from "../brand/assemble-context.js";
import type { PaletteLock } from "../brand/palette.js";
import { mintVersionId } from "../direction/store.js";
import { createDirectionCore } from "../direction/core.js";

export interface WriteDirectionVersionResult {
  directionId: string;
  versionId: string;
  versionDir: string; // absolute
  filesWritten: string[]; // cwd-relative, forward slashes
  imageSkips: string[];
  extracted: boolean;
}

/** cwd-relative, forward-slash path — the shared reporting convention. */
function relTo(cwd: string, abs: string): string {
  return path.relative(cwd, abs).split(path.sep).join("/");
}

/** Fallback context for callers that skip images (no compiler bypass on the
 * image-generation path; skipImages callers need no directives). */
const EMPTY_ASSEMBLED: AssembledContext = {
  brief: "",
  hardRules: [],
  guidelines: [],
  memory: [],
  references: [],
  negatives: [],
  visualDirectives: { must: [], prefer: [], avoid: [] },
};

/**
 * Write exactly ONE version's folder under
 * `directions/<directionId>/versions/<versionId>/`:
 * `direction-version.json` (the {@link DirectionVersion}), the frozen
 * `brief-snapshot.md` / `context-snapshot.md` projections, both prompt `.md`
 * files, and — gated on a key + a configured image model — the
 * reference-conditioned style tile + homepage images, after which the UNLOCKED
 * tokens are RE-EXTRACTED from the rendered tile (the inverted spine, preserved
 * verbatim from the old run writer). Finally advances the direction record's
 * `versions[]`/`head` to this version (`DirectionCore.appendVersion`) — the
 * direction record must already exist (created via `DirectionCore.create`)
 * before this is called.
 *
 * Shared by BOTH explore (WS-02: one v1 per fresh direction) and regenerate/edit
 * (WS-03: the next version). The caller may pass a pre-minted `version.id`, or
 * the writer mints one (keeping id assignment caller-driven).
 *
 * **No-generation contract (`skipImages: true`):** when set, this writer is
 * PURELY a persistence step — it writes json + both snapshot `.md` files + both
 * prompt `.md` files + advances the index, but NEVER reads the model, never
 * calls `hasApiKey()` for generation, and never re-extracts tokens. The caller
 * supplies a complete `version` (including `version.tokens`). This contract is
 * used by TWO paths:
 * 1. `runSaveVariant` — appending a new version to an EXISTING direction (the
 *    carry-forward tokens come from the user's edited version).
 * 2. `createAuthoredDirection` — writing v1 of a BRAND-NEW direction from
 *    host-agent-authored content (the caller supplies engine-seeded tokens built
 *    deterministically from the brief's soft intent + memory color-locks).
 *
 * A skipped image never throws; its reason is collected. Dry-run (no key / no
 * image) ⇒ no tile ⇒ no extraction ⇒ byte-identical to a lockless run.
 */
export async function writeDirectionVersion(opts: {
  cwd: string;
  /** The FLAT directions root (`directionsRoot(cwd,config)`) — directions no
   *  longer nest under a parent concept dir. */
  directionsDir: string;
  directionId: string;
  version: DirectionVersion;
  config: KeyartConfig;
  referenceImagePaths: string[];
  /**
   * The assembled context (global rules + direction memory + references) consumed
   * by the art-direction compiler. When provided, `composeArtDirection` is called
   * exactly once per generated prompt to inject the MUST/PREFER/AVOID tail + soft
   * color guidance. Absent ⇒ empty context (byte-identical no-directive path,
   * used by `skipImages: true` callers such as `runSaveVariant`).
   */
  assembled?: AssembledContext;
  /**
   * The user's LOCKED colors (hex strings) — the ONLY color signal fed to the
   * image model, as SOFT guidance ("build around these"), NO fonts. The SAME
   * hexes are honored VERBATIM as extraction locks after the tile renders.
   * Empty/absent ⇒ no guidance ⇒ byte-identical to a lockless prompt.
   */
  lockedColors?: string[];
  /**
   * ROLE-AWARE extraction locks honored VERBATIM when re-extracting tokens from
   * the rendered tile (SC-06 lock-and-rotate). When present these drive the
   * extraction merge so a locked ROLE (e.g. `primary`) is held at its exact hex
   * while unlocked roles rotate to the new tile — the role tag is what pins the
   * slot. Absent ⇒ derived from `lockedColors` as role-less hexes (byte-identical
   * to the prior explore behavior, where extract-derived locks carry no role).
   */
  extractionLocks?: PaletteLock[];
  /**
   * Skip model image generation — caller supplies a complete `version` (including
   * `version.tokens`); nothing is generated or extracted. Used by BOTH
   * `runSaveVariant` (append to an existing direction) and
   * `createAuthoredDirection` (a NEW direction's v1 with engine seed tokens).
   * See the function-level JSDoc for the full no-generation contract.
   */
  skipImages?: boolean;
  /**
   * One-shot art direction for THIS generation pass ONLY — included in the
   * compiled art-direction tail (between MUST and PREFER) and therefore present
   * in the written `*-prompt.md` files (provenance) as well as the live
   * `generateImage` call. Never persisted into `direction-version.json`.
   */
  oneShotArtDirection?: string;
}): Promise<WriteDirectionVersionResult> {
  const cwd = path.resolve(opts.cwd);
  const { directionsDir, directionId, version, config } = opts;
  const lockedColors = opts.lockedColors ?? [];
  const filesWritten: string[] = [];
  const imageSkips: string[] = [];
  let extracted = false;
  const rel = (abs: string): string => relTo(cwd, abs);

  const versionsDir = path.join(directionsDir, directionId, "versions");
  await ensureDir(versionsDir);

  // Caller-driven id: honor a pre-minted version.id, else mint a collision-safe
  // one. Either way the version folder is never reused.
  const versionId = version.id || (await mintVersionId(versionsDir));
  version.id = versionId;

  const versionDir = path.join(versionsDir, versionId);
  await ensureDir(versionDir);

  // INVERTED SPINE (SC-03): the art-direction compiler is called EXACTLY ONCE
  // per generated prompt. All visual directives (MUST/PREFER/AVOID), the live
  // one-shot, and soft locked-color guidance flow through the single chokepoint.
  // The one-shot now appears in the written prompt file (generation provenance).
  // BYTE-IDENTICAL no-directive contract (SC-11): empty assembled + no locks +
  // no oneShot ⇒ composeArtDirection returns "" ⇒ decorate emits
  // "${prompt}\n\n${content}" with nothing appended — unchanged from pre-WS-03.
  const content = composeContentLock(version);
  const assembled = opts.assembled ?? EMPTY_ASSEMBLED;
  const decorate = (prompt: string): string => {
    const artTail = composeArtDirection(assembled, {
      oneShot: opts.oneShotArtDirection,
      lockedColors,
    });
    let out = `${prompt}\n\n${content}`;
    if (artTail) out += `\n\n${artTail}`;
    return out;
  };
  const styleTilePrompt = decorate(version.styleTilePrompt);
  const homepageMockupPrompt = decorate(version.homepageMockupPrompt);

  // direction-version.json — written FIRST so a token-less/dry-run version still
  // has it; rewritten AFTER extraction so the persisted tokens ARE the image.
  const versionJsonPath = path.join(versionDir, "direction-version.json");
  await writeJsonFile(versionJsonPath, version);
  filesWritten.push(rel(versionJsonPath));

  // Frozen provenance projections (human-readable), mirroring the old run-level
  // snapshots but now scoped to THIS version.
  const briefSnapshotPath = path.join(versionDir, "brief-snapshot.md");
  await writeTextFile(briefSnapshotPath, version.briefSnapshot);
  filesWritten.push(rel(briefSnapshotPath));

  const contextSnapshotPath = path.join(versionDir, "context-snapshot.md");
  await writeTextFile(contextSnapshotPath, version.contextSnapshot + "\n");
  filesWritten.push(rel(contextSnapshotPath));

  const styleTilePromptPath = path.join(versionDir, "style-tile-prompt.md");
  await writeTextFile(styleTilePromptPath, styleTilePrompt + "\n");
  filesWritten.push(rel(styleTilePromptPath));

  const homepagePromptPath = path.join(versionDir, "homepage-mockup-prompt.md");
  await writeTextFile(homepagePromptPath, homepageMockupPrompt + "\n");
  filesWritten.push(rel(homepagePromptPath));

  // Optional image generation — conditioned on the concept's reference images. A
  // skip must never fail the run: generateImage returns a typed result instead
  // of throwing; collect any skippedReason and warn a single line.
  if (!opts.skipImages && hasApiKey() && config.models.image) {
    const styleTilePng = path.join(versionDir, "style-tile.png");
    const styleRes = await generateImage({
      model: config.models.image,
      prompt: styleTilePrompt,
      outPath: styleTilePng,
      referenceImagePaths: opts.referenceImagePaths,
    });
    if (styleRes.written) {
      filesWritten.push(rel(styleTilePng));

      // INVERTED SPINE (SC-04/SC-05): read the tokens back OUT of the freely
      // rendered tile in ONE vision call. COLOR is a TRANSCRIPTION of the printed
      // hex codes, mapped to roles honoring the user's locked colors VERBATIM;
      // TYPE is the printed family names mapped to a loadable catalog family. The
      // stable per-direction seed keeps the engine finish deterministic. The
      // extracted tokens OVERWRITE the provisional intent→engine tokens so the
      // persisted tokens ARE the image. Graceful (never throws).
      const seed = version.tokens?.provenance?.seed ?? 0;
      const { read } = await describeImageBrand({
        model: config.models.vision,
        imagePaths: [styleTilePng],
      });
      // Role-aware locks (regenerate's lock-and-rotate) win when supplied; else
      // fall back to the role-less hexes (explore's extract-derived locks).
      const colorOpts = {
        locks: opts.extractionLocks ?? lockedColors.map((hex) => ({ hex })),
        seed,
      };
      const extractedColor = tokensFromRoledColors(read.colors, colorOpts);
      const extractedType = mapTypeRead(read.type);
      version.tokens = {
        ...extractedColor.tokens,
        typography: extractedType.typography,
      };
      // Rewrite the version record so its tokens reflect the pixels.
      await writeJsonFile(versionJsonPath, version);
      extracted = true;
    } else if (styleRes.skippedReason) {
      imageSkips.push(styleRes.skippedReason);
      console.warn(
        `Warning: image generation skipped for ${directionId}/${versionId}/style-tile.png: ${styleRes.skippedReason}`,
      );
    }

    const homepagePng = path.join(versionDir, "homepage-mockup.png");
    const homeRes = await generateImage({
      model: config.models.image,
      prompt: homepageMockupPrompt,
      outPath: homepagePng,
      referenceImagePaths: opts.referenceImagePaths,
    });
    if (homeRes.written) {
      filesWritten.push(rel(homepagePng));
    } else if (homeRes.skippedReason) {
      imageSkips.push(homeRes.skippedReason);
      console.warn(
        `Warning: image generation skipped for ${directionId}/${versionId}/homepage-mockup.png: ${homeRes.skippedReason}`,
      );
    }
  }

  // Advance the direction record's versions[]/head to this version. The record
  // must already exist (DirectionCore.create) — this never creates one.
  await createDirectionCore(cwd, config).appendVersion(directionId, versionId);
  filesWritten.push(rel(path.join(directionsDir, directionId, "direction.yaml")));

  return { directionId, versionId, versionDir, filesWritten, imageSkips, extracted };
}

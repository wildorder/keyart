import type { DirectionTokens } from "../types.js";
import { hasApiKey, chatJson, visionJson } from "../openai.js";
import type { PaletteLock } from "../brand/palette.js";
import {
  buildPlaceholderDirections,
  type SeedDirection,
} from "./placeholders.js";
import {
  buildTokens,
  cloneTokens,
  deriveLocksFromContext,
  type RawTokenIntent,
} from "./token-intent.js";
import {
  buildExploreSystemPrompt,
  buildExploreUserPrompt,
} from "./prompts.js";

function isValidDirection(d: unknown): d is SeedDirection {
  if (!d || typeof d !== "object") return false;
  const obj = d as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return false;
  if (typeof obj.name !== "string" || !obj.name) return false;
  if (typeof obj.summary !== "string" || !obj.summary) return false;
  if (typeof obj.positioning !== "string" || !obj.positioning) return false;
  if (!obj.character || typeof obj.character !== "object") return false;
  if (typeof obj.homepageMockupPrompt !== "string" || !obj.homepageMockupPrompt)
    return false;
  if (typeof obj.styleTilePrompt !== "string" || !obj.styleTilePrompt)
    return false;

  const copy = obj.copyExamples;
  if (!copy || typeof copy !== "object") return false;
  const c = copy as Record<string, unknown>;
  if (
    typeof c.headline !== "string" ||
    typeof c.subheadline !== "string" ||
    typeof c.cta !== "string"
  )
    return false;

  // `usage` must be present with rules/antiRules arrays — but NO minimum count,
  // so the keyless/dry-run and empty-structured-fields paths (SC-09) validate.
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return false;
  if (!Array.isArray(usage.rules) || !Array.isArray(usage.antiRules))
    return false;

  return true;
}

/**
 * Shared post-processing for BOTH the vision and text routes — normalizes
 * `{ directions }`-or-array responses, validates every direction, and falls back
 * to the provided `fallback` on a dry-run/empty/invalid payload. Factored out so
 * explore and refine can never drift.
 *
 * `stamp` is applied ONLY to valid model-returned directions (the live path);
 * the fallback placeholders are returned untouched (they already carry WS-01
 * tokens), so token stamping never double-runs on the dry-run branch.
 */
function finalizeDirections(
  data: { directions: SeedDirection[] } | null,
  dryRun: boolean,
  fallback: () => SeedDirection[],
  stamp?: (directions: SeedDirection[]) => SeedDirection[],
): SeedDirection[] {
  if (dryRun || !data) {
    return fallback();
  }

  // Handle both { directions: [...] } and raw array responses
  const directions = Array.isArray(data)
    ? (data as unknown as SeedDirection[])
    : data.directions;

  if (!Array.isArray(directions) || directions.length === 0) {
    console.warn(
      "OpenAI returned unexpected structure; falling back to placeholders.",
    );
    return fallback();
  }

  if (!directions.every(isValidDirection)) {
    console.warn(
      "OpenAI returned directions with missing/invalid fields; falling back to placeholders.",
    );
    return fallback();
  }

  return stamp ? stamp(directions) : directions;
}

/** Shared token-engine options threaded through ONE typed object (no route fork). */
interface StampTokenOptions {
  /** Per-run seed base; each direction gets `seed + index` for intra-run variety. */
  seed: number;
  /** Assembled context block; its brief/hard-rule hexes become palette locks. */
  contextBlock?: string;
  /** Caller-supplied locks (WS-05 extract-derived); combined with context locks. */
  locks?: PaletteLock[];
  /** Prior-run palettes fed as anti-examples so consecutive runs diverge. */
  priorPalettes?: string[][];
  /**
   * The brief's SOFT aesthetic-intent seed (WS-04) — a base-hue/scheme/font-
   * pairing bias derived from `colorIntent`/`typeIntent` words. Applied as engine-
   * intent DEFAULTS: the model's own per-direction `tokenIntent` overrides it
   * field-by-field, and explicit locks still win. Empty/absent ⇒ no bias.
   */
  intentDefaults?: RawTokenIntent;
  /**
   * Tokens to inherit when a direction omits `tokenIntent` (refine/blend: the
   * primary parent's tokens). Absent on explore — those directions fall back to
   * default-intent engine tokens instead, never left token-less.
   */
  inheritTokens?: DirectionTokens;
}

/** A model direction may carry a transient `tokenIntent` the engine consumes. */
type DirectionWithIntent = SeedDirection & { tokenIntent?: unknown };

/**
 * The SINGLE token-stamping step used by both explore and refine (mirrors the
 * shared `finalizeDirections` so the two routes never drift). For each live
 * direction: run WS-01's palette engine on the model's `tokenIntent` (or a
 * default/inherited fallback), stamp the resulting `DirectionTokens`, and strip
 * the transient `tokenIntent` field. Every returned direction is guaranteed to
 * carry `tokens` (SC-02).
 *
 * INVERTED SPINE (WS-03): with a key, these intent→engine tokens are only
 * PROVISIONAL — they guarantee a direction is never token-less BEFORE the image
 * is generated, and they ARE the final tokens on the dry-run / no-image path.
 * On the keyed path `write-run.ts` OVERWRITES `direction.tokens` by EXTRACTING
 * color from the rendered style tile's pixels + type from a vision read (SC-04/
 * SC-05). The caller-supplied `locks` still flow through so the fallback tokens
 * honor the user's locked colors too — consistent with the extracted path.
 */
function stampTokens(
  directions: SeedDirection[],
  opts: StampTokenOptions,
): SeedDirection[] {
  const locks: PaletteLock[] = [
    ...(opts.locks ?? []),
    ...deriveLocksFromContext(opts.contextBlock),
  ];
  // The brief's SOFT intent (WS-04) — lowest precedence, applied as engine
  // DEFAULTS. Empty ⇒ behavior is byte-identical to before.
  const defaults = opts.intentDefaults ?? {};
  const hasDefaults = Object.keys(defaults).length > 0;

  return directions.map((d, index) => {
    const modelRaw = (d as DirectionWithIntent).tokenIntent;
    const hasModelIntent = modelRaw !== undefined && modelRaw !== null;
    const modelObj: RawTokenIntent =
      hasModelIntent && typeof modelRaw === "object"
        ? (modelRaw as RawTokenIntent)
        : {};

    let tokens: DirectionTokens;
    if (hasModelIntent || hasDefaults) {
      // The brief bias seeds any field the model left unspecified; the model's
      // own per-direction intent OVERRIDES it field-by-field (soft = a seed, not
      // a lock). Explicit locks still win downstream in the engine.
      tokens = buildTokens({
        raw: { ...defaults, ...modelObj },
        seed: opts.seed + index,
        locks,
        priorPalettes: opts.priorPalettes,
      });
    } else if (opts.inheritTokens) {
      // Refine/blend child with neither model intent nor a brief bias — inherit
      // the parent's tokens (a stronger signal than a generic engine default).
      tokens = cloneTokens(opts.inheritTokens);
    } else {
      // Explore direction without intent — never leave it token-less; engine
      // tokens from a default intent (malformed-intent mitigation).
      tokens = buildTokens({
        raw: {},
        seed: opts.seed + index,
        locks,
        priorPalettes: opts.priorPalettes,
      });
    }

    const stamped: DirectionWithIntent = { ...d, tokens };
    delete stamped.tokenIntent;
    return stamped;
  });
}

export interface GenerateDirectionsOptions {
  contextBlock?: string;
  /**
   * ABSOLUTE paths to the concept's reference images. When present alongside a
   * `vision` model (and a key), direction generation routes through multi-image
   * vision so the moodboard visibly shapes the run. Without a vision model the
   * references still travel via the rendered manifest inside `contextBlock`.
   */
  referenceImagePaths?: string[];
  /** Number of directions to generate. Defaults to 3 (behavior unchanged). */
  count?: number;
  /** One-shot steering for this generation only (not persisted). */
  instructions?: string;
  /**
   * Per-run seed driving palette variety (recorded in `tokens.provenance.seed`).
   * The caller supplies a fresh value each run so repeated explores of the same
   * brief yield different-but-coherent palettes (SC-13). Defaults to 0 for a
   * deterministic result when omitted (e.g. tests).
   */
  seed?: number;
  /** Explicit palette locks (WS-05 extract-derived); default none. */
  locks?: PaletteLock[];
  /** Prior-run palettes fed as anti-examples so runs actively diverge. */
  priorPalettes?: string[][];
  /**
   * The brief's SOFT aesthetic-intent seed (WS-04) — engine-intent DEFAULTS
   * derived from `colorIntent`/`typeIntent` words (base hue / scheme / catalog
   * font pairing). Lowest precedence; the model's own intent + locks win.
   */
  intentDefaults?: RawTokenIntent;
}

export async function generateDirections(
  brief: string,
  models: { text: string; vision?: string },
  opts?: GenerateDirectionsOptions,
): Promise<SeedDirection[]> {
  const count = opts?.count ?? 3;
  const fallback = (): SeedDirection[] =>
    buildPlaceholderDirections(brief, count);

  if (!hasApiKey()) {
    return fallback();
  }

  // Stamp engine-derived tokens onto every LIVE direction (explore has no parent
  // to inherit from — a missing intent falls back to default-intent tokens).
  const stamp = (directions: SeedDirection[]): SeedDirection[] =>
    stampTokens(directions, {
      seed: opts?.seed ?? 0,
      contextBlock: opts?.contextBlock,
      locks: opts?.locks,
      priorPalettes: opts?.priorPalettes,
      intentDefaults: opts?.intentDefaults,
    });

  const refs = opts?.referenceImagePaths ?? [];
  const useVision = refs.length > 0 && !!models.vision;

  try {
    if (useVision) {
      const { data, dryRun } = await visionJson<{
        directions: SeedDirection[];
      }>({
        model: models.vision!,
        system: buildExploreSystemPrompt(),
        user: buildExploreUserPrompt(brief, {
          contextBlock: opts?.contextBlock,
          hasReferenceImages: true,
          count,
          instructions: opts?.instructions,
        }),
        imagePaths: refs,
      });
      return finalizeDirections(data, dryRun, fallback, stamp);
    }

    const { data, dryRun } = await chatJson<{
      directions: SeedDirection[];
    }>({
      model: models.text,
      system: buildExploreSystemPrompt(),
      user: buildExploreUserPrompt(brief, {
        contextBlock: opts?.contextBlock,
        count,
        instructions: opts?.instructions,
      }),
    });
    return finalizeDirections(data, dryRun, fallback, stamp);
  } catch (err) {
    console.warn(
      "Failed to generate directions via OpenAI; falling back to placeholders.",
      err,
    );
    return fallback();
  }
}

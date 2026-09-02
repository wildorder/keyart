import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  Contradiction,
  ContradictionKind,
  ContradictionRef,
  ContradictionSeverity,
  ReconciliationAction,
} from "./brand/conflict-guard.js";

/**
 * Maximum number of reference images sent to a single vision or image call.
 * Bounds token/cost per the fix-directions Risk Register (matches WS-01's
 * MAX_CONTEXT_REFERENCES intent).
 */
const MAX_VISION_IMAGES = 6;

export function hasApiKey(): boolean {
  return !!(clientOptions.apiKey ?? process.env.OPENAI_API_KEY);
}

/**
 * One model call's token spend, in a PROVIDER-NEUTRAL shape (no OpenAI field
 * names) so the meter's contract survives a future multi-provider adapter.
 * Counts are best-effort: an endpoint that reports no usage yields no call.
 */
export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Options for the module's model client — the ONE injection point between
 * config and every model call (`chatJson`/`visionJson`/`generateImage` and the
 * chat agent's `createComplete` all route through {@link createClient}).
 * `baseURL` points the OpenAI SDK at any OpenAI-compatible endpoint (Azure
 * OpenAI, OpenRouter, a local server); unset, the SDK's own defaults apply —
 * including its native `OPENAI_BASE_URL` env-var support. `apiKey` overrides
 * the `OPENAI_API_KEY` environment variable (the per-tenant seam for an
 * embedding host — it also satisfies `hasApiKey()`, so dry-run gating honors
 * it). `onUsage` is the metering hook: invoked once per model response that
 * reports token usage; a throwing callback is swallowed — the meter must
 * never break the call it measures.
 */
export interface ModelClientOptions {
  baseURL?: string;
  apiKey?: string;
  onUsage?: (usage: ModelUsage) => void;
}

let clientOptions: ModelClientOptions = {};

/**
 * Set the module-level client options. Called by `loadConfig` with
 * `config.models.baseURL` so every command inherits the configured endpoint;
 * callable directly by an embedding host (a hosted deployment supplying
 * per-request options would wrap this seam rather than mutate it globally).
 */
export function configureModelClient(opts: ModelClientOptions): void {
  clientOptions = { ...opts };
}

export function createClient(): OpenAI | null {
  if (!hasApiKey()) return null;
  const { baseURL, apiKey } = clientOptions;
  if (!baseURL && !apiKey) return new OpenAI();
  return new OpenAI({
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
}

/**
 * Normalize a raw usage block (chat's `prompt_tokens`/`completion_tokens` or
 * the Images API's `input_tokens`/`output_tokens`) into {@link ModelUsage} and
 * hand it to the configured `onUsage` hook. Absent hook, absent usage, or a
 * throwing callback are all no-ops. Exported for the streaming chat seam
 * (`src/agent/model.ts`) — the one model path outside this module.
 */
export function recordModelUsage(model: string, usage: unknown): void {
  const onUsage = clientOptions.onUsage;
  if (!onUsage || usage === null || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  try {
    onUsage({
      model,
      promptTokens: num(u.prompt_tokens) + num(u.input_tokens),
      completionTokens: num(u.completion_tokens) + num(u.output_tokens),
    });
  } catch {
    // The meter must never break the call it measures.
  }
}

/**
 * Read an image from disk and return its base64 payload + normalized media
 * type. Defined once so every image (vision content, image references) is
 * encoded identically.
 */
async function encodeImage(
  imagePath: string,
): Promise<{ base64: string; mediaType: string }> {
  const imageBuffer = await fs.readFile(imagePath);
  const base64 = imageBuffer.toString("base64");
  const ext = path.extname(imagePath).slice(1) || "png";
  const mediaType = ext === "jpg" ? "jpeg" : ext;
  return { base64, mediaType };
}

export async function chatJson<T>(opts: {
  model: string;
  system: string;
  user: string;
}): Promise<{ data: T; dryRun: boolean }> {
  const client = createClient();
  if (!client) {
    return { data: null as T, dryRun: true };
  }

  const response = await client.chat.completions.create({
    model: opts.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });
  recordModelUsage(opts.model, response.usage);

  const content = response.choices[0]?.message?.content ?? "{}";
  return { data: JSON.parse(content) as T, dryRun: false };
}

/**
 * Vision + JSON call. Accepts either a single `imagePath` (back-compat, used by
 * audit) or a list of `imagePaths` (multi-image reference grounding). Sends one
 * `image_url` content entry per image — capped at MAX_VISION_IMAGES, in stable
 * order — followed by the single text entry. A single-`imagePath` call produces
 * a request byte-for-byte identical to the pre-multi-image version. With no
 * images it degrades to a plain text prompt (never throws). No API key ⇒
 * dry-run (no client call, no file read).
 */
export async function visionJson<T>(opts: {
  model: string;
  system: string;
  user: string;
  imagePath?: string; // back-compat (audit)
  imagePaths?: string[]; // NEW — multi-image
}): Promise<{ data: T; dryRun: boolean }> {
  const client = createClient();
  if (!client) {
    return { data: null as T, dryRun: true };
  }

  const paths = (
    opts.imagePaths ?? (opts.imagePath ? [opts.imagePath] : [])
  ).slice(0, MAX_VISION_IMAGES);

  const imageContent = await Promise.all(
    paths.map(async (p) => {
      const { base64, mediaType } = await encodeImage(p);
      return {
        type: "image_url" as const,
        image_url: {
          url: `data:image/${mediaType};base64,${base64}`,
        },
      };
    }),
  );

  const response = await client.chat.completions.create({
    model: opts.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: opts.system },
      {
        role: "user",
        content: [...imageContent, { type: "text", text: opts.user }],
      },
    ],
  });
  recordModelUsage(opts.model, response.usage);

  const content = response.choices[0]?.message?.content ?? "{}";
  return { data: JSON.parse(content) as T, dryRun: false };
}

/**
 * The vision read of an `extract`-intent reference: the image's dominant colors
 * (as `#rrggbb` hexes) plus a free-text typographic feel. These seed the palette
 * engine (WS-01) as locks — never a direct image-edit source (SC-06).
 */
export interface ReferenceTokenAnalysis {
  dominantColors: string[]; // #rrggbb hexes extracted from the image(s)
  typeIntent?: { style?: string; suggestedPairing?: string }; // free-text type read
}

/**
 * Vision-analyze `extract`-intent references into dominant colors + a type read.
 * Routes through {@link visionJson} (multi-image, capped at MAX_VISION_IMAGES) —
 * this is ANALYSIS ONLY; the reference is NEVER passed to {@link generateImage}
 * as an edit source (SC-06: no derivative output). Degrades gracefully: no API
 * key ⇒ `{ analysis: { dominantColors: [] }, dryRun: true }`; any failure ⇒ an
 * empty analysis with `dryRun: false`. Never throws.
 */
export async function analyzeReferenceForTokens(opts: {
  model: string;
  imagePaths: string[];
}): Promise<{ analysis: ReferenceTokenAnalysis; dryRun: boolean }> {
  const empty: ReferenceTokenAnalysis = { dominantColors: [] };
  if (!hasApiKey()) {
    return { analysis: empty, dryRun: true };
  }

  const system = [
    "You are a visual analyst extracting a color + type read from reference images.",
    "Return ONLY a JSON object of the shape:",
    '{ "dominantColors": ["#rrggbb", ...], "typeIntent": { "style": "...", "suggestedPairing": "..." } }',
    "dominantColors: 3–6 hex colors that dominate the image(s), most prominent first.",
    "typeIntent: a short free-text read of the typographic feel (style) and a suggested font pairing.",
    "Do NOT invent brand rules or copy — describe only what the image(s) show.",
  ].join("\n");
  const user =
    "Extract the dominant colors (as #rrggbb hexes) and the typographic feel from the attached reference image(s).";

  try {
    const { data, dryRun } = await visionJson<ReferenceTokenAnalysis>({
      model: opts.model,
      system,
      user,
      imagePaths: opts.imagePaths,
    });
    if (dryRun || !data || typeof data !== "object") {
      return { analysis: empty, dryRun };
    }
    const analysis: ReferenceTokenAnalysis = {
      dominantColors: Array.isArray(data.dominantColors)
        ? data.dominantColors.filter((c): c is string => typeof c === "string")
        : [],
      typeIntent:
        data.typeIntent && typeof data.typeIntent === "object"
          ? data.typeIntent
          : undefined,
    };
    return { analysis, dryRun };
  } catch {
    // Graceful, like the image path — a weak/failed read must never abort a run.
    return { analysis: empty, dryRun: false };
  }
}

/** The typographic half of a {@link BrandImageRead} — what the model read off
 * the GENERATED tile's typography panel. Every field is optional/advisory; the
 * catalog mapper (`mapTypeRead`) decides what to trust and always returns REAL,
 * loadable families (labeled approximate). */
export interface BrandTypeRead {
  /** Font family NAMES the model transcribed from labels printed in the tile's
   * typography panel (the strongest intent signal — mapped, not trusted). */
  printedFamilies?: { heading?: string; body?: string };
  /** Structured attributes read from the rendered letterforms (mapped to the
   * nearest catalog pairing when no printed name resolves). */
  attributes?: {
    /** serif / sans / mono / slab / display / handwritten … */
    classification?: string;
    /** light / regular / medium / bold / black … */
    weight?: string;
    /** low / medium / high stroke contrast. */
    contrast?: string;
    /** condensed / normal / wide. */
    width?: string;
    /** free-text mood (e.g. "friendly, rounded, playful"). */
    mood?: string;
  };
  /** A single real family the type most resembles (advisory catch-all). */
  suggestedFamily?: string;
}

/**
 * A single consolidated vision read of a GENERATED style tile — BOTH the brand
 * color palette and the typographic read, in one call, so we never hit the same
 * image twice. Distinct from {@link ReferenceTokenAnalysis} (which reads
 * *reference* images). Analysis only; it emits NO image-prompt constraint — the
 * image is never constrained to the catalog (SC-05).
 */
/**
 * The role a color PLAYS in the design, as inferred by the vision model from
 * actual usage across the style tile + homepage mockup (canvas / ink / CTA /
 * brand color) — NOT re-derived afterward from a lightness sort. The universal
 * roles occur at most once; `brand` is the OPEN set — every color that is not
 * one of the universal roles — and may repeat any number of times (no fixed
 * cap, and no prescribed "accent"-style usage; the color's `label` carries what
 * meaning the model actually read). `secondary` is the supporting brand color:
 * a universal one-each role the model may tag directly (WS-02), so it locks onto
 * the engine's `secondary` slot verbatim rather than being bridged from `brand`.
 */
export type BrandColorRole =
  | "background"
  | "surface"
  | "text"
  | "muted"
  | "primary"
  | "secondary"
  | "brand";

/** The universal (one-each) roles; every other color is a `brand` color. */
export const UNIVERSAL_BRAND_ROLES: readonly BrandColorRole[] = [
  "background",
  "surface",
  "text",
  "muted",
  "primary",
  "secondary",
];

/** One color read off the tile, already tagged with the role it plays. */
export interface BrandColorRead {
  /** `#rrggbb` transcribed from the printed swatch (verbatim). */
  hex: string;
  /** The role the color plays, inferred from usage (defaults to `brand`). */
  role: BrandColorRole;
  /** The swatch's printed name, if any (e.g. "Hot Pink") — advisory provenance
   * only; never keyed on for CSS vars or slot identity (non-deterministic). */
  label?: string;
}

export interface BrandImageRead {
  /** Role-tagged brand colors read off the tile — the model assigns each color
   * the role it PLAYS (canvas/ink/CTA/brand), so roles come from the image,
   * not a post-hoc OKLCH sort. Empty when unreadable / dry-run. */
  colors: BrandColorRead[];
  /** The typographic read (see {@link BrandTypeRead}). */
  type: BrandTypeRead;
}

const ALL_BRAND_ROLES: ReadonlySet<string> = new Set<string>([
  ...UNIVERSAL_BRAND_ROLES,
  "brand",
]);

/** Parse the model's `colors` array into validated role-tagged reads. */
function parseBrandColors(raw: unknown): BrandColorRead[] {
  if (!Array.isArray(raw)) return [];
  const out: BrandColorRead[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const hex = typeof rec.hex === "string" ? rec.hex.trim() : "";
    if (!hex) continue;
    const roleRaw =
      typeof rec.role === "string" ? rec.role.trim().toLowerCase() : "";
    const role: BrandColorRole = ALL_BRAND_ROLES.has(roleRaw)
      ? (roleRaw as BrandColorRole)
      : "brand";
    const label =
      typeof rec.label === "string" && rec.label.trim() ? rec.label : undefined;
    out.push(label ? { hex, role, label } : { hex, role });
  }
  return out;
}

/**
 * Vision-read a GENERATED style tile's brand palette + typography in ONE call.
 * COLOR is a TRANSCRIPTION of the exact hex codes printed in the tile's palette
 * panel (near-exact, unlike pixel guessing); TYPE is the family NAMES printed in
 * the typography panel plus a few structured letterform attributes. Routes
 * through {@link visionJson}; mirrors {@link analyzeReferenceForTokens}'s
 * graceful-degradation contract. No API key ⇒ an empty read, `dryRun: true`; any
 * failure ⇒ an empty read, `dryRun: false`. Never throws — downstream mappers
 * fall back to engine/catalog defaults, preserving keyless/dry-run parity.
 */
export async function describeImageBrand(opts: {
  model: string;
  imagePaths: string[];
}): Promise<{ read: BrandImageRead; dryRun: boolean }> {
  const empty: BrandImageRead = { colors: [], type: {} };
  if (!hasApiKey()) {
    return { read: empty, dryRun: true };
  }

  const system = [
    "You are a brand analyst reading tokens off a GENERATED style tile image.",
    "Return ONLY a JSON object of the shape:",
    '{ "colors": [ { "hex": "#rrggbb", "role": "<role>", "label": "<printed swatch name>" }, ... ], "type": { "printedFamilies": { "heading": "...", "body": "..." }, "attributes": { "classification": "...", "weight": "...", "contrast": "...", "width": "...", "mood": "..." }, "suggestedFamily": "..." } }',
    "colors: every intended brand color. TRANSCRIBE the exact hex code printed beside each swatch in the color-palette panel (only estimate if no hex is printed). For EACH color, assign the ROLE it plays in the design — judge from how the color is actually USED across the style tile and homepage mockup, NOT from how light or dark it is:",
    "  - background: the page canvas the layout sits on",
    "  - surface: raised card / panel fills placed on top of the background",
    "  - text: the primary body / ink color",
    "  - muted: secondary text, captions, borders, or dividers",
    "  - primary: the single dominant brand / call-to-action color",
    "  - secondary: a single supporting brand color that pairs with the primary (only if one is clearly used as such)",
    "  - brand: any OTHER brand color that is not one of the roles above — do NOT assume it is an emphasis/accent color; use \"brand\" as many times as needed (there is NO fixed limit) and let its label carry any meaning you can read",
    "Assign at most one background, one surface, one text, one muted, one primary, and one secondary; \"brand\" may repeat. List colors most-prominent first. label: the swatch's printed name if shown (advisory).",
    "printedFamilies: the heading/body font family NAMES printed as labels in the typography panel, transcribed verbatim (omit a field if no name is printed).",
    "attributes: a short structured read of the rendered letterforms — classification (serif/sans/mono/slab/display/handwritten), weight, stroke contrast (low/medium/high), width (condensed/normal/wide), and a free-text mood.",
    "suggestedFamily: one real font family the type most resembles (advisory).",
    "Report ONLY what the image shows — do NOT invent brand rules or copy.",
  ].join("\n");
  const user =
    "Read the brand colors (transcribe each printed hex code and assign the role it plays in the design) and the typography (printed family names + letterform attributes) from the attached generated style tile and homepage mockup.";

  try {
    const { data, dryRun } = await visionJson<BrandImageRead>({
      model: opts.model,
      system,
      user,
      imagePaths: opts.imagePaths,
    });
    if (dryRun || !data || typeof data !== "object") {
      return { read: empty, dryRun };
    }
    const rawType = data.type && typeof data.type === "object" ? data.type : {};
    const asString = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v : undefined;
    const rawPrinted =
      rawType.printedFamilies && typeof rawType.printedFamilies === "object"
        ? rawType.printedFamilies
        : undefined;
    const rawAttrs =
      rawType.attributes && typeof rawType.attributes === "object"
        ? rawType.attributes
        : undefined;
    const colors = parseBrandColors(data.colors);
    const read: BrandImageRead = {
      colors,
      type: {
        printedFamilies: rawPrinted
          ? {
              heading: asString(rawPrinted.heading),
              body: asString(rawPrinted.body),
            }
          : undefined,
        attributes: rawAttrs
          ? {
              classification: asString(rawAttrs.classification),
              weight: asString(rawAttrs.weight),
              contrast: asString(rawAttrs.contrast),
              width: asString(rawAttrs.width),
              mood: asString(rawAttrs.mood),
            }
          : undefined,
        suggestedFamily: asString(rawType.suggestedFamily),
      },
    };
    return { read, dryRun };
  } catch {
    // Graceful, like analyzeReferenceForTokens — a weak/failed read must never
    // abort a run; color/type degrade to engine/catalog defaults downstream.
    return { read: empty, dryRun: false };
  }
}

export interface GenerateImageResult {
  written: boolean;
  dryRun: boolean;
  /** Set when generation was attempted but skipped/failed (capability,
   * entitlement, or empty response) — a human-readable reason. Never thrown. */
  skippedReason?: string;
  /** Non-fatal degradations that did NOT stop generation (e.g. transparent
   * background unsupported by the model → retried with an opaque background).
   * Callers must surface these — a silent degradation reads as a key problem. */
  warnings?: string[];
}

/**
 * Generate an image to `outPath`. When `referenceImagePaths` is non-empty, the
 * generation is conditioned on those images via the reference-capable image API
 * (`images.edit`); otherwise prompt-only `images.generate` is used. Handles both
 * `b64_json` (gpt-image family) and `url` responses. Never throws for a
 * model/capability/entitlement failure or an empty response — it returns a
 * typed `skippedReason` so callers can surface the reason and flag the run. No
 * API key ⇒ dry-run (no write).
 */
export async function generateImage(opts: {
  model: string;
  prompt: string;
  outPath: string;
  referenceImagePaths?: string[]; // NEW — condition on these images when present
  transparentBackground?: boolean; // NEW — request a transparent background from the image API
}): Promise<GenerateImageResult> {
  const client = createClient();
  if (!client) {
    return { written: false, dryRun: true };
  }

  const references = (opts.referenceImagePaths ?? []).slice(
    0,
    MAX_VISION_IMAGES,
  );
  const warnings: string[] = [];

  const callApi = async (withBackground: boolean) => {
    const backgroundParam =
      withBackground && opts.transparentBackground
        ? ({ background: "transparent" as const })
        : {};
    if (references.length > 0) {
      const files = await Promise.all(
        references.map(async (p) => {
          const buffer = await fs.readFile(p);
          const ext = path.extname(p).slice(1) || "png";
          const type = `image/${ext === "jpg" ? "jpeg" : ext}`;
          return OpenAI.toFile(buffer, path.basename(p), { type });
        }),
      );
      return client.images.edit({
        model: opts.model,
        prompt: opts.prompt,
        image: files.length === 1 ? files[0] : files,
        n: 1,
        size: "1024x1024",
        ...backgroundParam,
      });
    }
    return client.images.generate({
      model: opts.model,
      prompt: opts.prompt,
      n: 1,
      size: "1024x1024",
      ...backgroundParam,
    });
  };

  let response;
  try {
    response = await callApi(true);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Transparency is BEST-EFFORT: a model that rejects the background param
    // gets ONE retry without it — an opaque PNG beats no PNG — and the
    // limitation is surfaced as a warning rather than swallowed as a failure
    // (a silent degradation is indistinguishable from a missing key).
    const backgroundRejected =
      opts.transparentBackground === true &&
      /background/i.test(reason) &&
      /not supported/i.test(reason);
    if (!backgroundRejected) {
      return { written: false, dryRun: false, skippedReason: reason };
    }
    warnings.push(
      `transparent background is not supported by ${opts.model} — retried and generated with an opaque background`,
    );
    try {
      response = await callApi(false);
    } catch (err2) {
      const reason2 = err2 instanceof Error ? err2.message : String(err2);
      return { written: false, dryRun: false, skippedReason: reason2, warnings };
    }
  }

  recordModelUsage(opts.model, (response as { usage?: unknown }).usage);

  const image = response.data?.[0];
  let buffer: Buffer;
  if (image?.b64_json) {
    buffer = Buffer.from(image.b64_json, "base64");
  } else if (image?.url) {
    const res = await fetch(image.url);
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    return {
      written: false,
      dryRun: false,
      skippedReason: "Image model returned no image data.",
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
  await fs.writeFile(opts.outPath, buffer);

  return { written: true, dryRun: false, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** One scan candidate as sent to the vision classifier (crop + hints + floor read). */
export interface SurfaceCandidateInput {
  signature: string;
  kind: string; // the floor's kind guess
  cropPath: string; // ABSOLUTE path to the crop PNG
  hints: { ariaLabel?: string; alt?: string; classNames?: string[]; nearbyText?: string };
  contextNote?: string; // the floor's observed value, when any
}

/** One refinement suggestion, keyed by signature. Absent fields = no suggestion. */
export interface SurfaceCandidateSuggestion {
  signature: string;
  suggestedId?: string; // e.g. "icon.restaurant" — VALIDATED by the caller, not trusted
  kind?: string; // confirmed/corrected kind — validated by the caller against SlotKind
  description?: string;
  tone?: string;
}

export interface ClassifySurfaceCandidatesResult {
  candidates: SurfaceCandidateSuggestion[];
  dryRun: boolean;
  skippedReason?: string;
}

/**
 * The key-gated vision refinement seam for surface-scan proposals (the
 * detectContradictionsLLM / describeImageBrand idiom): reads candidate CROPS +
 * DOM hints and suggests meaningful slot ids, confirmed kinds, and
 * descriptions. ADVISORY ONLY — the caller merges into the PROPOSAL; this call
 * never touches the manifest. NEVER throws, NEVER fabricates: no key ⇒
 * { candidates: [], dryRun: true } without touching the client; any failure ⇒
 * { candidates: [], dryRun: false, skippedReason }. Crops are chunked through
 * {@link visionJson} under MAX_VISION_IMAGES — one call per chunk. A chunk
 * whose call throws contributes nothing; only when EVERY chunk fails does the
 * result carry a `skippedReason` (the first failure's message).
 */
export async function classifySurfaceCandidates(opts: {
  model: string;
  candidates: SurfaceCandidateInput[];
  /** The closed slot-kind taxonomy, serialized by the caller (WS-01 owns it). */
  taxonomy: string;
}): Promise<ClassifySurfaceCandidatesResult> {
  if (!hasApiKey()) {
    return { candidates: [], dryRun: true };
  }
  if (opts.candidates.length === 0) {
    return { candidates: [], dryRun: false };
  }

  const system = [
    "You are a vision classifier refining anonymously-proposed UI style slots.",
    "Return ONLY a JSON object of the shape:",
    '{ "candidates": [ { "signature": "...", "suggestedId": "...", "kind": "...", "description": "...", "tone": "..." } ] }',
    "suggestedId: a meaningful, dot-namespaced kebab-case id (e.g. \"icon.restaurant\") — <family>.<name>, at least two segments.",
    "ROLE-NAMING LAW — name the ROLE, never the VALUE. Derive `suggestedId` from the element's FUNCTION or PURPOSE, inferred from its ariaLabel, alt text, class names, and nearby text.",
    "NEVER name a slot after its appearance: no color words, no hue names, no hex codes, no font family names. These ids record DEMAND and must survive a rebrand — a slot named for today's palette is false the moment the brand changes.",
    "icon / illustration: the depicted SUBJECT is the function — \"icon.restaurant\", \"illustration.empty-cart\" are correct.",
    "color-role / type-role: the id must describe USAGE — \"color-role.status-late\", \"type-role.data-table\" are correct; \"color.brand-green\", \"color-role.emerald\", \"type-role.space-grotesk\" are WRONG and will be discarded.",
    "contextNote states the literal value the page was observed using. It is EVIDENCE for your description — it is NEVER a naming source.",
    "If no functional role is inferable from the hints, OMIT `suggestedId` entirely. An honest anonymous candidate a human triages is better than a confident wrong name they accept.",
    "kind: one of the taxonomy kinds, only if you are confidently correcting or confirming the floor's guess.",
    "description: a short, concrete description of ONLY what the crop shows — never invent. (The description DOES describe appearance; the naming law above governs `suggestedId` only.)",
    "tone: an optional short mood/style read (e.g. \"friendly, rounded\").",
    "Omit any field you are not confident about — do not guess. Echo each `signature` verbatim from the input.",
  ].join("\n");

  const sentSignatures = new Set(opts.candidates.map((c) => c.signature));

  const chunks: SurfaceCandidateInput[][] = [];
  for (let i = 0; i < opts.candidates.length; i += MAX_VISION_IMAGES) {
    chunks.push(opts.candidates.slice(i, i + MAX_VISION_IMAGES));
  }

  const suggestions: SurfaceCandidateSuggestion[] = [];
  let failureCount = 0;
  let firstFailureReason: string | undefined;

  for (const chunk of chunks) {
    const descriptors = chunk
      .map((c, idx) => {
        const parts = [
          `Image ${idx + 1}: signature=${c.signature} kind=${c.kind}`,
          c.hints.ariaLabel ? `ariaLabel=${JSON.stringify(c.hints.ariaLabel)}` : undefined,
          c.hints.alt ? `alt=${JSON.stringify(c.hints.alt)}` : undefined,
          c.hints.classNames?.length ? `classNames=${JSON.stringify(c.hints.classNames)}` : undefined,
          c.hints.nearbyText ? `nearbyText=${JSON.stringify(c.hints.nearbyText)}` : undefined,
          c.contextNote ? `contextNote=${JSON.stringify(c.contextNote)}` : undefined,
        ].filter((p): p is string => p !== undefined);
        return parts.join(" ");
      })
      .join("\n");
    const user = [`Taxonomy: ${opts.taxonomy}`, descriptors].join("\n");

    try {
      const { data, dryRun } = await visionJson<{ candidates?: unknown }>({
        model: opts.model,
        system,
        user,
        imagePaths: chunk.map((c) => c.cropPath),
      });
      if (dryRun) continue; // hasApiKey() already gated this — defensive only
      const raw = data && typeof data === "object" ? (data as Record<string, unknown>).candidates : undefined;
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const signature = typeof rec.signature === "string" ? rec.signature : undefined;
        if (!signature || !sentSignatures.has(signature)) continue;
        const asString = (v: unknown): string | undefined =>
          typeof v === "string" && v.trim() ? v : undefined;
        suggestions.push({
          signature,
          suggestedId: asString(rec.suggestedId),
          kind: asString(rec.kind),
          description: asString(rec.description),
          tone: asString(rec.tone),
        });
      }
    } catch (err) {
      failureCount += 1;
      firstFailureReason ??= err instanceof Error ? err.message : String(err);
    }
  }

  if (chunks.length > 0 && failureCount === chunks.length) {
    return {
      candidates: [],
      dryRun: false,
      skippedReason: firstFailureReason ?? "Vision classification failed.",
    };
  }

  return { candidates: suggestions, dryRun: false };
}

/** Cap on the number of memory entries serialized into the semantic detector's
 * prompt — bounds cost/latency per the Risk Register. */
const MAX_CONTRADICTION_MEMORY = 20;

const VALID_CONTRADICTION_KINDS: ReadonlySet<string> = new Set<ContradictionKind>([
  "live-vs-hardrule",
  "live-vs-memory",
  "memory-vs-memory",
  "live-vs-guideline",
]);

const VALID_CONTRADICTION_SOURCES: ReadonlySet<string> = new Set<ContradictionRef["source"]>([
  "live",
  "memory",
  "hard-rule",
  "guideline",
]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set<ContradictionSeverity>([
  "warning",
  "info",
]);

const VALID_RECONCILIATION_ACTIONS: ReadonlySet<string> = new Set<ReconciliationAction>([
  "keep",
  "retire",
  "supersede",
  "promote",
]);

/**
 * The OPTIONAL, key-gated, ADVISORY semantic contradiction detector. Routes
 * through {@link chatJson} (OpenAI only — no new provider). NEVER called in
 * dry-run: with no key it returns `{ contradictions: [], dryRun: true }` WITHOUT
 * touching the client. Any failure ⇒ `{ contradictions: [], dryRun: false }`
 * (graceful, mirrors {@link analyzeReferenceForTokens}). Never throws.
 * Detection is ADVISORY — this call is fired for warnings only and its result
 * never edits any prompt or token extraction.
 */
export async function detectContradictionsLLM(opts: {
  model: string;
  liveInstruction: string;
  hardRules: { id: string; text: string }[];
  guidelines: { id: string; text: string }[];
  memory: { id: string; kind: string; body: string }[];
}): Promise<{ contradictions: Contradiction[]; dryRun: boolean }> {
  if (!hasApiKey()) {
    return { contradictions: [], dryRun: true };
  }

  const system = [
    "You are a brand-consistency reviewer. Given a live instruction, global brand rules/guidelines, and direction memory entries, detect contradictions and return ONLY a JSON object:",
    '{ "contradictions": [ { "kind": "live-vs-hardrule|live-vs-memory|memory-vs-memory|live-vs-guideline", "subject": { "source": "live|memory|hard-rule|guideline", "id": "...", "text": "..." }, "conflictsWith": { "source": "live|memory|hard-rule|guideline", "id": "...", "text": "..." }, "severity": "warning|info", "explanation": "...", "suggestions": ["keep|retire|supersede|promote"] } ] }',
    "Detect: live-vs-hardrule, live-vs-memory, and memory-vs-memory clashes. Advisory only — do NOT rewrite anything, only flag contradictions.",
    "severity: \"warning\" for hard-rule conflicts; \"info\" for memory/guideline conflicts.",
    "suggestions: \"keep\" for hard-rule conflicts (the rule always wins); \"retire\", \"supersede\", or \"promote\" for memory conflicts.",
    "Use the exact id strings provided for subject/conflictsWith ids. Only flag clear contradictions — skip ambiguous cases.",
  ].join("\n");

  const memoryCap = opts.memory.slice(0, MAX_CONTRADICTION_MEMORY);
  const user = [
    `Live instruction: ${opts.liveInstruction || "(none)"}`,
    `Hard rules: ${JSON.stringify(opts.hardRules)}`,
    `Guidelines: ${JSON.stringify(opts.guidelines)}`,
    `Memory entries (capped at ${MAX_CONTRADICTION_MEMORY}): ${JSON.stringify(memoryCap)}`,
  ].join("\n");

  try {
    const { data, dryRun } = await chatJson<{ contradictions?: unknown }>({
      model: opts.model,
      system,
      user,
    });

    if (dryRun || !data || typeof data !== "object") {
      return { contradictions: [], dryRun: dryRun ?? false };
    }

    const raw = (data as Record<string, unknown>).contradictions;
    if (!Array.isArray(raw)) {
      return { contradictions: [], dryRun: false };
    }

    // All supplied record ids for ref validation.
    const allRecordIds = new Set<string>([
      ...opts.hardRules.map((r) => r.id),
      ...opts.guidelines.map((r) => r.id),
      ...opts.memory.map((m) => m.id),
    ]);

    const contradictions: Contradiction[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;

      const kind = rec.kind;
      if (typeof kind !== "string" || !VALID_CONTRADICTION_KINDS.has(kind)) continue;

      const subject = rec.subject;
      if (!subject || typeof subject !== "object") continue;
      const subRec = subject as Record<string, unknown>;
      const subSource = subRec.source;
      if (typeof subSource !== "string" || !VALID_CONTRADICTION_SOURCES.has(subSource)) continue;
      const subId = subRec.id;
      if (typeof subId !== "string") continue;
      const subText = subRec.text;
      if (typeof subText !== "string") continue;

      const conflicts = rec.conflictsWith;
      if (!conflicts || typeof conflicts !== "object") continue;
      const cfRec = conflicts as Record<string, unknown>;
      const cfSource = cfRec.source;
      if (typeof cfSource !== "string" || !VALID_CONTRADICTION_SOURCES.has(cfSource)) continue;
      const cfId = cfRec.id;
      if (typeof cfId !== "string") continue;
      const cfText = cfRec.text;
      if (typeof cfText !== "string") continue;

      // Non-live refs must correspond to a supplied record.
      if (subSource !== "live" && !allRecordIds.has(subId)) continue;
      if (cfSource !== "live" && !allRecordIds.has(cfId)) continue;

      const severity = rec.severity;
      if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity)) continue;

      const explanationRaw = rec.explanation;
      const explanation =
        typeof explanationRaw === "string" ? explanationRaw : "";

      const suggestionsRaw = rec.suggestions;
      const suggestions: ReconciliationAction[] = Array.isArray(suggestionsRaw)
        ? (suggestionsRaw.filter(
            (s): s is string => VALID_RECONCILIATION_ACTIONS.has(s as string),
          ) as ReconciliationAction[])
        : [];

      const id = `${kind}::${subId}::${cfId}`;
      contradictions.push({
        id,
        kind: kind as ContradictionKind,
        subject: {
          source: subSource as ContradictionRef["source"],
          id: subId,
          text: subText,
        },
        conflictsWith: {
          source: cfSource as ContradictionRef["source"],
          id: cfId,
          text: cfText,
        },
        severity: severity as ContradictionSeverity,
        explanation,
        suggestions,
      });
    }

    return { contradictions, dryRun: false };
  } catch {
    // Graceful, like analyzeReferenceForTokens — a failed detection must never
    // abort a run; detection is advisory and degrades silently (SC-07).
    return { contradictions: [], dryRun: false };
  }
}

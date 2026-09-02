import type { StoreDriver } from "./store/create-store.js";

export const DEFAULT_MODELS = {
  text: "gpt-5.5",
  vision: "gpt-5.5",
  image: "gpt-image-2",
} as const;

export interface CopyExamples {
  headline: string;
  subheadline: string;
  cta: string;
}

/**
 * The SIX semantic color roles (WCAG-finished) that map 1:1 onto the --brand-*
 * CSS vars — the upper, fixed tier of the two-tier token model. There is no
 * `accent` role: emphasis colors live in the unbounded, hue-named `brand[]`
 * primitives ({@link BrandColorToken}), the lower tier, instead.
 */
export type PaletteRole =
  | "background"
  | "surface"
  | "text"
  | "muted"
  | "primary"
  | "secondary";

/** One resolved color token. `hex` is a #rrggbb string; `name` is a human label. */
export interface PaletteToken {
  role: PaletteRole;
  name: string;
  hex: string;
}

/**
 * One PRIMITIVE brand color in the unbounded `brand` set (the two-tier token
 * model's lower layer): a hue-named handle for a color the model tagged `brand`
 * (or the `primary`). `name` is a DETERMINISTIC hue slug derived from the hex
 * (e.g. "pink", "sky-blue", "pink-2") — stable across runs and used verbatim as
 * the `--brand-<name>` CSS var suffix; `label` is the model's freeform printed
 * name (e.g. "Hot Pink"), advisory provenance only (never keyed on). Unlike the
 * fixed semantic `PaletteToken[]`, this array has no cap.
 */
export interface BrandColorToken {
  hex: string;
  name: string;
  label?: string;
}

/** Color-theory harmony schemes the engine can expand a base hue into. */
export type HarmonyScheme =
  | "complementary"
  | "analogous"
  | "triadic"
  | "split-complementary"
  | "monochromatic"
  | "tetradic";

export interface TypographyTokens {
  /** A real, loadable heading family (from the fonts catalog), e.g. "Space Grotesk". */
  heading: string;
  /** A real, loadable body family (from the fonts catalog). */
  body: string;
  /** Optional modular type scale ratio (e.g. 1.25). */
  scale?: number;
}

export interface ShapeTokens {
  /** CSS length for --brand-radius, e.g. "8px". */
  radius: string;
  /** CSS length for --brand-spacing-unit, e.g. "8px". */
  spacingUnit: string;
}

/** How a palette was derived — enables deterministic reroll + provenance. */
export interface PaletteProvenance {
  baseHue: number; // 0–360
  scheme: HarmonyScheme;
  seed: number; // integer seed driving variety
  /** The #rrggbb hexes the engine held VERBATIM while finishing the palette —
   * predominantly the colors READ off the tile and mapped to roles (plus any
   * user-locked colors merged on top). NOT a record of user UI locks alone. */
  extracted: string[];
}

/**
 * Structured design tokens — the SOURCE OF TRUTH for a direction's look, and the
 * ONLY place a color hex or font family may live. TWO-TIER: the fixed semantic
 * `palette` (the six WCAG-finished {@link PaletteRole}s) is the upper tier;
 * `brand[]` the unbounded, hue-named PRIMITIVE lower tier. Optional on
 * `DirectionContent` so legacy prose-only directions still parse.
 */
export interface DirectionTokens {
  palette: PaletteToken[]; // one per PaletteRole — all six semantic roles present
  /**
   * The unbounded PRIMITIVE brand color set (two-tier model): every chromatic
   * brand color the model read — the `primary` plus the open `brand` set — as
   * hue-named handles, in prominence order. Optional/back-compat: absent on
   * legacy directions and on the keyless intent→engine fallback (which has no
   * per-color read). The semantic `palette` roles remain the stable contract;
   * `brand` is the additive lower layer that lets surplus colors survive.
   */
  brand?: BrandColorToken[];
  typography: TypographyTokens;
  shape: ShapeTokens;
  provenance?: PaletteProvenance;
}

/**
 * The EVOCATIVE character of a direction's look — structured, all-optional
 * fields replacing the freeform `visualStyle` prose. NO color hexes and NO
 * font-family names live here (those are the province of `tokens`); there is
 * simply no field to put them in — the "structure is truth" defense made
 * structural rather than a prompt-hygiene plea.
 */
export interface DirectionCharacter {
  mood?: string; // emotional tone / feeling
  composition?: string; // how elements are arranged / balanced
  layout?: string; // grid, density, structure
  imagery?: string; // illustration/photo/iconography vibe
  texture?: string; // surface qualities, grain, depth
  rhythm?: string; // pacing, repetition, motion feel
}

/**
 * IMPERATIVE usage rules that reference ROLES, never raw hexes or fonts.
 * `rules` = do-this; `antiRules` = never-do-this. Free-text strings WITHIN a
 * structured array (expression is kept; hex/font restatement is removed —
 * refer to `--brand-text` / "the darkest role", never `#111`).
 */
export interface DirectionUsage {
  rules: string[];
  antiRules: string[];
}

/**
 * The realized look/content of ONE direction version. This is today's flat
 * `VisualDirection` MINUS identity (`id`) and MINUS `lineage`, reshaped by the
 * `structured-directions` program so the on-disk shape has NO field that can
 * hold a hex or font family in prose: the freeform `visualStyle` became the
 * structured {@link DirectionCharacter}, and the `designRules`/`antiRules` string
 * blobs became the structured {@link DirectionUsage}. Color and type live ONLY in
 * `tokens`. `positioning` (strategy prose) and `copyExamples` are kept as-is.
 *
 * `tokens` remains optional so legacy prose-only content still parses and
 * `resolveBrandVars` (which throws when absent) is the single loud-fail point.
 */
export interface DirectionContent {
  name: string;
  summary: string;
  positioning: string;
  character: DirectionCharacter;
  homepageMockupPrompt: string;
  styleTilePrompt: string;
  copyExamples: CopyExamples;
  usage: DirectionUsage;
  tokens?: DirectionTokens;
}

/**
 * The AUTHORABLE subset of a {@link DirectionContent} — exactly what a host
 * agent (Cursor / Claude Code) may hand Keyart to persist as a NEW
 * Direction at v1 (the direction-level twin of an authored Brief). It is
 * `DirectionContent` MINUS `tokens`: tokens are EXTRACTED (from a style tile)
 * or engine-SEEDED (from soft intent + verbatim memory color-locks), NEVER
 * hand-authored (data-model law 3). `positioning` and the two image prompts
 * are OPTIONAL — the create core composes prompts deterministically when
 * omitted. There is deliberately NO `tokens` field here (the Zod parser also
 * rejects a `tokens` key at runtime); `character`/`usage` are free-text
 * containers whose hex/font hygiene is enforced by the runtime
 * `assertNoHexOrFontInProse` guard (NOT by the type — the string fields are
 * unrestricted at the type level).
 */
export interface AuthoredDirectionContent {
  name: string;
  summary: string;
  positioning?: string;
  character: DirectionCharacter; // required key; may be `{}`
  usage: DirectionUsage; // required key; rules/antiRules may be []
  copyExamples: CopyExamples;
  styleTilePrompt?: string;
  homepageMockupPrompt?: string;
}

/**
 * One immutable version in a direction's history. v1 = explore seed; the last
 * element of {@link Direction.versions} is the working head. Carries its own
 * frozen provenance (was Run-level): the brief + assembled-context text that
 * produced it.
 */
export interface DirectionVersion extends DirectionContent {
  id: string; // versionId (timestamp label, collision-safe)
  createdAt: string; // ISO 8601
  producedBy?: string; // the feedback/tweak that created this version (provenance)
  briefSnapshot: string; // frozen brief text at generation time
  contextSnapshot: string; // frozen assembled-context block at generation time
}

/**
 * A direction: stable identity + an ordered version history. NOTHING else lives
 * on the identity — all content is on the versions (`versions[length-1]` is the
 * head).
 */
export interface Direction {
  id: string;
  versions: DirectionVersion[];
}

export interface KeyartConfig {
  project: { name: string; type: string; framework: string };
  brand: {
    root: string;
    references: string;
    approved: string;
    rejected: string;
    directions?: string; // OPTIONAL — default "<brand.root>/directions"
    global?: string; // OPTIONAL — default "<brand.root>/brand.yaml"
    surface?: string; // OPTIONAL — default "<brand.root>/surface.yaml"
  };
  models: {
    text: string;
    vision: string;
    image: string;
    /** Optional OpenAI-compatible endpoint (Azure OpenAI, OpenRouter, a local
     * server). Unset ⇒ the SDK default, which itself honors `OPENAI_BASE_URL`. */
    baseURL?: string;
  };
  outputs: {
    cursorRules: string;
    cssVars: string;
    implementationBrief: string;
    binding?: string; // OPTIONAL — default "<brand.root>/generated/binding.json"
  };
  store?: { driver: StoreDriver }; // OPTIONAL — default { driver: "file" }
  scan?: ScanConfig; // OPTIONAL — absent ⇒ scan behavior identical to pre-`scan` builds
}

/** Mirrors `ScanCookieSchema` (src/config.ts) — the two-copy convention. */
export interface ScanCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

/** Mirrors `ScanConfigSchema` (src/config.ts). Optional TOP-LEVEL behavior block —
 *  NOT under `brand`, which holds paths. */
export interface ScanConfig {
  waitFor?: string;
  dismiss?: string[];
  storage?: Record<string, string>;
  cookies?: ScanCookie[];
  ignore?: string[]; // declared; consumed by a later workstream
  contentOrigins?: string[]; // declared; consumed by a later workstream
}

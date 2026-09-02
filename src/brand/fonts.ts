import type { HarmonyScheme, TypographyTokens } from "../types.js";

/**
 * A curated pairing of two real, loadable font families. The catalog is the
 * ONLY source of typographic tokens — the model selects a pairing (or supplies
 * raw family names that `snapFontFamilies` snaps to the nearest catalog entry),
 * so a font name is never hallucinated into a generated artifact.
 */
export interface FontPairing {
  id: string; // kebab-case, e.g. "grotesk-inter"
  label: string; // human label, e.g. "Space Grotesk + Inter"
  heading: string; // real family name usable in font-family, e.g. "Space Grotesk"
  body: string; // real family name
  /** Free-text mood tags the model matches intent against (e.g. ["bold","modern"]). */
  tags: string[];
}

/**
 * Curated real, commonly-available (Google Fonts) pairings. All family names
 * are genuine and loadable — do NOT add invented families here. The first
 * entry is the deterministic default returned for unknown/absent input.
 */
export const FONT_PAIRINGS: FontPairing[] = [
  {
    id: "grotesk-inter",
    label: "Space Grotesk + Inter",
    heading: "Space Grotesk",
    body: "Inter",
    tags: ["bold", "modern", "geometric", "tech"],
  },
  {
    id: "playfair-source-sans",
    label: "Playfair Display + Source Sans 3",
    heading: "Playfair Display",
    body: "Source Sans 3",
    tags: ["elegant", "refined", "editorial", "serif", "premium"],
  },
  {
    id: "dm-sans-inter",
    label: "DM Sans + Inter",
    heading: "DM Sans",
    body: "Inter",
    tags: ["friendly", "warm", "approachable", "rounded", "clean"],
  },
  {
    id: "fraunces-nunito-sans",
    label: "Fraunces + Nunito Sans",
    heading: "Fraunces",
    body: "Nunito Sans",
    tags: ["warm", "organic", "characterful", "soft", "editorial"],
  },
  {
    id: "libre-franklin-lora",
    label: "Libre Franklin + Lora",
    heading: "Libre Franklin",
    body: "Lora",
    tags: ["classic", "trustworthy", "editorial", "readable"],
  },
  {
    id: "archivo-ibm-plex-sans",
    label: "Archivo + IBM Plex Sans",
    heading: "Archivo",
    body: "IBM Plex Sans",
    tags: ["industrial", "bold", "structured", "technical"],
  },
  {
    id: "poppins-work-sans",
    label: "Poppins + Work Sans",
    heading: "Poppins",
    body: "Work Sans",
    tags: ["geometric", "friendly", "modern", "rounded"],
  },
  {
    id: "cormorant-montserrat",
    label: "Cormorant Garamond + Montserrat",
    heading: "Cormorant Garamond",
    body: "Montserrat",
    tags: ["luxury", "elegant", "minimal", "serif", "fashion"],
  },
  {
    id: "space-mono-inter",
    label: "Space Mono + Inter",
    heading: "Space Mono",
    body: "Inter",
    tags: ["mono", "monospace", "technical", "code", "developer", "utilitarian"],
  },
  {
    id: "bodoni-moda-inter",
    label: "Bodoni Moda + Inter",
    heading: "Bodoni Moda",
    body: "Inter",
    tags: ["high-contrast", "serif", "editorial", "fashion", "dramatic", "elegant"],
  },
  {
    id: "baloo-nunito-sans",
    label: "Baloo 2 + Nunito Sans",
    heading: "Baloo 2",
    body: "Nunito Sans",
    tags: ["rounded", "playful", "friendly", "soft", "approachable", "bubbly"],
  },
  {
    id: "oswald-roboto",
    label: "Oswald + Roboto",
    heading: "Oswald",
    body: "Roboto",
    tags: ["condensed", "impactful", "bold", "sporty", "strong"],
  },
];

/** The deterministic default pairing returned for unknown/absent input. */
export const DEFAULT_FONT_PAIRING: FontPairing = FONT_PAIRINGS[0];

/**
 * Resolve a pairing by id. Unknown or absent ids snap to the deterministic
 * default (first catalog entry) — never invents a pairing.
 */
export function resolveFontPairing(id?: string): FontPairing {
  if (!id) return DEFAULT_FONT_PAIRING;
  const norm = id.trim().toLowerCase();
  return FONT_PAIRINGS.find((p) => p.id === norm) ?? DEFAULT_FONT_PAIRING;
}

/**
 * Map a free-text type DESCRIPTION (a vision read of a generated image's
 * heading/body vibe + an optional suggested family) to the nearest catalog
 * FontPairing. Scores each pairing by mood-tag hits (+1 each) plus explicit
 * family-name mentions (a named heading/body counts strongly, +3). NEVER
 * invents a family: unknown/garbage/empty input falls back to
 * DEFAULT_FONT_PAIRING. Pure and deterministic.
 */
export function matchDescriptionToPairing(description: string): FontPairing {
  const t = (description ?? "").toLowerCase();
  let best = DEFAULT_FONT_PAIRING;
  let bestScore = 0;
  for (const pairing of FONT_PAIRINGS) {
    let score = 0;
    for (const tag of pairing.tags) if (t.includes(tag)) score += 1;
    if (t.includes(pairing.heading.toLowerCase())) score += 3;
    if (t.includes(pairing.body.toLowerCase())) score += 3;
    if (score > bestScore) {
      bestScore = score;
      best = pairing;
    }
  }
  return best;
}

/** Normalize a family string for tolerant comparison (drop quotes/case/space). */
function normalizeFamily(family: string): string {
  return family
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** All catalog family names (heading + body), for membership checks. */
const KNOWN_FAMILIES = new Map<string, string>();
for (const p of FONT_PAIRINGS) {
  KNOWN_FAMILIES.set(normalizeFamily(p.heading), p.heading);
  KNOWN_FAMILIES.set(normalizeFamily(p.body), p.body);
}

/** Look up a catalog family by tolerant name match; undefined if off-catalog. */
export function matchKnownFamily(family?: string): string | undefined {
  if (!family) return undefined;
  return KNOWN_FAMILIES.get(normalizeFamily(family));
}

/**
 * Every canonical catalog family name (heading + body), de-duplicated and
 * ordered longest-first so a multi-word family ("Playfair Display") is always
 * matched whole before any shorter name could bite into it.
 */
const CATALOG_FAMILIES: readonly string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of FONT_PAIRINGS) {
    for (const family of [p.heading, p.body]) {
      if (seen.has(family)) continue;
      seen.add(family);
      out.push(family);
    }
  }
  return out.sort((a, b) => b.length - a.length);
})();

/** Word-boundary, case-insensitive matcher for one catalog family name. */
function catalogFamilyRe(family: string): RegExp {
  const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "gi");
}

/**
 * The canonical catalog family names present in `text`, matched
 * case-insensitively with word boundaries. First-seen (by position) order,
 * de-duplicated. Pure and deterministic; never throws.
 */
export function findCatalogFamilies(text: string): string[] {
  const found: { family: string; index: number }[] = [];
  for (const family of CATALOG_FAMILIES) {
    const match = catalogFamilyRe(family).exec(text);
    if (match) found.push({ family, index: match.index });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.family);
}

/**
 * Remove every catalog family occurrence from `text` (word-boundary,
 * case-insensitive, longest-family-first), then collapse whitespace runs and
 * trim. A specific font family is soft-brief poison — the brief carries type
 * INTENT words; families live in the catalog. Pure and deterministic.
 */
export function stripCatalogFamilies(text: string): string {
  let out = text;
  for (const family of CATALOG_FAMILIES) {
    out = out.replace(catalogFamilyRe(family), " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Map a STRUCTURED type read (a vision read of a generated tile's letterforms —
 * classification/weight/contrast/width/mood + an advisory family) to the nearest
 * catalog pairing. Composes the attributes + suggested family into one text blob
 * and delegates to the shared {@link matchDescriptionToPairing} scorer, so both
 * the free-text and structured paths rank pairings the SAME way. NEVER invents a
 * family: an empty read falls back to DEFAULT_FONT_PAIRING. Pure & deterministic.
 */
export function matchAttributesToPairing(
  attrs?: {
    classification?: string;
    weight?: string;
    contrast?: string;
    width?: string;
    mood?: string;
  },
  suggestedFamily?: string,
): FontPairing {
  const text = [
    attrs?.classification,
    attrs?.weight,
    attrs?.contrast,
    attrs?.width,
    attrs?.mood,
    suggestedFamily,
  ]
    .filter((v): v is string => !!v)
    .join(" ");
  return matchDescriptionToPairing(text);
}

/**
 * Snap an arbitrary heading/body pair to catalog typography tokens. Known
 * family names pass through verbatim; off-catalog names snap to the nearest
 * catalog pairing (the default) so an invented family is NEVER emitted.
 *
 * Policy: if either supplied family is off-catalog, we do not keep it — we fall
 * back to the default pairing so both families are guaranteed real & loadable.
 * When both are known catalog families they are honored as-is (even if they
 * come from different pairings — any two catalog families are loadable).
 */
export function snapFontFamilies(
  heading?: string,
  body?: string,
): TypographyTokens {
  const knownHeading = matchKnownFamily(heading);
  const knownBody = matchKnownFamily(body);
  if (knownHeading && knownBody) {
    return { heading: knownHeading, body: knownBody };
  }
  // If only the heading is a known catalog family, keep it and pair with the
  // default body; likewise for a known body. Otherwise fall to the default.
  if (knownHeading) {
    return { heading: knownHeading, body: DEFAULT_FONT_PAIRING.body };
  }
  if (knownBody) {
    return { heading: DEFAULT_FONT_PAIRING.heading, body: knownBody };
  }
  return {
    heading: DEFAULT_FONT_PAIRING.heading,
    body: DEFAULT_FONT_PAIRING.body,
  };
}

/** The valid harmony schemes, in a stable order. */
const KNOWN_SCHEMES: HarmonyScheme[] = [
  "complementary",
  "analogous",
  "triadic",
  "split-complementary",
  "monochromatic",
  "tetradic",
];

/**
 * Synonyms / common abbreviations mapped to a canonical scheme. Anything not
 * matched (typo, garbage, undefined) falls to `"complementary"`.
 */
const SCHEME_SYNONYMS: Record<string, HarmonyScheme> = {
  complement: "complementary",
  complementary: "complementary",
  comp: "complementary",
  opposite: "complementary",
  analogous: "analogous",
  analog: "analogous",
  analogue: "analogous",
  adjacent: "analogous",
  triadic: "triadic",
  triad: "triadic",
  tri: "triadic",
  three: "triadic",
  "split-complementary": "split-complementary",
  "split complementary": "split-complementary",
  split: "split-complementary",
  splitcomplementary: "split-complementary",
  monochromatic: "monochromatic",
  monochrome: "monochromatic",
  mono: "monochromatic",
  tetradic: "tetradic",
  tetrad: "tetradic",
  tetra: "tetradic",
  square: "tetradic",
  double: "tetradic",
};

/**
 * Snap an arbitrary/unknown scheme string to the nearest known HarmonyScheme.
 * Exact matches and known synonyms/abbreviations resolve directly; unknown
 * input defaults to `"complementary"`. Never returns an off-catalog value.
 */
export function snapToKnownScheme(raw?: string): HarmonyScheme {
  if (!raw) return "complementary";
  const norm = raw.trim().toLowerCase().replace(/_/g, "-");
  if ((KNOWN_SCHEMES as string[]).includes(norm)) {
    return norm as HarmonyScheme;
  }
  if (SCHEME_SYNONYMS[norm]) return SCHEME_SYNONYMS[norm];
  // Loose containment fallback (e.g. "triadic-ish", "use analogous please").
  for (const scheme of KNOWN_SCHEMES) {
    const stem = scheme.split("-")[0];
    if (norm.includes(scheme) || norm.includes(stem)) return scheme;
  }
  return "complementary";
}

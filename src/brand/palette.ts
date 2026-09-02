import { oklch, rgb, formatHex, clampChroma } from "culori";
import type {
  HarmonyScheme,
  PaletteRole,
  PaletteToken,
  PaletteProvenance,
} from "../types.js";

/**
 * The algorithmic, coolors.co-style palette engine. ALL color math lives here —
 * never in an LLM. Given an intent (base hue + harmony scheme + integer seed +
 * optional locked hexes) it expands the six semantic role tokens in the
 * perceptual OKLCH space, jitters them deterministically per-seed for variety,
 * honors USER-locked hexes verbatim, and auto-adjusts lightness until every ink
 * pair — `text` AND `muted`, each against `background` and `surface` — meets
 * WCAG AA (≥4.5:1). Pure & deterministic:
 * the same input always yields byte-identical output (no Date/Math.random).
 */

/** Pin a hex, optionally to a specific role. */
export interface PaletteLock {
  role?: PaletteRole;
  hex: string;
  /**
   * Where the hex came from. `"user"` (the default when absent) is the user's
   * own pin — a studio role lock, a memory color-lock, an extract reference —
   * and is honored VERBATIM: the engine never rewrites it. `"extracted"` marks a
   * hex the vision read off the generated tile (`locksFromRoledColors`); it
   * anchors the palette the same way, but the engine is still its FINISHER, so a
   * readable role that misses WCAG AA may be walked to the floor.
   */
  source?: "user" | "extracted";
}

export interface PaletteEngineInput {
  baseHue: number; // 0–360 (normalized/wrapped)
  scheme: HarmonyScheme;
  seed: number; // integer; drives deterministic variety
  locks?: PaletteLock[]; // pinned hexes (brief / hard rule / extract ref / studio)
  /** Prior-run palettes (arrays of hexes) to diverge from (anti-examples for variety). */
  antiExamples?: string[][];
}

export interface GeneratedPalette {
  palette: PaletteToken[];
  provenance: PaletteProvenance;
}

/** The six semantic roles, in canonical output order. */
const ROLE_ORDER: PaletteRole[] = [
  "primary",
  "secondary",
  "background",
  "surface",
  "text",
  "muted",
];

/**
 * Minimum WCAG AA contrast for body text against its background. Both INK roles
 * are held to it: `text` and `muted`. `muted` is projected as
 * `--brand-text-muted` and the generated guides reserve it for supporting
 * context, timestamps, and low-priority hints — that is body text, so 4.5:1
 * applies to it exactly as it does to `text`, not the 3:1 large-text allowance.
 */
const MIN_CONTRAST = 4.5;

/** The roles a ground-sitting ink role must stay legible against. */
const INK_GROUNDS = ["background", "surface"] as const;

/**
 * Secondary hue offsets (degrees from the base hue) per scheme (the first of the
 * pair is used for `secondary`; the second is retained for scheme orientation).
 * Roles with a 0-offset (complementary/monochromatic) are differentiated by
 * lightness instead of hue. The base offsets follow standard color theory:
 * complementary +180, analogous ±30, triadic ±120, split-complementary
 * 150/210, monochromatic same-hue, tetradic 0/90/180/270.
 */
const SCHEME_OFFSETS: Record<HarmonyScheme, [number, number]> = {
  complementary: [180, 180],
  analogous: [30, -30],
  triadic: [120, -120],
  "split-complementary": [150, 210],
  monochromatic: [0, 0],
  tetradic: [90, 180],
};

// ── PRNG ────────────────────────────────────────────────────────────────────

/** Deterministic mulberry32 PRNG (never Math.random — that would break purity). */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── color helpers ─────────────────────────────────────────────────────────────

function wrapHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** Smallest angular distance between two hues (0–180). */
function angularDist(a: number, b: number): number {
  const d = Math.abs(wrapHue(a) - wrapHue(b));
  return d > 180 ? 360 - d : d;
}

/** OKLCH (l 0–1, c, h 0–360) → in-gamut #rrggbb, preserving hue & lightness. */
function oklchToHex(l: number, c: number, h: number): string {
  const clamped = clampChroma(
    { mode: "oklch", l: Math.max(0, Math.min(1, l)), c: Math.max(0, c), h: wrapHue(h) },
    "oklch",
  );
  return formatHex(clamped) ?? "#000000";
}

/** OKLCH hue of a hex, or undefined for achromatic (gray) colors. */
function hueOf(hex: string): number | undefined {
  const c = oklch(hex);
  return c && typeof c.h === "number" ? c.h : undefined;
}

/** Canonical lowercase 6-digit hex (e.g. "#FF5722" → "#ff5722", "#f52" → "#ff5522"). */
function normalizeHex(hex: string): string {
  const parsed = rgb(hex);
  return parsed ? (formatHex(parsed) ?? hex.toLowerCase()) : hex.toLowerCase();
}

/**
 * WCAG relative-luminance contrast ratio (1..21) between two hexes. Implements
 * the standard sRGB linearization + luminance formula directly so the values
 * are exact (`#000`↔`#fff` = 21, identical colors = 1).
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Deterministically adjust `hex` until it meets WCAG AA (>= 4.5:1) against
 * `against`, preserving hue/chroma and walking OKLCH lightness in 0.02 steps
 * (the enforceContrast idiom). Direction: darken when pure black would pass
 * against `against`, else lighten — one of the two always terminates at AA
 * (black passes for any `against` with relative luminance >= 0.175; white for
 * <= 0.1833; the ranges overlap). Already-passing input is returned normalized
 * unchanged. PURE — no Date, no Math.random; same input, same output.
 */
export function ensureContrastAA(hex: string, against: string): string {
  const normalized = normalizeHex(hex);
  if (contrastRatio(normalized, against) >= MIN_CONTRAST) {
    return normalized;
  }
  const darken = contrastRatio("#000000", against) >= MIN_CONTRAST;
  const parsed = oklch(normalized);
  const c = parsed?.c ?? 0;
  const h = parsed && typeof parsed.h === "number" ? parsed.h : 0;

  let level = parsed?.l ?? 0.5;
  let guard = 0;
  while (
    guard++ < 80 &&
    (darken ? level > 0 : level < 1) &&
    contrastRatio(oklchToHex(level, c, h), against) < MIN_CONTRAST
  ) {
    level = darken ? Math.max(0, level - 0.02) : Math.min(1, level + 0.02);
  }
  return oklchToHex(level, c, h);
}

function relativeLuminance(hex: string): number {
  const c = rgb(hex);
  if (!c) return 0;
  const lin = (v: number): number =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

// ── internal role model ───────────────────────────────────────────────────────

/**
 * A role during assembly: either generated (mutable OKLCH) or locked (fixed hex).
 *
 * `locked` means "emit this exact hex rather than recomposing from l/c/h".
 * `verbatim` is the stronger, separate claim: the USER pinned it, so the engine
 * must never adjust it. Every user lock is both; a lock READ off the tile is
 * `locked` but not `verbatim`, because finishing the read is the engine's job.
 */
interface RoleColor {
  l: number;
  c: number;
  h: number;
  locked: boolean;
  verbatim: boolean;
  hex?: string; // set only when locked
}

function hexOf(role: RoleColor): string {
  return role.locked && role.hex ? role.hex : oklchToHex(role.l, role.c, role.h);
}

/** True when `role` misses AA against ANY of the grounds it may be drawn on. */
function failsAA(role: RoleColor, grounds: RoleColor[]): boolean {
  return grounds.some(
    (ground) => contrastRatio(hexOf(role), hexOf(ground)) < MIN_CONTRAST,
  );
}

/**
 * Release a non-verbatim lock so its lightness can be walked. The read hex stays
 * the starting point (l/c/h were parsed from it); only the pin is dropped.
 */
function unpin(role: RoleColor): void {
  role.locked = false;
  role.hex = undefined;
}

function jitter(rng: () => number, range: number): number {
  return (rng() * 2 - 1) * range;
}

// ── engine ────────────────────────────────────────────────────────────────────

/**
 * Expand intent into all six role tokens: harmony in OKLCH, per-seed jitter
 * for variety, USER-locked hexes honored verbatim, WCAG-fixed ink contrast
 * (`text` and `muted`).
 */
export function generatePalette(input: PaletteEngineInput): GeneratedPalette {
  const rng = mulberry32(input.seed);
  const locks = input.locks ?? [];

  // Anchor the palette around a locked primary (or the first role-less lock) so
  // complements build around it; otherwise use the requested base hue.
  const anchorLock =
    locks.find((l) => l.role === "primary") ?? locks.find((l) => !l.role);
  let baseHue = wrapHue(input.baseHue);
  if (anchorLock) {
    const lh = hueOf(anchorLock.hex);
    if (lh !== undefined) baseHue = lh;
  } else if (input.antiExamples && input.antiExamples.length > 0) {
    // Best-effort: nudge away from hues already used by prior runs.
    baseHue = nudgeAwayFrom(baseHue, input.antiExamples);
  }

  // Seed-driven offset orientation: some schemes offer a mirrored pair; flip it
  // deterministically so different seeds explore both orientations.
  const [offA, offB] = SCHEME_OFFSETS[input.scheme];
  const flip = rng() < 0.5;
  const secOff = flip ? offB : offA;

  const roles: Record<PaletteRole, RoleColor> = {
    primary: gen(0.58 + jitter(rng, 0.04), 0.16 + jitter(rng, 0.03), baseHue),
    secondary: gen(0.52 + jitter(rng, 0.04), 0.13 + jitter(rng, 0.03), baseHue + secOff),
    background: gen(0.97 + jitter(rng, 0.015), 0.015 + jitter(rng, 0.008), baseHue),
    surface: gen(0.93 + jitter(rng, 0.02), 0.025 + jitter(rng, 0.01), baseHue),
    text: gen(0.22 + jitter(rng, 0.02), 0.03, baseHue),
    muted: gen(0.56 + jitter(rng, 0.03), 0.04 + jitter(rng, 0.02), baseHue),
  };

  // Apply locks verbatim (assigned to their role, else the nearest one).
  const normalizedLocks: string[] = [];
  for (const lock of locks) {
    const hex = normalizeHex(lock.hex);
    normalizedLocks.push(hex);
    const role = lock.role ?? nearestRole(roles, hex);
    const parsed = oklch(hex);
    roles[role] = {
      l: parsed?.l ?? 0.5,
      c: parsed?.c ?? 0,
      h: parsed && typeof parsed.h === "number" ? parsed.h : baseHue,
      locked: true,
      // A user pin is untouchable; a hex read off the tile still passes through
      // the finisher (see PaletteLock.source).
      verbatim: lock.source !== "extracted",
      hex,
    };
  }

  // Neutrals must cohere with their locked NEIGHBORS, not the abstract base
  // hue: a `surface` generated at `baseHue` floats a foreign hue over a locked
  // background (e.g. a pink card on a cream canvas). Re-derive unlocked
  // surface/muted from the resolved background/text. No-op when nothing is
  // locked (everything already shares `baseHue`), so keyless output is unchanged.
  deriveNeutralsFromAnchors(roles, rng);

  enforceContrast(roles);

  const palette: PaletteToken[] = ROLE_ORDER.map((role) => ({
    role,
    name: roleLabel(role),
    hex: hexOf(roles[role]),
  }));

  return {
    palette,
    provenance: {
      baseHue: Math.round(baseHue),
      scheme: input.scheme,
      seed: input.seed,
      extracted: normalizedLocks,
    },
  };
}

function gen(l: number, c: number, h: number): RoleColor {
  return { l, c, h: wrapHue(h), locked: false, verbatim: false };
}

/** Nearest role to a lock hex, by combined lightness + hue + chroma distance. */
function nearestRole(
  roles: Record<PaletteRole, RoleColor>,
  hex: string,
): PaletteRole {
  const target = oklch(hex);
  const tl = target?.l ?? 0.5;
  const tc = target?.c ?? 0;
  const th = target && typeof target.h === "number" ? target.h : 0;
  let best: PaletteRole = "primary";
  let bestScore = Infinity;
  for (const role of ROLE_ORDER) {
    const r = roles[role];
    const score =
      Math.abs(r.l - tl) * 2 + Math.abs(r.c - tc) + angularDist(r.h, th) / 180;
    if (score < bestScore) {
      bestScore = score;
      best = role;
    }
  }
  return best;
}

/** Clamp to the [0, 1] OKLCH lightness/chroma-safe range. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Make the UNLOCKED neutrals (`surface`, `muted`) key off the READ structural
 * colors instead of the abstract `baseHue`, so they read as the same material
 * as the palette the tile actually defined:
 *
 * - `surface` = a subtle raised step off the background — SAME hue, a touch
 *   less light, chroma tracking the background (never more saturated). A cream
 *   canvas gets a cream card, not a base-hue-tinted one.
 * - `muted` = faded ink on the text↔background axis — inherits the TEXT hue
 *   (reads as desaturated text), sitting partway toward the background. That
 *   45% step is a STARTING POINT for hue/chroma coherence only, not a promise of
 *   legibility — it can land close enough to the background to be unreadable,
 *   which is why {@link enforceContrast} walks `muted` back to the AA floor.
 *
 * Gated on a locked anchor: with no locks, background/text are themselves
 * generated at `baseHue`, so the defaults are already coherent and we leave
 * them (and the rng stream) untouched. Runs BEFORE {@link enforceContrast}, so
 * the new surface/muted still get AA-fixed.
 */
function deriveNeutralsFromAnchors(
  roles: Record<PaletteRole, RoleColor>,
  rng: () => number,
): void {
  const { background, text } = roles;

  if (!roles.surface.locked && background.locked) {
    roles.surface = {
      l: clamp01(background.l - 0.05 + jitter(rng, 0.015)),
      c: Math.min(background.c + 0.008, 0.04),
      h: background.h,
      locked: false,
      verbatim: false,
    };
  }

  if (!roles.muted.locked && (text.locked || background.locked)) {
    const l = text.l + (background.l - text.l) * 0.45 + jitter(rng, 0.02);
    roles.muted = {
      l: clamp01(l),
      c: Math.min(Math.max(text.c, 0.02), 0.05),
      h: text.h,
      locked: false,
      verbatim: false,
    };
  }
}

/**
 * Auto-adjust lightness (in OKLCH, never touching a hex the USER pinned) until
 * BOTH ink roles — `text` and `muted` — clear WCAG AA against `background` and
 * `surface`. Also darkens the non-locked primary/secondary against the
 * background as a best-effort so they remain legible when used as text-on-color.
 */
function enforceContrast(roles: Record<PaletteRole, RoleColor>): void {
  const { text, background, surface } = roles;
  const grounds = INK_GROUNDS.map((role) => roles[role]);

  if (!text.locked) {
    // Darken text toward black until both background pairs pass.
    let guard = 0;
    while (
      guard++ < 80 &&
      text.l > 0 &&
      (contrastRatio(hexOf(text), hexOf(background)) < MIN_CONTRAST ||
        contrastRatio(hexOf(text), hexOf(surface)) < MIN_CONTRAST)
    ) {
      text.l = Math.max(0, text.l - 0.02);
    }
  } else {
    // Text is locked — lighten the non-locked background/surface instead.
    for (const r of [background, surface]) {
      if (r.locked) continue;
      let guard = 0;
      while (
        guard++ < 80 &&
        r.l < 1 &&
        contrastRatio(hexOf(text), hexOf(r)) < MIN_CONTRAST
      ) {
        r.l = Math.min(1, r.l + 0.02);
        r.c = Math.max(0, r.c - 0.01);
      }
    }
  }

  // `muted` is INK, not decoration: it is projected as `--brand-text-muted` and
  // the generated guides reserve it for supporting context, timestamps, and
  // low-priority hints. Hold it to the same AA floor as `text`, against the same
  // two grounds — whether it was DERIVED (the 45% step toward the background can
  // land unreadable) or READ off the tile as a role-tagged extraction (which
  // nothing checked before). A USER lock is honored verbatim: a pinned hex is
  // the user's call everywhere else in the engine, and silently rewriting it
  // would break lock-and-rotate. Runs AFTER the block above so the grounds have
  // already settled.
  const { muted } = roles;
  if (!muted.verbatim && failsAA(muted, grounds)) {
    unpin(muted); // an extracted pin becomes walkable; its hex is the start point
    // Walk toward the ink side of the canvas: darken when pure black clears AA
    // against the background, else lighten (the `ensureContrastAA` idiom — one
    // of the two always terminates). Stopping at the FIRST passing step keeps
    // muted as faded as legibility allows, so it stays distinct from `text`.
    const darken = contrastRatio("#000000", hexOf(background)) >= MIN_CONTRAST;
    let guard = 0;
    while (
      guard++ < 80 &&
      (darken ? muted.l > 0 : muted.l < 1) &&
      failsAA(muted, grounds)
    ) {
      muted.l = darken ? Math.max(0, muted.l - 0.02) : Math.min(1, muted.l + 0.02);
    }
  }

  // Best-effort: keep primary/secondary legible on the background.
  for (const role of ["primary", "secondary"] as const) {
    const r = roles[role];
    if (r.locked) continue;
    let guard = 0;
    while (
      guard++ < 80 &&
      r.l > 0.12 &&
      contrastRatio(hexOf(r), hexOf(background)) < MIN_CONTRAST
    ) {
      r.l = Math.max(0.12, r.l - 0.02);
    }
  }
}

/** Rotate `hue` away from the nearest anti-example primary hue (best-effort). */
function nudgeAwayFrom(hue: number, antiExamples: string[][]): number {
  const antiHues: number[] = [];
  for (const palette of antiExamples) {
    if (palette.length === 0) continue;
    const h = hueOf(palette[0]);
    if (h !== undefined) antiHues.push(h);
  }
  if (antiHues.length === 0) return hue;
  let nearest = antiHues[0];
  let best = Infinity;
  for (const ah of antiHues) {
    const d = angularDist(hue, ah);
    if (d < best) {
      best = d;
      nearest = ah;
    }
  }
  if (best > 90) return hue; // already distinct — leave it.
  // Move further from the nearest used hue.
  const forward = wrapHue(hue - nearest);
  const dir = forward < 180 ? 1 : -1;
  return wrapHue(hue + dir * 40);
}

function roleLabel(role: PaletteRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Coolors-style lock-and-reroll: keep the given roles' hexes exactly, and
 * regenerate every other role around them with a new seed. Recovers the base
 * hue + scheme from `current` so the reroll stays in the same harmony family.
 */
export function rerollPalette(
  current: PaletteToken[],
  lockedRoles: PaletteRole[],
  seed: number,
): GeneratedPalette {
  const byRole = new Map(current.map((t) => [t.role, t]));
  const primary = byRole.get("primary");
  const secondary = byRole.get("secondary");

  const baseHue = (primary && hueOf(primary.hex)) ?? 220;
  const scheme = inferScheme(
    primary ? hueOf(primary.hex) : undefined,
    secondary ? hueOf(secondary.hex) : undefined,
  );

  const locks: PaletteLock[] = [];
  for (const role of lockedRoles) {
    const token = byRole.get(role);
    if (token) locks.push({ role, hex: token.hex });
  }

  return generatePalette({ baseHue, scheme, seed, locks });
}

/** Recover the harmony scheme from the primary→secondary hue delta. */
function inferScheme(
  primaryHue?: number,
  secondaryHue?: number,
): HarmonyScheme {
  if (primaryHue === undefined || secondaryHue === undefined) {
    return "complementary";
  }
  const d = angularDist(primaryHue, secondaryHue);
  const candidates: [HarmonyScheme, number][] = [
    ["monochromatic", 0],
    ["analogous", 30],
    ["tetradic", 90],
    ["triadic", 120],
    ["split-complementary", 150],
    ["complementary", 180],
  ];
  let best: HarmonyScheme = "complementary";
  let bestDelta = Infinity;
  for (const [scheme, target] of candidates) {
    const delta = Math.abs(d - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = scheme;
    }
  }
  return best;
}

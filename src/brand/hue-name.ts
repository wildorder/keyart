import { hsl, rgb, formatHex } from "culori";
import type { BrandColorToken } from "../types.js";

/**
 * Deterministic hex → human-recognizable hue name — the PRIMITIVE-layer namer of
 * the two-tier token model. Brand colors get `--brand-<name>` handles (e.g.
 * `--brand-pink`) instead of meaningless indices (`--brand-1`), so a human can
 * say "use the pink" and an agent can resolve it, while the name stays STABLE
 * across runs because it is derived from the HEX (never from the model's
 * non-deterministic printed label). Pure: no I/O, no key, no Date/Math.random.
 *
 * The family comes from the HSL hue bucket (the vocabulary people actually think
 * in for "red/orange/…/pink"); near-neutral colors name by lightness
 * (white/gray/black). Collisions within a set are disambiguated first by a
 * lightness qualifier (`pink` vs `pink-light`), then by a numeric suffix.
 */

/** Named hue families by HSL hue degrees, in the order they are tested. */
const HUE_FAMILIES: { name: string; from: number; to: number }[] = [
  { name: "red", from: 345, to: 360 },
  { name: "red", from: 0, to: 15 },
  { name: "orange", from: 15, to: 45 },
  { name: "yellow", from: 45, to: 65 },
  { name: "lime", from: 65, to: 90 },
  { name: "green", from: 90, to: 150 },
  { name: "teal", from: 150, to: 175 },
  { name: "cyan", from: 175, to: 195 },
  { name: "blue", from: 195, to: 240 },
  { name: "indigo", from: 240, to: 260 },
  { name: "violet", from: 260, to: 280 },
  { name: "purple", from: 280, to: 300 },
  { name: "magenta", from: 300, to: 330 },
  { name: "pink", from: 330, to: 345 },
];

/** Below this HSL saturation a color is treated as neutral (named by lightness). */
const NEUTRAL_SAT = 0.12;

/** Canonical lowercase 6-digit hex, or null when unparseable. */
function normHex(raw: string): string | null {
  const parsed = rgb(raw);
  return parsed ? (formatHex(parsed) ?? null) : null;
}

/**
 * The hue family (or neutral name) of a hex: "pink", "blue", "gray", … — the
 * bare, undisambiguated name. Neutral (low-saturation) colors resolve to
 * white/gray/black by lightness.
 */
export function hueFamily(hex: string): string {
  const c = hsl(hex);
  const s = c?.s ?? 0;
  const l = c?.l ?? 0.5;
  if (s < NEUTRAL_SAT || typeof c?.h !== "number") {
    if (l >= 0.9) return "white";
    if (l <= 0.12) return "black";
    return "gray";
  }
  const h = ((c.h % 360) + 360) % 360;
  for (const { name, from, to } of HUE_FAMILIES) {
    if (h >= from && h < to) return name;
  }
  return "pink"; // [345,360) rolls into red above; guard for exact 360-ish edge.
}

/** A lightness qualifier used to disambiguate same-family colors ("" when mid). */
function lightnessQualifier(hex: string): string {
  const l = hsl(hex)?.l ?? 0.5;
  if (l >= 0.66) return "light";
  if (l <= 0.4) return "dark";
  return "";
}

/**
 * Name an ordered set of brand colors into stable, unique {@link BrandColorToken}
 * handles. Unparseable hexes are dropped; case-insensitive duplicate hexes are
 * collapsed (first wins). Single-occurrence families keep the bare name; repeats
 * are disambiguated by lightness then a numeric suffix. Deterministic given the
 * same input order.
 */
export function nameBrandColors(
  colors: { hex: string; label?: string }[],
): BrandColorToken[] {
  // Normalize + dedupe first so family-count reflects the final set.
  const seen = new Set<string>();
  const normalized: { hex: string; label?: string }[] = [];
  for (const c of colors ?? []) {
    const hex = normHex(c.hex);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    normalized.push({ hex, label: c.label });
  }

  const familyCount = new Map<string, number>();
  for (const c of normalized) {
    const fam = hueFamily(c.hex);
    familyCount.set(fam, (familyCount.get(fam) ?? 0) + 1);
  }

  const used = new Set<string>();
  const out: BrandColorToken[] = [];
  for (const c of normalized) {
    const family = hueFamily(c.hex);
    let candidate = family;
    if (used.has(candidate) && (familyCount.get(family) ?? 0) > 1) {
      const qual = lightnessQualifier(c.hex);
      if (qual) candidate = `${family}-${qual}`;
    }
    let name = candidate;
    let n = 2;
    while (used.has(name)) name = `${candidate}-${n++}`;
    used.add(name);
    out.push(c.label ? { hex: c.hex, name, label: c.label } : { hex: c.hex, name });
  }
  return out;
}

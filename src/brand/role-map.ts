import { oklch, rgb, formatHex } from "culori";
import type { PaletteRole } from "../types.js";
import type { PaletteLock } from "./palette.js";

/**
 * The model-driven "role-tagged colors → semantic role locks" mapper plus the
 * OKLCH color-info helpers it shares with the palette engine. The vision read
 * assigns each color the role it PLAYS in the design (`locksFromRoledColors`);
 * this module trusts that assignment rather than guessing roles from lightness.
 * Pure and deterministic: no I/O, no key, no `Math.random`/`Date`.
 */

/** One color's OKLCH lightness / chroma / hue, alongside its canonical hex. */
export interface ColorInfo {
  hex: string;
  l: number;
  c: number;
  h: number;
}

/** Canonical lowercase 6-digit hex, or null when unparseable. */
export function normHex(raw: string): string | null {
  const parsed = rgb(raw);
  return parsed ? (formatHex(parsed) ?? null) : null;
}

/** Decompose a hex into OKLCH lightness/chroma/hue (achromatic → hue 0). */
export function colorInfo(hex: string): ColorInfo {
  const o = oklch(hex);
  return {
    hex,
    l: o?.l ?? 0.5,
    c: o?.c ?? 0,
    h: o && typeof o.h === "number" ? o.h : 0,
  };
}

/** A color the vision model tagged with the role it plays in the design. */
export interface RoledColor {
  hex: string;
  /** A universal role (`background`/`surface`/`text`/`muted`/`primary`/
   * `secondary`) or the open, repeatable `brand` bucket. Unknown strings are
   * treated as `brand`. */
  role: string;
  /** The swatch's printed name, if the model reported one — carried onto the
   * primitive `brand` tokens as advisory provenance (never keyed on). */
  label?: string;
}

/**
 * The universal, one-each roles the model reports directly (order irrelevant) —
 * the full six semantic roles (WS-02), so a vision-tagged `secondary` locks onto
 * that slot verbatim instead of being bridged up from the open `brand` queue.
 */
const UNIVERSAL_ROLES: ReadonlySet<PaletteRole> = new Set<PaletteRole>([
  "background",
  "surface",
  "text",
  "muted",
  "primary",
  "secondary",
]);

/**
 * Build engine locks from the MODEL's role assignments — the inverted spine done
 * right. This TRUSTS the role each color was tagged with when it was read off
 * the tile: `background` is whatever the model saw used as the canvas (even if
 * it is the darkest color), `text` is the actual ink, etc. Universal roles are
 * honored verbatim; every `brand` color flows into the remaining chromatic slots
 * in prominence order. Colors the model could not place fall back to `brand`.
 *
 * The model may now tag `secondary` directly (WS-02), so it locks verbatim like
 * any other universal role. The open `brand` set only BRIDGES onto whichever of
 * `primary`/`secondary` the model left untagged (in prominence order), to give
 * the engine a chromatic anchor; the FULL unbounded set is preserved separately
 * as hue-named primitives (`tokensFromRoledColors` → `nameBrandColors`), so no
 * read color is lost here. `surface`/`muted` the model did NOT report are left
 * unlocked so the palette engine finishes them.
 *
 * Every lock built here is stamped `source: "extracted"` — it came off the tile,
 * not from the user. The engine anchors on it exactly the same way, but stays
 * free to finish a READABLE role (`muted`) that misses WCAG AA, which a USER
 * lock (the caller's `opts.locks`, merged on top) is never subjected to.
 */
export function locksFromRoledColors(colors: RoledColor[]): PaletteLock[] {
  const locks: PaletteLock[] = [];
  const seen = new Set<PaletteRole>();
  const brandColors: string[] = [];

  for (const color of colors) {
    const hex = normHex(color.hex);
    if (!hex) continue;
    const role = color.role as PaletteRole;
    if (UNIVERSAL_ROLES.has(role) && !seen.has(role)) {
      seen.add(role);
      locks.push({ role, hex, source: "extracted" });
    } else {
      brandColors.push(hex);
    }
  }

  // Bridge the open `brand` set onto the current fixed token slots: fill
  // `primary` (if the model omitted it), then `secondary`, in prominence order.
  // The FULL unbounded set survives separately as hue-named primitives.
  const queue = [...brandColors];
  for (const role of ["primary", "secondary"] as PaletteRole[]) {
    if (seen.has(role)) continue;
    const hex = queue.shift();
    if (!hex) break;
    seen.add(role);
    locks.push({ role, hex, source: "extracted" });
  }

  return locks;
}

/** Smallest angular distance between two hues (0-180). */
export function hueDelta(a: number, b: number): number {
  const d = Math.abs(((a % 360) + 360) % 360 - (((b % 360) + 360) % 360));
  return d > 180 ? 360 - d : d;
}

/** Infer a harmony scheme string from the primary->secondary hue delta. */
export function inferSchemeString(locks: PaletteLock[]): string | undefined {
  const primary = locks.find((l) => l.role === "primary");
  const secondary = locks.find((l) => l.role === "secondary");
  if (!primary || !secondary) return undefined;
  const d = hueDelta(colorInfo(primary.hex).h, colorInfo(secondary.hex).h);
  if (d < 20) return "monochromatic";
  if (d < 50) return "analogous";
  if (d < 105) return "tetradic";
  if (d < 140) return "triadic";
  if (d < 165) return "split-complementary";
  return "complementary";
}

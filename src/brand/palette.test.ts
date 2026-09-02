import { describe, it, expect } from "vitest";
import { oklch } from "culori";
import {
  generatePalette,
  rerollPalette,
  contrastRatio,
  ensureContrastAA,
  type GeneratedPalette,
} from "./palette.js";
import type { PaletteRole } from "../types.js";

const ALL_ROLES: PaletteRole[] = [
  "primary",
  "secondary",
  "background",
  "surface",
  "text",
  "muted",
];

const HEX_RE = /^#[0-9a-f]{6}$/;

function byRole(p: GeneratedPalette): Record<PaletteRole, string> {
  const out = {} as Record<PaletteRole, string>;
  for (const t of p.palette) out[t.role] = t.hex;
  return out;
}

function hueOf(hex: string): number {
  const c = oklch(hex);
  return c && typeof c.h === "number" ? c.h : 0;
}

function angularDist(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

describe("generatePalette", () => {
  it("returns exactly the six roles, each a valid #rrggbb hex", () => {
    const p = generatePalette({ baseHue: 220, scheme: "complementary", seed: 1 });
    expect(p.palette.map((t) => t.role).sort()).toEqual([...ALL_ROLES].sort());
    for (const t of p.palette) {
      expect(t.hex).toMatch(HEX_RE);
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
    }
    expect(p.provenance).toMatchObject({
      baseHue: expect.any(Number),
      scheme: "complementary",
      seed: 1,
      extracted: [],
    });
  });

  it("triadic secondary hue sits ~±120° from primary", () => {
    const p = byRole(
      generatePalette({ baseHue: 30, scheme: "triadic", seed: 7 }),
    );
    const base = hueOf(p.primary);
    expect(angularDist(hueOf(p.secondary), base)).toBeGreaterThan(90);
    expect(angularDist(hueOf(p.secondary), base)).toBeLessThan(150);
  });

  it("BOTH ink roles meet WCAG AA (>=4.5) on both grounds across hues/schemes/seeds", () => {
    // `muted` is projected as `--brand-text-muted` and the guides reserve it for
    // supporting copy — it is body text, so it carries the same 4.5:1 floor as
    // `text`, not the 3:1 large-text allowance.
    const schemes = [
      "complementary",
      "analogous",
      "triadic",
      "split-complementary",
      "monochromatic",
      "tetradic",
    ] as const;
    for (const scheme of schemes) {
      for (const baseHue of [10, 90, 200, 300]) {
        for (const seed of [1, 42, 1000]) {
          const p = byRole(generatePalette({ baseHue, scheme, seed }));
          for (const ink of [p.text, p.muted]) {
            expect(contrastRatio(ink, p.background)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(ink, p.surface)).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });

  it("finishes a DERIVED muted to AA even when the anchors leave it pale", () => {
    // With background/text locked, `muted` is derived at 45% of the lightness
    // distance from text toward the background — a hue/chroma starting point
    // that lands unreadable on a pale canvas. The engine must walk it back.
    for (const seed of [0, 7, 99]) {
      const p = byRole(
        generatePalette({
          baseHue: 150,
          scheme: "analogous",
          seed,
          locks: [
            { role: "background", hex: "#f7f1e6" },
            { role: "text", hex: "#1f352d" },
          ],
        }),
      );
      expect(contrastRatio(p.muted, p.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.muted, p.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("finishes an EXTRACTED muted that fails AA, leaving every other read role verbatim", () => {
    // The docs/examples/starter-brand regression: a real keyed run whose vision
    // read tagged `muted` #b7d6b2 on a #f7f1e6 canvas — 1.41:1, a hard failure
    // that shipped as `--brand-text-muted` because nothing evaluated the role.
    expect(contrastRatio("#b7d6b2", "#f7f1e6")).toBeLessThan(1.5);

    const p = byRole(
      generatePalette({
        baseHue: 150,
        scheme: "analogous",
        seed: 0,
        locks: [
          { role: "background", hex: "#f7f1e6", source: "extracted" },
          { role: "surface", hex: "#edf1e8", source: "extracted" },
          { role: "text", hex: "#1f352d", source: "extracted" },
          { role: "muted", hex: "#b7d6b2", source: "extracted" },
          { role: "primary", hex: "#3f8a63", source: "extracted" },
          { role: "secondary", hex: "#6c8fa3", source: "extracted" },
        ],
      }),
    );

    expect(p.muted).not.toBe("#b7d6b2");
    expect(contrastRatio(p.muted, p.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.muted, p.surface)).toBeGreaterThanOrEqual(4.5);
    // It DARKENS the sprout green rather than swapping in a foreign hue, so the
    // token still reads as the palette the tile printed.
    expect(angularDist(hueOf(p.muted), hueOf("#b7d6b2"))).toBeLessThan(10);
    // Finishing one unreadable ink role never disturbs the rest of the read.
    expect(p.background).toBe("#f7f1e6");
    expect(p.surface).toBe("#edf1e8");
    expect(p.text).toBe("#1f352d");
    expect(p.primary).toBe("#3f8a63");
    expect(p.secondary).toBe("#6c8fa3");
  });

  it("leaves an already-passing extracted muted byte-identical", () => {
    // Finishing is conditional, not unconditional: a read `muted` that already
    // clears both grounds is emitted exactly as the tile printed it, so the
    // tokens still ARE the image wherever the image was already accessible.
    const p = byRole(
      generatePalette({
        baseHue: 150,
        scheme: "analogous",
        seed: 0,
        locks: [
          { role: "background", hex: "#f7f1e6", source: "extracted" },
          { role: "surface", hex: "#edf1e8", source: "extracted" },
          { role: "text", hex: "#1f352d", source: "extracted" },
          { role: "muted", hex: "#5f7263", source: "extracted" }, // 4.59 / 4.50
        ],
      }),
    );
    expect(p.muted).toBe("#5f7263");
  });

  it("honors a USER-locked muted VERBATIM even when it misses AA", () => {
    // Locks are the user's call everywhere else in the engine (lock-and-rotate
    // depends on it), so a pinned hex is never silently rewritten — only a
    // DERIVED or EXTRACTED muted is finished.
    const p = byRole(
      generatePalette({
        baseHue: 150,
        scheme: "analogous",
        seed: 0,
        locks: [
          { role: "background", hex: "#f7f1e6" },
          { role: "muted", hex: "#b7d6b2" }, // no `source` ⇒ the user pinned it
        ],
      }),
    );
    expect(p.muted).toBe("#b7d6b2");
    expect(contrastRatio(p.muted, p.background)).toBeLessThan(4.5);
  });

  it("contrastRatio is 21 for black↔white and 1 for identical colors", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#3d2c2e", "#3d2c2e")).toBeCloseTo(1, 5);
  });

  it("different seeds diverge; same input is byte-identical (pure)", () => {
    const a = generatePalette({ baseHue: 180, scheme: "analogous", seed: 1 });
    const b = generatePalette({ baseHue: 180, scheme: "analogous", seed: 2 });
    expect(a.palette).not.toEqual(b.palette);

    const a2 = generatePalette({ baseHue: 180, scheme: "analogous", seed: 1 });
    expect(a2).toEqual(a);
  });

  it("honors a locked hex verbatim and still passes text contrast", () => {
    const p = generatePalette({
      baseHue: 200,
      scheme: "complementary",
      seed: 3,
      locks: [{ role: "primary", hex: "#ff5722" }],
    });
    const roles = byRole(p);
    expect(roles.primary).toBe("#ff5722");
    expect(p.provenance.extracted).toContain("#ff5722");
    expect(contrastRatio(roles.text, roles.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(roles.text, roles.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("anti-examples nudge the output away from a used palette", () => {
    const plain = generatePalette({ baseHue: 200, scheme: "triadic", seed: 5 });
    const prior = plain.palette.map((t) => t.hex);
    const nudged = generatePalette({
      baseHue: 200,
      scheme: "triadic",
      seed: 5,
      antiExamples: [prior],
    });
    expect(nudged.palette).not.toEqual(plain.palette);
  });
});

describe("ensureContrastAA", () => {
  it("walks a failing gray pair to AA, preserving the achromatic hue family", () => {
    const result = ensureContrastAA("#888888", "#777777");
    expect(result).toMatch(HEX_RE);
    expect(contrastRatio(result, "#777777")).toBeGreaterThanOrEqual(4.5);
    const c = oklch(result);
    expect(c?.c ?? 0).toBeLessThan(0.01); // still achromatic — no hue introduced
  });

  it("returns an already-passing input unchanged (normalized)", () => {
    expect(ensureContrastAA("#000000", "#ffffff")).toBe("#000000");
    expect(ensureContrastAA("#FFFFFF", "#000000")).toBe("#ffffff");
  });

  it("is pure — same input always yields the same output", () => {
    const a = ensureContrastAA("#888888", "#777777");
    const b = ensureContrastAA("#888888", "#777777");
    expect(a).toBe(b);
  });
});

describe("rerollPalette", () => {
  it("keeps locked roles identical and changes at least one other role", () => {
    const base = generatePalette({ baseHue: 140, scheme: "triadic", seed: 1 });
    const rerolled = rerollPalette(base.palette, ["primary"], 99);
    const before = byRole(base);
    const after = byRole(rerolled);
    expect(after.primary).toBe(before.primary);
    const changed = ALL_ROLES.some((r) => after[r] !== before[r]);
    expect(changed).toBe(true);
  });

  it("keeps a frozen muted verbatim — a reroll lock is a USER lock", () => {
    const base = generatePalette({
      baseHue: 150,
      scheme: "analogous",
      seed: 1,
      locks: [{ role: "background", hex: "#f7f1e6" }],
    });
    const frozen = byRole(base).muted;
    const rerolled = byRole(rerollPalette(base.palette, ["muted"], 99));
    expect(rerolled.muted).toBe(frozen);
  });
});

import { describe, it, expect } from "vitest";
import {
  normalizeIntent,
  deriveLocksFromContext,
  buildTokens,
  briefIntentToSeed,
  composeLockedColorsGuidance,
  composeNegativesBlock,
  composeContentLock,
} from "./token-intent.js";
import { DEFAULT_FONT_PAIRING, FONT_PAIRINGS } from "../brand/fonts.js";
import { contrastRatio } from "../brand/palette.js";
import { buildPlaceholderDirections, type SeedDirection } from "./placeholders.js";
import type { PaletteRole } from "../types.js";

const ALL_ROLES: PaletteRole[] = [
  "primary",
  "secondary",
  "background",
  "surface",
  "text",
  "muted",
];

describe("normalizeIntent", () => {
  it("snaps an unknown scheme to a valid HarmonyScheme", () => {
    const { scheme } = normalizeIntent({ scheme: "not-a-real-scheme" });
    expect(scheme).toBe("complementary");
    // A known synonym snaps to its canonical scheme.
    expect(normalizeIntent({ scheme: "mono" }).scheme).toBe("monochromatic");
  });

  it("snaps a missing/off-catalog fontPairingId to the default catalog pairing", () => {
    const missing = normalizeIntent({});
    expect(missing.typography.heading).toBe(DEFAULT_FONT_PAIRING.heading);
    expect(missing.typography.body).toBe(DEFAULT_FONT_PAIRING.body);

    const offCatalog = normalizeIntent({ fontPairingId: "totally-made-up" });
    expect(offCatalog.typography.heading).toBe(DEFAULT_FONT_PAIRING.heading);

    // A real catalog id is honored.
    const real = FONT_PAIRINGS[2];
    const known = normalizeIntent({ fontPairingId: real.id });
    expect(known.typography.heading).toBe(real.heading);
    expect(known.typography.body).toBe(real.body);
  });

  it("clamps/wraps an out-of-range hue and defaults a NaN hue; never throws", () => {
    expect(normalizeIntent({ baseHue: 400 }).baseHue).toBe(40); // wrapped into [0,360)
    expect(normalizeIntent({ baseHue: -20 }).baseHue).toBe(340);
    const nan = normalizeIntent({ baseHue: Number.NaN });
    expect(Number.isFinite(nan.baseHue)).toBe(true);
    expect(nan.baseHue).toBeGreaterThanOrEqual(0);
    expect(nan.baseHue).toBeLessThan(360);

    // Garbage input of every shape resolves to safe defaults without throwing.
    expect(() => normalizeIntent(undefined)).not.toThrow();
    expect(() => normalizeIntent("nonsense")).not.toThrow();
    expect(() => normalizeIntent(42)).not.toThrow();
  });

  it("defaults shape metrics, honoring explicit radius/spacingUnit", () => {
    const def = normalizeIntent({});
    expect(def.shape).toEqual({ radius: "8px", spacingUnit: "8px" });
    const custom = normalizeIntent({ radius: "16px", spacingUnit: "4px" });
    expect(custom.shape).toEqual({ radius: "16px", spacingUnit: "4px" });
  });
});

describe("deriveLocksFromContext", () => {
  it("returns hex tokens from a brief color and a hard-rule line as locks", () => {
    const block = [
      "## Non-Negotiable Global Rules (HARD)",
      "- Brand red must always be #ff0000",
      "",
      "## Brief",
      "Accent everything with #123456 for depth.",
    ].join("\n");
    const locks = deriveLocksFromContext(block);
    const hexes = locks.map((l) => l.hex);
    expect(hexes).toContain("#ff0000");
    expect(hexes).toContain("#123456");
    // Unroled — the engine anchors/assigns them.
    for (const l of locks) expect(l.role).toBeUndefined();
  });

  it("returns [] for a block with no hexes (or no block)", () => {
    expect(deriveLocksFromContext("no colors here, just words")).toEqual([]);
    expect(deriveLocksFromContext(undefined)).toEqual([]);
  });

  it("dedupes case-insensitively", () => {
    const locks = deriveLocksFromContext("#FF0000 and #ff0000 again");
    expect(locks).toHaveLength(1);
  });
});

describe("buildTokens", () => {
  it("returns six palette roles + typography + shape, recording the seed", () => {
    const tokens = buildTokens({
      raw: { baseHue: 210, scheme: "complementary", fontPairingId: "dm-sans-inter" },
      seed: 7,
    });
    expect(tokens.palette).toHaveLength(6);
    expect(tokens.palette.map((t) => t.role)).toEqual(ALL_ROLES);
    expect(tokens.typography.heading).toBe("DM Sans");
    expect(tokens.shape.radius).toBe("8px");
    expect(tokens.provenance?.seed).toBe(7);
  });

  it("preserves a lock hex verbatim in the palette", () => {
    const tokens = buildTokens({
      raw: { baseHue: 200, scheme: "analogous" },
      seed: 3,
      locks: [{ role: "primary", hex: "#ff0000" }],
    });
    const primary = tokens.palette.find((t) => t.role === "primary");
    expect(primary?.hex).toBe("#ff0000");
  });

  it("holds WCAG AA text contrast even from malformed intent", () => {
    const tokens = buildTokens({ raw: "garbage", seed: 1 });
    const text = tokens.palette.find((t) => t.role === "text")!;
    const bg = tokens.palette.find((t) => t.role === "background")!;
    expect(contrastRatio(text.hex, bg.hex)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("briefIntentToSeed", () => {
  it("maps warm color words to a warm base hue — a bias, never a lock", () => {
    const seed = briefIntentToSeed({ colorIntent: "warm earthy" });
    expect(seed.baseHue).toBeGreaterThanOrEqual(20);
    expect(seed.baseHue).toBeLessThanOrEqual(60);
    // Not a lock: no `locks` field and nothing hex-shaped in the output.
    expect(seed).not.toHaveProperty("locks");
    expect(JSON.stringify(seed)).not.toMatch(/#[0-9a-f]{3,6}/i);

    // Fed through buildTokens it SHIFTS the palette vs. the engine default hue…
    const biased = buildTokens({ raw: seed, seed: 11 });
    const plain = buildTokens({ raw: {}, seed: 11 });
    expect(biased.provenance?.baseHue).not.toBe(plain.provenance?.baseHue);

    // …but an explicit lock still OVERRIDES the bias verbatim (soft = lowest).
    const locked = buildTokens({
      raw: seed,
      seed: 11,
      locks: [{ role: "primary", hex: "#0000ff" }],
    });
    expect(locked.palette.find((t) => t.role === "primary")?.hex).toBe("#0000ff");
  });

  it("maps type words to a REAL catalog font pairing, never an invented family", () => {
    const seed = briefIntentToSeed({ typeIntent: "editorial serif" });
    expect(seed.fontPairingId).toBeDefined();
    expect(FONT_PAIRINGS.some((p) => p.id === seed.fontPairingId)).toBe(true);
    // A genuine editorial/serif match — not the geometric default pairing.
    expect(seed.fontPairingId).not.toBe(DEFAULT_FONT_PAIRING.id);
  });

  it("never leaks a hex from the intent string into a lock or color value", () => {
    const seed = briefIntentToSeed({ colorIntent: "deep #1a1a1a grounding" });
    expect(seed).not.toHaveProperty("locks");
    expect(JSON.stringify(seed)).not.toContain("#1a1a1a");
    for (const v of Object.values(seed)) {
      expect(String(v)).not.toMatch(/^#[0-9a-f]{3,6}$/i);
    }
  });

  it("is deterministic; empty/absent intent ⇒ empty bias", () => {
    expect(briefIntentToSeed({ colorIntent: "warm earthy" })).toEqual(
      briefIntentToSeed({ colorIntent: "warm earthy" }),
    );
    expect(briefIntentToSeed({})).toEqual({});
    expect(briefIntentToSeed({ colorIntent: "   ", typeIntent: "" })).toEqual({});
  });
});

describe("composeLockedColorsGuidance", () => {
  it("carries the locked hexes as SOFT guidance — no hard lock, no fonts", () => {
    const guidance = composeLockedColorsGuidance(["#ff5722"]);
    expect(guidance).not.toBeNull();
    expect(guidance!).toContain("#ff5722");
    // Soft: never forbids other colors and never names a font family.
    expect(guidance!.toLowerCase()).not.toContain("use only");
    expect(guidance!.toLowerCase()).not.toContain("only");
    expect(guidance!.toLowerCase()).not.toContain("do not introduce");
    // No catalog font family leaks into the guidance (color-only, type-free).
    const tokens = buildTokens({
      raw: { fontPairingId: "grotesk-inter" },
      seed: 5,
    });
    expect(guidance!).not.toContain(tokens.typography.heading);
    expect(guidance!).not.toContain(tokens.typography.body);
  });

  it("carries every locked hex and dedupes case-insensitively", () => {
    const guidance = composeLockedColorsGuidance([
      "#ff5722",
      "#123456",
      "#FF5722",
    ]);
    expect(guidance!).toContain("#ff5722");
    expect(guidance!).toContain("#123456");
    // The duplicate (differing only in case) appears once.
    expect(guidance!.match(/#ff5722/gi)).toHaveLength(1);
  });

  it("returns null when there are no locked colors (byte-parity append-nothing)", () => {
    expect(composeLockedColorsGuidance([])).toBeNull();
    expect(composeLockedColorsGuidance(["  ", ""])).toBeNull();
  });
});

describe("composeNegativesBlock", () => {
  it("returns null for an empty or whitespace-only list", () => {
    expect(composeNegativesBlock([])).toBeNull();
    expect(composeNegativesBlock(["  "])).toBeNull();
    expect(composeNegativesBlock(["", "   ", "\n\t"])).toBeNull();
  });

  it("renders an imperative AVOID block with each item as a bullet", () => {
    const block = composeNegativesBlock(["heavy drop shadows", "neon gradients"]);
    expect(block).not.toBeNull();
    expect(block!.startsWith("AVOID (do not use):")).toBe(true);
    expect(block).toContain("- heavy drop shadows");
    expect(block).toContain("- neon gradients");
    // Deterministic full composition.
    expect(block).toBe(
      "AVOID (do not use):\n- heavy drop shadows\n- neon gradients",
    );
  });

  it("trims items and drops blanks", () => {
    const block = composeNegativesBlock(["  garish neon  ", "  ", "clip art"]);
    expect(block).toBe("AVOID (do not use):\n- garish neon\n- clip art");
  });
});

describe("composeContentLock", () => {
  /** A valid, fully-formed direction (placeholders carry every editable field). */
  function direction(): SeedDirection {
    return buildPlaceholderDirections("A moody editorial brief.")[0];
  }

  it("projects every editable field, with copy quoted verbatim", () => {
    const d = direction();
    const lock = composeContentLock(d);

    expect(lock).toContain("CONTENT LOCK");
    expect(lock).toContain(d.name);
    expect(lock).toContain(d.summary);
    expect(lock).toContain(d.positioning);
    const characterProse = [
      d.character.mood,
      d.character.composition,
      d.character.layout,
      d.character.imagery,
      d.character.texture,
      d.character.rhythm,
    ]
      .filter(Boolean)
      .join(" ");
    expect(lock).toContain(characterProse);
    for (const r of d.usage.rules) expect(lock).toContain(`- ${r}`);
    for (const r of d.usage.antiRules) expect(lock).toContain(`- ${r}`);
    expect(lock).toContain(`Headline: "${d.copyExamples.headline}"`);
    expect(lock).toContain(`Subheadline: "${d.copyExamples.subheadline}"`);
    expect(lock).toContain(`CTA button: "${d.copyExamples.cta}"`);
    // Imperative override phrasing (its whole purpose).
    expect(lock.toLowerCase()).toContain("authoritative");
    expect(lock).toContain("MUST read EXACTLY");
  });

  it("reflects an edited headline (the reported regression)", () => {
    const d = direction();
    d.copyExamples.headline = "Fresh, fast, unforgettable";
    const lock = composeContentLock(d);
    expect(lock).toContain(`Headline: "Fresh, fast, unforgettable"`);
  });

  it("renders the character sentence + usage bullets and leaks no hex (SC-08)", () => {
    const d = direction();
    const lock = composeContentLock(d);
    // The character sentence rides on its own line…
    const characterProse = [
      d.character.mood,
      d.character.composition,
      d.character.layout,
      d.character.imagery,
      d.character.texture,
      d.character.rhythm,
    ]
      .filter(Boolean)
      .join(" ");
    expect(lock).toContain(`Character: ${characterProse}`);
    // …the usage rules/anti-rules as bullet blocks…
    expect(lock).toContain("Design rules:");
    expect(lock).toContain("Never:");
    // …and nothing hex-shaped is introduced (character/usage are hex-free).
    expect(lock).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("yields a valid, non-throwing block for an empty-field direction (SC-09)", () => {
    const d = direction();
    const empty: SeedDirection = {
      ...d,
      character: {},
      usage: { rules: [], antiRules: [] },
    };
    let lock = "";
    expect(() => {
      lock = composeContentLock(empty);
    }).not.toThrow();
    // Core framing + copy survive; the empty character/usage lines are omitted
    // rather than left dangling.
    expect(lock).toContain("CONTENT LOCK");
    expect(lock).toContain(`Headline: "${d.copyExamples.headline}"`);
    expect(lock).not.toContain("Character:");
    expect(lock).not.toContain("Design rules:");
    expect(lock).not.toContain("Never:");
  });

  it("is deterministic — same input yields byte-identical output", () => {
    const d = direction();
    expect(composeContentLock(d)).toBe(composeContentLock(d));
  });
});

import { describe, it, expect } from "vitest";
import {
  parseAuthoredDirection,
  assertNoHexOrFontInProse,
} from "./authored-direction.js";
import { CommandError } from "../errors.js";

const FULL_PAYLOAD = {
  name: "Bold & Modern",
  summary: "A strong, geometric direction for a tech startup.",
  positioning: "Market leader in data tooling",
  character: {
    mood: "confident, energetic",
    composition: "asymmetric tension with clear focal points",
    layout: "dense grid with generous breathing room",
    imagery: "abstract data viz and clean iconography",
    texture: "flat with subtle shadow depth",
    rhythm: "fast, purposeful, driven",
  },
  usage: {
    rules: ["use the primary role for all CTAs"],
    antiRules: ["never use the muted role for critical UI"],
  },
  copyExamples: {
    headline: "Data that decides",
    subheadline: "From insight to action in seconds",
    cta: "Start free trial",
  },
  styleTilePrompt:
    "Style tile with dark navy, #1A2B3C swatch label, Space Grotesk heading specimen.",
  homepageMockupPrompt:
    "Hero section with Inter typography and #FF5500 CTA button.",
};

// ── 1. Valid payload round-trips ──────────────────────────────────────────────

describe("parseAuthoredDirection — valid payloads", () => {
  it("full payload round-trips (after trimming)", () => {
    const result = parseAuthoredDirection(FULL_PAYLOAD);
    expect(result.name).toBe(FULL_PAYLOAD.name);
    expect(result.summary).toBe(FULL_PAYLOAD.summary);
    expect(result.positioning).toBe(FULL_PAYLOAD.positioning);
    expect(result.character).toEqual(FULL_PAYLOAD.character);
    expect(result.usage).toEqual(FULL_PAYLOAD.usage);
    expect(result.copyExamples).toEqual(FULL_PAYLOAD.copyExamples);
    expect(result.styleTilePrompt).toBe(FULL_PAYLOAD.styleTilePrompt);
    expect(result.homepageMockupPrompt).toBe(FULL_PAYLOAD.homepageMockupPrompt);
  });

  it("full payload passes assertNoHexOrFontInProse (hexes only in prompts)", () => {
    const result = parseAuthoredDirection(FULL_PAYLOAD);
    expect(() => assertNoHexOrFontInProse(result)).not.toThrow();
  });

  // ── 2. Minimal payload validates (SC-08) ─────────────────────────────────

  it("minimal payload validates — empty character/usage/copyExamples (SC-08)", () => {
    const minimal = {
      name: "Minimal",
      summary: "A minimal direction",
      character: {},
      usage: { rules: [], antiRules: [] },
      copyExamples: { headline: "", subheadline: "", cta: "" },
    };
    const result = parseAuthoredDirection(minimal);
    expect(result.character).toEqual({});
    expect(result.usage).toEqual({ rules: [], antiRules: [] });
    expect(result.positioning).toBeUndefined();
    expect(result.styleTilePrompt).toBeUndefined();
    expect(result.homepageMockupPrompt).toBeUndefined();
  });

  it("usage rules/antiRules absent within usage object default to []", () => {
    const result = parseAuthoredDirection({
      name: "X",
      summary: "Y",
      character: {},
      usage: {},
      copyExamples: { headline: "", subheadline: "", cta: "" },
    });
    expect(result.usage.rules).toEqual([]);
    expect(result.usage.antiRules).toEqual([]);
  });
});

// ── 3. tokens key rejected (SC-03) ───────────────────────────────────────────

describe("parseAuthoredDirection — tokens rejection (SC-03)", () => {
  it("payload with tokens key throws CommandError naming tokens and color-locks", () => {
    const payload = {
      ...FULL_PAYLOAD,
      tokens: {
        palette: [],
        typography: { heading: "Inter", body: "Inter" },
        shape: { radius: "4px", spacingUnit: "8px" },
      },
    };
    let err: unknown;
    try {
      parseAuthoredDirection(payload);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    const msg = (err as CommandError).message;
    expect(msg).toContain("tokens");
    expect(msg).toMatch(/color.lock/i);
  });
});

// ── 4. Unknown key rejected ───────────────────────────────────────────────────

describe("parseAuthoredDirection — unknown key rejection", () => {
  it("unrecognized key throws CommandError naming valid fields", () => {
    const payload = { ...FULL_PAYLOAD, visualStyle: "dark and moody" };
    let err: unknown;
    try {
      parseAuthoredDirection(payload);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    const msg = (err as CommandError).message;
    expect(msg).toContain("visualStyle");
    expect(msg).toContain("Valid fields");
  });

  it("unrecognized key 'foo' names the valid fields", () => {
    const payload = { ...FULL_PAYLOAD, foo: "bar" };
    let err: unknown;
    try {
      parseAuthoredDirection(payload);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).message).toContain("foo");
    expect((err as CommandError).message).toContain("name");
  });
});

// ── 5. Missing required field rejected ───────────────────────────────────────

describe("parseAuthoredDirection — missing required fields", () => {
  it.each([
    ["name", (p: Record<string, unknown>) => { const { name: _, ...rest } = p; return rest; }],
    ["summary", (p: Record<string, unknown>) => { const { summary: _, ...rest } = p; return rest; }],
    ["copyExamples", (p: Record<string, unknown>) => { const { copyExamples: _, ...rest } = p; return rest; }],
    ["character", (p: Record<string, unknown>) => { const { character: _, ...rest } = p; return rest; }],
    ["usage", (p: Record<string, unknown>) => { const { usage: _, ...rest } = p; return rest; }],
  ])(
    "omitting '%s' throws CommandError naming the field",
    (field, omit) => {
      const payload = omit(FULL_PAYLOAD as unknown as Record<string, unknown>);
      let err: unknown;
      try {
        parseAuthoredDirection(payload);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CommandError);
      expect((err as CommandError).message).toMatch(new RegExp(field));
    },
  );
});

// ── 6. Hex in character rejected (SC-03) ─────────────────────────────────────

describe("assertNoHexOrFontInProse — hex in character (SC-03)", () => {
  it("hex in character.mood throws naming the field and hex", () => {
    const content = parseAuthoredDirection({
      ...FULL_PAYLOAD,
      character: { ...FULL_PAYLOAD.character, mood: "warm #1a2b3c grounding" },
    });
    let err: unknown;
    try {
      assertNoHexOrFontInProse(content);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    const msg = (err as CommandError).message;
    expect(msg).toContain("character.mood");
    expect(msg).toContain("#1a2b3c");
  });

  it("#rgb short-form caught in character.texture", () => {
    const content = parseAuthoredDirection({
      ...FULL_PAYLOAD,
      character: { ...FULL_PAYLOAD.character, texture: "#abc grain" },
    });
    let err: unknown;
    try {
      assertNoHexOrFontInProse(content);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    const msg = (err as CommandError).message;
    expect(msg).toContain("character.texture");
    expect(msg).toContain("#abc");
  });
});

// ── 7. Hex in usage rejected (SC-03) ─────────────────────────────────────────

describe("assertNoHexOrFontInProse — hex in usage (SC-03)", () => {
  it("hex in usage.rules throws naming usage.rules", () => {
    const content = parseAuthoredDirection({
      ...FULL_PAYLOAD,
      usage: { rules: ["use #111 for text"], antiRules: [] },
    });
    let err: unknown;
    try {
      assertNoHexOrFontInProse(content);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).message).toContain("usage.rules");
  });
});

// ── 8. Catalog font in prose rejected (SC-03) ────────────────────────────────

describe("assertNoHexOrFontInProse — catalog font in usage (SC-03)", () => {
  it("catalog font in usage.antiRules throws naming field and family", () => {
    const content = parseAuthoredDirection({
      ...FULL_PAYLOAD,
      usage: { rules: [], antiRules: ["never use Space Grotesk for body"] },
    });
    let err: unknown;
    try {
      assertNoHexOrFontInProse(content);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    const msg = (err as CommandError).message;
    expect(msg).toContain("usage.antiRules");
    expect(msg).toContain("Space Grotesk");
  });

  it("catalog font match is case-insensitive", () => {
    const content = parseAuthoredDirection({
      ...FULL_PAYLOAD,
      usage: { rules: [], antiRules: ["never use SPACE GROTESK"] },
    });
    expect(() => assertNoHexOrFontInProse(content)).toThrow(CommandError);
  });
});

// ── 9. Hex/font allowed in prompts and copyExamples ──────────────────────────

describe("assertNoHexOrFontInProse — prompts/copyExamples not scanned", () => {
  it("hexes and fonts in styleTilePrompt/homepageMockupPrompt pass (SC-03)", () => {
    const content = parseAuthoredDirection({
      ...FULL_PAYLOAD,
      styleTilePrompt: "Include #1A2B3C swatch and Space Grotesk label",
      homepageMockupPrompt: "Use #FF5500 and Inter for body",
    });
    expect(() => assertNoHexOrFontInProse(content)).not.toThrow();
  });

  it("hexes and fonts in copyExamples pass", () => {
    const content = parseAuthoredDirection({
      ...FULL_PAYLOAD,
      copyExamples: {
        headline: "#bold Design with Inter",
        subheadline: "Space Grotesk spacing",
        cta: "Try #1 tool",
      },
    });
    expect(() => assertNoHexOrFontInProse(content)).not.toThrow();
  });

  it("empty character/usage never throws (SC-08)", () => {
    const content = parseAuthoredDirection({
      name: "Empty",
      summary: "Empty fields",
      character: {},
      usage: { rules: [], antiRules: [] },
      copyExamples: { headline: "", subheadline: "", cta: "" },
    });
    expect(() => assertNoHexOrFontInProse(content)).not.toThrow();
  });
});

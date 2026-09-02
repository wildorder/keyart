import { describe, it, expect } from "vitest";
import { z } from "zod";
import * as schema from "./schema.js";
import {
  DirectionRecordSchema,
  DirectionMemorySchema,
  AssetRefSchema,
  BrandBriefSchema,
  MemoryEntrySchema,
  parseBrandBrief,
  parseDirectionMemory,
  parseDirectionRecord,
  isAssetRetired,
} from "./schema.js";
import { CommandError } from "../errors.js";
import { isRetired } from "./reconcile.js";

const BASE_RECORD = {
  id: "warm-editorial",
  name: "Warm Editorial",
  status: "active" as const,
  version: 1,
  createdAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:00.000Z",
};

describe("DirectionRecordSchema", () => {
  it("parses a minimal valid record and defaults brief/assets/versions/head", () => {
    const parsed = DirectionRecordSchema.parse(BASE_RECORD);
    expect(parsed.brief).toEqual({
      aliases: [],
      neverCallIt: [],
      audiences: [],
      differentiateFrom: [],
      tone: [],
      values: [],
      inspirations: [],
      constraints: [],
      surfaces: [],
    });
    expect(parsed.assets).toEqual([]);
    expect(parsed.versions).toEqual([]);
    expect(parsed.head).toBeNull();
  });

  it("rejects a non-kebab id", () => {
    const result = DirectionRecordSchema.safeParse({ ...BASE_RECORD, id: "Bad_Id" });
    expect(result.success).toBe(false);
  });

  it("rejects a record missing version", () => {
    const { version: _v, ...rest } = BASE_RECORD;
    const result = DirectionRecordSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("round-trips a record with a brief and moodboard (Test 1)", () => {
    const written = DirectionRecordSchema.parse({
      ...BASE_RECORD,
      brief: { positioning: "for people who cook" },
      assets: [
        { kind: "image", path: "brand/directions/warm/assets/a.png", intent: "inspire" },
      ],
    });
    const reread = DirectionRecordSchema.parse(JSON.parse(JSON.stringify(written)));
    expect(reread).toEqual(written);
    expect(written.brief.positioning).toBe("for people who cook");
    expect(written.assets).toEqual([
      { kind: "image", path: "brand/directions/warm/assets/a.png", intent: "inspire" },
    ]);
    expect(written.versions).toEqual([]);
    expect(written.head).toBeNull();
    expect(written.version).toBe(1);
  });
});

describe("DirectionRecordSchema — draft invariant (Test 2a: z.ZodError from superRefine)", () => {
  it("head non-null with empty versions throws z.ZodError naming head and versions", () => {
    let err: unknown;
    try {
      DirectionRecordSchema.parse({ ...BASE_RECORD, versions: [], head: "v1" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(z.ZodError);
    const paths = (err as z.ZodError).issues.map((i) => i.path.join("."));
    expect(paths).toContain("head");
  });

  it("head not equal to versions' last entry throws z.ZodError naming head and versions", () => {
    let err: unknown;
    try {
      DirectionRecordSchema.parse({
        ...BASE_RECORD,
        versions: ["v1", "v2"],
        head: "v1",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(z.ZodError);
    const paths = (err as z.ZodError).issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["head", "versions"]));
  });

  it("head equal to versions' last entry parses cleanly", () => {
    const parsed = DirectionRecordSchema.parse({
      ...BASE_RECORD,
      versions: ["v1", "v2"],
      head: "v2",
    });
    expect(parsed.head).toBe("v2");
    expect(parsed.versions).toEqual(["v1", "v2"]);
  });
});

describe("parseDirectionRecord — teaching CommandError (Test 2b)", () => {
  it("converts the same two bad inputs into a CommandError, not a raw ZodError", () => {
    for (const bad of [
      { ...BASE_RECORD, versions: [], head: "v1" },
      { ...BASE_RECORD, versions: ["v1", "v2"], head: "v1" },
    ]) {
      let err: unknown;
      try {
        parseDirectionRecord(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CommandError);
      expect(err).not.toBeInstanceOf(z.ZodError);
      expect((err as CommandError).message).toMatch(/head|versions/);
    }
  });

  it("a valid record parses cleanly through parseDirectionRecord too", () => {
    const parsed = parseDirectionRecord(BASE_RECORD);
    expect(parsed.id).toBe("warm-editorial");
  });
});

describe("MemoryEntrySchema / AssetRefSchema — scope fields are gone (Test 3)", () => {
  const BASE_ENTRY = {
    id: "feedback-abc",
    kind: "feedback" as const,
    body: "Loved the serif headline",
    author: "tim",
    source: "cli",
    date: "2026-07-01T00:00:00.000Z",
  };

  it("MemoryEntrySchema drops an unknown directionId key", () => {
    const parsed = MemoryEntrySchema.parse({ ...BASE_ENTRY, directionId: "x" });
    expect("directionId" in parsed).toBe(false);
  });

  it("AssetRefSchema drops an unknown directionId key", () => {
    const parsed = AssetRefSchema.parse({
      kind: "image",
      path: "hero.png",
      directionId: "x",
    });
    expect("directionId" in parsed).toBe(false);
  });

  it("the module's export surface is exactly the live schema API", () => {
    // Positive export-surface assertion: scope helpers stayed retired and no
    // stray export can appear unnoticed.
    expect(Object.keys(schema).sort()).toEqual([
      "AssetRefSchema",
      "AudienceSchema",
      "BrandBriefSchema",
      "DIRECTION_SLUG_RE",
      "DirectionMemorySchema",
      "DirectionRecordSchema",
      "DirectionStatusSchema",
      "MemoryEntrySchema",
      "MemoryKindSchema",
      "ReferenceIntentSchema",
      "isAssetRetired",
      "parseBrandBrief",
      "parseDirectionMemory",
      "parseDirectionRecord",
    ]);
  });

  it("round-trips channel/polarity on a decision entry", () => {
    const entry = MemoryEntrySchema.parse({
      ...BASE_ENTRY,
      kind: "decision",
      channel: "visual",
      polarity: "avoid",
    });
    expect(entry.channel).toBe("visual");
    expect(entry.polarity).toBe("avoid");
  });

  it("retire marker validates; isRetired returns true", () => {
    const entry = MemoryEntrySchema.parse({
      ...BASE_ENTRY,
      retiredAt: "2026-07-13T00:00:00.000Z",
      supersededBy: "decision-xyz",
    });
    expect(isRetired(entry)).toBe(true);
  });

  it("rejects invalid channel enum value", () => {
    expect(() => MemoryEntrySchema.parse({ ...BASE_ENTRY, channel: "sound" })).toThrow();
  });
});

describe("DirectionMemorySchema", () => {
  const entry = {
    id: "feedback-abc",
    kind: "feedback",
    body: "too cold",
    author: "tim",
    source: "cli",
    date: "2026-06-30T00:00:00.000Z",
  };

  it("parses a memory doc anchored by directionId", () => {
    const parsed = DirectionMemorySchema.parse({
      directionId: "warm-editorial",
      entries: [entry],
      version: 1,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.directionId).toBe("warm-editorial");
  });

  it("rejects an entry missing attribution (author/source/date)", () => {
    for (const field of ["author", "source", "date"] as const) {
      const incomplete = { ...entry } as Record<string, unknown>;
      delete incomplete[field];
      const result = DirectionMemorySchema.safeParse({
        directionId: "warm-editorial",
        entries: [incomplete],
        version: 1,
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects an unknown kind", () => {
    const result = DirectionMemorySchema.safeParse({
      directionId: "warm-editorial",
      entries: [{ ...entry, kind: "rumor" }],
      version: 1,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("parseDirectionMemory round-trips through the teaching idiom on success", () => {
    const parsed = parseDirectionMemory({
      directionId: "warm-editorial",
      entries: [],
      version: 0,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(parsed.directionId).toBe("warm-editorial");
  });

  it("parseDirectionMemory throws CommandError (not ZodError) on a malformed doc", () => {
    let err: unknown;
    try {
      parseDirectionMemory({ directionId: "x", entries: [{ kind: "feedback" }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    expect(err).not.toBeInstanceOf(z.ZodError);
  });
});

describe("AssetRefSchema", () => {
  it("parses a path-only asset ref", () => {
    const parsed = AssetRefSchema.parse({ kind: "image", path: "assets/hero.png" });
    expect(parsed.path).toBe("assets/hero.png");
    expect(Object.keys(parsed).sort()).toEqual(["kind", "path"]);
  });

  it("rejects an unknown kind", () => {
    const result = AssetRefSchema.safeParse({ kind: "video", path: "assets/clip.mp4" });
    expect(result.success).toBe(false);
  });

  it("parses without an intent (backward-compatible default)", () => {
    const parsed = AssetRefSchema.parse({ kind: "image", path: "assets/hero.png" });
    expect(parsed.intent).toBeUndefined();
  });

  it("round-trips an explicit intent: extract", () => {
    const parsed = AssetRefSchema.parse({
      kind: "image",
      path: "assets/hero.png",
      intent: "extract",
    });
    expect(parsed.intent).toBe("extract");
  });

  it("rejects an invalid intent", () => {
    const result = AssetRefSchema.safeParse({
      kind: "image",
      path: "assets/hero.png",
      intent: "steal",
    });
    expect(result.success).toBe(false);
  });
});

describe("AssetRef retire marker", () => {
  it("round-trips a retiredAt asset and parses a legacy asset (no retiredAt) unchanged", () => {
    const retired = AssetRefSchema.parse({
      kind: "image",
      path: "assets/keep/a.png",
      retiredAt: "2026-07-20T00:00:00.000Z",
    });
    expect(retired.retiredAt).toBe("2026-07-20T00:00:00.000Z");

    const legacy = AssetRefSchema.parse({ kind: "image", path: "assets/hero.png" });
    expect(legacy.retiredAt).toBeUndefined();
    expect("retiredAt" in legacy).toBe(false);
  });

  it("isAssetRetired truth table", () => {
    expect(isAssetRetired({})).toBe(false);
    expect(isAssetRetired({ retiredAt: "" })).toBe(false);
    expect(isAssetRetired({ retiredAt: "2026-07-20T00:00:00.000Z" })).toBe(true);
  });
});

describe("BrandBriefSchema", () => {
  it("parses {} — arrays default to empty, optionals stay undefined", () => {
    const brief = BrandBriefSchema.parse({});
    expect(brief.aliases).toEqual([]);
    expect(brief.audiences).toEqual([]);
    expect(brief.oneLiner).toBeUndefined();
    expect(brief.colorIntent).toBeUndefined();
    expect(brief.otherNotes).toBeUndefined();
  });

  it("round-trips a fully-populated brief unchanged (every field, multi-audience)", () => {
    const full = {
      aliases: ["Keyart", "LS"],
      neverCallIt: ["a platform", "a design tool"],
      oneLiner: "A local creative director for AI-built prototypes.",
      audiences: [
        { who: "indie devs", context: "shipping side projects", need: "a coherent brand fast" },
        { who: "design-curious PMs" },
      ],
      problem: "AI codegen has no taste.",
      positioning: "The creative director in your repo.",
      differentiateFrom: ["Figma", "generic UI kits"],
      tone: ["warm", "confident", "editorial"],
      values: ["craft", "honesty"],
      voice: "plain, imperative, a little dry",
      colorIntent: "warm earthy, grounding dark over pure black",
      typeIntent: "humanist sans, a little editorial",
      moodImagery: "textured paper, soft studio light",
      mascot: "a small brass compass",
      inspirations: ["Stripe docs", "Linear"],
      constraints: ["WCAG AA", "loadable Google Fonts only"],
      surfaces: ["marketing site", "CLI"],
      otherNotes: "Keep it repo-local. No cloud.",
    };
    const parsed = parseBrandBrief(full);
    expect(parsed).toEqual(full);
    expect(parseBrandBrief(parsed)).toEqual(parsed);
  });

  it("requires `who` on an audience segment", () => {
    const result = BrandBriefSchema.safeParse({ audiences: [{ context: "x" }] });
    expect(result.success).toBe(false);
  });
});

describe("DIRECTION_SLUG_RE", () => {
  it("matches kebab-case only", () => {
    expect(schema.DIRECTION_SLUG_RE.test("warm-editorial")).toBe(true);
    expect(schema.DIRECTION_SLUG_RE.test("Warm_Editorial")).toBe(false);
  });
});

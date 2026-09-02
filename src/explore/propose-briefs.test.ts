import { describe, it, expect } from "vitest";
import { CommandError } from "../errors.js";
import {
  normalizeIntentValue,
  floorBrief,
  proposeDivergentBriefs,
  type ProposeBriefsAdapter,
} from "./propose-briefs.js";
import { parseBrandBrief, type BrandBrief } from "../direction/schema.js";

const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;

function compoundKeys(briefs: BrandBrief[]): string[] {
  return briefs.map(
    (b) =>
      `${normalizeIntentValue(b.positioning ?? "")} ${normalizeIntentValue(b.colorIntent ?? "")}`,
  );
}

/** All three SC-05 distinctness assertions, each under normalizeIntentValue. */
function assertDistinct(briefs: BrandBrief[], count: number): void {
  expect(new Set(compoundKeys(briefs)).size).toBe(count);
  expect(
    new Set(briefs.map((b) => normalizeIntentValue(b.colorIntent ?? ""))).size,
  ).toBe(count);
  expect(
    new Set(briefs.map((b) => normalizeIntentValue(b.positioning ?? ""))).size,
  ).toBe(count);
}

function adapterReturning(value: unknown): ProposeBriefsAdapter {
  return async () => value;
}

describe("proposeDivergentBriefs — keyless floor", () => {
  it("is honest and distinct (case 1)", async () => {
    const result = await proposeDivergentBriefs({
      seed: "a cook's app",
      context: "",
      count: 3,
    });
    expect(result.keyless).toBe(true);
    expect(result.floorCount).toBe(3);
    expect(result.briefs).toHaveLength(3);
    for (const [i, brief] of result.briefs.entries()) {
      expect(brief.otherNotes).toContain("no OPENAI_API_KEY");
      expect(brief.positioning).toMatch(new RegExp(`^Option ${i + 1} `));
    }
    assertDistinct(result.briefs, 3);
  });

  it("--from seeding proven in the floor (case 11)", async () => {
    const source = {
      directionId: "warm",
      brief: parseBrandBrief({ positioning: "cozy editorial" }),
    };
    const withSource = await proposeDivergentBriefs({
      seed: "seed text",
      context: "",
      count: 2,
      source,
    });
    for (const brief of withSource.briefs) {
      expect(brief.otherNotes).toContain("Derived from warm");
    }

    const withoutSource = await proposeDivergentBriefs({
      seed: "seed text",
      context: "",
      count: 2,
    });
    for (const brief of withoutSource.briefs) {
      expect(brief.otherNotes ?? "").not.toContain("Derived from");
    }
  });
});

describe("proposeDivergentBriefs — adapter honesty (C-1)", () => {
  it("a full keyed read returns the model's briefs (case 2)", async () => {
    const proposals = [
      { positioning: "quiet utility", colorIntent: "paper white" },
      { positioning: "loud market stall", colorIntent: "citrus punch" },
      { positioning: "night kitchen", colorIntent: "charcoal and flame" },
    ];
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 3,
      adapter: adapterReturning(proposals),
    });
    expect(result.keyless).toBe(false);
    expect(result.floorCount).toBe(0);
    expect(result.briefs.map((b) => b.positioning)).toEqual([
      "quiet utility",
      "loud market stall",
      "night kitchen",
    ]);
    for (const brief of result.briefs) {
      expect(brief.otherNotes ?? "").not.toContain("no OPENAI_API_KEY");
    }
  });

  it("empty / null / non-array keyed reads THROW (case 3)", async () => {
    for (const bad of [[], null, {}]) {
      await expect(
        proposeDivergentBriefs({
          seed: "s",
          context: "",
          count: 3,
          adapter: adapterReturning(bad),
        }),
      ).rejects.toThrow(CommandError);
    }
  });

  it("a short keyed read is a DEGRADED keyed run (case 4)", async () => {
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 3,
      adapter: adapterReturning([
        { positioning: "quiet utility", colorIntent: "paper white" },
        { positioning: "loud market stall", colorIntent: "citrus punch" },
      ]),
    });
    expect(result.keyless).toBe(false);
    expect(result.floorCount).toBe(1);
    const shortNoted = result.briefs.filter((b) =>
      (b.otherNotes ?? "").includes("model returned 2 of 3"),
    );
    expect(shortNoted).toHaveLength(1);
    // The no-key note is unreachable while an adapter is present.
    for (const brief of result.briefs) {
      expect(brief.otherNotes ?? "").not.toContain("no OPENAI_API_KEY");
    }
    assertDistinct(result.briefs, 3);
  });

  it("a thrown adapter propagates — no floor fallback (case 5)", async () => {
    await expect(
      proposeDivergentBriefs({
        seed: "s",
        context: "",
        count: 3,
        adapter: async () => {
          throw new Error("model boom");
        },
      }),
    ).rejects.toThrow("model boom");
  });
});

describe("proposeDivergentBriefs — hygiene in code (case 6)", () => {
  it("strips a hex from colorIntent and a catalog family from typeIntent (adversarial)", async () => {
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 1,
      adapter: adapterReturning([
        {
          positioning: "editorial warmth",
          colorIntent: "warm #ff5722 tones",
          typeIntent: "Playfair Display editorial",
        },
      ]),
    });
    const json = JSON.stringify(result.briefs).toLowerCase();
    expect(json).not.toContain("#ff5722");
    expect(json).not.toContain("playfair display");
    expect(result.briefs[0].colorIntent).toContain("warm");
    expect(result.briefs[0].typeIntent).toContain("editorial");
    expect(JSON.stringify(result.briefs)).not.toMatch(HEX_RE);
  });
});

describe("proposeDivergentBriefs — the three repair passes", () => {
  it("C-2 beyond the adjective list: count 8, adapter returns 8 identical proposals (case 7)", async () => {
    const identical = Array.from({ length: 8 }, () => ({
      positioning: "same place",
      colorIntent: "same color",
    }));
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 8,
      adapter: adapterReturning(identical),
    });
    assertDistinct(result.briefs, 8);
  });

  it("Replan #9 — identical colorIntent, distinct positioning: all-model (case 8a)", async () => {
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 3,
      adapter: adapterReturning([
        { positioning: "quiet utility", colorIntent: "warm earthy" },
        { positioning: "loud market stall", colorIntent: "warm earthy" },
        { positioning: "night kitchen", colorIntent: "warm earthy" },
      ]),
    });
    assertDistinct(result.briefs, 3);
    // The colorIntent pass edits only colorIntent — positionings survive.
    expect(
      result.briefs.map((b) => normalizeIntentValue(b.positioning ?? "")),
    ).toEqual(["quiet utility", "loud market stall", "night kitchen"]);
  });

  it("Replan #9 — identical colorIntent: mixed set with a floor pad (case 8b)", async () => {
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 3,
      adapter: adapterReturning([
        { positioning: "quiet utility", colorIntent: "warm earthy" },
        { positioning: "loud market stall", colorIntent: "warm earthy" },
      ]),
    });
    expect(result.floorCount).toBe(1);
    assertDistinct(result.briefs, 3);
  });

  it("Replan #13 — identical positioning, distinct colorIntent: all-model (case 9a)", async () => {
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 3,
      adapter: adapterReturning([
        { positioning: "one true place", colorIntent: "paper white" },
        { positioning: "one true place", colorIntent: "citrus punch" },
        { positioning: "one true place", colorIntent: "charcoal flame" },
      ]),
    });
    assertDistinct(result.briefs, 3);
    // The positioning pass edits only positioning — colorIntents survive.
    expect(
      result.briefs.map((b) => normalizeIntentValue(b.colorIntent ?? "")),
    ).toEqual(["paper white", "citrus punch", "charcoal flame"]);
  });

  it("Replan #13 — identical positioning: mixed set with a floor pad (case 9b)", async () => {
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 3,
      adapter: adapterReturning([
        { positioning: "one true place", colorIntent: "paper white" },
        { positioning: "one true place", colorIntent: "citrus punch" },
      ]),
    });
    expect(result.floorCount).toBe(1);
    assertDistinct(result.briefs, 3);
  });

  it("Replan #17 — case/spacing-equivalent duplicates: all-model (case 10a)", async () => {
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 2,
      adapter: adapterReturning([
        { positioning: "Bold  Editorial", colorIntent: "Warm  Earthy" },
        { positioning: "bold editorial", colorIntent: "warm earthy" },
      ]),
    });
    // A raw-string implementation passes this input unrepaired and fails here.
    assertDistinct(result.briefs, 2);
  });

  it("Replan #17 — case/spacing-equivalent duplicates: mixed (case 10b)", async () => {
    const result = await proposeDivergentBriefs({
      seed: "s",
      context: "",
      count: 3,
      adapter: adapterReturning([
        { positioning: "Bold  Editorial", colorIntent: "Warm  Earthy" },
        { positioning: "bold editorial", colorIntent: "warm earthy" },
      ]),
    });
    expect(result.floorCount).toBe(1);
    assertDistinct(result.briefs, 3);
  });
});

describe("floorBrief / normalizeIntentValue", () => {
  it("normalizeIntentValue trims, collapses whitespace, case-folds", () => {
    expect(normalizeIntentValue("  Warm   Earthy \t Tones ")).toBe(
      "warm earthy tones",
    );
  });

  it("floorBrief embeds the ordinal in BOTH fields", () => {
    const b0 = floorBrief("seed", 0, "keyless");
    const b7 = floorBrief("seed", 7, "keyless");
    expect(b0.positioning).toMatch(/^Option 1 /);
    expect(b7.positioning).toMatch(/^Option 8 /);
    expect(b0.colorIntent).toContain("(option 1)");
    expect(b7.colorIntent).toContain("(option 8)");
  });

  it("floorBrief sanitizes a hex-bearing seed out of otherNotes", () => {
    const brief = floorBrief("warm with #ff5722 accents", 0, "keyless");
    expect(brief.otherNotes).toContain("warm");
    expect(brief.otherNotes ?? "").not.toMatch(HEX_RE);
  });
});

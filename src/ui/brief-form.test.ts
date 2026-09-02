import { describe, it, expect } from "vitest";
import {
  splitTags,
  joinTags,
  hasHex,
  emptyBrief,
  cleanAudiences,
  toPatch,
  briefEquals,
} from "./brief-form.js";
import type { BrandBrief } from "./types.js";

describe("splitTags / joinTags", () => {
  it("splits a comma input into trimmed, non-empty tags and round-trips", () => {
    expect(splitTags("warm,  earthy , ,playful ")).toEqual([
      "warm",
      "earthy",
      "playful",
    ]);
    expect(splitTags("   ")).toEqual([]);
    expect(joinTags(["warm", "earthy"])).toBe("warm, earthy");
  });
});

describe("hasHex", () => {
  it("flags scalar values that carry an exact hex (the lock hint)", () => {
    expect(hasHex("warm #ff5722 earthy")).toBe(true);
    expect(hasHex("#abc")).toBe(true);
    expect(hasHex("warm, earthy")).toBe(false);
    expect(hasHex(undefined)).toBe(false);
  });
});

describe("cleanAudiences", () => {
  it("drops audiences with no `who` and trims optional suffixes", () => {
    expect(
      cleanAudiences([
        { who: "  Designers ", context: " startups ", need: "" },
        { who: "   " },
        { who: "PMs", need: "clarity" },
      ]),
    ).toEqual([
      { who: "Designers", context: "startups" },
      { who: "PMs", need: "clarity" },
    ]);
  });
});

describe("toPatch", () => {
  it("sends the whole form: arrays wholesale, scalars trimmed (empty ⇒ '')", () => {
    const form: BrandBrief = {
      ...emptyBrief(),
      oneLiner: "  cozy tools  ",
      tone: ["warm"],
      voice: "   ", // cleared scalar ⇒ ""
      audiences: [{ who: "Designers" }, { who: "" }],
    };
    const patch = toPatch(form);
    expect(patch.oneLiner).toBe("cozy tools");
    expect(patch.voice).toBe("");
    expect(patch.tone).toEqual(["warm"]);
    expect(patch.audiences).toEqual([{ who: "Designers" }]);
    // Every field is present (whole-form patch), so a cleared array/scalar clears.
    expect(Object.keys(patch)).toContain("aliases");
  });
});

describe("briefEquals", () => {
  it("ignores cosmetic whitespace but sees real field changes (dirty tracking)", () => {
    const a = emptyBrief();
    const b: BrandBrief = { ...emptyBrief(), oneLiner: "   " };
    // A whitespace-only scalar normalizes to "" — not dirty vs an absent scalar.
    expect(briefEquals(a, b)).toBe(true);

    const c: BrandBrief = { ...emptyBrief(), oneLiner: "changed" };
    expect(briefEquals(a, c)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { assertDerivedIntent } from "./derived-context.js";
import type { FoundationContext } from "./foundation.js";

const foundation = {
  directionId: "route", versionId: "v1",
  tokens: { palette: [{ hex: "#112233" }], typography: { heading: "Inter", body: "Inter" } },
} as FoundationContext;

describe("derived local intent respects frozen token facts", () => {
  it("accepts existing exact and equivalent shorthand colors", () => {
    for (const hex of ["#112233", "#123", "#123f", "#112233ff"]) {
      expect(() => assertDerivedIntent(foundation, `Use ${hex} for the frame`)).not.toThrow();
    }
  });
  it("teaches foundation revision for differing full, shorthand and alpha colors", () => {
    for (const hex of ["#456", "#445566", "#1238", "#11223380"]) {
      expect(() => assertDerivedIntent(foundation, `Use ${hex}`)).toThrow(/Revise the direction foundation/);
    }
  });
  it("rejects differing catalog family even without a font keyword", () => {
    expect(() => assertDerivedIntent(foundation, "Use Playfair Display for the headline")).toThrow(/Revise the direction foundation/);
    expect(() => assertDerivedIntent(foundation, "Set the headline in Inter")).not.toThrow();
    expect(() => assertDerivedIntent(foundation, "A winter illustration")).not.toThrow();
  });
});

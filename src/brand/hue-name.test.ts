import { describe, it, expect } from "vitest";
import { hueFamily, nameBrandColors } from "./hue-name.js";

describe("hueFamily", () => {
  it("names chromatic colors by their hue bucket", () => {
    expect(hueFamily("#ff2d8d")).toBe("pink");
    expect(hueFamily("#ff6a00")).toBe("orange");
    expect(hueFamily("#ffd600")).toBe("yellow");
    expect(hueFamily("#5ac8ff")).toBe("blue");
    expect(hueFamily("#008080")).toBe("cyan");
  });

  it("names near-neutral colors by lightness (white/gray/black)", () => {
    expect(hueFamily("#ffffff")).toBe("white");
    expect(hueFamily("#808080")).toBe("gray");
    expect(hueFamily("#111111")).toBe("black");
  });

  it("is deterministic and case-insensitive", () => {
    expect(hueFamily("#FF2D8D")).toBe(hueFamily("#ff2d8d"));
  });
});

describe("nameBrandColors", () => {
  it("names each brand color by hue and carries the model label as provenance", () => {
    const out = nameBrandColors([
      { hex: "#ff2d8d", label: "Hot Pink" },
      { hex: "#ff6a00", label: "Orange" },
      { hex: "#ffd600", label: "Lemon" },
    ]);
    expect(out).toEqual([
      { hex: "#ff2d8d", name: "pink", label: "Hot Pink" },
      { hex: "#ff6a00", name: "orange", label: "Orange" },
      { hex: "#ffd600", name: "yellow", label: "Lemon" },
    ]);
  });

  it("disambiguates same-family colors by lightness, then a numeric suffix", () => {
    const out = nameBrandColors([
      { hex: "#c71360" }, // mid pink → "pink"
      { hex: "#ffb3d1" }, // light pink → "pink-light"
      { hex: "#ff9ec9" }, // also light pink → "pink-light-2"
    ]);
    expect(out.map((c) => c.name)).toEqual(["pink", "pink-light", "pink-light-2"]);
  });

  it("disambiguates two same-lightness pinks with a bare numeric suffix (SC-05)", () => {
    // Both are mid-lightness (no light/dark qualifier applies), so the collision
    // falls straight through to a deterministic numeric suffix: pink, pink-2.
    const out = nameBrandColors([{ hex: "#cc3377" }, { hex: "#c23a74" }]);
    expect(out.map((c) => c.name)).toEqual(["pink", "pink-2"]);
  });

  it("drops unparseable hexes and collapses case-insensitive duplicates", () => {
    const out = nameBrandColors([
      { hex: "#ff2d8d" },
      { hex: "#FF2D8D" }, // dupe
      { hex: "not-a-color" },
      { hex: "#ff6a00" },
    ]);
    expect(out.map((c) => c.hex)).toEqual(["#ff2d8d", "#ff6a00"]);
    expect(out.map((c) => c.name)).toEqual(["pink", "orange"]);
  });

  it("omits label when the model reported none", () => {
    const [only] = nameBrandColors([{ hex: "#5ac8ff" }]);
    expect(only).toEqual({ hex: "#5ac8ff", name: "blue" });
  });
});

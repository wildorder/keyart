import { describe, it, expect } from "vitest";
import {
  colorInfo,
  inferSchemeString,
  locksFromRoledColors,
  normHex,
} from "./role-map.js";

describe("locksFromRoledColors", () => {
  it("honors the model's role tags verbatim (never a lightness sort)", () => {
    const locks = locksFromRoledColors([
      { hex: "#0e382e", role: "background" }, // darkest, but the canvas
      { hex: "#fff6e6", role: "text" }, // lightest, but the ink
      { hex: "#ff2d8d", role: "primary" },
    ]);
    expect(locks.find((l) => l.role === "background")?.hex).toBe("#0e382e");
    expect(locks.find((l) => l.role === "text")?.hex).toBe("#fff6e6");
    expect(locks.find((l) => l.role === "primary")?.hex).toBe("#ff2d8d");
  });

  it("locks a directly-tagged secondary verbatim; extra brand colors do NOT lock (SC-04)", () => {
    const locks = locksFromRoledColors([
      { hex: "#0e382e", role: "background" }, // dark, but tagged the canvas
      { hex: "#fff6e6", role: "text" },
      { hex: "#ff2d8d", role: "primary" },
      { hex: "#008080", role: "secondary" }, // the model tagged it directly
      { hex: "#ffc107", role: "brand" }, // surplus — stays a primitive only
    ]);
    expect(locks.find((l) => l.role === "background")?.hex).toBe("#0e382e");
    expect(locks.find((l) => l.role === "text")?.hex).toBe("#fff6e6");
    expect(locks.find((l) => l.role === "primary")?.hex).toBe("#ff2d8d");
    // Tagged `secondary` locks to secondary (not bridged, not a lightness sort).
    expect(locks.find((l) => l.role === "secondary")?.hex).toBe("#008080");
    // The extra brand color produced no lock — it survives only as a primitive.
    expect(locks.some((l) => l.hex === "#ffc107")).toBe(false);
    expect(locks).toHaveLength(4);
  });

  it("bridges the open brand set onto primary then secondary in order", () => {
    const locks = locksFromRoledColors([
      { hex: "#ff5722", role: "brand" },
      { hex: "#008080", role: "brand" },
      { hex: "#ffc107", role: "brand" },
    ]);
    expect(locks.find((l) => l.role === "primary")?.hex).toBe("#ff5722");
    expect(locks.find((l) => l.role === "secondary")?.hex).toBe("#008080");
    // No accent slot exists anymore: the third brand color remains only in the
    // unbounded brand set and produces no lock.
    expect(locks).toHaveLength(2);
    expect(locks.some((l) => l.hex === "#ffc107")).toBe(false);
  });

  it("returns no locks for an empty read", () => {
    expect(locksFromRoledColors([])).toEqual([]);
  });
});

describe("colorInfo", () => {
  it("decomposes a hex into OKLCH lightness/chroma/hue", () => {
    const info = colorInfo("#ffffff");
    expect(info.hex).toBe("#ffffff");
    expect(info.l).toBeGreaterThan(0.95);
    expect(info.c).toBeLessThan(0.01); // white is achromatic
  });
});

describe("normHex", () => {
  it("canonicalizes to lowercase #rrggbb and rejects garbage", () => {
    expect(normHex("#FF5722")).toBe("#ff5722");
    expect(normHex("#f52")).toBe("#ff5522");
    expect(normHex("not-a-color")).toBeNull();
  });
});

describe("inferSchemeString", () => {
  it("infers monochromatic when primary and secondary share a hue", () => {
    const scheme = inferSchemeString([
      { role: "primary", hex: "#3355cc" },
      { role: "secondary", hex: "#3355cc" },
    ]);
    expect(scheme).toBe("monochromatic");
  });

  it("is undefined without both primary and secondary", () => {
    expect(inferSchemeString([{ role: "primary", hex: "#3355cc" }])).toBeUndefined();
  });
});

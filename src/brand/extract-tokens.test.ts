import { describe, it, expect } from "vitest";
import { tokensFromRoledColors } from "./extract-tokens.js";
import { contrastRatio } from "./palette.js";
import type { RoledColor } from "./role-map.js";
import type { PaletteRole } from "../types.js";

const byRole = (
  tokens: { palette: { role: PaletteRole; hex: string }[] },
  role: PaletteRole,
) => tokens.palette.find((t) => t.role === role)!;

describe("tokensFromRoledColors", () => {
  // The model tagged roles by USAGE: the darkest color is the canvas, the
  // lightest is the ink — the exact inverse of a lightness sort. This is the
  // fixture that proves roles come from the read, not from OKLCH ordering.
  const ROLED: RoledColor[] = [
    { hex: "#0e382e", role: "background" }, // darkest, but the canvas
    { hex: "#fff6e6", role: "text" }, // lightest, but the ink
    { hex: "#ff2d8d", role: "primary" },
    { hex: "#ff6a00", role: "brand" },
    { hex: "#ffd600", role: "brand" },
  ];

  it("honors the model's roles verbatim instead of sorting by lightness", () => {
    const { tokens } = tokensFromRoledColors(ROLED);
    // A lightness sort would call #fff6e6 the background; the model said canvas
    // is the dark #0e382e, and we trust it.
    expect(byRole(tokens, "background").hex).toBe("#0e382e");
    expect(byRole(tokens, "text").hex).toBe("#fff6e6");
    expect(byRole(tokens, "primary").hex).toBe("#ff2d8d");
    // The open brand set bridges onto the remaining chromatic slot (secondary
    // only); further brand colors survive in the unbounded brand[] layer.
    expect(byRole(tokens, "secondary").hex).toBe("#ff6a00");
    expect(tokens.palette).toHaveLength(6);
  });

  it("preserves EVERY read color as a hue-named brand[] entry (lossless, SC-03)", () => {
    const { tokens } = tokensFromRoledColors(ROLED);
    expect(tokens.brand).toBeDefined();
    // Literal reading of "preserve every color on the tile": all N distinct read
    // colors survive in prominence order — structural roles (background/text)
    // included — hue-named + collision-disambiguated, none dropped or synthesized.
    // (The cream #fff6e6 buckets to "orange" by HSL, so the true orange #ff6a00
    // is deterministically disambiguated to "orange-2".)
    expect(tokens.brand!.map((b) => [b.name, b.hex])).toEqual([
      ["teal", "#0e382e"],
      ["orange", "#fff6e6"],
      ["pink", "#ff2d8d"],
      ["orange-2", "#ff6a00"],
      ["yellow", "#ffd600"],
    ]);
    // N distinct read colors → exactly N brand[] entries.
    expect(tokens.brand).toHaveLength(ROLED.length);
  });

  it("carries the model's label onto brand primitives", () => {
    const { tokens } = tokensFromRoledColors([
      { hex: "#ff2d8d", role: "primary", label: "Hot Pink" },
      { hex: "#5ac8ff", role: "brand", label: "Sky Blue" },
    ]);
    expect(tokens.brand).toEqual([
      { hex: "#ff2d8d", name: "pink", label: "Hot Pink" },
      { hex: "#5ac8ff", name: "blue", label: "Sky Blue" },
    ]);
  });

  it("keeps even purely structural (neutral) reads in brand[] — nothing is dropped", () => {
    // Lossless is literal: a background + text read still surface as brand[]
    // primitives (named by lightness), so no color the tile printed is lost.
    const { tokens } = tokensFromRoledColors([
      { hex: "#ffffff", role: "background" },
      { hex: "#111111", role: "text" },
    ]);
    expect(tokens.brand).toEqual([
      { hex: "#ffffff", name: "white" },
      { hex: "#111111", name: "black" },
    ]);
  });

  it("is deterministic and records the read hexes as provenance palette", () => {
    const a = tokensFromRoledColors(ROLED);
    const b = tokensFromRoledColors(ROLED);
    expect(JSON.stringify(a.tokens)).toBe(JSON.stringify(b.tokens));
    expect(a.palette).toEqual([
      "#0e382e",
      "#fff6e6",
      "#ff2d8d",
      "#ff6a00",
      "#ffd600",
    ]);
  });

  it("promotes the first brand color to primary when the model omits one", () => {
    const { tokens } = tokensFromRoledColors([
      { hex: "#ffffff", role: "background" },
      { hex: "#111111", role: "text" },
      { hex: "#ff5722", role: "brand" },
      { hex: "#008080", role: "brand" },
    ]);
    expect(byRole(tokens, "primary").hex).toBe("#ff5722");
    expect(byRole(tokens, "secondary").hex).toBe("#008080");
  });

  it("a user lock still wins over the model's role assignment (SC-06)", () => {
    const { tokens } = tokensFromRoledColors(ROLED, {
      locks: [{ role: "primary", hex: "#123456" }],
    });
    expect(byRole(tokens, "primary").hex).toBe("#123456");
    expect(byRole(tokens, "background").hex).toBe("#0e382e");
  });

  it("falls back to engine defaults around the locks on an empty read", () => {
    const result = tokensFromRoledColors([], {
      locks: [{ role: "primary", hex: "#ff0000" }],
    });
    expect(result.tokens.palette).toHaveLength(6);
    expect(result.palette).toEqual([]);
    expect(byRole(result.tokens, "primary").hex).toBe("#ff0000");
    // An empty read carries no brand[] primitives (SC-09).
    expect(result.tokens.brand).toBeUndefined();
  });

  it("AA-finishes a role-tagged muted the read placed on top of the canvas", () => {
    // The docs/examples/starter-brand read, verbatim: the model tagged the pale
    // sprout green as `muted`, and it shipped into `--brand-text-muted` at
    // 1.41:1 on the paper canvas. A tagged role is trusted for PLACEMENT; the
    // engine is still its finisher, and `muted` is ink.
    const { tokens } = tokensFromRoledColors([
      { hex: "#f7f1e6", role: "background", label: "Paper Base" },
      { hex: "#1f352d", role: "text", label: "Deep Canopy" },
      { hex: "#3f8a63", role: "primary", label: "Growth Primary" },
      { hex: "#edf1e8", role: "surface", label: "Cloud Surface" },
      { hex: "#b7d6b2", role: "muted", label: "Soft Sprout" },
      { hex: "#6c8fa3", role: "secondary", label: "Calm Info" },
      { hex: "#d28b55", role: "brand", label: "Signal Accent" },
    ]);

    const muted = byRole(tokens, "muted").hex;
    const background = byRole(tokens, "background").hex;
    const surface = byRole(tokens, "surface").hex;
    expect(muted).not.toBe("#b7d6b2");
    expect(contrastRatio(muted, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(4.5);

    // Every other tagged role still lands verbatim — only the unreadable ink
    // role moved.
    expect(background).toBe("#f7f1e6");
    expect(surface).toBe("#edf1e8");
    expect(byRole(tokens, "text").hex).toBe("#1f352d");
    expect(byRole(tokens, "primary").hex).toBe("#3f8a63");
    expect(byRole(tokens, "secondary").hex).toBe("#6c8fa3");

    // The lossless primitive layer is untouched: it records what the tile
    // PRINTED (including the original #b7d6b2), which the finisher never edits.
    expect(tokens.brand!.map((b) => b.hex)).toEqual([
      "#f7f1e6",
      "#1f352d",
      "#3f8a63",
      "#edf1e8",
      "#b7d6b2",
      "#6c8fa3",
      "#d28b55",
    ]);
  });

  it("a USER-locked muted outranks the finisher (SC-06 locks are verbatim)", () => {
    const { tokens } = tokensFromRoledColors(
      [
        { hex: "#f7f1e6", role: "background" },
        { hex: "#1f352d", role: "text" },
        { hex: "#b7d6b2", role: "muted" },
      ],
      { locks: [{ role: "muted", hex: "#b7d6b2" }] },
    );
    expect(byRole(tokens, "muted").hex).toBe("#b7d6b2");
  });

  it("locks a directly-tagged secondary onto the secondary role (WS-02)", () => {
    // The model may now tag a `secondary` directly; it locks verbatim instead of
    // being bridged from the open `brand` queue.
    const { tokens } = tokensFromRoledColors([
      { hex: "#0e382e", role: "background" },
      { hex: "#fff6e6", role: "text" },
      { hex: "#ff2d8d", role: "primary" },
      { hex: "#008080", role: "secondary" },
    ]);
    expect(byRole(tokens, "primary").hex).toBe("#ff2d8d");
    expect(byRole(tokens, "secondary").hex).toBe("#008080");
  });
});

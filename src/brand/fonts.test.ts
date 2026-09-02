import { describe, it, expect } from "vitest";
import {
  FONT_PAIRINGS,
  DEFAULT_FONT_PAIRING,
  resolveFontPairing,
  matchDescriptionToPairing,
  snapFontFamilies,
  snapToKnownScheme,
  findCatalogFamilies,
  stripCatalogFamilies,
} from "./fonts.js";
import type { HarmonyScheme } from "../types.js";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VALID_SCHEMES: HarmonyScheme[] = [
  "complementary",
  "analogous",
  "triadic",
  "split-complementary",
  "monochromatic",
  "tetradic",
];

describe("FONT_PAIRINGS catalog", () => {
  it("has >= 6 pairings with valid, unique kebab-case ids and real families", () => {
    expect(FONT_PAIRINGS.length).toBeGreaterThanOrEqual(6);
    const ids = new Set<string>();
    for (const p of FONT_PAIRINGS) {
      expect(p.id).toMatch(KEBAB_RE);
      expect(p.heading.trim().length).toBeGreaterThan(0);
      expect(p.body.trim().length).toBeGreaterThan(0);
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
    }
    expect(ids.size).toBe(FONT_PAIRINGS.length);
  });
});

describe("matchDescriptionToPairing", () => {
  const catalogFamilies = FONT_PAIRINGS.flatMap((p) => [p.heading, p.body]);

  it("maps a described vibe to a matching catalog pairing (not the default)", () => {
    const pairing = matchDescriptionToPairing("elegant editorial serif headings");
    expect(FONT_PAIRINGS.map((p) => p.id)).toContain(pairing.id);
    expect(pairing.id).not.toBe(DEFAULT_FONT_PAIRING.id);
    expect(pairing.tags).toContain("serif");
  });

  it("honors an explicitly named real family", () => {
    const pairing = matchDescriptionToPairing("headings uses Space Grotesk throughout");
    expect(pairing.heading).toBe("Space Grotesk");
  });

  it("snaps empty/garbage input to the loadable default, never inventing a family", () => {
    for (const desc of ["", "asdf qwerty zzz"]) {
      const pairing = matchDescriptionToPairing(desc);
      expect(pairing).toEqual(DEFAULT_FONT_PAIRING);
      expect(catalogFamilies).toContain(pairing.heading);
      expect(catalogFamilies).toContain(pairing.body);
    }
  });
});

describe("resolveFontPairing", () => {
  it("returns the deterministic default for undefined and unknown ids", () => {
    expect(resolveFontPairing(undefined)).toEqual(DEFAULT_FONT_PAIRING);
    expect(resolveFontPairing("nope")).toEqual(DEFAULT_FONT_PAIRING);
    expect(DEFAULT_FONT_PAIRING).toEqual(FONT_PAIRINGS[0]);
  });

  it("round-trips a known id", () => {
    const known = FONT_PAIRINGS[2];
    expect(resolveFontPairing(known.id)).toEqual(known);
    // Case/space tolerant.
    expect(resolveFontPairing(`  ${known.id.toUpperCase()} `)).toEqual(known);
  });
});

describe("snapToKnownScheme", () => {
  it("snaps synonyms/abbreviations/garbage to a valid scheme, defaulting to complementary", () => {
    expect(snapToKnownScheme("complement")).toBe("complementary");
    expect(snapToKnownScheme("tri")).toBe("triadic");
    expect(snapToKnownScheme(undefined)).toBe("complementary");
    expect(snapToKnownScheme("garbage")).toBe("complementary");
    expect(snapToKnownScheme("mono")).toBe("monochromatic");
    expect(snapToKnownScheme("split complementary")).toBe("split-complementary");
    for (const s of VALID_SCHEMES) {
      expect(snapToKnownScheme(s)).toBe(s);
    }
  });
});

describe("snapFontFamilies", () => {
  it("keeps two known catalog families verbatim", () => {
    const t = snapFontFamilies("Space Grotesk", "Inter");
    expect(t.heading).toBe("Space Grotesk");
    expect(t.body).toBe("Inter");
  });

  it("never returns an off-catalog family — unknown names snap to the catalog", () => {
    const t = snapFontFamilies("Totally Fake Font", "Also Invented Sans");
    expect(t.heading).toBe(DEFAULT_FONT_PAIRING.heading);
    expect(t.body).toBe(DEFAULT_FONT_PAIRING.body);
    expect(t.heading).not.toBe("Totally Fake Font");
    expect(t.body).not.toBe("Also Invented Sans");
  });

  it("keeps a known side and snaps the unknown side", () => {
    const t = snapFontFamilies("Playfair Display", "Invented Body");
    expect(t.heading).toBe("Playfair Display");
    expect(t.body).toBe(DEFAULT_FONT_PAIRING.body);
  });
});

describe("findCatalogFamilies / stripCatalogFamilies", () => {
  it("strips a multi-word family whole while keeping the surrounding intent words", () => {
    const out = stripCatalogFamilies("Playfair Display, warm editorial");
    expect(out).toContain("warm editorial");
    expect(out).not.toContain("Playfair");
  });

  it("removes every catalog family in a string", () => {
    const out = stripCatalogFamilies("Space Grotesk + Inter");
    expect(out).not.toContain("Space Grotesk");
    expect(out).not.toContain("Inter");
  });

  it("returns a family-free string with only whitespace normalization", () => {
    expect(stripCatalogFamilies("warm   earthy\ttones")).toBe(
      "warm earthy tones",
    );
  });

  it("finds a catalog family by name", () => {
    expect(findCatalogFamilies("use Fraunces here")).toEqual(["Fraunces"]);
  });

  it("matches case-insensitively", () => {
    expect(findCatalogFamilies("try BODONI MODA energy")).toEqual([
      "Bodoni Moda",
    ]);
    expect(stripCatalogFamilies("try BODONI MODA energy")).toBe("try energy");
  });

  it("respects word boundaries — a word merely containing a family substring survives", () => {
    // "Winterfell" contains "inter"; "Loravel" contains "Lora" — neither is a
    // whole-word catalog family occurrence, so both survive intact.
    expect(stripCatalogFamilies("Winterfell in Loravel style")).toBe(
      "Winterfell in Loravel style",
    );
    expect(findCatalogFamilies("Winterfell in Loravel style")).toEqual([]);
  });

  it("reports families first-seen (by position), de-duplicated", () => {
    expect(findCatalogFamilies("Lora before Fraunces, then Lora again")).toEqual(
      ["Lora", "Fraunces"],
    );
  });
});

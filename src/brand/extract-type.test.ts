import { describe, it, expect } from "vitest";
import { mapTypeRead } from "./extract-type.js";
import { DEFAULT_FONT_PAIRING, FONT_PAIRINGS } from "./fonts.js";
import type { BrandTypeRead } from "../openai.js";

const catalogFamilies = FONT_PAIRINGS.flatMap((p) => [p.heading, p.body]);

describe("mapTypeRead", () => {
  it("uses transcribed printed family names when they resolve to the catalog", () => {
    const read: BrandTypeRead = {
      printedFamilies: { heading: "Baloo 2", body: "Nunito Sans" },
    };
    const res = mapTypeRead(read);
    expect(res.approximate).toBe(true);
    expect(res.typography.heading).toBe("Baloo 2");
    expect(res.typography.body).toBe("Nunito Sans");
  });

  it("keeps a known printed family and defaults the off-catalog side", () => {
    const read: BrandTypeRead = {
      printedFamilies: { heading: "Poppins", body: "Totally Made Up Face" },
    };
    const res = mapTypeRead(read);
    expect(res.typography.heading).toBe("Poppins");
    expect(res.typography.body).toBe(DEFAULT_FONT_PAIRING.body);
    expect(catalogFamilies).toContain(res.typography.body);
  });

  it("falls back to structured attributes when no printed name resolves", () => {
    const read: BrandTypeRead = {
      printedFamilies: { heading: "Invented One", body: "Invented Two" },
      attributes: { classification: "serif", mood: "elegant editorial" },
    };
    const res = mapTypeRead(read);
    expect(res.approximate).toBe(true);
    expect(catalogFamilies).toContain(res.typography.heading);
    expect(catalogFamilies).toContain(res.typography.body);
    const pairing = FONT_PAIRINGS.find(
      (p) =>
        p.heading === res.typography.heading && p.body === res.typography.body,
    )!;
    expect(pairing.tags.some((t) => ["serif", "editorial", "elegant"].includes(t))).toBe(true);
  });

  it("snaps an off-catalog suggested family to a loadable catalog family", () => {
    const read: BrandTypeRead = { suggestedFamily: "Nebula Sans Ultra" };
    const res = mapTypeRead(read);
    expect(res.approximate).toBe(true);
    expect(catalogFamilies).toContain(res.typography.heading);
    expect(catalogFamilies).toContain(res.typography.body);
    expect(res.typography.heading).not.toBe("Nebula Sans Ultra");
    expect(res.typography.body).not.toBe("Nebula Sans Ultra");
  });

  it("falls back to the default (or supplied) pairing on an empty/absent read", () => {
    const res = mapTypeRead(undefined);
    expect(res.typography.heading).toBe(DEFAULT_FONT_PAIRING.heading);
    expect(res.typography.body).toBe(DEFAULT_FONT_PAIRING.body);
    expect(res.approximate).toBe(true);

    const empty = mapTypeRead({});
    expect(empty.typography.heading).toBe(DEFAULT_FONT_PAIRING.heading);

    const custom = FONT_PAIRINGS[3];
    const res2 = mapTypeRead({}, { fallback: custom });
    expect(res2.typography.heading).toBe(custom.heading);
    expect(res2.typography.body).toBe(custom.body);
    expect(res2.approximate).toBe(true);
  });
});

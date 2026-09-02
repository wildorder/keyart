import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  SLOT_KINDS,
  SLOT_ID_RE,
  SurfaceSlotSchema,
  parseSurfaceManifest,
  formatTeachingIssues,
  isAssetSlot,
  isSlotRetired,
  slotById,
  SURFACE_MANIFEST_JSON_SCHEMA,
  type SurfaceManifest,
  type SurfaceSlot,
} from "./schema.js";

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
});

function slot(overrides: Partial<SurfaceSlot> = {}): SurfaceSlot {
  return {
    id: "icon.restaurant",
    kind: "icon",
    description: "A restaurant icon.",
    criticality: "required",
    origin: "authored",
    attributions: [],
    ...overrides,
  };
}

describe("SurfaceManifestSchema / parseSurfaceManifest", () => {
  it("parses a valid manifest with one slot per kind and round-trips deep-equal", () => {
    const manifest = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      slots: [
        slot({ id: "icon.restaurant", kind: "icon" }),
        slot({ id: "illustration.empty-cart", kind: "illustration" }),
        slot({ id: "color-role.chart-accent", kind: "color-role" }),
        slot({ id: "type-role.stat-numeral", kind: "type-role" }),
        slot({
          id: "other.sound-motif",
          kind: "other",
          context: { note: "ambient sound motif" },
        }),
      ],
    };

    const parsed = parseSurfaceManifest(manifest);
    expect(parsed).toEqual(manifest);
  });

  it("defaults attributions to [] when omitted", () => {
    const raw = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      slots: [
        {
          id: "icon.restaurant",
          kind: "icon",
          description: "A restaurant icon.",
          criticality: "required",
          origin: "authored",
        },
      ],
    };
    const parsed = parseSurfaceManifest(raw);
    expect(parsed.slots[0].attributions).toEqual([]);
  });

  it("rejects an unknown kind, naming the five valid kinds", () => {
    const raw = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      slots: [slot({ kind: "graphic" as never })],
    };
    let message = "";
    try {
      parseSurfaceManifest(raw);
      expect.fail("expected parseSurfaceManifest to throw");
    } catch (err) {
      message = err instanceof z.ZodError ? formatTeachingIssues(err) : String(err);
    }
    expect(message).toContain('"graphic"');
    expect(message).toContain("icon, illustration, color-role, type-role, other");
  });

  it.each([
    ["restaurant", "no namespace"],
    ["Icon.Restaurant", "uppercase"],
    ["icon.", "empty segment"],
    ["icon.-bad", "segment not starting with a letter"],
  ])("rejects invalid id %s (%s) with format + example", (badId) => {
    const raw = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      slots: [slot({ id: badId })],
    };
    let message = "";
    try {
      parseSurfaceManifest(raw);
      expect.fail("expected parseSurfaceManifest to throw");
    } catch (err) {
      message = err instanceof z.ZodError ? formatTeachingIssues(err) : String(err);
    }
    expect(message).toContain(JSON.stringify(badId));
    expect(message).toContain("dot-namespaced kebab-case");
    expect(message).toContain("icon.restaurant");
  });

  it("accepts multi-segment ids like icon.nav.settings", () => {
    expect(SLOT_ID_RE.test("icon.nav.settings")).toBe(true);
    expect(() => SurfaceSlotSchema.parse(slot({ id: "icon.nav.settings" }))).not.toThrow();
  });

  it('accepts kind "other" with a context.note cleanly (no warning, no error)', () => {
    const parsed = SurfaceSlotSchema.parse(
      slot({
        id: "other.sound-motif",
        kind: "other",
        context: { note: "ambient sound motif" },
      }),
    );
    expect(parsed.kind).toBe("other");
    expect(parsed.context?.note).toBe("ambient sound motif");
  });

  it("rejects duplicate slot ids with a teaching message naming the id", () => {
    const raw: SurfaceManifest = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      slots: [slot({ id: "icon.restaurant" }), slot({ id: "icon.restaurant" })],
    };
    let message = "";
    try {
      parseSurfaceManifest(raw);
      expect.fail("expected parseSurfaceManifest to throw");
    } catch (err) {
      message = err instanceof z.ZodError ? formatTeachingIssues(err) : String(err);
    }
    expect(message).toContain('"icon.restaurant"');
    expect(message).toContain("surface request");
  });
});

describe("retire marker + pure predicates", () => {
  it("parses the retiredAt marker", () => {
    const parsed = SurfaceSlotSchema.parse(
      slot({ retiredAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(parsed.retiredAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("isSlotRetired is true only for a non-empty retiredAt", () => {
    const retired = slot({ retiredAt: "2026-01-01T00:00:00.000Z" });
    const live = slot({});
    const emptyString = slot({ retiredAt: "" });
    const beforeRetired = { ...retired };
    const beforeLive = { ...live };
    const beforeEmpty = { ...emptyString };

    expect(isSlotRetired(retired)).toBe(true);
    expect(isSlotRetired(live)).toBe(false);
    expect(isSlotRetired(emptyString)).toBe(false);

    expect(retired).toEqual(beforeRetired);
    expect(live).toEqual(beforeLive);
    expect(emptyString).toEqual(beforeEmpty);
  });

  it.each(SLOT_KINDS)("isAssetSlot for kind %s", (kind) => {
    const before = { kind };
    const result = isAssetSlot({ kind });
    expect(result).toBe(kind === "icon" || kind === "illustration");
    expect({ kind }).toEqual(before);
  });

  it("slotById finds live AND retired slots by id, undefined for unknown", () => {
    const liveSlot = slot({ id: "icon.a" });
    const retiredSlot = slot({ id: "icon.b", retiredAt: "2026-01-01T00:00:00.000Z" });
    const manifest: SurfaceManifest = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      slots: [liveSlot, retiredSlot],
    };
    const before = { ...manifest, slots: [...manifest.slots] };

    expect(slotById(manifest, "icon.a")).toEqual(liveSlot);
    expect(slotById(manifest, "icon.b")).toEqual(retiredSlot);
    expect(slotById(manifest, "icon.unknown")).toBeUndefined();

    expect(manifest).toEqual(before);
  });
});

describe("formatTeachingIssues", () => {
  it("renders one line per issue with the field path prefix", () => {
    const result = SurfaceSlotSchema.safeParse(
      slot({ id: "Bad Id", kind: "graphic" as never }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const formatted = formatTeachingIssues(result.error);
    const lines = formatted.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).toMatch(/^- /);
    }
    expect(formatted).toMatch(/- kind:/);
    expect(formatted).toMatch(/- id:/);
  });
});

describe("SURFACE_MANIFEST_JSON_SCHEMA lockstep", () => {
  it("kind enum deep-equals SLOT_KINDS and id pattern equals SLOT_ID_RE.source", () => {
    expect(
      SURFACE_MANIFEST_JSON_SCHEMA.definitions.SurfaceSlot.properties.kind.enum,
    ).toEqual([...SLOT_KINDS]);
    expect(
      SURFACE_MANIFEST_JSON_SCHEMA.definitions.SurfaceSlot.properties.id.pattern,
    ).toBe(SLOT_ID_RE.source);
  });
});

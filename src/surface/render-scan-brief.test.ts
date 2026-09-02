import { describe, it, expect, beforeEach } from "vitest";
import { renderScanBrief } from "./render-scan-brief.js";
import { SLOT_KINDS, SurfaceSlotSchema } from "./schema.js";
import type { SurfaceManifest, SurfaceSlot } from "./schema.js";

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
});

function slot(overrides: Partial<SurfaceSlot> = {}): SurfaceSlot {
  return {
    id: "icon.a",
    kind: "icon",
    description: "Slot A.",
    criticality: "required",
    origin: "authored",
    attributions: [],
    ...overrides,
  };
}

const SAMPLE_MANIFEST: SurfaceManifest = {
  version: 3,
  updatedAt: "2026-01-01T00:00:00.000Z",
  slots: [
    slot({ id: "icon.live", description: "A live slot." }),
    slot({
      id: "icon.retired",
      description: "A retired slot.",
      retiredAt: "2026-01-02T00:00:00.000Z",
    }),
  ],
};

describe("renderScanBrief — determinism", () => {
  it("renderScanBrief(null) is byte-identical across two calls", () => {
    expect(renderScanBrief(null)).toBe(renderScanBrief(null));
  });

  it("renderScanBrief(manifest) is byte-identical across two calls with the same object", () => {
    expect(renderScanBrief(SAMPLE_MANIFEST)).toBe(renderScanBrief(SAMPLE_MANIFEST));
  });

  it("two structurally-equal but distinct manifest objects render identically", () => {
    const copy: SurfaceManifest = JSON.parse(JSON.stringify(SAMPLE_MANIFEST));
    expect(renderScanBrief(SAMPLE_MANIFEST)).toBe(renderScanBrief(copy));
  });
});

describe("renderScanBrief — contract sections", () => {
  it("contains all sections in order, with JSON Schema + taxonomy content", () => {
    const output = renderScanBrief(SAMPLE_MANIFEST);
    const sections = [
      "## What this is",
      "## JSON Schema",
      "## Taxonomy",
      "## What to ignore",
      "## Current manifest",
    ];
    const indices = sections.map((s) => output.indexOf(s));
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }

    for (const kind of SLOT_KINDS) {
      expect(output).toContain(kind);
    }
    expect(output).toContain("icon.restaurant");

    const headingMatches = [...output.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headingMatches).toEqual([...SLOT_KINDS]);

    const jsonFences = [...output.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
      (m) => m[1],
    );
    // 1 JSON Schema fence + 5 taxonomy examples + 1 current-manifest fence = 7
    expect(jsonFences.length).toBe(7);

    const taxonomyExampleFences = jsonFences.slice(1, 6);
    expect(taxonomyExampleFences.length).toBe(5);
    for (const fence of taxonomyExampleFences) {
      const parsedExample = JSON.parse(fence);
      expect(() => SurfaceSlotSchema.parse(parsedExample)).not.toThrow();
    }
  });
});

describe("renderScanBrief — null case", () => {
  it("keeps every section and states no manifest exists with no manifest fence", () => {
    const output = renderScanBrief(null);
    expect(output).toContain("## What this is");
    expect(output).toContain("## JSON Schema");
    expect(output).toContain("## Taxonomy");
    expect(output).toContain("## What to ignore");
    expect(output).toContain("## Current manifest");

    const currentManifestSection = output.slice(
      output.indexOf("## Current manifest"),
    );
    expect(currentManifestSection).toContain("surface set");
    expect(currentManifestSection).toContain("brand/surface.yaml");
    expect(currentManifestSection).not.toContain("```json");
  });
});

describe("renderScanBrief — current manifest embedding", () => {
  it("embeds the manifest verbatim, retired slots included, and parses back deep-equal", () => {
    const output = renderScanBrief(SAMPLE_MANIFEST);
    expect(output).toContain("icon.live");
    expect(output).toContain("icon.retired");

    const currentManifestSection = output.slice(
      output.indexOf("## Current manifest"),
    );
    const fenceMatch = currentManifestSection.match(/```json\n([\s\S]*?)\n```/);
    expect(fenceMatch).not.toBeNull();
    const parsed = JSON.parse(fenceMatch![1]);
    expect(parsed).toEqual(SAMPLE_MANIFEST);
  });
});

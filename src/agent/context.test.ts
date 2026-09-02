import { describe, it, expect } from "vitest";
import { buildSystemPreamble } from "./context.js";
import { assembleContext } from "../brand/assemble-context.js";
import type { ContextMemoryEntry } from "../brand/assemble-context.js";
import type { GlobalBrand } from "../brand/schema.js";

const EMPTY_GLOBAL: GlobalBrand = {
  approvedPointer: null,
  rules: [],
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("buildSystemPreamble", () => {
  it("states the focused ids so an id-free message can resolve to the focused direction", () => {
    const memory: ContextMemoryEntry[] = [];
    const assembled = assembleContext({
      brief: "A calm, modern brand.",
      global: EMPTY_GLOBAL,
      memory,
    });

    const preamble = buildSystemPreamble(
      { directionId: "direction-b", versionId: "v3" },
      assembled,
    );

    expect(preamble).toContain("direction-b");
    expect(preamble).toContain("v3");
  });

  it("frames the assembled content as untrusted DATA inside a delimited boundary", () => {
    const assembled = assembleContext({
      brief: "Brief text.",
      global: EMPTY_GLOBAL,
      memory: [],
    });

    const preamble = buildSystemPreamble({ directionId: "moody" }, assembled);

    expect(preamble).toMatch(/not instructions/i);
    expect(preamble).toMatch(/descriptive data/i);
    expect(preamble).toContain("<brand-context>");
    expect(preamble).toContain("</brand-context>");

    const start = preamble.indexOf("<brand-context>");
    const end = preamble.indexOf("</brand-context>");
    expect(preamble.slice(start, end)).toContain("Brief text.");
  });

  it("is pure — regenerated from live state, deterministic for the same input, no fs/Date.now", () => {
    const assembledA = assembleContext({
      brief: "Brief A.",
      global: EMPTY_GLOBAL,
      memory: [],
    });
    const assembledB = assembleContext({
      brief: "Brief B.",
      global: EMPTY_GLOBAL,
      memory: [],
    });

    const preambleA = buildSystemPreamble(
      { directionId: "direction-a" },
      assembledA,
    );
    const preambleB = buildSystemPreamble(
      { directionId: "direction-b" },
      assembledB,
    );

    expect(preambleA).not.toEqual(preambleB);

    const repeat = buildSystemPreamble(
      { directionId: "direction-a" },
      assembledA,
    );
    expect(repeat).toEqual(preambleA);
  });
});

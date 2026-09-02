import { describe, it, expect } from "vitest";
import {
  GlobalBrandSchema,
  GlobalRuleSchema,
  ApprovedPointerSchema,
  parseGlobalBrand,
} from "./schema.js";

const BASE_RULE = {
  id: "rule-1",
  severity: "guideline" as const,
  text: "Prefer generous whitespace",
  author: "tim",
  source: "cli",
  date: "2026-07-01T00:00:00.000Z",
};

describe("GlobalBrand schema", () => {
  it("parses a minimal doc and applies defaults", () => {
    const brand = GlobalBrandSchema.parse({
      version: 0,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(brand.approvedPointer).toBeNull();
    expect(brand.rules).toEqual([]);
    expect(brand.version).toBe(0);
  });

  it("parseGlobalBrand is equivalent to schema.parse", () => {
    const raw = {
      version: 1,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    };
    expect(parseGlobalBrand(raw)).toEqual(GlobalBrandSchema.parse(raw));
  });

  it("rejects a rule missing required attribution", () => {
    expect(() =>
      GlobalRuleSchema.parse({
        id: "rule-1",
        severity: "hard",
        text: "Never use pure black",
        // author/source/date missing
      }),
    ).toThrow();
  });

  it("rejects an unknown severity", () => {
    expect(() =>
      GlobalRuleSchema.parse({
        id: "rule-1",
        severity: "critical",
        text: "x",
        author: "tim",
        source: "cli",
        date: "2026-06-30T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an approvedPointer missing directionId", () => {
    expect(() =>
      ApprovedPointerSchema.parse({
        versionId: "v1",
        approvedAt: "2026-06-30T00:00:00.000Z",
        // directionId missing
      }),
    ).toThrow();
  });

  it("Test 14: parses the two-id pointer; a stray unknown key is dropped", () => {
    const pointer = ApprovedPointerSchema.parse({
      directionId: "direction-a",
      versionId: "2026-07-11T00-00-00-000Z",
      approvedAt: "2026-07-11T00:00:00.000Z",
      legacyAnchor: "moody", // unknown key — stripped by the schema
    });
    expect(pointer.versionId).toBe("2026-07-11T00-00-00-000Z");
    expect(pointer.directionId).toBe("direction-a");
    expect("legacyAnchor" in pointer).toBe(false);
  });

  it("rejects an approvedPointer missing versionId", () => {
    expect(() =>
      ApprovedPointerSchema.parse({
        directionId: "direction-a",
        approvedAt: "2026-06-30T00:00:00.000Z",
        // versionId missing
      }),
    ).toThrow();
  });
});

describe("GlobalRule — channel/polarity (WS-01 additive schema)", () => {
  it("round-trips a rule with channel and polarity", () => {
    const rule = GlobalRuleSchema.parse({
      ...BASE_RULE,
      channel: "visual",
      polarity: "avoid",
    });
    expect(rule.channel).toBe("visual");
    expect(rule.polarity).toBe("avoid");
  });

  it("back-compat: absent channel/polarity parse to undefined (not defaulted on disk)", () => {
    const rule = GlobalRuleSchema.parse(BASE_RULE);
    expect(rule.channel).toBeUndefined();
    expect(rule.polarity).toBeUndefined();
  });

  it("rejects invalid channel enum value", () => {
    expect(() =>
      GlobalRuleSchema.parse({ ...BASE_RULE, channel: "audio" }),
    ).toThrow();
  });

  it("rejects invalid polarity enum value", () => {
    expect(() =>
      GlobalRuleSchema.parse({ ...BASE_RULE, polarity: "maybe" }),
    ).toThrow();
  });

  it("parseGlobalBrand succeeds on a legacy rules array (no channel/polarity)", () => {
    const brand = parseGlobalBrand({
      version: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      rules: [BASE_RULE],
    });
    expect(brand.rules).toHaveLength(1);
    expect(brand.rules[0].channel).toBeUndefined();
    expect(brand.rules[0].polarity).toBeUndefined();
  });
});

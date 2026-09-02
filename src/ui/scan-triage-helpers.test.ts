import { describe, it, expect } from "vitest";
import {
  proposalIsRefined,
  refinedFieldBadges,
  candidateDescription,
  partitionAccepted,
  hostOf,
  SKIP_EXAMPLE_CAP,
  skipRows,
  formatSkipRow,
  skipHeadline,
  migrationRows,
  overlayWarning,
} from "./scan-triage-helpers.js";
import type {
  MigrationFinding,
  ScanCandidate,
  ScanProposal,
  ScanSkipGroup,
} from "./types.js";

function makeCandidate(overrides: Partial<ScanCandidate> = {}): ScanCandidate {
  return {
    signature: "aaaaaaaaaaaaaaaa",
    kind: "icon",
    proposedId: "icon.unnamed-1",
    cropFile: "brand/generated/surface-scan/crops/aaaaaaaaaaaaaaaa.png",
    hints: {},
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ScanProposal> = {}): ScanProposal {
  return {
    createdAt: "2026-08-06T00:00:00.000Z",
    urls: ["http://localhost:3000"],
    candidates: [],
    rejectedSignatures: [],
    ...overrides,
  };
}

describe("proposalIsRefined", () => {
  it("true when refinedAt is present", () => {
    expect(
      proposalIsRefined(makeProposal({ refinedAt: "2026-08-06T00:00:00.000Z" })),
    ).toBe(true);
  });

  it("false when refinedAt is absent", () => {
    expect(proposalIsRefined(makeProposal())).toBe(false);
  });
});

describe("refinedFieldBadges", () => {
  it("badges only the refined field", () => {
    expect(refinedFieldBadges(makeCandidate({ refined: { proposedId: true } }))).toEqual({
      id: true,
      kind: false,
      description: false,
    });
  });

  it("absent refined ⇒ all floor", () => {
    expect(refinedFieldBadges(makeCandidate())).toEqual({
      id: false,
      kind: false,
      description: false,
    });
  });

  it("full refined ⇒ all three", () => {
    expect(
      refinedFieldBadges(
        makeCandidate({ refined: { proposedId: true, kind: true, description: true } }),
      ),
    ).toEqual({ id: true, kind: true, description: true });
  });
});

describe("candidateDescription", () => {
  it("passes a set description through verbatim", () => {
    expect(candidateDescription(makeCandidate({ description: "A cart icon" }))).toBe(
      "A cart icon",
    );
  });

  it("falls back to the honest floor placeholder when unset", () => {
    expect(candidateDescription(makeCandidate())).toBe("no description (floor scan)");
  });
});

describe("partitionAccepted", () => {
  const a = makeCandidate({ signature: "aaaaaaaaaaaaaaaa" });
  const b = makeCandidate({ signature: "bbbbbbbbbbbbbbbb" });
  const c = makeCandidate({ signature: "cccccccccccccccc" });

  it("splits accepted vs rejected, preserving candidate order", () => {
    expect(partitionAccepted([a, b, c], new Set([a.signature]))).toEqual({
      acceptedIds: [a.signature],
      rejectedCount: 2,
    });
  });

  it("an empty checked set rejects everything", () => {
    expect(partitionAccepted([a, b, c], new Set())).toEqual({
      acceptedIds: [],
      rejectedCount: 3,
    });
  });

  it("does not mutate the input array", () => {
    const candidates = [a, b, c];
    const copy = [...candidates];
    partitionAccepted(candidates, new Set([b.signature]));
    expect(candidates).toEqual(copy);
  });
});

describe("hostOf", () => {
  it("extracts host:port from a valid URL", () => {
    expect(hostOf("http://localhost:3000/menu")).toBe("localhost:3000");
  });

  it("falls back to the raw input when unparseable", () => {
    expect(hostOf("not a url")).toBe("not a url");
  });
});

function makeSkipGroup(overrides: Partial<ScanSkipGroup> = {}): ScanSkipGroup {
  return {
    reason: "repeated-content",
    count: 1,
    exampleSources: [],
    ...overrides,
  };
}

function makeMigration(overrides: Partial<MigrationFinding> = {}): MigrationFinding {
  return {
    kind: "color-role",
    value: "#2e7d32",
    nearestRole: "--brand-primary",
    delta: 0.02,
    occurrences: 1,
    examples: [],
    ...overrides,
  };
}

describe("skipRows", () => {
  it("9. merges by reason and sums counts, preserving first-appearance order", () => {
    const input = [
      makeSkipGroup({ reason: "repeated-content", count: 20 }),
      makeSkipGroup({ reason: "repeated-content", count: 27 }),
      makeSkipGroup({ reason: "foreign-origin", count: 9 }),
    ];
    const before = JSON.parse(JSON.stringify(input));

    const rows = skipRows(input);
    expect(rows[0]).toMatchObject({ reason: "repeated-content", count: 47, groupCount: 2 });
    expect(rows[1]).toMatchObject({ reason: "foreign-origin", count: 9, groupCount: 1 });
    expect(input).toEqual(before);
  });

  it("10. caps examples honestly and de-duplicates", () => {
    const rows = skipRows([
      makeSkipGroup({ exampleSources: ["a", "b", "a", "c", "d", "e"] }),
    ]);
    expect(rows[0].examples).toEqual(["a", "b", "c"]);
    expect(rows[0].examples).toHaveLength(SKIP_EXAMPLE_CAP);
    expect(rows[0].moreExamples).toBe(2);
  });
});

describe("formatSkipRow", () => {
  it("11. the group clause appears only for multi-group reasons", () => {
    const rows = skipRows([
      makeSkipGroup({ reason: "repeated-content", count: 20 }),
      makeSkipGroup({ reason: "repeated-content", count: 27 }),
      makeSkipGroup({ reason: "foreign-origin", count: 9 }),
    ]);
    const line0 = formatSkipRow(rows[0]);
    expect(line0).toContain("skipped 47");
    expect(line0).toContain("dynamic content");
    expect(line0).toContain(String(rows[0].groupCount));
    expect(line0).toContain("repeated groups");

    const line1 = formatSkipRow(rows[1]);
    expect(line1).not.toMatch(/\(/);
  });
});

describe("skipHeadline", () => {
  it("12. absent-field tolerance and the summed total", () => {
    expect(skipHeadline(undefined)).toBeNull();
    expect(skipHeadline([])).toBeNull();
    expect(skipRows(undefined)).toEqual([]);
    expect(skipRows([])).toEqual([]);

    const headline = skipHeadline([
      makeSkipGroup({ count: 47 }),
      makeSkipGroup({ reason: "foreign-origin", count: 9 }),
    ]);
    expect(headline).toContain("56");
  });
});

describe("migrationRows", () => {
  it("13. renders the finding's own token spelling and URL examples", () => {
    const colorFinding = makeMigration({
      value: "#2e7d32",
      nearestRole: "--brand-primary",
      occurrences: 14,
      examples: [
        "http://localhost:4321/",
        "http://localhost:4321/vendors",
        "http://localhost:4321/about",
        "http://localhost:4321/faq",
      ],
    });
    const typeFinding = makeMigration({
      kind: "type-role",
      value: "Courier New",
      nearestRole: "--brand-font-body",
      delta: 0,
      occurrences: 3,
      examples: ["http://localhost:4321/"],
    });

    const rows = migrationRows([colorFinding, typeFinding]);
    expect(rows[0].line).toContain("#2e7d32");
    expect(rows[0].line).toContain("--brand-primary");
    expect(rows[0].line).toContain("14");
    expect(rows[0].line).not.toMatch(/var\(/);
    expect(rows[0].moreExamples).toBe(1);

    expect(rows[1].line).toContain("Courier New");
    expect(rows[1].line).toContain("--brand-font-body");

    expect(migrationRows(undefined)).toEqual([]);
  });
});

describe("overlayWarning", () => {
  it("14. presence, rounding, and the honest detail ladder", () => {
    expect(overlayWarning(undefined)).toBeNull();

    const withAriaLabel = overlayWarning({
      fraction: 0.924,
      hints: { ariaLabel: "Choose your location" },
    });
    expect(withAriaLabel!.percent).toBe(92);
    expect(withAriaLabel!.detail).toBe("Choose your location");
    expect(withAriaLabel!.message).toContain("scan.dismiss");

    const withClassNames = overlayWarning({
      fraction: 0.5,
      hints: { classNames: ["modal", "gate"] },
    });
    expect(withClassNames!.percent).toBe(50);
    expect(withClassNames!.detail).toContain("modal");
    expect(withClassNames!.detail).toContain("gate");

    const noHints = overlayWarning({ fraction: 1.4, hints: {} });
    expect(noHints!.percent).toBe(100);
    expect(noHints!.detail).toBeNull();
    expect(noHints!.message).toContain("scan.dismiss");
  });
});

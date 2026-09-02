import { describe, it, expect, vi } from "vitest";
import {
  splitMigrations,
  oklchDistance,
  normalizeFamilyKey,
  isMigrationDistance,
  MIGRATION_DELTA,
  type MigrationBaseline,
  type RoleCandidateObservation,
} from "./migrations.js";

function colorObs(
  value: string,
  overrides: Partial<RoleCandidateObservation<{ id: string }>> = {},
): RoleCandidateObservation<{ id: string }> {
  return {
    candidate: { id: value },
    kind: "color-role",
    value,
    occurrences: 1,
    examples: [],
    ...overrides,
  };
}

function fontObs(
  value: string,
  overrides: Partial<RoleCandidateObservation<{ id: string }>> = {},
): RoleCandidateObservation<{ id: string }> {
  return {
    candidate: { id: value },
    kind: "type-role",
    value,
    occurrences: 1,
    examples: [],
    ...overrides,
  };
}

const GREEN_BASELINE: MigrationBaseline = {
  colors: [{ role: "--brand-primary", hex: "#2e7d32" }],
  families: [],
};

describe("migrations.ts — the delta boundary, both sides (Test 1)", () => {
  it("a near-duplicate green becomes a migration; a distinct green stays a candidate", () => {
    const { candidates, migrations } = splitMigrations({
      candidates: [colorObs("#388e3c"), colorObs("#43a047")],
      baseline: GREEN_BASELINE,
    });

    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      kind: "color-role",
      value: "#388e3c",
      nearestRole: "--brand-primary",
    });
    expect(migrations[0].delta).toBeCloseTo(0.0528, 4);
    expect(candidates.map((c) => c.value)).toEqual(["#43a047"]);
  });

  it("the exported oklchDistance crosses the threshold exactly where the calibration table says", () => {
    expect(oklchDistance("#388e3c", "#2e7d32")).toBeLessThan(MIGRATION_DELTA);
    expect(oklchDistance("#43a047", "#2e7d32")).toBeGreaterThan(MIGRATION_DELTA);
  });
});

describe("migrations.ts — equality is a CANDIDATE, not a migration (Test 1b)", () => {
  it("isMigrationDistance is strict: < is a migration, >= is a candidate", () => {
    expect(isMigrationDistance(MIGRATION_DELTA)).toBe(false);
    expect(isMigrationDistance(MIGRATION_DELTA - 1e-9)).toBe(true);
    expect(isMigrationDistance(Infinity)).toBe(false);
  });
});

describe("migrations.ts — nearest-role selection and tie-break (Test 2)", () => {
  const FULL_BASELINE: MigrationBaseline = {
    colors: [
      { role: "--brand-primary", hex: "#2e7d32" },
      { role: "--brand-secondary", hex: "#1565c0" },
      { role: "--brand-background", hex: "#faf6f0" },
      { role: "--brand-surface", hex: "#ffffff" },
      { role: "--brand-text", hex: "#1c1a17" },
      { role: "--brand-text-muted", hex: "#6c757d" },
      { role: "--brand-pink", hex: "#e84393" },
      { role: "--brand-sky-blue", hex: "#2d98da" },
    ],
    families: [],
  };

  it("picks the nearest role by distance", () => {
    const { migrations } = splitMigrations({
      candidates: [colorObs("#1668c4")], // very close to --brand-secondary
      baseline: FULL_BASELINE,
    });
    expect(migrations).toHaveLength(1);
    expect(migrations[0].nearestRole).toBe("--brand-secondary");
  });

  it("an exact tie is broken by the earlier baseline entry", () => {
    const equidistant: MigrationBaseline = {
      colors: [
        { role: "--brand-first", hex: "#336699" },
        { role: "--brand-second", hex: "#336699" },
      ],
      families: [],
    };
    const { migrations } = splitMigrations({
      candidates: [colorObs("#346799")],
      baseline: equidistant,
    });
    expect(migrations).toHaveLength(1);
    expect(migrations[0].nearestRole).toBe("--brand-first");
  });
});

describe("migrations.ts — occurrence counting and example collection (Test 3)", () => {
  it("carries occurrences and examples verbatim onto the finding", () => {
    const { migrations } = splitMigrations({
      candidates: [
        colorObs("#388e3c", {
          occurrences: 14,
          examples: ["http://a.test", "http://b.test"],
        }),
      ],
      baseline: GREEN_BASELINE,
    });
    expect(migrations).toHaveLength(1);
    expect(migrations[0].occurrences).toBe(14);
    expect(migrations[0].examples).toEqual(["http://a.test", "http://b.test"]);
  });
});

describe("migrations.ts — a semantically distinct value stays a candidate (Test 4)", () => {
  it("distinct colors against a green baseline are returned as candidates, unmutated", () => {
    const red = colorObs("#d32f2f");
    const blue = colorObs("#0ea5e9");
    const input = Object.freeze([red, blue]);
    const { candidates, migrations } = splitMigrations({
      candidates: input as unknown as RoleCandidateObservation<{ id: string }>[],
      baseline: GREEN_BASELINE,
    });

    expect(migrations).toEqual([]);
    expect(candidates).toEqual([red, blue]);
    expect(candidates[0]).toBe(red);
    expect(candidates[1]).toBe(blue);
  });
});

describe("migrations.ts — type-role family matching (Test 5)", () => {
  const TYPE_BASELINE: MigrationBaseline = {
    colors: [],
    families: [
      { role: "--brand-font-body", family: "Inter" },
      { role: "--brand-font-heading", family: "Space Grotesk" },
    ],
  };

  it("normalized/de-spaced/suffix-stripped observations match; unrelated families do not", () => {
    const { candidates, migrations } = splitMigrations({
      candidates: [
        fontObs("inter"),
        fontObs("Inter-Bold"),
        fontObs("spacegrotesk"),
        fontObs("space_grotesk variable"),
        fontObs("roboto"),
        fontObs("ibm plex sans"),
      ],
      baseline: TYPE_BASELINE,
    });

    expect(migrations).toHaveLength(4);
    for (const m of migrations) {
      expect(m.delta).toBe(0);
    }
    expect(migrations.find((m) => m.value === "inter")?.nearestRole).toBe("--brand-font-body");
    expect(migrations.find((m) => m.value === "Inter-Bold")?.nearestRole).toBe(
      "--brand-font-body",
    );
    expect(migrations.find((m) => m.value === "spacegrotesk")?.nearestRole).toBe(
      "--brand-font-heading",
    );
    expect(migrations.find((m) => m.value === "space_grotesk variable")?.nearestRole).toBe(
      "--brand-font-heading",
    );

    expect(candidates.map((c) => c.value)).toEqual(["roboto", "ibm plex sans"]);
  });
});

describe("migrations.ts — empty baseline keeps everything as demand (Test 6)", () => {
  it("no bound tokens ⇒ zero migrations, every observation returned unchanged", () => {
    const empty: MigrationBaseline = { colors: [], families: [] };
    const input = [colorObs("#388e3c"), fontObs("inter"), colorObs("#d32f2f")];
    const { candidates, migrations } = splitMigrations({ candidates: input, baseline: empty });

    expect(migrations).toEqual([]);
    expect(candidates).toEqual(input);
  });
});

describe("migrations.ts — purity and determinism (Test 7)", () => {
  it("50 runs over a frozen input yield deep-equal outputs, no mutation, no clock dependence", () => {
    const baseline: MigrationBaseline = Object.freeze({
      colors: Object.freeze([{ role: "--brand-primary", hex: "#2e7d32" }]) as unknown as {
        role: string;
        hex: string;
      }[],
      families: Object.freeze([]) as unknown as { role: string; family: string }[],
    });
    const input = Object.freeze([
      Object.freeze(colorObs("#388e3c", { occurrences: 3, examples: ["http://a.test"] })),
      Object.freeze(colorObs("#d32f2f")),
    ]) as unknown as RoleCandidateObservation<{ id: string }>[];

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    const first = splitMigrations({ candidates: input, baseline });
    vi.setSystemTime(new Date("2030-06-15T12:00:00.000Z"));
    const results = [first];
    for (let i = 0; i < 49; i++) {
      results.push(splitMigrations({ candidates: input, baseline }));
    }
    vi.useRealTimers();

    for (const result of results) {
      expect(result).toEqual(first);
    }

    expect(oklchDistance("#abc", "#abc")).toBe(0);
    expect(oklchDistance("not-a-color", "#2e7d32")).toBe(Infinity);
  });
});

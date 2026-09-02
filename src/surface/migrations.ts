import { oklch } from "culori";

/**
 * One legacy hardcoded value that should reference an EXISTING bound token
 * instead of becoming new demand. ADVISORY and proposal-only: never a
 * ScanCandidate, never applicable to brand/surface.yaml.
 */
export interface MigrationFinding {
  kind: "color-role" | "type-role";
  value: string; // the observed literal (lowercased hex, or the font family as observed)
  nearestRole: string; // the bound token it should reference, e.g. "--brand-primary"
  delta: number; // OKLab ΔE for colors; 0 for an exact (normalized) family match
  occurrences: number; // aggregated count across the scanned pages
  examples: string[]; // page URLs where it was seen (deduped, first-seen order)
}

/**
 * The perceptual distance below which an observed color is judged "the same
 * color, slightly off" — a MIGRATION — rather than a distinct unmet role.
 * OKLab ΔE units (L in 0..1, a/b in roughly -0.4..0.4).
 *
 * Calibration (measured with this module's own oklchDistance):
 *   #2e7d32 vs #2f7f34  = 0.0063  — a rounding-error duplicate       => migration
 *   #ffffff vs #fafafa  = 0.0149  — an off-white duplicate            => migration
 *   #2e7d32 vs #388e3c  = 0.0528  — Material green 800 vs 700         => migration
 *   #111827 vs #1f2937  = 0.0682  — two deliberate neutral steps      => candidate
 *   #2e7d32 vs #1b5e20  = 0.0998  — a distinctly darker green          => candidate
 *   #2e7d32 vs #43a047  = 0.1075  — a distinctly lighter green         => candidate
 *   #2e7d32 vs #d32f2f  = 0.2921  — a different hue entirely           => candidate
 *
 * The boundary is STRICT: `delta < MIGRATION_DELTA` is a migration;
 * `delta === MIGRATION_DELTA` (and above) stays a candidate.
 */
export const MIGRATION_DELTA = 0.06;

/** The bound tokens a finding can point at, labeled with the CSS var that holds
 *  them — projected by the caller from resolveBrandVars, never re-derived. */
export interface MigrationBaseline {
  colors: { role: string; hex: string }[]; // e.g. { role: "--brand-primary", hex: "#2e7d32" }
  families: { role: string; family: string }[]; // e.g. { role: "--brand-font-heading", family: "Inter" }
}

/** One observed color/type role candidate, pre-mint, with the aggregate facts a
 *  finding needs. `candidate` is the scan.ts pre-mint role-candidate record. */
export interface RoleCandidateObservation<C> {
  candidate: C;
  kind: "color-role" | "type-role";
  value: string; // lowercased hex, or the observed font family (lowercased)
  occurrences: number;
  examples: string[]; // page URLs, deduped, first-seen order
}

/** PURE. The `delta < MIGRATION_DELTA` boundary, factored so callers (and
 *  tests) can assert the strict-less-than rule directly without depending on
 *  a hex pair that happens to land exactly on the constant. */
export function isMigrationDistance(delta: number): boolean {
  return delta < MIGRATION_DELTA;
}

/**
 * PURE. OKLab ΔE between two hexes: sqrt(dL² + da² + db²) with a/b derived
 * from the OKLCH chroma/hue. Unparseable input ⇒ Infinity (never a migration).
 */
export function oklchDistance(a: string, b: string): number {
  const A = oklch(a);
  const B = oklch(b);
  if (!A || !B) return Infinity;
  const ah = typeof A.h === "number" ? A.h : 0;
  const bh = typeof B.h === "number" ? B.h : 0;
  const ac = A.c ?? 0;
  const bc = B.c ?? 0;
  const aa = ac * Math.cos((ah * Math.PI) / 180);
  const ab = ac * Math.sin((ah * Math.PI) / 180);
  const ba = bc * Math.cos((bh * Math.PI) / 180);
  const bb = bc * Math.sin((bh * Math.PI) / 180);
  return Math.hypot(A.l - B.l, aa - ba, ab - bb);
}

/** Words stripped from a multi-word family key (weight/style/variable
 *  suffixes) — never stripped when they are the ENTIRE string. */
const FAMILY_SUFFIX_WORDS = new Set([
  "variable",
  "vf",
  "regular",
  "italic",
  "oblique",
  "thin",
  "light",
  "medium",
  "semibold",
  "bold",
  "black",
  "display",
]);

/** PURE. Tolerant font-family key: lowercased, quotes stripped, separators
 *  collapsed to single spaces, weight/style/variable suffix words removed
 *  (unless the family IS entirely one such word). */
export function normalizeFamilyKey(family: string): string {
  const collapsed = family
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
  const words = collapsed.split(" ").filter(Boolean);
  if (words.length <= 1) return collapsed;
  const filtered = words.filter((w) => !FAMILY_SUFFIX_WORDS.has(w));
  const kept = filtered.length > 0 ? filtered : words;
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * PURE. Partitions observed color/type role candidates into the ones that are
 * genuine unmet demand (kept as candidates) and the ones that are legacy
 * literals of an already-bound token (returned as advisory MigrationFindings).
 * No I/O, no model, no Date, no Math.random — same input, same output.
 *
 * Order preserved on both returned arrays; migrations are not capped, deduped
 * further, or sorted — the caller already aggregated by distinct value.
 */
export function splitMigrations<C>(input: {
  candidates: RoleCandidateObservation<C>[];
  baseline: MigrationBaseline;
}): { candidates: RoleCandidateObservation<C>[]; migrations: MigrationFinding[] } {
  const candidates: RoleCandidateObservation<C>[] = [];
  const migrations: MigrationFinding[] = [];

  for (const observation of input.candidates) {
    if (observation.kind === "color-role") {
      let nearestRole: string | undefined;
      let bestDelta = Infinity;
      for (const entry of input.baseline.colors) {
        const delta = oklchDistance(observation.value, entry.hex);
        if (delta < bestDelta) {
          bestDelta = delta;
          nearestRole = entry.role;
        }
      }
      if (nearestRole !== undefined && isMigrationDistance(bestDelta)) {
        migrations.push({
          kind: "color-role",
          value: observation.value,
          nearestRole,
          delta: Math.round(bestDelta * 10000) / 10000,
          occurrences: observation.occurrences,
          examples: [...observation.examples],
        });
        continue;
      }
      candidates.push(observation);
      continue;
    }

    // type-role: normalized-key match only, never fuzzy.
    const observedKey = normalizeFamilyKey(observation.value);
    const observedDespaced = observedKey.replace(/ /g, "");
    let matchedRole: string | undefined;
    for (const entry of input.baseline.families) {
      const familyKey = normalizeFamilyKey(entry.family);
      if (familyKey === observedKey || familyKey.replace(/ /g, "") === observedDespaced) {
        matchedRole = entry.role;
        break;
      }
    }
    if (matchedRole !== undefined) {
      migrations.push({
        kind: "type-role",
        value: observation.value,
        nearestRole: matchedRole,
        delta: 0,
        occurrences: observation.occurrences,
        examples: [...observation.examples],
      });
      continue;
    }
    candidates.push(observation);
  }

  return { candidates, migrations };
}

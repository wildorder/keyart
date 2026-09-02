import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  isConceptIdentifier,
  scanText,
  scanRepository,
  type CleanBreakViolation,
} from "./clean-break-scan.js";

// The real `src/` root, resolved relative to THIS test file's own location.
const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

let fixtureRoot: string;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-clean-break-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

async function writeFixture(rel: string, content: string): Promise<void> {
  const abs = path.join(fixtureRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe("clean-break scan (SC-13) — the remove-concept terminal state", () => {
  it("7. the real src/ tree has ZERO violations (the R-8 terminal state)", async () => {
    const violations = await scanRepository(SRC_ROOT);
    const message =
      violations
        .map((v) => `${v.file}${v.line !== undefined ? `:${v.line}` : ""} [${v.kind}] ${JSON.stringify(v.text)}`)
        .join("\n") +
      "\n^ unswept clean-break matches. The concept layer was removed with no " +
      "migrator; do not reintroduce its vocabulary — rename the identifier, " +
      "string, or path segment instead of relaxing this scan.";
    expect(violations, message).toEqual([]);
  });

  it("8. the identifier predicate is word-boundary containment with the lowercase-only lookahead", () => {
    // Matches: the segment ends at `Concept` (uppercase follows / digit follows
    // / end of string), plus exact `conceptId`.
    expect(isConceptIdentifier("ConceptRecord")).toBe(true); // uppercase follows
    expect(isConceptIdentifier("DashboardConcept")).toBe(true); // end of string
    expect(isConceptIdentifier("SomeConcept2")).toBe(true); // digit follows — the Replan #7 case
    expect(isConceptIdentifier("ConceptStatus")).toBe(true);
    expect(isConceptIdentifier("conceptId")).toBe(true);
    // Non-matches: a following lowercase letter continues the word; unrelated
    // identifiers never match.
    expect(isConceptIdentifier("Conceptual")).toBe(false);
    expect(isConceptIdentifier("ConceptuallyDifferent")).toBe(false);
    expect(isConceptIdentifier("conceptual")).toBe(false);
    expect(isConceptIdentifier("aConcertId")).toBe(false);
    expect(isConceptIdentifier("DirectionRecord")).toBe(false);
  });

  it("9. scanText flags concept identifiers; a clean source yields none", () => {
    const violations = scanText(
      "interface ConceptRecord { conceptId: string }",
      "x.ts",
    );
    const identifierTexts = violations
      .filter((v) => v.kind === "identifier")
      .map((v) => v.text);
    expect(identifierTexts).toContain("ConceptRecord");
    expect(identifierTexts).toContain("conceptId");

    expect(scanText("interface DirectionRecord {}", "x.ts")).toEqual([]);
  });

  it("10. scanText flags a concept string literal, including a concatenated template path", () => {
    const literal = scanText('const p = "brand/concepts/warm"', "x.ts");
    expect(literal.some((v) => v.kind === "string-literal")).toBe(true);

    // Template chunks are checked individually, so the `concepts/` segment of a
    // concatenated path is caught.
    const template = scanText("const p = `${root}/concepts/${id}`", "x.ts");
    expect(template.some((v) => v.kind === "string-literal")).toBe(true);

    const clean = scanText('const c = "#ff5722"', "x.ts");
    expect(clean.filter((v) => v.kind === "string-literal")).toEqual([]);
  });

  it("11. scanText flags a concept import specifier; a direction import passes", () => {
    const flagged = scanText('import { X } from "../concept/store"', "x.ts");
    expect(flagged.some((v) => v.kind === "import-specifier")).toBe(true);

    const clean = scanText('import { X } from "../direction/store"', "x.ts");
    expect(clean.filter((v) => v.kind === "import-specifier")).toEqual([]);
  });

  it("12. scanRepository flags a concept-bearing PATH even when content is clean — any extension", async () => {
    await writeFixture("foo/concept.test.ts", "export const x = 1;\n");
    await writeFixture("styles/concept.css", "body { color: red; }\n");
    await writeFixture("bar/direction.ts", "export const y = 2;\n");

    const violations = await scanRepository(fixtureRoot);
    const pathViolations = violations.filter((v) => v.kind === "path-segment");
    // BOTH the clean-content TypeScript file and the non-TypeScript file fail
    // on their pathname alone (Replan #6 — the every-extension walk), each with
    // no line number.
    expect(
      pathViolations.some((v) => v.file.endsWith("foo/concept.test.ts")),
    ).toBe(true);
    expect(
      pathViolations.some((v) => v.file.endsWith("styles/concept.css")),
    ).toBe(true);
    expect(pathViolations.every((v) => v.line === undefined)).toBe(true);
    // The clean file at a clean path yields nothing.
    expect(violations.some((v) => v.file.endsWith("bar/direction.ts"))).toBe(false);
  });

  it("13. the content self-exemption is FULL-relative-path, content-only — and swallows no other file", async () => {
    // (i) A file merely NAMED clean-break-scan.ts at a different relative path
    // earns no exemption — its ConceptRecord fixture IS flagged.
    await writeFixture(
      "helper/clean-break-scan.ts",
      "export interface ConceptRecord { id: string }\n",
    );
    // (ii) A sibling helper with the same identifier is flagged too.
    await writeFixture(
      "helper/helper.ts",
      "export type ConceptRecord = { id: string };\n",
    );

    const violations = await scanRepository(fixtureRoot);
    const identifierFiles = violations
      .filter((v) => v.kind === "identifier" && v.text === "ConceptRecord")
      .map((v) => v.file);
    expect(
      identifierFiles.some((f) => f.endsWith("helper/clean-break-scan.ts")),
    ).toBe(true);
    expect(identifierFiles.some((f) => f.endsWith("helper/helper.ts"))).toBe(true);

    // (iii) The real scanner + this test — which necessarily contain the
    // forbidden token as patterns and fixtures — produce NO content violations
    // in the real-tree run (case 7 already asserted zero overall; here we
    // assert the exemption is what makes that possible, by proving both files
    // DO contain content the scanner would otherwise flag).
    const scannerSource = await fs.readFile(
      path.join(SRC_ROOT, "integration", "clean-break-scan.ts"),
      "utf-8",
    );
    expect(scanText(scannerSource, "not-exempt.ts").length).toBeGreaterThan(0);
    const realTree: CleanBreakViolation[] = await scanRepository(SRC_ROOT);
    expect(
      realTree.filter(
        (v) =>
          v.file === "src/integration/clean-break-scan.ts" ||
          v.file === "src/integration/clean-break.test.ts",
      ),
    ).toEqual([]);
  });
});

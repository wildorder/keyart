import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

/**
 * The AST-based clean-break scanner (WS-14, SC-13/SC-02): proves the terminal
 * zero-match state of the `remove-concept` program over the real `src/` tree.
 *
 * Two layers:
 * - CONTENT (`scanText`, `.ts`/`.tsx` only — only those parse as TypeScript):
 *   identifiers matching the word-boundary predicate, string literals (and
 *   template text) containing a `concept` substring case-insensitively, and
 *   import/export module specifiers containing `concept`.
 * - PATH SEGMENTS (`scanRepository`, EVERY file regardless of extension, no
 *   directory excluded but `node_modules`): any path segment containing
 *   `concept` case-insensitively — a clean-content `concept.css` still fails.
 *
 * The ONLY exemption: the scanner's own two files are content-exempt (they
 * necessarily contain the forbidden token as patterns and test fixtures),
 * matched by FULL RELATIVE PATH — never by basename — and they remain subject
 * to the path-segment check like everything else.
 *
 * Lives under `src/integration/` so `tsconfig.build.json`'s wholesale exclusion
 * keeps the runtime `typescript` import out of `dist/` (the
 * `package-contents.test.ts` devDependency guard).
 *
 * Pure over the compiler API — no network, no clock.
 */

export interface CleanBreakViolation {
  file: string; // repo-relative path (forward slashes)
  kind: "identifier" | "string-literal" | "import-specifier" | "path-segment";
  text: string; // the offending identifier / literal / specifier / path segment
  line?: number; // 1-based; omitted for path-segment violations
}

/**
 * The word-boundary identifier predicate. True iff `name` matches
 * `/Concept(?![a-z])/` — the PascalCase segment ends at `Concept` when what
 * follows is NOT a lowercase letter (a following uppercase letter starts a new
 * segment, a following digit is a numeric suffix, end-of-string ends the word;
 * only a following lowercase letter continues the word) — OR is exactly
 * `conceptId`. So `ConceptRecord`, `DashboardConcept`, `SomeConcept2`, and
 * `conceptId` all match, while `Conceptual`/`ConceptuallyDifferent` do not.
 * No lookbehind (Replan #7): `DashboardConcept` must match.
 */
export function isConceptIdentifier(name: string): boolean {
  return /Concept(?![a-z])/.test(name) || name === "conceptId";
}

const FORBIDDEN_SUBSTRING = /concept/i;

/**
 * Parse `sourceText` as a TS source file at `filePath` and return every CONTENT
 * violation. Pure; never touches the filesystem. Path-segment logic lives in
 * {@link scanRepository} (which sees every extension), not here.
 */
export function scanText(
  sourceText: string,
  filePath: string,
): CleanBreakViolation[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const violations: CleanBreakViolation[] = [];

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isConceptIdentifier(node.text)) {
      violations.push({
        file: filePath,
        kind: "identifier",
        text: node.text,
        line: lineOf(node),
      });
    }

    if (ts.isStringLiteralLike(node) && FORBIDDEN_SUBSTRING.test(node.text)) {
      violations.push({
        file: filePath,
        kind: "string-literal",
        text: node.text,
        line: lineOf(node),
      });
    }

    // Template expressions: check each head/middle/tail chunk so a concatenated
    // path segment (e.g. `${root}/concepts/${id}`) is caught.
    if (
      (ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      FORBIDDEN_SUBSTRING.test(node.text)
    ) {
      violations.push({
        file: filePath,
        kind: "string-literal",
        text: node.text,
        line: lineOf(node),
      });
    }

    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      FORBIDDEN_SUBSTRING.test(node.moduleSpecifier.text)
    ) {
      violations.push({
        file: filePath,
        kind: "import-specifier",
        text: node.moduleSpecifier.text,
        line: lineOf(node.moduleSpecifier),
      });
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return violations;
}

/** The scanner's own two files — content-exempt by FULL relative path (walk-root
 *  relative, forward slashes), never by basename. Path-segment checks still apply. */
const CONTENT_EXEMPT_RELATIVE_PATHS = new Set([
  "integration/clean-break-scan.ts",
  "integration/clean-break.test.ts",
]);

function toForward(p: string): string {
  return p.split(path.sep).join("/");
}

async function walkFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/**
 * Walk EVERY file under `srcRoot` — every extension, `src/integration/`
 * included, no directory excluded (skip only `node_modules`). Every file gets
 * the PATH-SEGMENT check (no exemptions); every `.ts`/`.tsx` file except the
 * scanner's own two (matched by full `srcRoot`-relative path, forward slashes)
 * also gets the CONTENT check. Returned `file` paths are `src/<relative>`
 * (forward slashes), sorted by `(file, line ?? 0)`.
 */
export async function scanRepository(
  srcRoot: string,
): Promise<CleanBreakViolation[]> {
  const absFiles: string[] = [];
  await walkFiles(path.resolve(srcRoot), absFiles);

  const violations: CleanBreakViolation[] = [];
  for (const abs of absFiles) {
    const rel = toForward(path.relative(path.resolve(srcRoot), abs));
    const reported = `src/${rel}`;

    // Path-segment check — every file, every extension, NO exemptions.
    for (const segment of rel.split("/")) {
      if (FORBIDDEN_SUBSTRING.test(segment)) {
        violations.push({ file: reported, kind: "path-segment", text: segment });
      }
    }

    // Content check — .ts/.tsx only, minus the scanner's own two files.
    const isTypeScript = rel.endsWith(".ts") || rel.endsWith(".tsx");
    if (!isTypeScript || CONTENT_EXEMPT_RELATIVE_PATHS.has(rel)) continue;

    const sourceText = await fs.readFile(abs, "utf-8");
    for (const v of scanText(sourceText, reported)) {
      violations.push(v);
    }
  }

  violations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return violations;
}

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface PackedFile {
  path: string;
  size: number;
}
interface PackResult {
  files: PackedFile[];
  entryCount: number;
  unpackedSize: number;
}

function packManifest(): PackResult {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    // npm prints notices on stderr; only stdout carries the JSON.
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  // Newer npm versions append human-readable notice/warn text around the
  // JSON on stdout (seen with npm@latest in the release workflow): drop
  // npm-prefixed lines, then parse exactly the bracketed span.
  const clean = stdout
    .split("\n")
    .filter((line) => !/^npm (notice|warn|error)\b/.test(line))
    .join("\n");
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  return JSON.parse(clean.slice(start, end + 1))[0] as PackResult;
}

/** Fails loudly (never skips) if `dist/` was never built. */
function assertBuilt(root: string): void {
  if (!fsSync.existsSync(path.join(root, "dist", "cli.js"))) {
    throw new Error(
      "dist/ is not built — run `npm run build` before `vitest run`. " +
        "(The canonical gate is `npm run build && npx tsc --noEmit && npx vitest run`.)",
    );
  }
}

/** Module-scope `import`/`export ... from` specifiers. Deliberately does NOT match
 *  `await import(...)` — a dynamic import is exactly the escape hatch this guard blesses. */
function moduleScopeSpecifiers(source: string): string[] {
  const out: string[] = [];
  // `[^;(`[]]*?` spans newlines, so multi-line named-import lists are covered, but
  // excludes `(`, backtick, and `[` so the lazy span can never leak past a semicolon-less
  // `export function foo() {` into the function body and false-match a "from" inside an
  // unrelated string literal or template deeper in the file.
  const fromRe = /(?:^|\n)(?:import|export)\b[^;(`[]*?\bfrom\s*["']([^"']+)["']/g;
  const sideEffectRe = /(?:^|\n)import\s*["']([^"']+)["']/g;
  for (const re of [fromRe, sideEffectRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
  }
  return out;
}

/** Bare specifier → package name ("@scope/pkg/sub" → "@scope/pkg", "pkg/sub" → "pkg"). */
function packageNameOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  if (isBuiltin(spec)) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Scans one file's source for module-scope imports that resolve to a package
 * outside `dependencies` and returns offender strings naming the file, the
 * specifier, and where the package actually lives.
 */
function scanSource(
  file: string,
  source: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): string[] {
  const offenders: string[] = [];
  for (const spec of moduleScopeSpecifiers(source)) {
    const pkg = packageNameOf(spec);
    if (pkg === null) continue;
    if (pkg in dependencies) continue;
    const section = pkg in devDependencies ? "a devDependency" : "not a declared dependency";
    offenders.push(`${file} imports ${spec} (${section})`);
  }
  return offenders;
}

// dist/ui/** is excluded: it is browser-side React source compiled by a separate Vite
// build, so it legitimately imports `react` at module scope — that code runs in the
// browser via Vite, never through Node's ESM resolver. This workstream makes no
// assertion about dist/ui (WS-02 owns its packaging).
const SCANNED = (f: string) =>
  f.startsWith("dist/") && f.endsWith(".js") && !f.startsWith("dist/ui/");

describe("packaged contents (floor)", () => {
  beforeAll(() => {
    assertBuilt(repoRoot);
  });

  it("the ./server subpath entrypoint ships with the NOTICE file", () => {
    const manifest = packManifest();
    const paths = manifest.files.map((f) => f.path);

    expect(paths).toContain("dist/server.js");
    expect(paths).toContain("dist/server.d.ts");
    expect(paths).toContain("NOTICE");
  });

  it("required entrypoints ship", () => {
    const manifest = packManifest();
    const paths = manifest.files.map((f) => f.path);

    expect(paths).toContain("dist/cli.js");
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("bin/keyart.js");
    expect(paths.some((p) => p.startsWith("templates/"))).toBe(true);
  });

  it("the studio bundle ships (SC-03/SC-07)", () => {
    const manifest = packManifest();
    const paths = manifest.files.map((f) => f.path);

    expect(paths).toContain("dist/ui/index.html");
    const hashedAssets = paths.filter((p) => /^dist\/ui\/assets\/.+\.(js|css)$/.test(p));
    expect(hashedAssets.length).toBeGreaterThan(0);
  });

  it("package.json entry fields are populated", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
      bin: Record<string, string>;
      main: string;
      types: string;
      exports: Record<string, { import?: string }>;
      engines: Record<string, string>;
    };

    expect(pkg.bin.keyart).toBe("./bin/keyart.js");
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types.endsWith(".d.ts")).toBe(true);
    expect(pkg.exports["."].import).toBeTruthy();
    expect(typeof pkg.engines.node).toBe("string");
    expect(pkg.engines.node.length).toBeGreaterThan(0);
  });

  it("no module-scope import in packed dist/** resolves to a devDependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const manifest = packManifest();

    const offenders: string[] = [];
    let scannedCount = 0;
    for (const file of manifest.files) {
      if (!SCANNED(file.path)) continue;
      scannedCount++;
      const source = readFileSync(path.join(repoRoot, file.path), "utf-8");
      offenders.push(...scanSource(file.path, source, pkg.dependencies, pkg.devDependencies));
    }

    expect(offenders).toEqual([]);
    // A scan over an empty set is a vacuous pass — prove the scan actually ran.
    expect(scannedCount).toBeGreaterThan(0);
  });

  it("the guard actually bites — a synthetic offender is caught", () => {
    const fixture = [
      'import { createServer } from "vite";',
      'import { z } from "zod";',
      'const x = await import("vite");',
    ].join("\n");
    const dependencies = { zod: "^3.25.76" };
    const devDependencies = { vite: "^6.4.3" };

    const offenders = scanSource("dist/fixture.js", fixture, dependencies, devDependencies);

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("vite");
    expect(offenders.some((o) => o.includes("zod"))).toBe(false);
  });

  it("builtins and relative specifiers are never flagged", () => {
    const fixture = [
      'import fs from "node:fs";',
      'import path from "path";',
      'import { x } from "./local.js";',
    ].join("\n");
    const dependencies = {};
    const devDependencies = {};

    const offenders = scanSource("dist/fixture.js", fixture, dependencies, devDependencies);

    expect(offenders).toEqual([]);
  });

  it("multi-line named imports are scanned", () => {
    const fixture = [
      "import {",
      "  a,",
      "  b,",
      '} from "@vitejs/plugin-react";',
    ].join("\n");
    const dependencies = {};
    const devDependencies = { "@vitejs/plugin-react": "^4.7.0" };

    const offenders = scanSource("dist/fixture.js", fixture, dependencies, devDependencies);

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("@vitejs/plugin-react");
  });

  it("an unbuilt tree fails loudly rather than skipping", () => {
    const rootWithoutDist = path.join(repoRoot, "src");
    expect(() => assertBuilt(rootWithoutDist)).toThrow(/npm run build/);
  });

  // --- Extended by WS-02 (dist/ui) and WS-03 (exclusions, license/metadata) ---
});

describe("packaged contents (WS-03: license & metadata)", () => {
  beforeAll(() => {
    assertBuilt(repoRoot);
  });

  it("compiled test files never re-enter the tarball", () => {
    const manifest = packManifest();
    const offending = manifest.files
      .map((f) => f.path)
      .filter((p) => /\.test\.(js|d\.ts)$/.test(p));

    expect(offending).toEqual([]);
  });

  it("dist/integration/** never ships", () => {
    const manifest = packManifest();
    const offending = manifest.files
      .map((f) => f.path)
      .filter((p) => p.startsWith("dist/integration/"));

    expect(offending).toEqual([]);
  });

  it("LICENSE and README.md ship", () => {
    const manifest = packManifest();
    const paths = manifest.files.map((f) => f.path);

    expect(paths).toContain("LICENSE");
    expect(paths).toContain("README.md");
  });

  it("every required metadata field is populated, and the license matches the file", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
      license: string;
      description: string;
      keywords: string[];
      author: string;
      repository: { url: string };
      homepage: string;
      bugs: { url: string };
    };
    const license = readFileSync(path.join(repoRoot, "LICENSE"), "utf-8");

    expect(pkg.license).toBe("Apache-2.0");
    expect(license).toContain("Apache License");
    expect(license).toContain("Copyright 2026 Tim OConnell");

    expect(typeof pkg.description).toBe("string");
    expect(pkg.description.length).toBeGreaterThan(0);
    expect(pkg.description.length).toBeLessThanOrEqual(160);

    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect(pkg.keywords.length).toBeGreaterThanOrEqual(5);
    expect(pkg.keywords).toContain("branding");
    expect(pkg.keywords).toContain("mcp");

    expect(typeof pkg.author).toBe("string");
    expect(pkg.author.length).toBeGreaterThan(0);

    expect(pkg.repository.url.length).toBeGreaterThan(0);
    expect(pkg.homepage.length).toBeGreaterThan(0);
    expect(pkg.bugs.url.length).toBeGreaterThan(0);

    const slugMatch = pkg.repository.url.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
    expect(slugMatch).not.toBeNull();
    const slug = slugMatch![1];
    expect(pkg.homepage).toContain(slug);
    expect(pkg.bugs.url).toContain(slug);
  });

  it("the description carries no internal vocabulary", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
      description: string;
    };
    const banned = [
      "inverted spine",
      "composeartdirection",
      "assemblecontext",
      "two-tier",
      "facade",
    ];

    for (const term of banned) {
      expect(pkg.description.toLowerCase()).not.toContain(term);
    }
  });

  it("the required entrypoints still ship after the narrowing", () => {
    const manifest = packManifest();
    const paths = manifest.files.map((f) => f.path);

    expect(paths).toContain("dist/cli.js");
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("bin/keyart.js");
    expect(paths.some((p) => p.startsWith("templates/"))).toBe(true);
    expect(paths).toContain("dist/ui/index.html");
  });

  it("prepublishOnly and test:package are declared and wired", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.prepublishOnly).toContain("npm run build");
    expect(pkg.scripts.prepublishOnly).toContain("npm test");
    expect(pkg.scripts.prepublishOnly).toContain("npm run test:package");
    expect(pkg.scripts["test:package"]).toBeTruthy();
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
    expect(pkg.scripts.build).toContain("tsconfig.build.json");
  });
});

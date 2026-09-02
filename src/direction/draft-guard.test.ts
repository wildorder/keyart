import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandError } from "../errors.js";
import { assertDirectionHasVersions } from "./draft-guard.js";

describe("assertDirectionHasVersions", () => {
  it("refuses a draft with a teaching error naming the id and the explore fix", () => {
    let thrown: unknown;
    try {
      assertDirectionHasVersions("warm", null);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CommandError);
    const message = (thrown as CommandError).message;
    expect(message).toContain("warm");
    expect(message).toContain("keyart explore warm");
  });

  it("returns undefined (no throw) for a direction with a head version", () => {
    expect(assertDirectionHasVersions("warm", "v1")).toBeUndefined();
  });
});

describe("draft-guard import membership (R-2/R-3/R-4 fence)", () => {
  const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

  async function sourceFilesImporting(needle: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
          continue;
        }
        const content = await readFile(full, "utf8");
        if (content.includes(needle)) {
          out.push(path.relative(SRC_DIR, full).replaceAll("\\", "/"));
        }
      }
    }
    await walk(SRC_DIR);
    return out.sort();
  }

  it("is imported by exactly the four caller-direction-targeted consumers — never by pointer-addressed commands", async () => {
    // R-2/R-3: audit and surface bind/fill take no direction argument, so a
    // draft is not a representable input to them — they must never gain the
    // guard. R-4: asset pack's guard covers only the explicit-id branch.
    const importers = (await sourceFilesImporting("draft-guard.js")).filter(
      (file) => file !== "direction/draft-guard.ts",
    );
    expect(importers).toEqual([
      "asset/extract.ts",
      "asset/pack.ts",
      "commands/approve.ts",
      "commands/regenerate-visuals.ts",
    ]);
  });
});

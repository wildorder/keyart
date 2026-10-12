import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveFoundation } from "./foundation.js";
import { createDirectionCore } from "./core.js";
import { createBrandCore } from "../brand/core.js";
import { directionsRoot, globalBrandPath } from "../config.js";
import { buildPlaceholderDirections } from "../explore/placeholders.js";
import { writeDirectionVersion } from "../explore/write-direction-version.js";
import type { KeyartConfig } from "../types.js";

let cwd: string;
let config: KeyartConfig;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-foundation-"));
  config = { project: { name: "Foundation", type: "test", framework: "none" },
    brand: { root: "brand", references: "brand/references", approved: "brand/approved", rejected: "brand/rejected" },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" }, outputs: { cursorRules: ".cursor/rules", cssVars: "brand/brand.css", implementationBrief: "brand/implementation.md" } };
  await createDirectionCore(cwd, config).create({ id: "alpha", name: "Alpha" });
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

async function write(id: string, briefSnapshot = "Original brief") {
  return writeDirectionVersion({ cwd, config, directionsDir: directionsRoot(cwd, config), directionId: "alpha",
    version: { ...buildPlaceholderDirections(briefSnapshot)[0], id, createdAt: "2026-10-10T00:00:00Z",
      briefSnapshot, contextSnapshot: "Original context" },
    referenceImagePaths: [], skipImages: true });
}

describe("immutable foundation", () => {
  it("pins frozen facts and tile after the live brief/head change, leaving historical bytes and approval intact", async () => {
    const first = await write("v1");
    await fs.writeFile(path.join(first.versionDir, "style-tile.png"), "old tile");
    await createBrandCore(cwd, config).setPointer({ directionId: "alpha", versionId: "v1" });
    const before = await fs.readFile(path.join(first.versionDir, "direction-version.json"), "utf8");
    const approval = await fs.readFile(globalBrandPath(cwd, config), "utf8");
    await createDirectionCore(cwd, config).setBriefFields("alpha", { oneLiner: "Changed working brief" });
    const next = await write("v2", "Newer brief");
    await fs.writeFile(path.join(next.versionDir, "style-tile.png"), "new tile");
    const foundation = await resolveFoundation({ cwd, config, directionId: "alpha", versionId: "v1" });
    expect(foundation.briefSnapshot).toBe("Original brief");
    expect(foundation.content.contextSnapshot).toBe("Original context");
    expect(foundation.tilePath).toBe(path.join(first.versionDir, "style-tile.png"));
    expect(foundation.imageReady).toBe(true);
    expect(Object.isFrozen(foundation.content.character)).toBe(true);
    expect(() => { foundation.content.summary = "mutate"; }).toThrow();
    expect(await fs.readFile(path.join(first.versionDir, "direction-version.json"), "utf8")).toBe(before);
    expect(await fs.readFile(globalBrandPath(cwd, config), "utf8")).toBe(approval);
  });

  it("missing tile is an explicit pending foundation even when a later tile exists", async () => {
    await write("v1");
    const second = await write("v2");
    await fs.writeFile(path.join(second.versionDir, "style-tile.png"), "new tile");
    const old = await resolveFoundation({ cwd, config, directionId: "alpha", versionId: "v1" });
    expect(old.tilePath).toBeNull();
    expect(old.imageReady).toBe(false);
    expect(old.tokens).toBeDefined();
  });

  it("rejects drafts, foreign versions and traversal rather than substituting a version", async () => {
    await expect(resolveFoundation({ cwd, config, directionId: "alpha", versionId: "v1" })).rejects.toThrow("Generate v1");
    await write("v1");
    await createDirectionCore(cwd, config).create({ id: "beta", name: "Beta" });
    await expect(resolveFoundation({ cwd, config, directionId: "beta", versionId: "v1" })).rejects.toThrow("history");
    for (const versionId of ["../alpha/versions/v1", "..\\v1", "C:\\v1", ""]) {
      await expect(resolveFoundation({ cwd, config, directionId: "alpha", versionId })).rejects.toThrow();
    }
    await expect(resolveFoundation({ cwd, config, directionId: "../alpha", versionId: "v1" })).rejects.toThrow("Invalid direction");
  });

  it("unsupported snapshot remains untouched and cannot inherit the live brief", async () => {
    const first = await write("v1");
    const file = path.join(first.versionDir, "direction-version.json");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    delete value.briefSnapshot;
    const old = JSON.stringify(value);
    await fs.writeFile(file, old);
    await expect(resolveFoundation({ cwd, config, directionId: "alpha", versionId: "v1" })).rejects.toThrow("Unsupported foundation");
    expect(await fs.readFile(file, "utf8")).toBe(old);
  });

  it("rejects a sibling junction masquerading as another direction without touching its records", async () => {
    const first = await write("v1");
    const file = path.join(first.versionDir, "direction-version.json");
    const before = await fs.readFile(file, "utf8");
    const root = directionsRoot(cwd, config);
    const alias = path.join(root, "beta");
    await fs.symlink(path.join(root, "alpha"), alias, "junction");
    try {
      await expect(resolveFoundation({ cwd, config, directionId: "beta", versionId: "v1" })).rejects.toThrow("identity");
      expect(await fs.readFile(file, "utf8")).toBe(before);
    } finally {
      await fs.unlink(alias);
    }
  });
});

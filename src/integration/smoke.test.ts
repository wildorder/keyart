import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runInit } from "../commands/init.js";
import { runExplore } from "../commands/explore.js";
import { runApprove } from "../commands/approve.js";
import { runBrief } from "../commands/brief.js";
import { readHead } from "../direction/store.js";
import type { DirectionVersion } from "../types.js";
import type { KeyartConfig } from "../types.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

let tmpDir: string;

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Smoke Test", type: "prototype", framework: "next" },
    brand: {
      root: path.join(cwd, "brand"),
      references: path.join(cwd, "brand", "input", "references"),
      approved: path.join(cwd, "brand", "approved"),
      rejected: path.join(cwd, "brand", "rejected"),
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: path.join(cwd, ".cursor", "rules", "keyart-brand.mdc"),
      cssVars: path.join(cwd, "brand", "generated", "brand.css"),
      implementationBrief: path.join(cwd, "brand", "generated", "implementation-brief.md"),
    },
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-smoke-"));
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function exists(relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(tmpDir, relPath));
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(relPath: string): Promise<T> {
  const raw = await fs.readFile(path.join(tmpDir, relPath), "utf-8");
  return JSON.parse(raw) as T;
}

describe("smoke: full CLI workflow (dry-run, no network)", () => {
  it("init → explore → approve → brief produces expected files", async () => {
    // 1. Init
    await runInit({ cwd: tmpDir });
    expect(await exists("keyart.config.ts")).toBe(true);
    expect(await exists("brand/directions/default/brief.md")).toBe(true);
    expect(await exists("brand/directions/default/direction.yaml")).toBe(true);

    // Mock loadConfig since the scaffolded config can't be imported in tests
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    // 2. Explore — positional explore writes one dry-run placeholder v1 INTO
    //    the existing "default" draft (WS-16: siblings come from --from/--describe;
    //    WS-01 layout: directions/<id>/versions/<versionId>/, no runs/).
    const exploreResult = await runExplore({
      cwd: tmpDir,
      directionId: "default",
    });
    expect(exploreResult.direction).toBe("default");
    expect(exploreResult.directionIds).toEqual(["default"]);
    expect(exploreResult.floorCount).toBe(0);

    const directionId = exploreResult.directionIds[0];
    const directionsDir = path.join(
      tmpDir,
      "brand",
      "directions",
    );

    // Resolve the head version of the first direction and verify its version
    // folder was written with the frozen snapshots + prompts.
    const version = await readHead(directionsDir, directionId);
    const versionPrefix = `brand/directions/${directionId}/versions/${version.id}`;
    expect(await exists(`${versionPrefix}/direction-version.json`)).toBe(true);
    expect(await exists(`${versionPrefix}/style-tile-prompt.md`)).toBe(true);
    expect(await exists(`${versionPrefix}/homepage-mockup-prompt.md`)).toBe(true);

    // brief-snapshot.md is byte-identical to the direction brief at explore time.
    const snapshotBytes = await fs.readFile(
      path.join(tmpDir, `${versionPrefix}/brief-snapshot.md`),
    );
    const directionBriefBytes = await fs.readFile(
      path.join(tmpDir, "brand/directions/default/brief.md"),
    );
    expect(snapshotBytes.equals(directionBriefBytes)).toBe(true);

    // The head version carries the first placeholder direction's content.
    expect(version.name).toBe("Bold & Modern");

    // 3. Approve — pins the direction's head version and codifies the brand.
    await runApprove({ cwd: tmpDir, directionId, force: true });

    // Check approved artifacts
    expect(await exists("brand/approved/current-direction.json")).toBe(true);
    const approved = await readJson<
      DirectionVersion & { provenance?: { directionId: string; versionId: string } }
    >("brand/approved/current-direction.json");
    expect(approved.name).toBe("Bold & Modern");
    expect(approved.provenance?.directionId).toBe(directionId);
    expect(approved.provenance?.versionId).toBe(version.id);

    // Guides
    expect(await exists("brand/guides/visual-style-guide.md")).toBe(true);
    expect(await exists("brand/guides/brand-guide.md")).toBe(true);

    // Generated artifacts
    expect(await exists("brand/generated/cursor-brand.mdc")).toBe(true);
    expect(await exists("brand/generated/image-prompts.md")).toBe(true);
    expect(await exists("brand/generated/implementation-brief.md")).toBe(true);
    expect(await exists("brand/generated/brand.css")).toBe(true);

    // Cursor rules path from config
    expect(await exists(".cursor/rules/keyart-brand.mdc")).toBe(true);

    // 4. Brief
    await runBrief({ cwd: tmpDir, pageName: "home", force: true });

    expect(await exists("brand/generated/page-briefs/home.md")).toBe(true);
    const pageBrief = await fs.readFile(
      path.join(tmpDir, "brand/generated/page-briefs/home.md"),
      "utf-8",
    );
    expect(pageBrief).toContain("Page Brief: home");
    expect(pageBrief).toContain("Cursor prompt");
  });
});

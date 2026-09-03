import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { groupOf, helpIndex } from "../mcp/registry.js";

// --- repo paths ------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url)); // src/integration (or dist/integration)
const repoRoot = path.resolve(here, "..", "..");
const binPath = path.join(repoRoot, "bin", "keyart.js");

// --- Node version gate -----------------------------------------------------
// The spawned child is plain Node running dist/. loadConfig() dynamically
// import()s the consuming project's keyart.config.ts; importing a .ts module
// in plain Node requires native type-stripping, which is on by default from
// Node 22.18. On older Node the child cannot load the config, so we skip rather
// than fail.
const SKIP_REASON =
  "requires Node >= 22.18 for .ts config import in child process";

function nodeMajorMinorBelow(threshold: string): boolean {
  const [tMaj, tMin] = threshold.split(".").map(Number);
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < tMaj) return true;
  if (maj > tMaj) return false;
  return min < tMin;
}

const NODE_OK = !nodeMajorMinorBelow("22.18");
if (!NODE_OK) {
  // eslint-disable-next-line no-console
  console.warn(`[mcp.test] Skipping MCP stdio integration: ${SKIP_REASON}`);
}

// --- helpers ---------------------------------------------------------------
function textOf(res: CallToolResult): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

/** Newest mtime (ms) of any *.ts file under `dir`, recursively. */
function newestTsMtime(dir: string): number {
  let newest = 0;
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestTsMtime(full));
    } else if (entry.name.endsWith(".ts")) {
      newest = Math.max(newest, fsSync.statSync(full).mtimeMs);
    }
  }
  return newest;
}

/** Build dist/ if cli.js is missing or older than the newest src file. */
function ensureBuilt(): void {
  const distCli = path.join(repoRoot, "dist", "cli.js");
  let needsBuild = false;
  try {
    const distMtime = fsSync.statSync(distCli).mtimeMs;
    const srcMtime = newestTsMtime(path.join(repoRoot, "src"));
    needsBuild = srcMtime > distMtime;
  } catch {
    needsBuild = true; // dist missing
  }
  if (needsBuild) {
    execSync("npm run build", {
      cwd: repoRoot,
      stdio: "inherit",
      timeout: 120_000,
    });
  }
}

// Dependency-free, annotation-free config (valid under Node type-stripping):
// the scaffolded template imports defineKeyartConfig from "@wildorder/keyart", which
// is not resolvable inside a tmp project, so we overwrite it before `explore`.
const ITEST_CONFIG = `export default {
  project: { name: "MCP ITest", type: "prototype", framework: "next" },
  brand: { root: "./brand", references: "./brand/input/references", approved: "./brand/approved", rejected: "./brand/rejected" },
  models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
  outputs: { cursorRules: ".cursor/rules/keyart-brand.mdc", cssVars: "brand/generated/brand.css", implementationBrief: "brand/generated/implementation-brief.md" },
};
`;

// ---------------------------------------------------------------------------
describe.skipIf(!NODE_OK)("mcp integration (real stdio)", () => {
  let tmpDir: string;
  let client: Client;
  let exploreText = ""; // captured in test 6, asserted in test 7
  let directionId = ""; // captured in the explore test, reused by regenerate/approve

  async function pathExists(rel: string): Promise<boolean> {
    try {
      await fs.access(path.join(tmpDir, rel));
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    ensureBuilt();

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-mcp-"));

    // Genuinely dry-run: strip OPENAI_API_KEY from this process and the child env.
    delete process.env.OPENAI_API_KEY;
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "OPENAI_API_KEY") childEnv[k] = v;
    }

    const transport = new StdioClientTransport({
      command: process.execPath, // node — cross-platform, no shell
      args: [binPath, "mcp"],
      cwd: tmpDir,
      env: childEnv,
    });
    client = new Client({ name: "keyart-itest", version: "0.0.0" });
    await client.connect(transport);
  }, 180_000);

  afterAll(async () => {
    if (client) await client.close(); // terminates the child process
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // 1. tools/list (SC-06)
  it("exposes exactly the four capability facades", async () => {
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "keyart_brand",
      "keyart_help",
      "keyart_implement",
      "keyart_setup",
    ]);
    expect(names).not.toContain("keyart_run");

    for (const t of tools) {
      const desc = t.description ?? "";
      expect(desc.length).toBeGreaterThan(0);
      expect(desc.length).toBeLessThan(800);
    }
  });

  // 2. facade catalogs (SC-06) — each facade names its own commands so an agent
  // self-selects Keyart by domain from the always-on tool list.
  it("each facade description lists its domain's commands", async () => {
    const { tools } = await client.listTools();
    const descOf = (name: string): string =>
      tools.find((t) => t.name === name)?.description ?? "";

    const brand = descOf("keyart_brand");
    expect(brand).toContain("explore");
    expect(brand).toContain("regenerate");
    expect(brand).toContain("approve");
    expect(brand).not.toContain("refine");

    const implement = descOf("keyart_implement");
    expect(implement).toContain("brief");
    expect(implement).toContain("audit");

    const setup = descOf("keyart_setup");
    expect(setup).toContain("init");
    expect(setup).toContain("doctor");
  });

  // 3. help index mode (SC-08) — names the three facades, every command across
  // groups, and the progressive command/group/workflow pointers.
  it("keyart_help with no arg lists every command + facade pointers", async () => {
    const res = (await client.callTool({
      name: "keyart_help",
      arguments: {},
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const text = textOf(res);

    for (const tool of ["keyart_brand", "keyart_implement", "keyart_setup"]) {
      expect(text).toContain(tool);
    }
    for (const name of [
      "init",
      "explore",
      "regenerate",
      "approve",
      "brief",
      "audit",
      "serve",
      "direction",
      "rule",
      "promote",
      "doctor",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain("refine");
    // WS-06: the legacy aggregate command never appears, and chat is not a
    // registry command (never listed by keyart_help).
    expect(text).not.toMatch(new RegExp(`\\b${["con", "cept"].join("")}\\b`));
    expect(text).not.toContain("chat");
    // Progressive-help pointers.
    expect(text).toContain("command");
    expect(text).toContain("group");
    expect(text).toContain("workflow");
  });

  // 4. help command mode (SC-08)
  it("keyart_help with a command returns its full doc; bogus errors", async () => {
    const res = (await client.callTool({
      name: "keyart_help",
      arguments: { command: "audit" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("## Usage");
    expect(text).toContain("## Outputs");
    expect(text).toContain("## Examples");
    expect(text).toContain("Playwright");
    expect(text).toMatch(/30\D{1,3}60s/); // the 30–60s duration note

    const bogus = (await client.callTool({
      name: "keyart_help",
      arguments: { command: "bogus" },
    })) as CallToolResult;
    expect(bogus.isError).toBe(true);
    expect(textOf(bogus)).toContain("init, explore, approve, brief, audit, serve");
  });

  // 5. help workflow mode (SC-08)
  it("keyart_help { workflow: true } returns the lifecycle overview", async () => {
    const res = (await client.callTool({
      name: "keyart_help",
      arguments: { workflow: true },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("\n"); // multi-line narrative
    for (const step of ["explore", "approve", "audit"]) {
      expect(text).toContain(step);
    }
  });

  // 6. serve rejection (via facade)
  it("rejects dispatching serve but keeps the server alive", async () => {
    const res = (await client.callTool({
      name: "keyart_setup",
      arguments: { command: "serve" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("npx keyart serve");

    // Follow-up call proves the child process survived the rejected dispatch.
    const alive = (await client.callTool({
      name: "keyart_help",
      arguments: {},
    })) as CallToolResult;
    expect(alive.isError).toBeFalsy();
  });

  // 7. init dispatch (via facade)
  it("dispatches init and scaffolds the project", async () => {
    const res = (await client.callTool({
      name: "keyart_setup",
      arguments: { command: "init" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("Files written");
    expect(text).toContain(".cursor/mcp.json");

    expect(await pathExists("keyart.config.ts")).toBe(true);
    expect(await pathExists("brand/directions/default/brief.md")).toBe(true);
    expect(await pathExists(".cursor/mcp.json")).toBe(true);
  });

  // 8. explore dry-run dispatch (SC-07) — the first leg of the keyless round-trip.
  it("dispatches explore in dry-run and writes direction-version artifacts", async () => {
    // Replace the scaffolded config (unimportable in a tmp project) and give the
    // brief some product text so explore has input.
    await fs.writeFile(
      path.join(tmpDir, "keyart.config.ts"),
      ITEST_CONFIG,
      "utf-8",
    );
    const res = (await client.callTool({
      name: "keyart_brand",
      arguments: {
        command: "explore",
        input: ["--from", "default", "--count", "2"],
      },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    exploreText = textOf(res);
    expect(exploreText).toContain("Files written");
    expect(exploreText).toContain("brand/directions/");

    // On disk: exactly two new top-level siblings beside the default seed
    // direction (no parent folder, run folder, or batch file).
    const directionsDir = path.join(tmpDir, "brand/directions");
    const dirIds = (await fs.readdir(directionsDir)).filter(
      (e) => e !== ".gitkeep" && e !== "default",
    );
    expect(dirIds.length).toBe(2);
    // Capture one directionId for the regenerate → approve legs below.
    directionId = dirIds[0];

    for (const id of dirIds) {
      // Each direction has a v1 index pointing at its head version folder, which
      // carries the frozen brief snapshot + the version record.
      const indexPath = path.join(directionsDir, id, "direction.yaml");
      await expect(fs.access(indexPath)).resolves.toBeUndefined();
      const index = YAML.parse(await fs.readFile(indexPath, "utf-8")) as {
        head: string;
      };
      const versionDir = path.join(directionsDir, id, "versions", index.head);
      await expect(
        fs.access(path.join(versionDir, "brief-snapshot.md")),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(versionDir, "direction-version.json")),
      ).resolves.toBeUndefined();
    }
  });

  // 8b. regenerate <directionId> (SC-09) — the second leg: iterate the direction,
  // appending a new version (head advances) in dry-run.
  it("dispatches regenerate <directionId> and appends a new version", async () => {
    expect(directionId).not.toBe("");
    const res = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "regenerate", input: [directionId] },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("Files written");
    // Reports a new version under the addressed direction (no runId).
    expect(text).toContain(`brand/directions/${directionId}/versions/`);
    expect(text).not.toContain("runId");
  });

  // 8c. approve <directionId> (SC-09) — the third leg: pin the head version and
  // set the global pointer (rebrand). No versionId ⇒ head.
  it("dispatches approve <directionId> and sets the global pointer", async () => {
    const res = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "approve", input: [directionId] },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("Files written");
    expect(text).toContain("brand/brand.yaml");
    expect(text).toContain("brand/approved/current-direction.json");
    expect(text).not.toContain("runId");
  });

  // 8d. refine is gone on the wire (SC-07/SC-09) — dispatching it returns the
  // canonical unknown-command error, and the help index names no refine.
  it("rejects refine with the canonical unknown-command error; help has no refine", async () => {
    const res = (await client.callTool({
      name: "keyart_brand",
      arguments: {
        command: "refine",
        input: ["parent-dir", "direction-a", "--tweak", "warm the type"],
      },
    })) as CallToolResult;
    expect(res.isError).toBeTruthy();
    expect(textOf(res)).toContain('Unknown command "refine"');

    const help = (await client.callTool({
      name: "keyart_help",
      arguments: {},
    })) as CallToolResult;
    expect(textOf(help)).not.toContain("refine");
  });

  // 9. object-input via facade (SC-07) — the forgiving object-input contract:
  // the same command dispatches through a facade whether `input` is an array or
  // a whitespace-splittable string.
  it("accepts both array and string object-input through a facade", async () => {
    const arrayRes = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "direction", input: ["list"] },
    })) as CallToolResult;
    expect(arrayRes.isError).toBeFalsy();
    expect(textOf(arrayRes)).toContain("direction");

    const stringRes = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "direction", input: "list" },
    })) as CallToolResult;
    expect(stringRes.isError).toBeFalsy();
    expect(textOf(stringRes)).toContain("direction");
  });

  // 9b. keyless brief round-trip via keyart_brand (SC-04/SC-09) — an external
  // host agent writes a structured brief field with NO Keyart model call, then
  // re-reads it. The child env has OPENAI_API_KEY stripped, so this proves the
  // deterministic, keyless write surface.
  it("writes and re-reads a brief field via keyart_brand with no key", async () => {
    const value = "the local creative director for AI prototypes";

    const setRes = (await client.callTool({
      name: "keyart_brand",
      arguments: {
        command: "direction",
        input: ["brief", "set", "default", "positioning", value],
      },
    })) as CallToolResult;
    expect(setRes.isError).toBeFalsy();
    const setText = textOf(setRes);
    expect(setText).toContain("Files written");
    expect(setText).toContain("brand/directions/default/direction.yaml");
    expect(setText).toContain("brand/directions/default/brief.md");

    const showRes = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "direction", input: ["brief", "show", "default"] },
    })) as CallToolResult;
    expect(showRes.isError).toBeFalsy();
    expect(textOf(showRes)).toContain(value);
  });

  // 9c. direction create round-trip via keyart_brand (SC-06 / WS-03)
  it("dispatches direction create and writes a v1 direction", async () => {
    const dirPayload = JSON.stringify({
      name: "Bold Editorial",
      summary: "Strong contrast, confident type, editorial feel",
      character: { mood: "bold, editorial, confident" },
      usage: {
        rules: ["Lead with strong typography"],
        antiRules: ["Avoid pastel backgrounds"],
      },
      copyExamples: {
        headline: "Ship it boldly",
        subheadline: "Design that means business",
        cta: "Get started",
      },
    });

    const res = (await client.callTool({
      name: "keyart_brand",
      arguments: {
        command: "direction",
        input: ["create", dirPayload, "--from", "default"],
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("Created direction");
    expect(text).toContain("Files written");
    expect(text).toContain("brand/directions/bold-editorial/");

    // The authored direction is its own aggregate root with a v1 head.
    const indexPath = path.join(
      tmpDir,
      "brand/directions/bold-editorial/direction.yaml",
    );
    await expect(fs.access(indexPath)).resolves.toBeUndefined();
    const index = YAML.parse(await fs.readFile(indexPath, "utf-8")) as {
      versions: string[];
      head: string | null;
    };
    expect(index.versions).toHaveLength(1);
    expect(index.head).toBe(index.versions[0]);
  });

  // 9d. keyart_help { command: "direction" } returns usage (SC-06 / WS-03)
  it("keyart_help { command: 'direction' } returns full direction helpDoc", async () => {
    const res = (await client.callTool({
      name: "keyart_help",
      arguments: { command: "direction" },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    // CLI form
    expect(text).toContain("keyart direction create");
    // keyart_brand array form
    expect(text).toContain("keyart_brand");
    // Must document the array input requirement
    expect(text).toContain("input");
    // tokens are never authored — the payload key is rejected
    expect(text).toMatch(/tokens.*(rejected|not accepted)/i);
  });

  // 9e. memory-lifecycle + rule-lifecycle round-trip via keyart_brand (SC-06 / WS-04)
  it("drives direction memory delete and rule remove via keyart_brand, keylessly", async () => {
    const feedbackRes = (await client.callTool({
      name: "keyart_brand",
      arguments: {
        command: "direction",
        input: ["feedback", "default", "--body", "No longer relevant note"],
      },
    })) as CallToolResult;
    expect(feedbackRes.isError).toBeFalsy();

    // The rendered CLI/MCP text never carries entry ids — read memory.yaml
    // directly (mirrors how other cases here read direction.yaml off disk).
    const memoryYamlPath = path.join(
      tmpDir,
      "brand/directions/default/memory.yaml",
    );
    const memoryDocBefore = YAML.parse(
      await fs.readFile(memoryYamlPath, "utf-8"),
    ) as { entries: { id: string; body: string }[] };
    const entry = memoryDocBefore.entries.find(
      (e) => e.body === "No longer relevant note",
    );
    expect(entry).toBeDefined();

    const deleteRes = (await client.callTool({
      name: "keyart_brand",
      arguments: {
        command: "direction",
        input: [
          "memory",
          "delete",
          "default",
          entry!.id,
          "--reason",
          "no longer relevant",
        ],
      },
    })) as CallToolResult;
    expect(deleteRes.isError).toBeFalsy();
    expect(textOf(deleteRes)).toContain("Deleted");

    const memoryDocAfter = YAML.parse(
      await fs.readFile(memoryYamlPath, "utf-8"),
    ) as { entries: { id: string; retiredAt?: string }[] };
    const retired = memoryDocAfter.entries.find((e) => e.id === entry!.id);
    expect(retired?.retiredAt).toBeDefined();

    // Rule lifecycle: add a global rule, then remove (retire) it.
    const ruleAddRes = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "rule", input: ["add", "Prefer generous whitespace"] },
    })) as CallToolResult;
    expect(ruleAddRes.isError).toBeFalsy();

    const brandYamlPath = path.join(tmpDir, "brand/brand.yaml");
    const brandDocBefore = YAML.parse(
      await fs.readFile(brandYamlPath, "utf-8"),
    ) as { rules: { id: string; text: string }[] };
    const rule = brandDocBefore.rules.find(
      (r) => r.text === "Prefer generous whitespace",
    );
    expect(rule).toBeDefined();

    const ruleRemoveRes = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "rule", input: ["remove", rule!.id] },
    })) as CallToolResult;
    expect(ruleRemoveRes.isError).toBeFalsy();
    expect(textOf(ruleRemoveRes)).toContain("Removed global rule");

    const brandDocAfter = YAML.parse(
      await fs.readFile(brandYamlPath, "utf-8"),
    ) as { rules: { id: string; retiredAt?: string }[] };
    const retiredRule = brandDocAfter.rules.find((r) => r.id === rule!.id);
    expect(retiredRule?.retiredAt).toBeDefined();
  });

  // 9f. WS-06 (SC-08): the FULL keyless round-trip through keyart_brand —
  // direction new → brief set → explore → feedback → regenerate → approve —
  // over the real stdio channel (a stray stdout write would corrupt the
  // JSON-RPC stream and fail these calls). No OPENAI_API_KEY in the child env.
  it("drives direction new → brief set → explore → feedback → regenerate → approve keylessly", async () => {
    const rt = "roundtrip";
    const rtDir = `brand/directions/${rt}`;

    // 1. direction new — a draft: record + brief projection, NO versions yet.
    const newRes = (await client.callTool({
      name: "keyart_brand",
      arguments: {
        command: "direction",
        input: ["new", rt, "--describe", "a calm cooking tracker"],
      },
    })) as CallToolResult;
    expect(newRes.isError).toBeFalsy();
    expect(textOf(newRes)).toContain(`Created draft direction "${rt}"`);
    expect(await pathExists(`${rtDir}/direction.yaml`)).toBe(true);
    expect(await pathExists(`${rtDir}/memory.yaml`)).toBe(true);
    const draftIndex = YAML.parse(
      await fs.readFile(path.join(tmpDir, rtDir, "direction.yaml"), "utf-8"),
    ) as { versions: string[]; head: string | null };
    expect(draftIndex.versions).toHaveLength(0);
    expect(draftIndex.head).toBeNull();

    // 2. brief set — deterministic keyless field write.
    const briefRes = (await client.callTool({
      name: "keyart_brand",
      arguments: {
        command: "direction",
        input: ["brief", "set", rt, "oneLiner", "calm cooking, warm type"],
      },
    })) as CallToolResult;
    expect(briefRes.isError).toBeFalsy();
    expect(textOf(briefRes)).toContain(`${rtDir}/brief.md`);

    // 3. explore <id> — generate v1 into the draft (dry-run placeholder).
    const exploreRes = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "explore", input: [rt] },
    })) as CallToolResult;
    expect(exploreRes.isError).toBeFalsy();
    const afterExplore = YAML.parse(
      await fs.readFile(path.join(tmpDir, rtDir, "direction.yaml"), "utf-8"),
    ) as { versions: string[]; head: string | null };
    expect(afterExplore.versions).toHaveLength(1);
    expect(
      await pathExists(`${rtDir}/versions/${afterExplore.head}/direction-version.json`),
    ).toBe(true);

    // 4. feedback — direction-scoped memory write.
    const feedbackRes = (await client.callTool({
      name: "keyart_brand",
      arguments: {
        command: "direction",
        input: ["feedback", rt, "--body", "warmer hero, less neon"],
      },
    })) as CallToolResult;
    expect(feedbackRes.isError).toBeFalsy();
    expect(textOf(feedbackRes)).toContain(`${rtDir}/memory.yaml`);

    // 5. regenerate — appends a new version (head advances, append-only).
    const regenRes = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "regenerate", input: [rt] },
    })) as CallToolResult;
    expect(regenRes.isError).toBeFalsy();
    const afterRegen = YAML.parse(
      await fs.readFile(path.join(tmpDir, rtDir, "direction.yaml"), "utf-8"),
    ) as { versions: string[]; head: string | null };
    expect(afterRegen.versions).toHaveLength(2);
    expect(afterRegen.head).toBe(afterRegen.versions[1]);

    // 6. approve — pins the head, sets the global pointer.
    const approveRes = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "approve", input: [rt] },
    })) as CallToolResult;
    expect(approveRes.isError).toBeFalsy();
    expect(await pathExists("brand/approved/current-direction.json")).toBe(true);
    const pointer = YAML.parse(
      await fs.readFile(path.join(tmpDir, "brand/brand.yaml"), "utf-8"),
    ) as { approvedPointer: { directionId: string } };
    expect(pointer.approvedPointer.directionId).toBe(rt);

    // The facade set is unchanged after the whole trip, and serve stays
    // never-MCP-dispatchable.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "keyart_brand",
      "keyart_help",
      "keyart_implement",
      "keyart_setup",
    ]);
    const serveRes = (await client.callTool({
      name: "keyart_brand",
      arguments: { command: "serve" },
    })) as CallToolResult;
    expect(serveRes.isError).toBe(true);
    expect(textOf(serveRes)).toContain("npx keyart serve");
  }, 120_000);

  // 10. protocol stream integrity — logs captured, not leaked to stdout.
  it("captures command logs in the run response (stream intact)", () => {
    // If any log had leaked to the child's stdout, the JSON-RPC stream would
    // have broken and the explore test would have failed/timed out. Additionally,
    // the captured "Log output" block must contain the explore log text — proving
    // logs were captured rather than dropped.
    const logBlock = exploreText.slice(exploreText.indexOf("Log output:"));
    expect(logBlock).toContain("Explore complete");
  });
});

// ---------------------------------------------------------------------------
// direction registry unit checks (SC-06 / WS-03) — no server needed.
// ---------------------------------------------------------------------------
describe("direction registry (unit)", () => {
  it("groupOf('direction') === 'brand'", () => {
    expect(groupOf("direction")).toBe("brand");
  });

  it("helpIndex() lists direction under the brand facade", () => {
    const index = helpIndex();
    expect(index).toContain("direction");
    expect(index).toContain("keyart_brand");
  });

  it("keyart_brand facade description lists direction via groupToolDescription", async () => {
    const { groupToolDescription } = await import("../mcp/registry.js");
    const desc = groupToolDescription("brand");
    expect(desc).toContain("direction");
  });
});

// ---------------------------------------------------------------------------
// docs consistency (SC-10) — no server needed; reads the published README from
// the repo root. Asserts the facade/wizard/doctor reality the MCP surface
// actually exposes.
describe("docs consistency", () => {
  it("README.md documents the facades + object input (not keyart_run as a live tool)", async () => {
    const readme = await fs.readFile(
      path.join(repoRoot, "README.md"),
      "utf-8",
    );
    for (const tool of [
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
      "keyart_help",
    ]) {
      expect(readme).toContain(tool);
    }
    // The forgiving object-input shape is documented.
    expect(readme).toMatch(/\{\s*"command"/);
    expect(readme).toContain("doctor");
  });
});

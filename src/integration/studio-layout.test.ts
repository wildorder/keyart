/**
 * Real-browser layout test for the `serve` studio.
 *
 * Every other studio test is a source-level or request-level check, and none of
 * them could see the bug this file exists for: the chat rail was mounted beside
 * the direction content but a CSS rule stacked it underneath, about a full
 * screen down. Only a real layout engine sees that, so this test drives headless
 * Chromium against the BUILT studio (`dist/ui`) served through the same mounts
 * `keyart serve` composes, over a throwaway project.
 *
 * Hermetic by construction:
 * - `dist/ui` must already exist (the build gate writes it). This test never
 *   builds it, and fails loudly when it is missing.
 * - No API key: the fixture's first version comes from the key-free dry-run
 *   explore, and two small PNGs are written into its version folder.
 * - No network: every request that is not to the local test server is aborted,
 *   and Chromium is told not to resolve any other host.
 * - Port 0: the server takes whatever free port the OS hands it.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn() };
});

import { loadConfig, directionsRoot } from "../config.js";
import type { KeyartConfig } from "../types.js";
import { runInit } from "../commands/init.js";
import { createApiMounts } from "../commands/serve.js";
import { createJobStore } from "../ui/jobs.js";
import { createRequestListener, createStaticFileHandler } from "../ui/static-server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const uiRoot = path.join(repoRoot, "dist", "ui");

const VIEWPORT = { width: 1440, height: 900 };

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Studio Layout", type: "prototype", framework: "next" },
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

// --- a solid-colour PNG, encoded by hand (no image dependency) --------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- fixture ---------------------------------------------------------------

let tmpDir: string;
let server: http.Server;
let baseUrl: string;
let browser: Browser;
let page: Page;

async function api<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface DashboardShape {
  directions: { id: string; head: string | null; versions: { versionId: string }[] }[];
}

beforeAll(async () => {
  if (!fsSync.existsSync(path.join(uiRoot, "index.html"))) {
    throw new Error(
      "dist/ui is not built — run `npm run build` before `vitest run`. " +
        "This test serves the prebuilt studio and never builds it itself.",
    );
  }

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-studio-layout-"));
  delete process.env.OPENAI_API_KEY;
  const config = buildTestConfig(tmpDir);
  vi.mocked(loadConfig).mockResolvedValue(config);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await runInit({ cwd: tmpDir, force: true });

  const jobs = createJobStore();
  server = http.createServer(
    createRequestListener([
      ...createApiMounts({ cwd: tmpDir, jobs }),
      { prefix: "/", handler: createStaticFileHandler({ root: uiRoot }) },
    ]),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // One direction with one version: the scaffolded direction, given its v1 by
  // the key-free dry-run explore, then two images dropped into its version folder.
  const before = await api<DashboardShape>("GET", "/api/dashboard");
  const directionId = before.directions[0]?.id;
  if (!directionId) throw new Error("init scaffolded no direction");
  const { jobId } = await api<{ jobId: string }>("POST", "/api/actions/explore", { directionId });
  const deadline = Date.now() + 20_000;
  let status = "running";
  while (status === "running" && Date.now() < deadline) {
    status = (await api<{ status: string }>("GET", `/api/jobs/${jobId}`)).status;
    if (status === "running") await new Promise((r) => setTimeout(r, 50));
  }
  if (status !== "succeeded") throw new Error(`fixture explore ended ${status}`);

  const after = await api<DashboardShape>("GET", "/api/dashboard");
  const direction = after.directions.find((d) => d.id === directionId);
  const head = direction?.head ?? direction?.versions.at(-1)?.versionId;
  if (!head) throw new Error("fixture direction has no version");
  const versionDir = path.join(directionsRoot(tmpDir, config), directionId, "versions", head);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, "style-tile.png"), solidPng(1200, 900, [240, 200, 160]));
  await fs.writeFile(path.join(versionDir, "homepage-mockup.png"), solidPng(1600, 1000, [60, 90, 140]));

  browser = await chromium.launch({
    headless: true,
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(baseUrl) || url.startsWith("data:") || url.startsWith("blob:")) {
      return route.continue();
    }
    return route.abort();
  });
  page = await context.newPage();
  await page.goto(`${baseUrl}/`);
  await page.locator(".chat-rail").waitFor({ state: "attached", timeout: 20_000 });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  vi.restoreAllMocks();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} has no layout box`);
  return box;
}

describe("studio layout in a real browser (1440×900)", () => {
  it("puts the chat rail beside the direction content, not under it", async () => {
    const content = await boxOf(".workspace-focus-main");
    const rail = await boxOf(".chat-rail");

    // Beside: the rail starts at or right of where the content ends.
    expect(rail.x).toBeGreaterThanOrEqual(content.x + content.width - 1);
    // On the first screen, overlapping the content vertically.
    expect(rail.y).toBeLessThan(VIEWPORT.height);
    const overlap =
      Math.min(rail.y + rail.height, content.y + content.height) - Math.max(rail.y, content.y);
    expect(overlap).toBeGreaterThan(0);
  });

  it("makes the rail a full-height third column beside the header too, scrolling on its own", async () => {
    const header = await boxOf(".direction-chrome");
    const rail = await boxOf(".chat-rail");
    expect(rail.x).toBeGreaterThanOrEqual(header.x + header.width - 1);
    expect(rail.y).toBeLessThanOrEqual(1);
    expect(rail.height).toBeGreaterThanOrEqual(VIEWPORT.height - 2);

    // Scrolling the workspace leaves the rail where it is.
    await page.locator(".main").evaluate((el) => el.scrollTo(0, 400));
    const railAfter = await boxOf(".chat-rail");
    expect(railAfter.y).toBe(rail.y);
    await page.locator(".main").evaluate((el) => el.scrollTo(0, 0));
  });

  it("shows each generated image once, with no separate feedback panel", async () => {
    // The stage's thumbnail row is its image SELECTOR (every image, the staged
    // one highlighted), not a second gallery, so it is counted on its own.
    const srcsOf = (selector: string) =>
      page
        .locator(selector)
        .evaluateAll((imgs) => imgs.map((i) => decodeURIComponent((i as HTMLImageElement).src)));
    const shown = await srcsOf(".main img:not(.stage-thumb__img), .app-rail img");
    const thumbs = await srcsOf(".stage-thumb__img");
    for (const name of ["style-tile.png", "homepage-mockup.png"]) {
      expect(shown.filter((s) => s.includes(name)).length, name).toBeLessThanOrEqual(1);
      expect(thumbs.filter((s) => s.includes(name)), name).toHaveLength(1);
    }
    // Exactly one image is on the stage.
    expect(await page.locator(".stage-image img").count()).toBe(1);
    expect(await page.locator(".gallery-feedback").count()).toBe(0);
    expect(await page.getByText("Give feedback on an image").count()).toBe(0);
  });

  it("heads the page with the name and description, then a drawer bar with no Regenerate", async () => {
    const identity = await boxOf(".direction-identity");
    const bar = await boxOf(".direction-chrome");
    expect(await page.locator(".direction-identity .gallery-summary").count()).toBe(1);
    expect(identity.y + identity.height).toBeLessThanOrEqual(bar.y + 1);
    for (const region of [".direction-identity", ".direction-chrome"]) {
      expect(
        await page.locator(region).getByRole("button", { name: /regenerat/i }).count(),
        region,
      ).toBe(0);
    }
  });

  it("pins the drawer bar flush with the top of the canvas when scrolled", async () => {
    await page.locator(".main").evaluate((el) => el.scrollTo(0, 400));
    const bar = await boxOf(".direction-chrome");
    expect(Math.abs(bar.y)).toBeLessThanOrEqual(1);
    await page.locator(".main").evaluate((el) => el.scrollTo(0, 0));
  });

  it("records a crop dragged on the stage from the rail, with the typed note", async () => {
    await page.locator(".stage-tools").getByRole("button", { name: "Crop" }).click();
    const surface = page.locator(".stage-image__surface");
    await surface.waitFor();
    const box = await boxOf(".stage-image__surface");
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 4 });
    await page.mouse.up();

    const chip = page.locator(".chat-crop-chip");
    await chip.waitFor({ timeout: 10_000 });
    await page.locator(".chat-composer__input").fill("love this warm corner");
    await page.locator(".chat-quick-intents").getByRole("button", { name: "Keep" }).click();
    await chip.waitFor({ state: "detached", timeout: 10_000 });

    // A kept crop is registered on the direction as a positive reference,
    // carrying the note, exactly as the old feedback panel recorded it.
    const dashboard = await api<{ directions: unknown[] }>("GET", "/api/dashboard");
    expect(JSON.stringify(dashboard.directions[0])).toContain("love this warm corner");
  });
});

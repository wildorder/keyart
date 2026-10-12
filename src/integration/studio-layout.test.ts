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
import type { JobStore } from "../ui/jobs.js";
import { createBoard, reserveBoardRevision, finishBoardRevision, boardRevisionDir, readBoardRevision } from "../board/board-store.js";
import { runBoardCreate } from "../board/operations.js";
import { runReviseDirection } from "../commands/regenerate-visuals.js";
import { reserveAssetId, reserveAssetVersion, appendVersionToIndex, assetVersionDir } from "../asset/asset-store.js";
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
let jobs: JobStore;
let fixtureDirectionId: string;
let foundationV1: string;
let fixtureBoardId: string;
let fixtureRevisionId: string;

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

  jobs = createJobStore();
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
  fixtureDirectionId = directionId;
  foundationV1 = head;
  const versionDir = path.join(directionsRoot(tmpDir, config), directionId, "versions", head);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, "style-tile.png"), solidPng(1200, 900, [240, 200, 160]));
  const directionDir = path.dirname(path.dirname(versionDir));
  const board = await createBoard(directionDir, { directionId, name: "Launch poster", instructions: "A launch event poster" });
  fixtureBoardId = board.id;
  const revision = await reserveBoardRevision(directionDir, { boardId: board.id,
    foundation: { directionId, versionId: head }, sourceRevisionId: null, expectedInstructionVersion: 1 });
  fixtureRevisionId = revision.id;
  const boardImage = path.join(boardRevisionDir(directionDir, board.id, revision.id), "board.png");
  await fs.writeFile(boardImage, solidPng(1600, 1000, [60, 90, 140]));
  const { runningPid: _pid, ...finished } = revision;
  await finishBoardRevision(directionDir, { ...finished, status: "completed",
    files: { ...revision.files, image: path.relative(directionDir, boardImage).split(path.sep).join("/") } });

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
  const deadline = Date.now() + 20_000;
  while (jobs?.list().some((job) => job.status === "running")) {
    if (Date.now() > deadline) throw new Error("Studio fixture jobs did not settle before teardown.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

it("consumes chat approval once, retaining resolved history through jobs and later gates", async () => {
  const chatPage = await browser.newPage({ viewport: VIEWPORT });
  let resumes = 0;
  const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  try {
    await chatPage.route("**/*", async (route) => {
      const url = route.request().url();
      if (!url.startsWith(baseUrl) && !url.startsWith("data:") && !url.startsWith("blob:")) return route.abort();
      if (url.endsWith("/api/chat")) return route.fulfill({ contentType: "text/event-stream", body: sse([
        { type: "pending_approval", sessionId: "approval-regression", toolName: "asset_extract", arguments: { version: "v8" }, mutates: "write" },
      ]) });
      if (url.endsWith("/api/chat/approval-regression/approve")) {
        resumes++;
        const approved = route.request().postDataJSON().approve;
        return route.fulfill({ contentType: "text/event-stream", body: sse([
          ...(approved ? [{ type: "job", jobId: "approval-regression-job", kind: "asset" }] : []),
          { type: "tool_result", toolName: "asset_extract", text: approved ? "Launched extraction." : "Nothing changed.", isError: false },
          { type: "done", sessionId: "approval-regression" },
        ]) });
      }
      if (url.endsWith("/api/jobs/approval-regression-job")) return route.fulfill({ json: {
        id: "approval-regression-job", kind: "asset", status: "succeeded", startedAt: new Date().toISOString(), result: {
          isError: false, text: 'Extracted asset "test-crop": completed.\n\nFiles written (1):\n- brand/test-crop/asset.png\n\nLog output:\nExtraction finished.',
        },
      } });
      return route.continue();
    });
    await chatPage.goto(baseUrl);
    const rail = chatPage.locator(".chat-rail");
    const composer = rail.locator("textarea");
    await composer.fill("Extract an asset");
    await rail.getByRole("button", { name: "Send", exact: true }).click();
    const approve = rail.getByRole("button", { name: "Approve", exact: true });
    await approve.waitFor();
    // Two same-tick clicks exercise the synchronous duplicate-request guard.
    await approve.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await rail.getByText("Approved", { exact: true }).waitFor();
    await rail.getByRole("link", { name: "Open asset", exact: true }).waitFor();
    expect(await rail.locator(".tool-call-card").count()).toBe(1);
    expect(await rail.getByText("Launched extraction.", { exact: true }).count()).toBe(0);
    expect(await rail.getByText('Extracted asset "test-crop": completed.', { exact: true }).count()).toBe(1);
    expect(await approve.count()).toBe(0);
    expect(resumes).toBe(1);
    await composer.fill("Extract another asset");
    await rail.getByRole("button", { name: "Send", exact: true }).click();
    await approve.waitFor();
    expect(await approve.count()).toBe(1);
    await rail.getByRole("button", { name: "Cancel", exact: true }).click();
    await rail.getByText("Cancelled", { exact: true }).waitFor();
    expect(await rail.locator(".tool-call-card").count()).toBe(2);
    expect(await approve.count()).toBe(0);
    expect(resumes).toBe(2);
  } finally {
    await chatPage.close();
  }
}, 30_000);

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
    for (const name of ["style-tile.png", "board.png"]) {
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

  it("attaches a crop and its source to chat without recording a preference", async () => {
    const before = await api<unknown>("GET", "/api/dashboard");
    await page.route("**/api/chat", (route) => route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done","sessionId":"crop-test"}\n\n' }));
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
    expect(await page.locator(".chat-quick-intents").count()).toBe(0);
    expect(await page.locator(".chat-composer__input").getAttribute("placeholder")).toBe("What would you like to do with this?");
    await page.locator(".chat-composer__input").fill("love this warm corner");
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/chat"));
    await page.locator(".chat-composer").getByRole("button", { name: "Send", exact: true }).click();
    const payload = (await sent).postDataJSON();
    expect(payload.message).toBe("love this warm corner");
    expect(payload.attachment.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(payload.attachment.source.directionId).toBe(fixtureDirectionId);
    expect(payload.attachment.source.versionId).toBe(foundationV1);
    await chip.waitFor({ state: "detached", timeout: 10_000 });
    expect(await api<unknown>("GET", "/api/dashboard")).toEqual(before);
    await page.unroute("**/api/chat");
  });

  it("keeps Board history and selected foundation through job completion and a concurrent head advance", async () => {
    const v2 = await runReviseDirection({ cwd: tmpDir, directionId: fixtureDirectionId });
    await runBoardCreate({ cwd: tmpDir, directionId: fixtureDirectionId, versionId: v2.versionId,
      name: "Pending social", describe: "A social announcement composition" });
    await page.reload();
    await page.getByText("Foundation render pending", { exact: true }).waitFor();
    expect(await page.locator(".stage-image img").count()).toBe(0);

    const staged = page.getByRole("tablist", { name: "Staged image" });
    await staged.getByRole("tab", { name: "Launch poster" }).click();
    await page.getByText("No Board render for this foundation", { exact: true }).waitFor();
    expect(await page.locator(".stage-image img").count()).toBe(0);
    await staged.getByRole("tab", { name: "Pending social" }).click();
    await page.getByText("Board render pending", { exact: true }).waitFor();
    expect(await page.locator(".stage-image img").count()).toBe(0);

    // A historical Board remains explicitly selectable without borrowing it as
    // the current foundation's default image.
    await staged.getByRole("tab", { name: "Launch poster" }).click();
    expect(await page.locator(".stage-details").getAttribute("open")).toBeNull();
    expect(await page.getByLabel("Board revision history").isVisible()).toBe(false);
    await page.locator(".stage-details > summary").click();
    await page.getByLabel("Board revision history").selectOption(fixtureRevisionId);
    await page.locator(".stage-image img").waitFor();
    expect(decodeURIComponent(await page.locator(".stage-image img").getAttribute("src") ?? "")).toContain(fixtureRevisionId);
    expect(await page.locator(".stage-details > .field-hint").first().textContent()).toContain(foundationV1);
    const artworkTop = (await page.locator(".stage-image").boundingBox())!.y;
    await page.locator(".stage-details > summary").click();
    expect((await page.locator(".stage-image").boundingBox())!.y).toBe(artworkTop);
    await page.locator(".stage-tools").getByRole("button", { name: "Crop" }).click();
    const cropBox = await boxOf(".stage-image__surface");
    await page.mouse.move(cropBox.x + 20, cropBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(cropBox.x + 120, cropBox.y + 90, { steps: 4 });
    await page.mouse.up();
    await page.locator(".chat-crop-chip").waitFor();
    await page.locator(".chat-composer__input").fill("historical poster crop");
    await page.route("**/api/chat", (route) => route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done","sessionId":"crop-test"}\n\n' }));
    const cropRequest = page.waitForRequest((request) => request.url().endsWith("/api/chat") && request.method() === "POST");
    await page.locator(".chat-composer").getByRole("button", { name: "Send", exact: true }).click();
    const payload = (await cropRequest).postDataJSON();
    expect(payload.attachment.source).toEqual({ kind: "board", directionId: fixtureDirectionId, versionId: foundationV1, boardId: fixtureBoardId, revisionId: fixtureRevisionId });
    await page.locator(".chat-crop-chip").waitFor({ state: "detached" });
    await page.unroute("**/api/chat");

    // The focused source is r1/v1, while the target defaults independently to v2.
    // Capture completion refreshes the workspace; select its historical source again.
    await staged.getByRole("tab", { name: "Launch poster" }).click();
    await page.locator(".stage-details > summary").click();
    await page.getByLabel("Board revision history").selectOption(fixtureRevisionId);
    await page.getByRole("button", { name: "Revise Board", exact: true }).click();
    expect(await page.getByLabel("Board target foundation").inputValue()).toBe(v2.versionId);
    await page.getByRole("button", { name: "Review request", exact: true }).click();
    const confirmation = page.getByRole("region", { name: "Confirm Board operation" });
    await confirmation.waitFor();
    expect(await confirmation.textContent()).toContain(v2.versionId);
    expect(await confirmation.textContent()).toContain(fixtureRevisionId);
    await page.getByRole("tablist", { name: "Version history" }).getByRole("tab", { name: /^v1$/ }).click();
    const v3 = await runReviseDirection({ cwd: tmpDir, directionId: fixtureDirectionId });
    const requestPromise = page.waitForRequest((request) => request.url().endsWith("/api/actions/board-revise") && request.method() === "POST");
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/actions/board-revise") && response.request().method() === "POST");
    const refreshedDashboard = page.waitForResponse((response) => response.url().endsWith("/api/dashboard") && response.request().method() === "GET");
    await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
    const body = (await requestPromise).postDataJSON();
    expect(body).toMatchObject({ directionId: fixtureDirectionId, boardId: fixtureBoardId,
      versionId: v2.versionId, revisionId: fixtureRevisionId, expectedInstructionVersion: 1 });
    expect(body.versionId).not.toBe(v3.versionId);
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    const { jobId } = await response.json();
    await expect.poll(() => jobs.get(jobId)?.status, { timeout: 20_000 }).toBe("succeeded");
    const result = jobs.get(jobId)!.result as { revisionId: string };
    const directionDir = path.join(directionsRoot(tmpDir, buildTestConfig(tmpDir)), fixtureDirectionId);
    const persisted = await readBoardRevision(directionDir, fixtureBoardId, result.revisionId);
    expect(persisted.foundation.versionId).toBe(v2.versionId);
    expect(persisted.sourceRevisionId).toBe(fixtureRevisionId);
    expect(persisted.status).toBe("pending");

    // Completing generation reloads dashboard data. It must neither unmount the
    // workspace nor move a deliberately selected historical foundation to the
    // newly discovered head. Board selection/history must survive that refresh.
    await refreshedDashboard;
    const versions = page.getByRole("tablist", { name: "Version history" });
    await versions.getByRole("tab", { name: /^v3/ }).waitFor();
    await expect.poll(() => versions.getByRole("tab", { name: /^v1$/ }).getAttribute("aria-selected")).toBe("true");
    expect(await staged.getByRole("tab", { name: "Launch poster" }).getAttribute("aria-selected")).toBe("true");
    expect(await page.getByLabel("Board revision history").inputValue()).toBe(fixtureRevisionId);
    expect(decodeURIComponent(await page.locator(".stage-image img").getAttribute("src") ?? "")).toContain(fixtureRevisionId);
  }, 45_000);

  it("confirms an exact permanent version deletion without renumbering retained versions or deleting Boards", async () => {
    const before = await api<DashboardShape>("GET", "/api/dashboard");
    const direction = before.directions.find((d) => d.id === fixtureDirectionId)!;
    const removedId = direction.versions[1].versionId;
    const versionDir = path.join(directionsRoot(tmpDir, buildTestConfig(tmpDir)), fixtureDirectionId, "versions", removedId);
    const versions = page.getByRole("tablist", { name: "Version history" });
    await versions.getByRole("tab", { name: /^v2$/ }).click();
    await page.getByRole("button", { name: "Delete version", exact: true }).click();
    const confirmation = page.getByRole("region", { name: "Confirm direction version deletion" });
    await confirmation.waitFor();
    expect(await confirmation.textContent()).toContain(removedId);
    await fs.access(versionDir); // Reviewing alone must not delete anything.
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await fs.access(versionDir);
    await page.getByRole("button", { name: "Delete version", exact: true }).click();
    await versions.getByRole("tab", { name: /^v3/ }).click();
    const deleted = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/versions/${removedId}`));
    await confirmation.getByRole("button", { name: "Permanently delete version", exact: true }).click();
    expect((await deleted).status()).toBe(200);
    await versions.getByRole("tab", { name: /^v2$/ }).waitFor({ state: "detached" });
    expect(await versions.getByRole("tab", { name: /^v3/ }).getAttribute("aria-selected")).toBe("true");
    await expect(fs.access(versionDir)).rejects.toThrow();
    await versions.getByRole("tab", { name: /^v1$/ }).click();
    await page.getByRole("tablist", { name: "Staged image" }).getByRole("tab", { name: "Launch poster" }).click();
    expect(await page.getByLabel("Board revision history").inputValue()).toBe(fixtureRevisionId);
    expect(decodeURIComponent(await page.locator(".stage-image img").getAttribute("src") ?? "")).toContain(fixtureRevisionId);
  }, 30_000);

  it("keeps assets downloadable after deleting every foundation and asks for replacements only when revising", async () => {
    const directionDir = path.join(directionsRoot(tmpDir, buildTestConfig(tmpDir)), fixtureDirectionId);
    const assetId = await reserveAssetId(directionDir, "Retained illustration");
    const meta = { directionId: fixtureDirectionId, name: "Retained illustration" };
    const revision = await reserveAssetVersion(directionDir, assetId, meta, {
      formatVersion: 2, conditioning: "foundation", createdAt: new Date().toISOString(), description: "A quiet illustration",
      foundation: { directionId: fixtureDirectionId, versionId: foundationV1 }, provenance: { kind: "generated" },
      status: "pending", contextSnapshot: "Fixture context", files: [],
    });
    const png = solidPng(64, 64, [90, 130, 180]);
    await fs.writeFile(path.join(assetVersionDir(directionDir, assetId, revision.id), "asset.png"), png);
    await appendVersionToIndex(directionDir, assetId, meta, { ...revision, status: "completed", files: ["asset.png"] });
    await page.reload();
    const shelf = page.locator(".asset-card").filter({ hasText: "Retained illustration" });
    await shelf.waitFor();
    const deleteSelected = async () => {
      await page.getByRole("button", { name: "Delete version", exact: true }).click();
      const confirmation = page.getByRole("region", { name: "Confirm direction version deletion" });
      const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/dashboard"));
      await confirmation.getByRole("button", { name: "Permanently delete version", exact: true }).click();
      await refreshed;
      await confirmation.waitFor({ state: "detached" });
    };
    await page.getByRole("tablist", { name: "Version history" }).getByRole("tab", { name: /^v1$/ }).click();
    await deleteSelected();
    await page.getByRole("tablist", { name: "Version history" }).waitFor({ state: "detached" });
    expect(await shelf.getByLabel("Foundation for Retained illustration").count()).toBe(0);
    const retainedDashboard = await api<DashboardShape>("GET", "/api/dashboard");
    const replacement = retainedDashboard.directions.find((d) => d.id === fixtureDirectionId)!.head!;
    await shelf.getByPlaceholder("e.g. make it face left").fill("Make it face left");
    await shelf.getByRole("button", { name: "Revise asset", exact: true }).click();
    const picker = shelf.getByLabel("Foundation for Retained illustration");
    await picker.waitFor();
    expect(await picker.inputValue()).toBe("");
    expect(await shelf.getByRole("button", { name: "Confirm revision", exact: true }).count()).toBe(0);
    await picker.selectOption(replacement);
    await shelf.getByRole("button", { name: "Review revision", exact: true }).click();
    const request = page.waitForRequest((r) => r.url().endsWith("/api/actions/asset-revise") && r.method() === "POST");
    const refreshed = page.waitForResponse((r) => r.url().endsWith("/api/dashboard"));
    await shelf.getByRole("button", { name: "Confirm revision", exact: true }).click();
    expect((await request).postDataJSON()).toMatchObject({ directionId: fixtureDirectionId, assetId, revisionId: revision.id, versionId: replacement });
    await refreshed;
    await deleteSelected();
    await page.locator(".workspace-empty-state").waitFor();
    expect(await page.locator(".asset-shelf").count()).toBe(1);
    await shelf.getByRole("link", { name: "Download", exact: true }).waitFor();
    const downloadPath = await shelf.getByRole("link", { name: "Download", exact: true }).getAttribute("href");
    const downloaded = await fetch(new URL(downloadPath!, baseUrl));
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(png);
    expect(await shelf.getByLabel("Foundation for Retained illustration").count()).toBe(0);
  }, 45_000);
});

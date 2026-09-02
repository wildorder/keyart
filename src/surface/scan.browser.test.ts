import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import type { DirectionVersion, DirectionTokens, KeyartConfig } from "../types.js";
import { pathExists } from "../fs.js";
import { SLOT_ID_RE } from "./schema.js";
import {
  candidateSignature,
  runSurfaceScan,
  OVERLAY_VIEWPORT_FRACTION,
  type ScanProposal,
} from "./scan.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

// ===========================================================================
// The ONLY file in the repo that launches a real Chromium.
//
// Everything downstream of `observePage`'s `page.evaluate(...)` walker consumes
// a plain `PageObservation` and is pure — so it is unit-tested in `scan.test.ts`
// (the pure floor) and against a fake `playwright` (the propose/apply/dedupe
// semantics). What CANNOT be faked is the walker's own truth: what a real DOM +
// real layout + real computed styles actually yield. That is this file's job,
// and its only job.
//
// Every case carries an explicit, generous timeout: a real browser launch +
// navigation + per-candidate screenshots is slow under full-suite parallel load,
// and vitest's 5s default is what made the old in-file browser suite flaky.
// ===========================================================================

// ---------------------------------------------------------------------------
// Fixture assets: a self-contained solid-color PNG encoder built from node:zlib
// only — no new dependency. Test-only, deliberately duplicated here rather than
// exported from a production module.
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData), 0);
  return Buffer.concat([len, typeData, crc]);
}

/** A self-contained solid-color PNG encoder (RGB, 8-bit, filter-none rows). */
function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const off = rowStart + 1 + x * 3;
      raw[off] = 100;
      raw[off + 1] = 150;
      raw[off + 2] = 200;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PHOTO_PNG = makePng(48, 48);
const SPACER_PNG = makePng(1, 1);
const BG_PNG = makePng(40, 40);

// ---------------------------------------------------------------------------
// Fixture page + project scaffolding.
// ---------------------------------------------------------------------------

async function chromiumAvailable(): Promise<boolean> {
  try {
    const pw = await import("playwright");
    const exe = pw.chromium.executablePath();
    return exe.length > 0 && (await pathExists(exe));
  } catch {
    return false;
  }
}

const hasChromium = await chromiumAvailable();

const FIXTURE_TOKENS: DirectionTokens = {
  palette: [
    { role: "primary", name: "Hot Pink", hex: "#e84393" },
    { role: "secondary", name: "Sky Blue", hex: "#2d98da" },
    { role: "background", name: "Cream", hex: "#faf6f0" },
    { role: "surface", name: "White", hex: "#ffffff" },
    { role: "text", name: "Ink", hex: "#1c1a17" },
    { role: "muted", name: "Slate", hex: "#6c757d" },
  ],
  brand: [
    { hex: "#e84393", name: "pink", label: "Hot Pink" },
    { hex: "#2d98da", name: "sky-blue" },
  ],
  typography: { heading: "Space Grotesk", body: "Inter", scale: 1.25 },
  shape: { radius: "8px", spacingUnit: "8px" },
};

const PAGE_STYLE =
  'html,body{margin:0;padding:0;background:#ffffff;}' +
  // #123a5e is deliberately far (OKLab ΔE) from every FIXTURE_TOKENS role, so
  // it stays a color-role candidate rather than tripping the WS-05 migration
  // split (unlike the retired #112233, which sat within MIGRATION_DELTA of
  // the fixture's text role).
  'body{color:#123a5e;font-family:"Courier New",monospace;}' +
  '.bg-illustration{display:block;width:40px;height:40px;background-image:url(/bg.png);background-size:cover;}' +
  'svg,img{display:block;}';

function page1Html(): string {
  // The oversized svg carries a distinguishing class so it does not
  // structurally collide with the two glyph-sized svgs above it — all three
  // are otherwise flat, unrelated body-level siblings, not a repeated list,
  // and must not accidentally bucket together under the content classifier.
  return `<!DOCTYPE html><html><head><style>${PAGE_STYLE}</style></head><body>
<svg aria-label="restaurant" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
<svg width="20" height="20" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>
<svg class="oversized" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200"/></svg>
<img src="/photo.png" width="48" height="48" alt="Team photo" />
<img src="/spacer.png" width="20" height="20" alt="" />
<div class="bg-illustration"></div>
</body></html>`;
}

/**
 * `/gated` (closable) and `/gated-stuck` (no close button) — a full-viewport
 * `position:fixed; z-index:999` location-modal with `aria-label="location-gate"`
 * over a page whose two glyph svgs + one 48x48 img start hidden (`display:none`)
 * and are revealed ONLY by the `#gate-close` click handler removing the modal —
 * so a candidate for them proves a real dismiss really happened, not just that
 * the DOM was already there. `<h1>Welcome</h1>` keeps `<main>` non-empty (and
 * so genuinely "visible" to Playwright) from first paint, independent of the
 * hidden reveal.
 */
function gatedHtml(closable: boolean): string {
  return `<!DOCTYPE html><html><head><style>${PAGE_STYLE}</style></head><body>
<main>
  <h1>Welcome</h1>
  <div id="reveal" style="display:none">
    <svg aria-label="restaurant" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
    <svg width="20" height="20" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>
    <img src="/photo.png" width="48" height="48" alt="Team photo" />
  </div>
</main>
<div id="gate" aria-label="location-gate" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:999;background:#ffffff;">
  <p>Are you in NYC?</p>
  ${closable ? '<button id="gate-close" onclick="document.getElementById(\'gate\').remove();document.getElementById(\'reveal\').style.removeProperty(\'display\');">Yes, I am</button>' : ""}
</div>
</body></html>`;
}

/**
 * `/content` — a DB-style card list of 12 remote-host photos (served from a
 * SECOND in-process server on another ephemeral port, so nothing leaves the
 * loopback interface while still being a genuinely foreign origin), alongside
 * same-origin chrome of the same rendered size: a standalone illustration and
 * two nav glyph icons — the over-firing guard, proven against a real DOM.
 */
function contentHtml(foreignBaseUrl: string): string {
  const cards = Array.from(
    { length: 12 },
    (_, i) => `  <li class="card"><a><img src="${foreignBaseUrl}card.png?i=${i}" width="48" height="48" /></a></li>`,
  ).join("\n");
  return `<!DOCTYPE html><html><head><style>${PAGE_STYLE}</style></head><body>
<ul class="grid">
${cards}
</ul>
<img src="/photo.png" width="48" height="48" alt="Standalone" />
<nav>
  <svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
  <svg width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24"/></svg>
</nav>
</body></html>`;
}

function makeDirectionVersion(
  tokens: DirectionTokens,
  overrides: Partial<DirectionVersion> = {},
): DirectionVersion {
  return {
    id: "v1",
    createdAt: "2026-08-05T00:00:00.000Z",
    briefSnapshot: "brief snapshot",
    contextSnapshot: "context snapshot",
    name: "Direction A",
    summary: "A summary.",
    positioning: "A positioning statement.",
    character: {},
    homepageMockupPrompt: "",
    styleTilePrompt: "",
    copyExamples: { headline: "h", subheadline: "s", cta: "c" },
    usage: { rules: [], antiRules: [] },
    tokens,
    ...overrides,
  };
}

describe.runIf(hasChromium)("runSurfaceScan — real-Chromium walker truth", () => {
  let server: http.Server;
  let baseUrl: string;
  /** A SECOND in-process server on another ephemeral port — a genuinely
   *  foreign origin relative to `baseUrl`, without leaving the loopback
   *  interface. Serves only the `/content` fixture's card images. */
  let foreignServer: http.Server;
  let foreignBaseUrl: string;

  beforeAll(async () => {
    foreignServer = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url.startsWith("/card.png")) {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(PHOTO_PNG);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => foreignServer.listen(0, "127.0.0.1", resolve));
    const foreignPort = (foreignServer.address() as AddressInfo).port;
    foreignBaseUrl = `http://127.0.0.1:${foreignPort}/`;

    server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/" || url === "") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(page1Html());
      } else if (url === "/photo.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(PHOTO_PNG);
      } else if (url === "/spacer.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(SPACER_PNG);
      } else if (url === "/bg.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(BG_PNG);
      } else if (url === "/gated") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(gatedHtml(true));
      } else if (url === "/gated-stuck") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(gatedHtml(false));
      } else if (url === "/content") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(contentHtml(foreignBaseUrl));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      foreignServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-surface-scan-browser-"));
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function mockConfig(): KeyartConfig {
    return {
      project: { name: "Scan Test", type: "prototype", framework: "next" },
      brand: {
        root: path.join(tmpDir, "brand"),
        references: path.join(tmpDir, "brand", "input", "references"),
        approved: path.join(tmpDir, "brand", "approved"),
        rejected: path.join(tmpDir, "brand", "rejected"),
      },
      models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
      outputs: {
        cursorRules: path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
        cssVars: path.join(tmpDir, "brand", "generated", "brand.css"),
        implementationBrief: path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      },
      store: { driver: "file" },
    };
  }

  async function useConfig(config: KeyartConfig): Promise<void> {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(config);
  }

  async function seedApprovedDirection(config: KeyartConfig): Promise<void> {
    const directionCore = createDirectionCore(tmpDir, config);
    await directionCore.create({ id: "direction-a", name: "Direction A" });
    const directionsDir = path.join(tmpDir, "brand", "directions");
    const version = makeDirectionVersion(FIXTURE_TOKENS);
    const versionDir = path.join(directionsDir, "direction-a", "versions", version.id);
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(
      path.join(versionDir, "direction-version.json"),
      JSON.stringify(version),
      "utf-8",
    );
    await directionCore.appendVersion("direction-a", version.id);
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: version.id,
    });
  }

  it(
    "the real DOM walker classifies real layout, real sources, real hints and real computed styles",
    { timeout: 60_000 },
    async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [baseUrl] });

      expect(await pathExists(path.join(tmpDir, result.proposalFile))).toBe(true);
      const proposal = JSON.parse(
        await fs.readFile(
          path.join(config.brand.root, "generated", "surface-scan", "proposal.json"),
          "utf-8",
        ),
      ) as ScanProposal;

      expect(proposal.urls).toEqual([baseUrl]);
      expect(typeof proposal.createdAt).toBe("string");
      expect(proposal.rejectedSignatures).toEqual([]);

      const icons = proposal.candidates.filter((c) => c.kind === "icon");
      const illustrations = proposal.candidates.filter((c) => c.kind === "illustration");
      const colors = proposal.candidates.filter((c) => c.kind === "color-role");
      const types = proposal.candidates.filter((c) => c.kind === "type-role");

      // Real layout: the 24px and 20px svgs measure inside [ICON_MIN, ICON_MAX]
      // and become icons; the 200px svg measures outside it and yields nothing.
      expect(icons).toHaveLength(2);

      // Real resolved sources: `img.src` and the computed `background-image`
      // url() are absolute, so their signatures are the absolute-URL hashes.
      expect(illustrations).toHaveLength(2);
      expect(illustrations.map((c) => c.signature).sort()).toEqual(
        [
          candidateSignature("illustration", `${baseUrl}photo.png`),
          candidateSignature("illustration", `${baseUrl}bg.png`),
        ].sort(),
      );

      // Real intrinsic size: the 1x1 spacer PNG is filtered even though its
      // rendered box (20x20) clears ILLUSTRATION_MIN.
      expect(
        illustrations.some(
          (c) => c.signature === candidateSignature("illustration", `${baseUrl}spacer.png`),
        ),
      ).toBe(false);

      // Real accessibility hint, carried off the element into the candidate.
      expect(icons.some((c) => c.hints.ariaLabel === "restaurant")).toBe(true);

      // Real computed styles, off-baseline, observed value verbatim in the note.
      expect(colors.some((c) => c.context?.note?.includes("#123a5e"))).toBe(true);
      expect(types.some((c) => c.context?.note?.toLowerCase().includes("courier new"))).toBe(true);

      // The floor never marks anything refined, mints regex-valid ids, and
      // screenshots every candidate to a repo-relative forward-slash path.
      for (const candidate of proposal.candidates) {
        expect(candidate.refined).toBeUndefined();
        expect(SLOT_ID_RE.test(candidate.proposedId)).toBe(true);
        expect(candidate.cropFile).not.toContain("\\");
        expect(await pathExists(path.join(tmpDir, candidate.cropFile))).toBe(true);
      }
    },
  );

  it(
    "page setup: a real gate is really dismissed, and a real un-dismissed one is really detected (SC-02 + SC-03)",
    { timeout: 60_000 },
    async () => {
      const config = mockConfig();
      config.scan = { waitFor: "main", dismiss: ["#gate-close"] };
      await useConfig(config);
      await seedApprovedDirection(config);

      const gatedStuckUrl = `${baseUrl}gated-stuck`;
      const gatedUrl = `${baseUrl}gated`;

      // One browser launch, one page, two navigations — the deliberate
      // consolidation: the still-blocked case and the real-dismiss case share
      // one fixture and one launch rather than paying for a second `runIf`.
      const result = await runSurfaceScan({ cwd: tmpDir, urls: [gatedStuckUrl, gatedUrl] });

      const proposal = JSON.parse(
        await fs.readFile(
          path.join(config.brand.root, "generated", "surface-scan", "proposal.json"),
          "utf-8",
        ),
      ) as ScanProposal;

      // Behind the gate: a real Playwright waitForSelector + click on a real
      // DOM really dismissed the modal and revealed the two glyph icons + the
      // 48x48 illustration that only exist once it's gone.
      const icons = proposal.candidates.filter((c) => c.kind === "icon");
      const illustrations = proposal.candidates.filter((c) => c.kind === "illustration");
      expect(icons).toHaveLength(2);
      expect(icons.some((c) => c.hints.ariaLabel === "restaurant")).toBe(true);
      expect(illustrations).toHaveLength(1);
      expect(illustrations[0].signature).toBe(
        candidateSignature("illustration", `${baseUrl}photo.png`),
      );

      // Overlay collection from a real DOM: the walker really reads
      // position/z-index/getBoundingClientRect and hands the pure
      // `detectOverlay` real geometry — the FIRST observation (the never-
      // dismissed gated-stuck page) carries the still-blocking gate.
      expect(proposal.blockedByOverlay).toBeDefined();
      expect(proposal.blockedByOverlay!.fraction).toBeGreaterThan(OVERLAY_VIEWPORT_FRACTION);
      expect(proposal.blockedByOverlay!.hints.ariaLabel).toBe("location-gate");
      expect(result.blockedByOverlay?.hints.ariaLabel).toBe("location-gate");

      // Absence-tolerance in a real browser: a not-found note for the stuck
      // page, an applied note for the real dismiss, and the scan resolved.
      expect(proposal.setupNotes).toContainEqual(
        expect.objectContaining({
          url: gatedStuckUrl,
          step: "dismiss",
          selector: "#gate-close",
          status: "not-found",
        }),
      );
      expect(proposal.setupNotes).toContainEqual(
        expect.objectContaining({
          url: gatedUrl,
          step: "dismiss",
          selector: "#gate-close",
          status: "applied",
        }),
      );
    },
  );

  it(
    "walker-truth: structure and ignoredBy are really computed from a real DOM, and an invalid ignore selector is really swallowed in-page (SC-04)",
    { timeout: 60_000 },
    async () => {
      const config = mockConfig();
      config.scan = { ignore: ["!!!not a selector", ".grid"] };
      await useConfig(config);
      await seedApprovedDirection(config);

      const contentUrl = `${baseUrl}content`;
      const result = await runSurfaceScan({ cwd: tmpDir, urls: [contentUrl] });

      const proposal = JSON.parse(
        await fs.readFile(
          path.join(config.brand.root, "generated", "surface-scan", "proposal.json"),
          "utf-8",
        ),
      ) as ScanProposal;

      // structure ancestry is real and shared: the twelve card photos collapse
      // into exactly one group, not twelve — only possible if `path` +
      // `parentKey` were computed in-page from the shared <ul> and matched
      // across siblings.
      const twelveGroups = proposal.skipped.filter((s) => s.count === 12);
      expect(twelveGroups).toHaveLength(1);

      // ignoredBy is really marked in-page: that group's reason is
      // "ignored-selector" (the .grid subtree), proving el.closest(".grid")
      // ran against a live document and the mark travelled out of
      // page.evaluate on the payload.
      expect(twelveGroups[0].reason).toBe("ignored-selector");

      // the invalid-selector catch really holds: runSurfaceScan resolves —
      // the SyntaxError from the malformed first entry was swallowed in-page
      // and never propagated out of evaluate — and the valid entry still did
      // its job (proven by the group above existing at all).
      expect(result.dryRun).toBe(false);

      // no over-firing in a real browser: the nav svgs are still 2 icon
      // candidates and the standalone same-origin img is still 1
      // illustration candidate.
      expect(proposal.candidates.filter((c) => c.kind === "icon")).toHaveLength(2);
      expect(proposal.candidates.filter((c) => c.kind === "illustration")).toHaveLength(1);
    },
  );
});

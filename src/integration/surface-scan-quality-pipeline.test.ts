import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { oklch, formatHex } from "culori";
import type { KeyartConfig, ScanConfig, DirectionVersion, DirectionTokens } from "../types.js";

// Mock loadConfig (tmp project) AND openai, mirroring surface-pipeline.test.ts —
// every other export keeps its real implementation.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    hasApiKey: vi.fn(actual.hasApiKey),
    classifySurfaceCandidates: vi.fn(actual.classifySurfaceCandidates),
  };
});

// ---------------------------------------------------------------------------
// A SIBLING file-level `vi.mock("playwright", …)` fake (Decision 1/2 — a
// `vi.mock` factory is per-file, so this cannot be shared by import with
// scan.test.ts's). It fakes ONLY the browser driver, the same way
// scan.test.ts does: `observePage`/`runSurfaceScan` are the real,
// unmocked implementations, so setup ordering, the overlay guard,
// classification, fallback minting, the migration split, refine, apply, and
// retire all stay under genuine test. Nothing is ever fetched — the page URL
// is a plain string, never navigated to, and `evaluate` ignores the walker
// function entirely, returning whichever canned observation is registered.
//
// The one addition beyond scan.test.ts's fake: a page can be GATED — its
// `evaluate` returns the `gated` payload until the registered dismiss
// selector is actually clicked (tracked per-url in `dismissedUrls`), then the
// `content` payload thereafter. This proves setup ordering/gate-dismissal
// deterministically, without a real DOM.
// ---------------------------------------------------------------------------

const pwFake = vi.hoisted(() => ({
  tinyPngBase64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  /** url -> { gated, content, dismissSelector } — evaluate() switches on `dismissedUrls`. */
  gatedPages: new Map<string, { gated: unknown; content: unknown; dismissSelector: string }>(),
  /** url -> a single canned observation — no gate involved. */
  plainPages: new Map<string, unknown>(),
  dismissedUrls: new Set<string>(),
  unreachable: new Set<string>(),
  presentSelectors: new Set<string>(),
  calls: [] as { step: string; selector?: string; arg?: unknown }[],
}));

vi.mock("playwright", async () => {
  const fsp = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const pngBytes = Buffer.from(pwFake.tinyPngBase64, "base64");

  const chromium = {
    async launch() {
      return {
        async newPage(_options?: unknown) {
          let currentUrl = "";
          const context = {
            async addCookies(cookies: unknown) {
              pwFake.calls.push({ step: "addCookies", arg: cookies });
            },
          };
          return {
            async goto(url: string, _options?: unknown) {
              pwFake.calls.push({ step: "goto", arg: url });
              if (
                pwFake.unreachable.has(url) ||
                (!pwFake.gatedPages.has(url) && !pwFake.plainPages.has(url))
              ) {
                throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${url}`);
              }
              currentUrl = url;
              return null;
            },
            async evaluate(_fn: unknown, arg?: unknown) {
              pwFake.calls.push({ step: "evaluate", arg });
              const gated = pwFake.gatedPages.get(currentUrl);
              if (gated) {
                return pwFake.dismissedUrls.has(currentUrl) ? gated.content : gated.gated;
              }
              return pwFake.plainPages.get(currentUrl);
            },
            async screenshot(options?: { path?: string; clip?: unknown }) {
              pwFake.calls.push({
                step: "screenshot",
                arg: { path: options?.path, clip: options?.clip },
              });
              if (options?.path) {
                await fsp.mkdir(nodePath.dirname(options.path), { recursive: true });
                await fsp.writeFile(options.path, pngBytes);
              }
              return pngBytes;
            },
            async addInitScript(_fn: unknown, arg?: unknown) {
              pwFake.calls.push({ step: "addInitScript", arg });
            },
            context() {
              return context;
            },
            async waitForSelector(selector: string, _opts?: unknown) {
              pwFake.calls.push({ step: "waitForSelector", selector });
              if (!pwFake.presentSelectors.has(selector)) {
                throw new Error(`Timeout waiting for selector "${selector}"`);
              }
              return {
                async click(_opts?: unknown) {
                  pwFake.calls.push({ step: "click", selector });
                  const gated = pwFake.gatedPages.get(currentUrl);
                  if (gated && gated.dismissSelector === selector) {
                    pwFake.dismissedUrls.add(currentUrl);
                  }
                },
              };
            },
            async waitForLoadState(_state: string, _opts?: unknown) {
              pwFake.calls.push({ step: "waitForLoadState" });
            },
          };
        },
        async close() {
          /* nothing to tear down */
        },
      };
    },
  };

  return { chromium, default: { chromium } };
});

import { hasApiKey, classifySurfaceCandidates } from "../openai.js";
import type { SurfaceCandidateSuggestion } from "../openai.js";
import { dispatchCommand } from "../mcp/registry.js";
import { surfaceManifestPath } from "../config.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { createSurfaceCore } from "../surface/store.js";
import { runSurfaceBind } from "../surface/bind.js";
import { runSurfaceRefine } from "../surface/refine.js";
import {
  runSurfaceScan,
  surfaceScanDir,
  OVERLAY_VIEWPORT_FRACTION,
  type ScanProposal,
  type ObservedElement,
  type ObservedStyleUse,
  type OverlayObservation,
  type PageObservation,
} from "../surface/scan.js";
import type { SurfaceSlot } from "../surface/schema.js";
import { loadDashboardData } from "../ui/api.js";
import { pathExists } from "../fs.js";

// ── The faked-driver registration + control helpers (test-side of pwFake) ──

function resetPwFake(): void {
  pwFake.gatedPages.clear();
  pwFake.plainPages.clear();
  pwFake.dismissedUrls.clear();
  pwFake.unreachable.clear();
  pwFake.presentSelectors.clear();
  pwFake.calls = [];
}

type RawObservation = Omit<PageObservation, "url">;
type RawObservationWithOverlays = RawObservation & { overlays?: OverlayObservation[] };

function registerGatedPage(
  url: string,
  gated: RawObservationWithOverlays,
  content: RawObservationWithOverlays,
  dismissSelector: string,
): void {
  pwFake.gatedPages.set(url, { gated, content, dismissSelector });
}

function registerPlainPage(url: string, observation: RawObservationWithOverlays): void {
  pwFake.plainPages.set(url, observation);
}

function setPresentSelectors(selectors: string[]): void {
  pwFake.presentSelectors.clear();
  for (const s of selectors) pwFake.presentSelectors.add(s);
}

// ── Fixture: two "pages" (Decision 2) — canned observations, never HTML ────

const PAGE_URL = "http://127.0.0.1:4317/";
const PAGE2_URL = "http://127.0.0.1:4317/plain";
const PAGE_ORIGIN = new URL(PAGE_URL).origin;
const GATE_LABEL = "consent-gate";

function box(width: number, height: number, x = 0, y = 0): ObservedElement["box"] {
  return { x, y, width, height };
}

/** Before dismissal: a single full-viewport, high-stacking gate — no elements. */
function gatedObservation(): RawObservationWithOverlays {
  return {
    elements: [],
    colors: [],
    fontFamilies: [],
    overlays: [
      {
        box: box(1280, 720),
        zIndex: 999,
        position: "fixed",
        hints: { ariaLabel: GATE_LABEL },
      },
    ],
  };
}

/**
 * After the `#gate-accept` click: 12 repeated remote-origin cards (>=
 * CONTENT_GROUP_MIN, identical structure, differing only in `source`, whose
 * host differs from `pageOrigin` AND whose path matches the upload/CDN
 * pattern — both of WS-02's origin signals fire so the group's reason holds
 * regardless of which signal the merged classifier keys on first) + 3
 * same-origin chrome "icons" (distinct structure each, so no group forms —
 * the over-firing guard) + one legacy near-duplicate of the approved
 * direction's bound primary + one genuinely distinct color.
 */
function contentObservation(legacyColorHex: string, distinctColorHex: string): RawObservationWithOverlays {
  const vendorCards: ObservedElement[] = Array.from({ length: 12 }, (_, i) => ({
    type: "img",
    source: `https://cdn.vendor.test/uploads/vendor-${i + 1}.png`,
    box: box(48, 48, 0, 100 + i * 50),
    intrinsic: { width: 48, height: 48 },
    visible: true,
    hints: i === 0 ? { classNames: ["vendor-card"], nearbyText: "Restaurants near you" } : {},
    structure: { path: "body>ul.cards>li>img", parentKey: "ul.cards[0]", siblingIndex: i },
  }));

  const chromeIcons: ObservedElement[] = [
    {
      type: "img",
      source: `${PAGE_ORIGIN}/icons/search.svg`,
      box: box(24, 24, 0, 0),
      intrinsic: { width: 24, height: 24 },
      visible: true,
      hints: { ariaLabel: "search" },
      structure: { path: "header>nav>img.icon-search", parentKey: "header[0]", siblingIndex: 0 },
    },
    {
      type: "img",
      source: `${PAGE_ORIGIN}/icons/cart.svg`,
      box: box(24, 24, 30, 0),
      intrinsic: { width: 24, height: 24 },
      visible: true,
      hints: { ariaLabel: "cart" },
      structure: { path: "header>nav>img.icon-cart", parentKey: "header[1]", siblingIndex: 0 },
    },
    {
      type: "img",
      source: `${PAGE_ORIGIN}/icons/user.svg`,
      box: box(24, 24, 60, 0),
      intrinsic: { width: 24, height: 24 },
      visible: true,
      hints: { ariaLabel: "user" },
      structure: { path: "header>nav>img.icon-user", parentKey: "header[2]", siblingIndex: 0 },
    },
  ];

  const colors: ObservedStyleUse[] = [
    { value: legacyColorHex, count: 40, firstBox: box(1280, 80) },
    { value: distinctColorHex, count: 5, firstBox: box(1280, 80) },
  ];

  return { elements: [...chromeIcons, ...vendorCards], colors, fontFamilies: [] };
}

/** A second, unrepeated same-origin page — the "no groups ⇒ no fallback" control. */
function plainObservation(): RawObservationWithOverlays {
  return {
    elements: [
      {
        type: "svg",
        source: '<svg aria-label="heart" width="24" height="24"><path d="M0 0"/></svg>',
        box: box(24, 24, 0, 0),
        visible: true,
        hints: { ariaLabel: "heart" },
        structure: { path: "body>svg", parentKey: "body[0]", siblingIndex: 0 },
      },
    ],
    colors: [],
    fontFamilies: [],
  };
}

// ── Migration baseline — the approved direction's bound tokens (Decision 2:
// the legacy color is COMPUTED from these, never a hardcoded hex). ─────────

const DIRECTION_TOKENS: DirectionTokens = {
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

/** A hex whose OKLab distance from `hex` sits well under MIGRATION_DELTA
 *  (0.06) — nudging lightness by 0.02 stays far inside the boundary — so a
 *  palette change to `DIRECTION_TOKENS` can never make this fixture lie. */
function migratingNeighborHex(hex: string): string {
  const c = oklch(hex);
  if (!c) throw new Error(`unparseable hex: ${hex}`);
  const nudgedL = c.l >= 0.5 ? c.l - 0.02 : c.l + 0.02;
  return (formatHex({ ...c, l: nudgedL }) ?? hex).toLowerCase();
}

const LEGACY_COLOR = migratingNeighborHex(DIRECTION_TOKENS.palette[0].hex);
// Deliberately far (OKLab ΔE) from every DIRECTION_TOKENS role — the
// "distinct value stays a candidate" half of SC-07.
const DISTINCT_COLOR = "#123a5e";

const DEFAULT_SCAN_CONFIG: ScanConfig = {
  waitFor: "#cards",
  dismiss: ["#gate-accept"],
  ignore: [".ads"],
  storage: { "yaku.visitor": "known" },
  cookies: [{ name: "gate", value: "dismissed" }],
};

// ── Config + approved-direction scaffolding ─────────────────────────────────

function buildTestConfig(cwd: string, scan?: ScanConfig): KeyartConfig {
  return {
    project: { name: "Surface Scan Quality ITest", type: "prototype", framework: "next" },
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
    ...(scan ? { scan } : {}),
  };
}

async function useConfig(config: KeyartConfig): Promise<void> {
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(config);
}

function makeDirectionVersion(tokens: DirectionTokens): DirectionVersion {
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
  };
}

/** Seeds the approved direction that supplies the migration baseline. */
async function seedApprovedDirection(cwd: string, config: KeyartConfig): Promise<void> {
  const directionCore = createDirectionCore(cwd, config);
  await directionCore.create({ id: "direction-a", name: "Direction A" });
  const directionsDir = path.join(cwd, "brand", "directions");
  const version = makeDirectionVersion(DIRECTION_TOKENS);
  const versionDir = path.join(directionsDir, "direction-a", "versions", version.id);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, "direction-version.json"), JSON.stringify(version), "utf-8");
  await directionCore.appendVersion("direction-a", version.id);
  await createBrandCore(cwd, config).setPointer({
    directionId: "direction-a",
    versionId: version.id,
  });
}

/**
 * The chain helper: seeds the migration baseline and runs the REAL
 * `runSurfaceScan` over `PAGE_URL` (registered gated -> content in
 * `beforeEach`). Every test starts from a genuine scan result, not a
 * hand-synthesized proposal — that's what makes this a chain, not a set of
 * stubs. `scan: null` omits the config's `scan` block entirely (Test 3/11).
 */
async function seedAndScan(
  cwd: string,
  opts: { scan?: ScanConfig | null; urls?: string[]; apply?: boolean } = {},
): Promise<{ config: KeyartConfig; result: Awaited<ReturnType<typeof runSurfaceScan>> }> {
  const scanBlock = opts.scan === null ? undefined : (opts.scan ?? DEFAULT_SCAN_CONFIG);
  const config = buildTestConfig(cwd, scanBlock);
  await useConfig(config);
  await seedApprovedDirection(cwd, config);
  setPresentSelectors(["#cards", "#gate-accept"]);
  const urls = opts.urls ?? [PAGE_URL];
  const result = await runSurfaceScan({ cwd, urls, apply: opts.apply });
  return { config, result };
}

async function readProposal(cwd: string, config: KeyartConfig): Promise<ScanProposal> {
  const proposalPath = path.join(surfaceScanDir(cwd, config), "proposal.json");
  return JSON.parse(await fs.readFile(proposalPath, "utf-8")) as ScanProposal;
}

function surfaceManifestPathOf(cwd: string, config: KeyartConfig): string {
  return surfaceManifestPath(cwd, config);
}

/**
 * Scripts the EXISTING `classifySurfaceCandidates` seam (Decision 3) — never
 * a real call, never a key. Matches suggestions by CONTENT (the chrome
 * "search" hint, the fallback's context note, the distinct color's note)
 * rather than a hardcoded signature, so it works whichever real proposal
 * (Test 6's standalone refine, Test 8/9's scan-internal auto-refine) it is
 * handed — every returned `signature` is still echoed verbatim from the real
 * input, so suggestions are genuinely "keyed on the real signatures".
 */
function scriptRefineSeam(): void {
  process.env.OPENAI_API_KEY = "test-key";
  vi.mocked(hasApiKey).mockReturnValue(true);
  vi.mocked(classifySurfaceCandidates).mockImplementation(async (opts) => {
    const candidates: SurfaceCandidateSuggestion[] = [];
    for (const c of opts.candidates) {
      if (c.hints.ariaLabel === "search") {
        candidates.push({
          signature: c.signature,
          suggestedId: "icon.search",
          kind: "icon",
          description: "a magnifying glass",
        });
      } else if (c.contextNote?.startsWith("fallback/empty state")) {
        candidates.push({
          signature: c.signature,
          suggestedId: "illustration.vendor-placeholder",
          kind: "illustration",
          description: "an empty vendor card",
        });
      } else if (c.kind === "color-role" && c.contextNote?.includes(DISTINCT_COLOR)) {
        // The value-derived suggestion the guard must drop.
        candidates.push({
          signature: c.signature,
          suggestedId: "color.brand-green",
          kind: "color-role",
          description: "a green swatch",
        });
      }
    }
    return { candidates, dryRun: false };
  });
}

const AUTHORED_SLOT: SurfaceSlot = {
  id: "icon.brand-mark",
  kind: "icon",
  description: "the brand mark icon",
  criticality: "required",
  origin: "authored",
  attributions: [],
};

// ── Lifecycle ─────────────────────────────────────────────────────────────

let tmpDir: string;
let savedKey: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  resetPwFake();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-surface-scan-quality-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const actualOpenai = await vi.importActual<typeof import("../openai.js")>("../openai.js");
  vi.mocked(hasApiKey).mockImplementation(actualOpenai.hasApiKey);
  vi.mocked(classifySurfaceCandidates).mockImplementation(actualOpenai.classifySurfaceCandidates);

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  registerGatedPage(PAGE_URL, gatedObservation(), contentObservation(LEGACY_COLOR, DISTINCT_COLOR), "#gate-accept");
  registerPlainPage(PAGE2_URL, plainObservation());
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function logText(): string {
  return logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
}

// ---------------------------------------------------------------------------
// ONE always-running describe — no `describe.runIf`, no `chromiumAvailable()`
// probe, no fixture HTTP server, no per-test timeout override (Decision 1).
// The proof runs unconditionally in every environment; the only genuinely
// browser-dependent fact (does the real `page.evaluate` walker extract these
// elements from a real DOM) is walker-truth, owned separately by
// `scan.browser.test.ts`, which this workstream neither edits nor extends.
// ---------------------------------------------------------------------------

describe("surface-scan-quality — the full quality chain (SC-11)", () => {
  it("Test 1 — config-driven setup dismisses the gate and the content behind it is observed", async () => {
    const { config, result } = await seedAndScan(tmpDir);

    const calls = pwFake.calls;
    const idxInit = calls.findIndex((c) => c.step === "addInitScript");
    const idxCookies = calls.findIndex((c) => c.step === "addCookies");
    const idxGoto = calls.findIndex((c) => c.step === "goto");
    const idxWaitCards = calls.findIndex((c) => c.step === "waitForSelector" && c.selector === "#cards");
    const idxClickGate = calls.findIndex((c) => c.step === "click" && c.selector === "#gate-accept");

    expect(idxInit).toBeGreaterThanOrEqual(0);
    expect(idxCookies).toBeGreaterThan(idxInit);
    expect(idxCookies).toBeLessThan(idxGoto);
    expect(idxGoto).toBeLessThan(idxWaitCards);
    expect(idxWaitCards).toBeLessThan(idxClickGate);

    const proposal = await readProposal(tmpDir, config);
    expect(proposal.candidates.some((c) => c.hints.ariaLabel === "search")).toBe(true);
    expect(proposal.candidates.every((c) => c.hints.ariaLabel !== GATE_LABEL)).toBe(true);

    expect(result.blockedByOverlay).toBeUndefined();
    expect("blockedByOverlay" in proposal).toBe(false);

    // Sanity on the fixture's shape, reused by later tests: 3 chrome
    // illustrations + 1 fallback illustration + 1 distinct color candidate.
    expect(result.byKind.illustration).toBe(4);
    expect(result.byKind["color-role"]).toBe(1);
  });

  it("Test 2 — a dismiss selector that never appears is recorded, not fatal", async () => {
    const scan: ScanConfig = { ...DEFAULT_SCAN_CONFIG, dismiss: ["#gate-accept", "#never-present"] };

    const { config, result } = await seedAndScan(tmpDir, { scan });

    expect(
      result.setupNotes.some(
        (n) => n.step === "dismiss" && n.selector === "#never-present" && n.status === "not-found",
      ),
    ).toBe(true);
    expect(
      result.setupNotes.some(
        (n) => n.step === "dismiss" && n.selector === "#gate-accept" && n.status === "applied",
      ),
    ).toBe(true);

    // The candidate set is unchanged versus Test 1's baseline.
    expect(result.byKind.illustration).toBe(4);
    expect(result.byKind["color-role"]).toBe(1);
    const proposal = await readProposal(tmpDir, config);
    expect(proposal.candidates.some((c) => c.hints.ariaLabel === "search")).toBe(true);
  });

  it("Test 3 — a still-blocked page is flagged, not silently inventoried", async () => {
    const { result } = await seedAndScan(tmpDir, { scan: null });

    expect(result.blockedByOverlay).toBeDefined();
    expect(result.blockedByOverlay!.fraction).toBeGreaterThan(OVERLAY_VIEWPORT_FRACTION);
    expect(result.blockedByOverlay!.hints.ariaLabel).toBe(GATE_LABEL);

    const logs = logText();
    expect(logs).toMatch(/still appears blocked/);
    expect(logs).toContain(GATE_LABEL);
  });

  it("Test 4 — content is skipped and REPORTED; same-origin chrome survives", async () => {
    const { config } = await seedAndScan(tmpDir);
    const proposal = await readProposal(tmpDir, config);

    const nonFallbackIllustrations = proposal.candidates.filter(
      (c) => c.kind === "illustration" && c.fallbackForGroup === undefined,
    );
    expect(nonFallbackIllustrations).toHaveLength(3);

    for (const c of proposal.candidates) {
      expect(c.context?.note ?? "").not.toContain("vendor-");
      expect(c.cropFile).not.toContain("vendor-");
    }

    const skippedEntry = proposal.skipped.find((s) => s.count === 12);
    expect(skippedEntry).toBeDefined();
    // The precedence between WS-02's two independent origin signals is an
    // implementation detail of the merged classifier — assert the honest
    // outer contract (a recognized reason, a non-empty representative
    // sample), not which signal fired first.
    expect(["repeated-content", "foreign-origin"]).toContain(skippedEntry!.reason);
    expect(skippedEntry!.exampleSources.length).toBeGreaterThan(0);
    for (const src of skippedEntry!.exampleSources) {
      expect(src).toContain("vendor-");
    }

    const logs = logText();
    expect(logs).toContain(String(skippedEntry!.count));
    expect(logs).toContain(skippedEntry!.reason);

    expect(
      proposal.candidates.filter((c) => ["search", "cart", "user"].includes(c.hints.ariaLabel ?? "")),
    ).toHaveLength(3);
  });

  it("Test 5 — exactly ONE fallback candidate per group — never N", async () => {
    const { config } = await seedAndScan(tmpDir);
    const proposal = await readProposal(tmpDir, config);

    const fallbacks = proposal.candidates.filter((c) => c.fallbackForGroup !== undefined);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].kind).toBe("illustration");
    expect(fallbacks[0].hints).toEqual({
      classNames: ["vendor-card"],
      nearbyText: "Restaurants near you",
    });

    // A scan of the second, unrepeated URL yields zero fallback candidates.
    await runSurfaceScan({ cwd: tmpDir, urls: [PAGE2_URL] });
    const plainProposal = await readProposal(tmpDir, config);
    expect(plainProposal.candidates.filter((c) => c.fallbackForGroup !== undefined)).toHaveLength(0);
  });

  it("Test 6 — a value-derived refined id is DROPPED, recorded, and the candidate stays anonymous", async () => {
    const { config } = await seedAndScan(tmpDir);
    const before = await readProposal(tmpDir, config);

    const colorCandidate = before.candidates.find(
      (c) => c.kind === "color-role" && c.context?.note?.includes(DISTINCT_COLOR),
    )!;
    const iconCandidate = before.candidates.find((c) => c.hints.ariaLabel === "search")!;
    const fallbackCandidate = before.candidates.find((c) => c.fallbackForGroup !== undefined)!;
    expect(colorCandidate).toBeDefined();
    expect(iconCandidate).toBeDefined();
    expect(fallbackCandidate).toBeDefined();
    for (const c of [colorCandidate, iconCandidate, fallbackCandidate]) {
      expect(await pathExists(path.join(tmpDir, c.cropFile))).toBe(true);
    }
    expect(await pathExists(surfaceManifestPathOf(tmpDir, config))).toBe(false);

    scriptRefineSeam();
    const refineResult = await runSurfaceRefine({ cwd: tmpDir });
    delete process.env.OPENAI_API_KEY;

    expect(refineResult.dryRun).toBe(false);

    const after = await readProposal(tmpDir, config);

    const colorAfter = after.candidates.find((c) => c.signature === colorCandidate.signature)!;
    expect(colorAfter.proposedId).toBe(colorCandidate.proposedId);
    expect(colorAfter.proposedId).toMatch(/^color\.unnamed-\d+$/);
    expect(colorAfter.refined?.proposedId).not.toBe(true);
    expect(
      after.refineNotes?.some(
        (n) => n.includes(colorCandidate.signature) && n.includes("brand-green"),
      ),
    ).toBe(true);

    const iconAfter = after.candidates.find((c) => c.signature === iconCandidate.signature)!;
    expect(iconAfter.proposedId).toBe("icon.search");
    expect(iconAfter.refined?.proposedId).toBe(true);
    expect(iconAfter.kind).toBe("icon");

    const fallbackAfter = after.candidates.find((c) => c.signature === fallbackCandidate.signature)!;
    expect(fallbackAfter.proposedId).toBe("illustration.vendor-placeholder");
    expect(fallbackAfter.refined?.proposedId).toBe(true);

    // Refinement upgrades the PROPOSAL only.
    expect(await pathExists(surfaceManifestPathOf(tmpDir, config))).toBe(false);
  });

  it("Test 7 — the legacy color surfaces as a MIGRATION FINDING and never as a candidate", async () => {
    const { config } = await seedAndScan(tmpDir);
    const proposal = await readProposal(tmpDir, config);

    const finding = proposal.migrations.find((m) => m.value === LEGACY_COLOR);
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("color-role");
    expect(finding!.nearestRole).toBe("--brand-primary");
    expect(finding!.occurrences).toBeGreaterThan(1);
    expect(finding!.examples.length).toBeGreaterThan(0);

    expect(proposal.candidates.some((c) => c.context?.note?.includes(LEGACY_COLOR))).toBe(false);
    expect(proposal.candidates.some((c) => c.context?.note?.includes(DISTINCT_COLOR))).toBe(true);

    const logs = logText();
    expect(logs).toContain("Migration findings");
    expect(logs).toContain(LEGACY_COLOR);
    expect(logs).toMatch(/Proposed \d+ candidate/);
  });

  it("Test 8 — apply writes ONLY the legitimate slots", async () => {
    scriptRefineSeam();
    const { config } = await seedAndScan(tmpDir, { apply: true });
    delete process.env.OPENAI_API_KEY;

    const rawYaml = await fs.readFile(surfaceManifestPathOf(tmpDir, config), "utf-8");
    expect(rawYaml).not.toContain("brand-green");
    expect(rawYaml).not.toContain(LEGACY_COLOR);

    const manifest = await createSurfaceCore(tmpDir, config).read();
    const icon = manifest!.slots.find((s) => s.id === "icon.search");
    const illo = manifest!.slots.find((s) => s.id === "illustration.vendor-placeholder");
    expect(icon).toBeDefined();
    expect(illo).toBeDefined();
    for (const slot of [icon!, illo!]) {
      expect(slot.origin).toBe("scan");
      expect(slot.attributions).toHaveLength(1);
      expect(slot.attributions[0].source).toMatch(/^surface-scan:[0-9a-f]{16}$/);
    }

    // A migration finding is structurally unable to be an accepted candidate
    // (it carries no signature — `candidateToSlot` has nothing to key on).
    const proposal = await readProposal(tmpDir, config);
    for (const finding of proposal.migrations) {
      expect((finding as unknown as { signature?: unknown }).signature).toBeUndefined();
    }
  });

  it("Test 9 — surface retire --origin scan clears them non-destructively and idempotently", async () => {
    const config = buildTestConfig(tmpDir, DEFAULT_SCAN_CONFIG);
    await useConfig(config);
    await seedApprovedDirection(tmpDir, config);

    const setRes = await dispatchCommand(
      { command: "surface", input: ["set", JSON.stringify([AUTHORED_SLOT])] },
      { defaultCwd: tmpDir },
    );
    expect(setRes.isError).toBe(false);

    setPresentSelectors(["#cards", "#gate-accept"]);
    scriptRefineSeam();
    await runSurfaceScan({ cwd: tmpDir, urls: [PAGE_URL], apply: true });
    delete process.env.OPENAI_API_KEY;

    const manifestBefore = await createSurfaceCore(tmpDir, config).read();
    const scanSlotIds = manifestBefore!.slots.filter((s) => s.origin === "scan").map((s) => s.id);
    expect(scanSlotIds.length).toBeGreaterThan(0);

    const res1 = await dispatchCommand(
      { command: "surface", input: ["retire", "--origin", "scan"] },
      { defaultCwd: tmpDir },
    );
    expect(res1.isError).toBe(false);

    const manifestAfter1 = await createSurfaceCore(tmpDir, config).read();
    for (const id of scanSlotIds) {
      expect(manifestAfter1!.slots.find((s) => s.id === id)!.retiredAt).toBeTruthy();
    }
    const authoredAfter1 = manifestAfter1!.slots.find((s) => s.id === AUTHORED_SLOT.id)!;
    expect(authoredAfter1.retiredAt).toBeUndefined();

    const rawBeforeSecond = await fs.readFile(surfaceManifestPathOf(tmpDir, config), "utf-8");
    const versionBeforeSecond = manifestAfter1!.version;

    const res2 = await dispatchCommand(
      { command: "surface", input: ["retire", "--origin", "scan"] },
      { defaultCwd: tmpDir },
    );
    expect(res2.isError).toBe(false);

    const rawAfterSecond = await fs.readFile(surfaceManifestPathOf(tmpDir, config), "utf-8");
    expect(rawAfterSecond).toBe(rawBeforeSecond);
    const manifestAfter2 = await createSurfaceCore(tmpDir, config).read();
    expect(manifestAfter2!.version).toBe(versionBeforeSecond);
  });

  it("Test 10 — the studio read sees the quality signals and never writes", async () => {
    scriptRefineSeam();
    const { config } = await seedAndScan(tmpDir, { apply: true });
    delete process.env.OPENAI_API_KEY;

    await runSurfaceBind({ cwd: tmpDir });
    const bindingPath = path.join(tmpDir, "brand", "generated", "binding.json");
    const before = await fs.readFile(bindingPath);

    const dashboard = await loadDashboardData(tmpDir);

    const after = await fs.readFile(bindingPath);
    expect(after.equals(before)).toBe(true);

    expect(dashboard.surface).not.toBeNull();
    expect(dashboard.surface!.proposal).toBeDefined();
    expect(dashboard.surface!.proposal!.skipped.length).toBeGreaterThan(0);
    expect(dashboard.surface!.proposal!.migrations.length).toBeGreaterThan(0);
    expect(dashboard.surface!.proposal!.blockedByOverlay).toBeUndefined();
    expect(dashboard.errors).toEqual([]);

    void config;
  });

  it("Test 11 — keyless honesty + the standing invariants (closer)", async () => {
    // A refine over a fresh scan's floor proposal, keyless, degrades honestly.
    const { config } = await seedAndScan(tmpDir);
    delete process.env.OPENAI_API_KEY;
    const refineResult = await runSurfaceRefine({ cwd: tmpDir });
    expect(refineResult.dryRun).toBe(true);
    expect(refineResult.refinedCount).toBe(0);
    const proposalAfterRefine = await readProposal(tmpDir, config);
    expect(proposalAfterRefine.candidates.every((c) => c.refined === undefined)).toBe(true);

    // A config WITHOUT a scan block round-trips through the real schema and
    // scans identically to pre-program: same candidate set as WITH a scan
    // block, for a page that never needed the setup anyway.
    const { KeyartConfigSchema } = await import("../config.js");
    const noScanConfig = buildTestConfig(tmpDir, undefined);
    const parsed = KeyartConfigSchema.safeParse(noScanConfig);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.scan).toBeUndefined();

    await useConfig(noScanConfig);
    const plainResult = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE2_URL] });
    expect(plainResult.setupNotes).toEqual([]);
    expect(plainResult.blockedByOverlay).toBeUndefined();
    const plainProposal = await readProposal(tmpDir, noScanConfig);

    const withScanConfig = buildTestConfig(tmpDir, DEFAULT_SCAN_CONFIG);
    await useConfig(withScanConfig);
    setPresentSelectors(["#cards", "#gate-accept"]);
    await runSurfaceScan({ cwd: tmpDir, urls: [PAGE2_URL] });
    const proposalWithScan = await readProposal(tmpDir, withScanConfig);

    expect(proposalWithScan.candidates.map((c) => ({ kind: c.kind, hints: c.hints }))).toEqual(
      plainProposal.candidates.map((c) => ({ kind: c.kind, hints: c.hints })),
    );

    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});

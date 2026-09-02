import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DirectionVersion, DirectionTokens, KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import { pathExists } from "../fs.js";
import { SLOT_ID_RE, SurfaceSlotSchema } from "./schema.js";
import {
  buildScanCandidates,
  candidateSignature,
  runSurfaceScan,
  resolveScanSetup,
  isEmptyScanSetup,
  detectOverlay,
  describeOverlayHints,
  fallbackCandidateFor,
  FALLBACK_REASONS,
  clipFor,
  OVERLAY_VIEWPORT_FRACTION,
  OVERLAY_MIN_Z_INDEX,
  type ObservedElement,
  type ObservedStyleUse,
  type OverlayObservation,
  type PageObservation,
  type ScanProposal,
  type ScanSetup,
  type TokenBaseline,
} from "./scan.js";
import { contentGroupKeyOf, type ContentGroup } from "./classify-content.js";
import type { ScanConfig } from "../types.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { createSurfaceCore } from "./store.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

// ---------------------------------------------------------------------------
// The fake `playwright`.
//
// ONLY the code that actually runs inside a browser needs a browser — in
// `scan.ts` that is exactly the `page.evaluate(...)` walker inside
// `observePage`. Its truth is proven against real Chromium in
// `scan.browser.test.ts`. Everything else in `runSurfaceScan` consumes a plain
// `PageObservation`, so here we fake the `playwright` MODULE (never
// `observePage`, never `runSurfaceScan` — their real code stays under test) and
// hand `evaluate` a canned raw payload. The walker function argument is
// ignored on purpose.
//
// The fake satisfies exactly what `runSurfaceScan` uses:
//   chromium.launch() -> browser.newPage({ viewport })
//   page.goto(url, opts) / page.evaluate(fn) / page.screenshot({ path, clip })
//   browser.close()
// `screenshot` writes a real (tiny) PNG so crop-file assertions and downstream
// readers see genuine files on disk.
// ---------------------------------------------------------------------------

const pwFake = vi.hoisted(() => ({
  /** url -> canned `{ elements, colors, fontFamilies, overlays? }` payload. */
  observations: new Map<string, unknown>(),
  /** urls whose `goto` must reject (unknown urls reject too). */
  unreachable: new Set<string>(),
  /** A 1x1 PNG, base64 — a real PNG, not a placeholder byte string. */
  tinyPngBase64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  /** Selectors `waitForSelector` resolves for — everything else times out. */
  presentSelectors: new Set<string>(),
  /** Selectors whose `click` rejects. */
  clickFailSelectors: new Set<string>(),
  /** `context().addCookies` rejects when true. */
  cookiesShouldFail: false,
  /** `waitForLoadState` rejects when true (proves the `.catch(() => {})` swallow). */
  waitForLoadStateShouldFail: false,
  /** `screenshot` basenames (e.g. "<signature>.png") whose call must reject —
   *  WS-03's path-keyed screenshot-failure toggle. */
  screenshotFailures: new Set<string>(),
  /** Ordered step log: "addInitScript" | "addCookies" | "goto" | "waitForSelector" | "click" | "waitForLoadState" | "screenshot". */
  calls: [] as { step: string; selector?: string; arg?: unknown }[],
}));

function resetPwFake(): void {
  pwFake.observations.clear();
  pwFake.unreachable.clear();
  pwFake.presentSelectors.clear();
  pwFake.clickFailSelectors.clear();
  pwFake.cookiesShouldFail = false;
  pwFake.waitForLoadStateShouldFail = false;
  pwFake.screenshotFailures.clear();
  pwFake.calls = [];
}

/** Simple step-name view of the call-order recorder — the ordering assertion target. */
function callSteps(): string[] {
  return pwFake.calls.map((c) => c.step);
}

/** Selectors the fake's `waitForSelector` resolves for — everything else times out. */
function setPresentSelectors(selectors: string[]): void {
  pwFake.presentSelectors.clear();
  for (const s of selectors) pwFake.presentSelectors.add(s);
}

/** Arms the fake so `click()` on `selector` rejects (the dismiss "failed" note). */
function armClickFailure(selector: string): void {
  pwFake.clickFailSelectors.add(selector);
}

/** Arms the fake so `context().addCookies(...)` rejects (the cookies "failed" note). */
function armCookiesFailure(): void {
  pwFake.cookiesShouldFail = true;
}

/** Arms the fake so the ONE `screenshot` call whose `path` ends with
 *  `<signature>.png` rejects, while every other crop still succeeds. */
function failScreenshotFor(signature: string): void {
  pwFake.screenshotFailures.add(`${signature}.png`);
}

vi.mock("playwright", async () => {
  const fsp = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const pngBytes = Buffer.from(pwFake.tinyPngBase64, "base64");

  const chromium = {
    executablePath: () => "",
    async launch() {
      return {
        async newPage(_options?: unknown) {
          let currentUrl = "";
          const context = {
            async addCookies(cookies: unknown) {
              pwFake.calls.push({ step: "addCookies", arg: cookies });
              if (pwFake.cookiesShouldFail) {
                throw new Error("context.addCookies: rejected by fixture");
              }
            },
          };
          return {
            async goto(url: string, _options?: unknown) {
              pwFake.calls.push({ step: "goto", arg: url });
              if (pwFake.unreachable.has(url) || !pwFake.observations.has(url)) {
                throw new Error(
                  `page.goto: net::ERR_CONNECTION_REFUSED at ${url}\n` +
                    `Call log:\n  - navigating to "${url}", waiting until "networkidle"`,
                );
              }
              currentUrl = url;
              return null;
            },
            async evaluate(_fn: unknown, arg?: unknown) {
              pwFake.calls.push({ step: "evaluate", arg });
              return pwFake.observations.get(currentUrl);
            },
            async screenshot(options?: { path?: string; clip?: unknown }) {
              pwFake.calls.push({
                step: "screenshot",
                arg: { path: options?.path, clip: options?.clip },
              });
              const basename = options?.path ? nodePath.basename(options.path) : undefined;
              if (basename && pwFake.screenshotFailures.has(basename)) {
                throw new Error(`page.screenshot: rejected by fixture for ${basename}`);
              }
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
                  if (pwFake.clickFailSelectors.has(selector)) {
                    throw new Error(`click failed for "${selector}"`);
                  }
                },
              };
            },
            async waitForLoadState(_state: string, _opts?: unknown) {
              pwFake.calls.push({ step: "waitForLoadState" });
              if (pwFake.waitForLoadStateShouldFail) {
                throw new Error("waitForLoadState: rejected by fixture");
              }
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

/** The raw payload shape `observePage`'s `page.evaluate` resolves to. */
type RawObservation = Omit<PageObservation, "url">;
/** The evaluate-return shape, including the internal `overlays` payload
 *  `observePage` strips before returning a `PageObservation`. */
type RawObservationWithOverlays = RawObservation & { overlays?: OverlayObservation[] };

/** Set the canned observation a fake `page.evaluate` returns for `url`. */
function setObservation(url: string, observation: RawObservationWithOverlays): void {
  pwFake.unreachable.delete(url);
  pwFake.observations.set(url, observation);
}

/** Make the fake `page.goto` reject for `url` (the unreachable-URL case). */
function markUnreachable(url: string): void {
  pwFake.observations.delete(url);
  pwFake.unreachable.add(url);
}

// ---------------------------------------------------------------------------
// Shared fixtures: a minimal box, an empty baseline, an empty coverage set.
// ---------------------------------------------------------------------------

function box(width: number, height: number, x = 0, y = 0): ObservedElement["box"] {
  return { x, y, width, height };
}

/** Compile-fix + fixture default: `ObservedElement.structure` is required. The
 *  pre-existing threshold/dedupe/id-mint fixtures share this default (their
 *  assertions never key on structure); the content-classification fixtures
 *  override it with meaningful values (Test 15/16/17/19/19b). */
function structure(
  path = "body>div>svg",
  parentKey = "body[0]",
  siblingIndex = 0,
): ObservedElement["structure"] {
  return { path, parentKey, siblingIndex };
}

function emptyBaseline(): TokenBaseline {
  return { hexes: new Set(), families: new Set() };
}

function emptyCoverage() {
  return {
    coveredSignatures: new Set<string>(),
    coveredNotes: new Set<string>(),
    takenIds: new Set<string>(),
  };
}

// ===========================================================================
// Pure floor — no Playwright, always runs.
// ===========================================================================

describe("buildScanCandidates — classification + thresholds (Test 1)", () => {
  it("classifies icons/illustrations by conservative bounds and filters spacers + invisible elements", () => {
    const observations: PageObservation[] = [
      {
        url: "http://fixture/",
        elements: [
          // A 24x24 visible svg -> one icon candidate.
          {
            type: "svg",
            source: "<svg width=\"24\" height=\"24\"></svg>",
            box: box(24, 24),
            visible: true,
            hints: {},
            structure: structure(),
          },
          // A 200x200 svg -> outside ICON_MAX, no icon candidate.
          {
            type: "svg",
            source: "<svg width=\"200\" height=\"200\"></svg>",
            box: box(200, 200),
            visible: true,
            hints: {},
            structure: structure(),
          },
          // A 6x6 svg -> below ICON_MIN, no icon candidate.
          {
            type: "svg",
            source: "<svg width=\"6\" height=\"6\"></svg>",
            box: box(6, 6),
            visible: true,
            hints: {},
            structure: structure(),
          },
          // A 48x48 img -> illustration.
          {
            type: "img",
            source: "http://fixture/photo.png",
            box: box(48, 48),
            intrinsic: { width: 48, height: 48 },
            visible: true,
            hints: {},
            structure: structure(),
          },
          // A 1x1-intrinsic img -> filtered (spacer).
          {
            type: "img",
            source: "http://fixture/spacer.png",
            box: box(20, 20),
            intrinsic: { width: 1, height: 1 },
            visible: true,
            hints: {},
            structure: structure(),
          },
          // A 2px-tall img -> filtered (below ILLUSTRATION_MIN).
          {
            type: "img",
            source: "http://fixture/sliver.png",
            box: box(40, 2),
            intrinsic: { width: 40, height: 2 },
            visible: true,
            hints: {},
            structure: structure(),
          },
          // An invisible glyph-sized svg -> filtered.
          {
            type: "svg",
            source: "<svg width=\"24\" height=\"24\" class=\"hidden\"></svg>",
            box: box(24, 24),
            visible: false,
            hints: {},
            structure: structure(),
          },
        ],
        colors: [],
        fontFamilies: [],
      },
    ];

    const { candidates, skippedCovered } = buildScanCandidates(
      observations,
      emptyBaseline(),
      emptyCoverage(),
    );

    expect(skippedCovered).toBe(0);
    expect(candidates.filter((c) => c.kind === "icon")).toHaveLength(1);
    expect(candidates.filter((c) => c.kind === "illustration")).toHaveLength(1);
    expect(candidates).toHaveLength(2);
  });
});

describe("buildScanCandidates — role candidates + baseline diff + caps (Test 2)", () => {
  it("only off-baseline values become candidates, most-frequent-first, capped at 6/3, observed value verbatim in context.note", () => {
    const url = "http://fixture/";
    const colorUses: ObservedStyleUse[] = [
      { value: "#ffffff", count: 99, firstBox: box(10, 10) }, // in baseline -> excluded
      { value: "#111111", count: 1, firstBox: box(10, 10) }, // in baseline -> excluded
      { value: "#aaaaaa", count: 8, firstBox: box(10, 10) },
      { value: "#bbbbbb", count: 7, firstBox: box(10, 10) },
      { value: "#cccccc", count: 6, firstBox: box(10, 10) },
      { value: "#dddddd", count: 5, firstBox: box(10, 10) },
      { value: "#eeeeee", count: 4, firstBox: box(10, 10) },
      { value: "#123456", count: 3, firstBox: box(10, 10) },
      { value: "#234567", count: 2, firstBox: box(10, 10) }, // beyond cap of 6
      { value: "#345678", count: 1, firstBox: box(10, 10) }, // beyond cap of 6
    ];
    const fontUses: ObservedStyleUse[] = [
      { value: "Inter", count: 50, firstBox: box(10, 10) }, // in baseline -> excluded
      { value: "Space Grotesk", count: 5, firstBox: box(10, 10) },
      { value: "Arial", count: 3, firstBox: box(10, 10) },
      { value: "Courier", count: 2, firstBox: box(10, 10) },
      { value: "Verdana", count: 1, firstBox: box(10, 10) }, // beyond cap of 3
    ];

    const observations: PageObservation[] = [
      { url, elements: [], colors: colorUses, fontFamilies: fontUses },
    ];
    const baseline: TokenBaseline = {
      hexes: new Set(["#ffffff", "#111111"]),
      families: new Set(["inter"]),
    };

    const { candidates } = buildScanCandidates(observations, baseline, emptyCoverage());
    const colorCandidates = candidates.filter((c) => c.kind === "color-role");
    const typeCandidates = candidates.filter((c) => c.kind === "type-role");

    expect(colorCandidates).toHaveLength(6);
    expect(colorCandidates.map((c) => c.context?.note)).toEqual([
      `observed color #aaaaaa on ${url}`,
      `observed color #bbbbbb on ${url}`,
      `observed color #cccccc on ${url}`,
      `observed color #dddddd on ${url}`,
      `observed color #eeeeee on ${url}`,
      `observed color #123456 on ${url}`,
    ]);

    expect(typeCandidates).toHaveLength(3);
    expect(typeCandidates.map((c) => c.context?.note)).toEqual([
      `observed font "space grotesk" on ${url}`,
      `observed font "arial" on ${url}`,
      `observed font "courier" on ${url}`,
    ]);
  });
});

describe("candidateSignature — stability + kind scoping (Test 3)", () => {
  it("is stable across calls, kind-scoped, and collapses whitespace-only markup differences", () => {
    const a = candidateSignature("icon", "<svg><circle/></svg>");
    const b = candidateSignature("icon", "<svg><circle/></svg>");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);

    const asIllustration = candidateSignature("illustration", "<svg><circle/></svg>");
    expect(asIllustration).not.toBe(a);

    // Whitespace-only differences in svg markup collapse to the SAME icon
    // signature once the impure classifier collapses whitespace (a run of
    // whitespace, not the absence of it, is what collapses).
    const compact = '<svg width="24" height="24"> <circle r="10"/> </svg>';
    const spaced = '<svg   width="24"  height="24">\n  <circle r="10"/>\n  </svg>';
    const observations: PageObservation[] = [
      {
        url: "http://fixture/",
        elements: [
          { type: "svg", source: compact, box: box(24, 24), visible: true, hints: {}, structure: structure() },
          { type: "svg", source: spaced, box: box(24, 24), visible: true, hints: {}, structure: structure() },
        ],
        colors: [],
        fontFamilies: [],
      },
    ];
    const { candidates } = buildScanCandidates(observations, emptyBaseline(), emptyCoverage());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].signature).toBe(candidateSignature("icon", compact));
  });
});

describe("contentGroupKeyOf — stable and shape-derived (Test 15)", () => {
  it("is equal for equal type/path/parentKey regardless of siblingIndex/source, and changes when path or parentKey changes", () => {
    const a: ObservedElement = {
      type: "img",
      source: "http://fixture/a.jpg",
      box: box(48, 48),
      visible: true,
      hints: {},
      structure: structure("ul.grid>li>img", "ul.grid[0]", 0),
    };
    const b: ObservedElement = {
      ...a,
      source: "http://fixture/b.jpg",
      structure: structure("ul.grid>li>img", "ul.grid[0]", 5),
    };
    expect(contentGroupKeyOf(a)).toBe(contentGroupKeyOf(b));

    const differentPath: ObservedElement = {
      ...a,
      structure: structure("ul.other>li>img", "ul.grid[0]", 0),
    };
    expect(contentGroupKeyOf(a)).not.toBe(contentGroupKeyOf(differentPath));

    const differentParentKey: ObservedElement = {
      ...a,
      structure: structure("ul.grid>li>img", "ul.grid[3]", 0),
    };
    expect(contentGroupKeyOf(a)).not.toBe(contentGroupKeyOf(differentParentKey));
  });
});

describe("buildScanCandidates — id minting is honest, regex-valid, and collision-free (Test 4)", () => {
  it("mints per-kind unnamed-N ids in stable order, validated against the WS-01 slot-id regex, skipping taken ids", () => {
    const observations: PageObservation[] = [
      {
        url: "http://fixture/",
        elements: [
          { type: "svg", source: "<svg id=\"a\"/>", box: box(24, 24), visible: true, hints: {}, structure: structure() },
          { type: "svg", source: "<svg id=\"b\"/>", box: box(24, 24), visible: true, hints: {}, structure: structure() },
          { type: "img", source: "http://fixture/x.png", box: box(48, 48), visible: true, hints: {}, structure: structure() },
        ],
        colors: [{ value: "#123456", count: 1, firstBox: box(10, 10) }],
        fontFamilies: [{ value: "Courier", count: 1, firstBox: box(10, 10) }],
      },
    ];

    const { candidates } = buildScanCandidates(observations, emptyBaseline(), emptyCoverage());
    expect(candidates.map((c) => c.proposedId)).toEqual([
      "icon.unnamed-1",
      "icon.unnamed-2",
      "illustration.unnamed-1",
      "color.unnamed-1",
      "type.unnamed-1",
    ]);

    for (const candidate of candidates) {
      expect(SLOT_ID_RE.test(candidate.proposedId)).toBe(true);
      const synthesized = SurfaceSlotSchema.parse({
        id: candidate.proposedId,
        kind: candidate.kind,
        description: "Scanned candidate",
        criticality: "preferred",
        origin: "scan",
        attributions: [],
      });
      expect(synthesized.id).toBe(candidate.proposedId);
    }

    const coverageWithTaken = { ...emptyCoverage(), takenIds: new Set(["icon.unnamed-1"]) };
    const single: PageObservation[] = [
      {
        url: "http://fixture/",
        elements: [
          { type: "svg", source: "<svg id=\"a\"/>", box: box(24, 24), visible: true, hints: {}, structure: structure() },
        ],
        colors: [],
        fontFamilies: [],
      },
    ];
    const { candidates: skipped } = buildScanCandidates(single, emptyBaseline(), coverageWithTaken);
    expect(skipped[0].proposedId).toBe("icon.unnamed-2");
  });
});

describe("buildScanCandidates — coverage omits covered + rejected (Test 5)", () => {
  it("omits a signature-covered element and a note-covered color-role, counting both as skippedCovered", () => {
    const svgSource = "<svg id=\"covered\"/>";
    const coveredSig = candidateSignature("icon", svgSource);
    const colorSig = candidateSignature("color-role", "#654321");

    const observations: PageObservation[] = [
      {
        url: "http://fixture/",
        elements: [
          { type: "svg", source: svgSource, box: box(24, 24), visible: true, hints: {}, structure: structure() },
          {
            type: "svg",
            source: "<svg id=\"fresh\"/>",
            box: box(24, 24),
            visible: true,
            hints: {},
            structure: structure(),
          },
        ],
        colors: [
          { value: "#654321", count: 5, firstBox: box(10, 10) },
          { value: "#abcabc", count: 1, firstBox: box(10, 10) },
        ],
        fontFamilies: [],
      },
    ];

    const coverage = {
      coveredSignatures: new Set([coveredSig]),
      coveredNotes: new Set(["existing slot notes observed color #654321 elsewhere"]),
      takenIds: new Set<string>(),
    };

    const { candidates, skippedCovered } = buildScanCandidates(
      observations,
      emptyBaseline(),
      coverage,
    );

    expect(candidates.some((c) => c.signature === coveredSig)).toBe(false);
    expect(candidates.some((c) => c.signature === colorSig)).toBe(false);
    expect(candidates.find((c) => c.kind === "icon")).toBeDefined();
    expect(candidates.some((c) => c.context?.note?.includes("#abcabc"))).toBe(true);
    expect(skippedCovered).toBe(2);
  });
});

// ===========================================================================
// fallbackCandidateFor — pure mint (WS-03), no DOM, no Playwright.
// ===========================================================================

function fallbackGroup(overrides: Partial<ContentGroup> = {}): ContentGroup {
  return {
    key: "img|ul.grid>li.card>a>img|ul.grid[0]",
    count: 12,
    reason: "repeated-content",
    exampleSources: ["https://cdn.cards.example/photo-0.jpg"],
    hints: { classNames: ["card-photo"], nearbyText: "Restaurants near you" },
    ...overrides,
  };
}

describe("fallbackCandidateFor — the fallback candidate contract (WS-03 Test 1)", () => {
  it("mints an anonymous illustration candidate joined back to its group", () => {
    const group = fallbackGroup();
    const candidate = fallbackCandidateFor(group, "http://fixture.test/", {}, new Set());

    expect(candidate.kind).toBe("illustration");
    expect(candidate.proposedId).toBe("illustration.unnamed-1");
    expect(SLOT_ID_RE.test(candidate.proposedId)).toBe(true);
    expect(candidate.fallbackForGroup).toBe(group.key);
    expect(candidate.description).toBeUndefined();
    expect(candidate.signature).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("fallbackCandidateFor — hints carried through verbatim (WS-03 Test 2)", () => {
  it("candidate.hints deep-equals the group's hints", () => {
    const group = fallbackGroup();
    const candidate = fallbackCandidateFor(group, "http://fixture.test/", {}, new Set());
    expect(candidate.hints).toEqual(group.hints);
  });
});

describe("fallbackCandidateFor — context.note describes the group (WS-03 Test 3)", () => {
  it("the note names the reason, the count, and the page", () => {
    const group = fallbackGroup();
    const url = "http://fixture.test/restaurants";
    const candidate = fallbackCandidateFor(group, url, {}, new Set());
    expect(candidate.context?.note).toContain("repeated-content");
    expect(candidate.context?.note).toContain("12");
    expect(candidate.context?.note).toContain(url);
  });
});

describe("fallbackCandidateFor — signature is stable and group-derived (WS-03 Test 4)", () => {
  it("identical groups sign identically; a one-character key change signs differently", () => {
    const group = fallbackGroup();
    const a = fallbackCandidateFor(group, "http://fixture.test/", {}, new Set());
    const b = fallbackCandidateFor(group, "http://fixture.test/", {}, new Set());
    expect(a.signature).toBe(b.signature);

    const differentGroup = fallbackGroup({ key: group.key + "x" });
    const c = fallbackCandidateFor(differentGroup, "http://fixture.test/", {}, new Set());
    expect(c.signature).not.toBe(a.signature);
  });
});

describe("fallbackCandidateFor — id minting shares the run's taken ids (WS-03 Test 5)", () => {
  it("skips ids already taken by element candidates or existing manifest slots", () => {
    const group = fallbackGroup();
    const taken = new Set(["illustration.unnamed-1", "illustration.unnamed-2"]);
    const candidate = fallbackCandidateFor(group, "http://fixture.test/", {}, taken);
    expect(candidate.proposedId).toBe("illustration.unnamed-3");
  });
});

describe("fallbackCandidateFor — two groups mint two distinct candidates, in order (WS-03 Test 6)", () => {
  it("distinct signatures and distinct ids through the same counters/takenIds", () => {
    const groupA = fallbackGroup();
    const groupB = fallbackGroup({
      key: "svg|nav>svg|nav[0]",
      reason: "foreign-origin",
      count: 3,
      hints: {},
    });
    const counters: Record<string, number> = {};
    const taken = new Set<string>();
    const a = fallbackCandidateFor(groupA, "http://fixture.test/", counters, taken);
    taken.add(a.proposedId);
    const b = fallbackCandidateFor(groupB, "http://fixture.test/", counters, taken);

    expect(a.signature).not.toBe(b.signature);
    expect(a.proposedId).toBe("illustration.unnamed-1");
    expect(b.proposedId).toBe("illustration.unnamed-2");
  });
});

describe("FALLBACK_REASONS — excludes explicit ignores (WS-03 Test 7)", () => {
  it("contains repeated-content and foreign-origin, never ignored-selector", () => {
    expect(FALLBACK_REASONS).toContain("repeated-content");
    expect(FALLBACK_REASONS).toContain("foreign-origin");
    expect(FALLBACK_REASONS).not.toContain("ignored-selector");
  });
});

describe("fallbackCandidateFor — purity (WS-03 Test 8)", () => {
  it("is deterministic across calls with the same inputs", () => {
    const group = fallbackGroup();
    const a = fallbackCandidateFor(group, "http://fixture.test/", {}, new Set());
    const b = fallbackCandidateFor(group, "http://fixture.test/", {}, new Set());
    expect(a).toEqual(b);
  });
});

// ===========================================================================
// Pure setup + overlay unit cases (Tests 4–10) — no driver at all.
// ===========================================================================

describe("resolveScanSetup — config only (Test 4)", () => {
  it("yields all four setup keys from config; ignore/contentOrigins never copied", () => {
    const configScan: ScanConfig = {
      waitFor: "main",
      dismiss: ["#a", "#b"],
      storage: { k: "v" },
      cookies: [{ name: "seen", value: "yes" }],
      ignore: [".ads"],
      contentOrigins: ["cdn.example.com"],
    };
    const setup = resolveScanSetup(configScan, undefined);
    expect(setup).toEqual({
      waitFor: "main",
      dismiss: ["#a", "#b"],
      storage: { k: "v" },
      cookies: [{ name: "seen", value: "yes" }],
    });
    expect(Object.keys(setup).sort()).toEqual(["cookies", "dismiss", "storage", "waitFor"]);
  });
});

describe("resolveScanSetup — an override REPLACES, never merges (Test 5)", () => {
  it("an override dismiss array replaces the config array outright", () => {
    const configScan: ScanConfig = { dismiss: ["#a", "#b"] };
    const setup = resolveScanSetup(configScan, { dismiss: ["#c"] });
    expect(setup.dismiss).toEqual(["#c"]);
  });

  it("an override waitFor wins over config", () => {
    const configScan: ScanConfig = { waitFor: "main" };
    const setup = resolveScanSetup(configScan, { waitFor: "footer" });
    expect(setup.waitFor).toBe("footer");
  });

  it("an absent override key falls through to config", () => {
    const configScan: ScanConfig = { waitFor: "main", dismiss: ["#a"] };
    const setup = resolveScanSetup(configScan, { dismiss: ["#c"] });
    expect(setup.waitFor).toBe("main");
  });

  it("an override dismiss: [] is treated as absent, falling through to config", () => {
    const configScan: ScanConfig = { dismiss: ["#a"] };
    const setup = resolveScanSetup(configScan, { dismiss: [] });
    expect(setup.dismiss).toEqual(["#a"]);
  });
});

describe("isEmptyScanSetup gates the byte-identical path (Test 6)", () => {
  it("resolveScanSetup(undefined, undefined) is empty", () => {
    const setup = resolveScanSetup(undefined, undefined);
    expect(setup).toEqual({});
    expect(isEmptyScanSetup(setup)).toBe(true);
  });

  it("a config with only ignore/contentOrigins set is ALSO empty", () => {
    const configScan: ScanConfig = { ignore: [".ads"], contentOrigins: ["cdn.example.com"] };
    const setup = resolveScanSetup(configScan, undefined);
    expect(isEmptyScanSetup(setup)).toBe(true);
  });
});

function overlayBlocker(overrides: Partial<OverlayObservation> = {}): OverlayObservation {
  return {
    box: { x: 0, y: 0, width: 1280, height: 720 },
    zIndex: 999,
    position: "fixed",
    hints: {},
    ...overrides,
  };
}

describe("detectOverlay — boundary on both sides (Test 7)", () => {
  // Round numbers (1000x1000) so the boundary fraction is exactly representable
  // in floating point — the strictly-greater rule must not be an artifact of
  // rounding.
  const viewport = { width: 1000, height: 1000 };
  const exactHeight = viewport.height * OVERLAY_VIEWPORT_FRACTION; // 600 -> fraction === 0.6 exactly

  it("exactly at OVERLAY_VIEWPORT_FRACTION is NOT an overlay (strictly-greater rule)", () => {
    const blocker = overlayBlocker({ box: { x: 0, y: 0, width: viewport.width, height: exactHeight } });
    expect(detectOverlay([blocker], viewport)).toBeUndefined();
  });

  it("one pixel-row larger crosses the strictly-greater threshold", () => {
    const blocker = overlayBlocker({ box: { x: 0, y: 0, width: viewport.width, height: exactHeight + 1 } });
    const finding = detectOverlay([blocker], viewport);
    expect(finding).toBeDefined();
    expect(finding!.fraction).toBeGreaterThan(OVERLAY_VIEWPORT_FRACTION);
  });
});

describe("detectOverlay — stacking and position are required (Test 8)", () => {
  const viewport = { width: 1280, height: 720 };

  it("a full-viewport static element is never an overlay", () => {
    const blocker = overlayBlocker({ position: "static" });
    expect(detectOverlay([blocker], viewport)).toBeUndefined();
  });

  it("a full-viewport fixed element below OVERLAY_MIN_Z_INDEX is never an overlay", () => {
    const blocker = overlayBlocker({ position: "fixed", zIndex: OVERLAY_MIN_Z_INDEX - 1 });
    expect(detectOverlay([blocker], viewport)).toBeUndefined();
  });

  it("a full-viewport fixed element at/above OVERLAY_MIN_Z_INDEX is an overlay", () => {
    const blocker = overlayBlocker({ position: "fixed", zIndex: 50 });
    expect(detectOverlay([blocker], viewport)).toBeDefined();
  });
});

describe("detectOverlay — clipping, largest-wins, and hint carry-through (Test 9)", () => {
  const viewport = { width: 1280, height: 720 };

  it("credits only the on-screen intersection for an off-screen-origin box", () => {
    const blocker = overlayBlocker({ box: { x: -400, y: 0, width: 1280, height: 720 } });
    const finding = detectOverlay([blocker], viewport);
    expect(finding).toBeDefined();
    const expectedFraction = (880 * 720) / (1280 * 720);
    expect(finding!.fraction).toBeCloseTo(expectedFraction, 5);
  });

  it("the larger of two qualifying blockers wins, carrying its hints verbatim", () => {
    const smaller = overlayBlocker({
      box: { x: 0, y: 0, width: 1280, height: 500 },
      hints: { ariaLabel: "smaller" },
    });
    const larger = overlayBlocker({
      box: { x: 0, y: 0, width: 1280, height: 720 },
      hints: { ariaLabel: "larger" },
    });
    const finding = detectOverlay([smaller, larger], viewport);
    expect(finding!.hints).toEqual({ ariaLabel: "larger" });
  });
});

describe("describeOverlayHints — prefers the most specific label (Test 10)", () => {
  it("prefers ariaLabel, then classNames, then nearbyText, then a fallback", () => {
    expect(describeOverlayHints({ ariaLabel: "location-gate" })).toBe(
      'aria-label="location-gate"',
    );
    expect(describeOverlayHints({ classNames: ["a", "b"] })).toBe(".a.b");
    expect(describeOverlayHints({ nearbyText: "Are you in NYC?" })).toBe(
      'near "Are you in NYC?"',
    );
    expect(describeOverlayHints({})).toBe("an unlabeled element");
  });
});

// ===========================================================================
// Browser-free suite — the former Tests 7–12, converted onto the fake
// `playwright` module above. No `runIf`: these ALWAYS run, fast and
// deterministically, because none of what they assert needs a browser.
// `observePage` and `runSurfaceScan` are the real, unmocked implementations;
// only the module they import is faked, so the unreachable-URL case still
// proves the real `CommandError` from the real catch block.
//
// The canned observations below reproduce, element for element, exactly what
// the real fixture page in `scan.browser.test.ts` yields — so these tests
// exercise the same candidate set the browser suite used to generate.
// ===========================================================================

const PAGE1_URL = "http://fixture.test/";
const PAGE2_URL = "http://fixture.test/page2";

const RESTAURANT_SVG =
  '<svg aria-label="restaurant" width="24" height="24" viewBox="0 0 24 24">' +
  '<circle cx="12" cy="12" r="10"></circle></svg>';
const PLAIN_SVG =
  '<svg width="20" height="20" viewBox="0 0 20 20"><rect width="20" height="20"></rect></svg>';
const BIG_SVG =
  '<svg width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200"></rect></svg>';

/** Page 1: two icon-sized svgs (one aria-labeled), one oversized svg, a photo
 *  img, a 1x1-intrinsic spacer img, a background-image div, plus the computed
 *  colors/fonts the walker collects. `#ffffff` and the fixture direction's
 *  fonts sit in the token baseline; `#123a5e` / `courier new` do not — and
 *  `#123a5e` is deliberately far (OKLab ΔE) from every baseline role, so it
 *  stays a candidate rather than tripping the WS-05 migration split. */
function page1Observation(): RawObservation {
  return {
    elements: [
      {
        type: "svg",
        source: RESTAURANT_SVG,
        box: box(24, 24, 0, 0),
        visible: true,
        hints: { ariaLabel: "restaurant" },
        // Each element below gets its OWN parentKey — none of these represent a
        // repeated list, so they must never accidentally structurally collide.
        structure: structure("body>svg", "body[0]", 0),
      },
      {
        type: "svg",
        source: PLAIN_SVG,
        box: box(20, 20, 0, 24),
        visible: true,
        hints: {},
        structure: structure("body>svg", "body[1]", 1),
      },
      {
        type: "svg",
        source: BIG_SVG,
        box: box(200, 200, 0, 44),
        visible: true,
        hints: {},
        structure: structure("body>svg", "body[2]", 2),
      },
      {
        type: "img",
        source: `${PAGE1_URL}photo.png`,
        box: box(48, 48, 0, 244),
        intrinsic: { width: 48, height: 48 },
        visible: true,
        hints: { alt: "Team photo" },
        structure: structure("body>img", "body[3]", 3),
      },
      {
        type: "img",
        source: `${PAGE1_URL}spacer.png`,
        box: box(20, 20, 0, 292),
        intrinsic: { width: 1, height: 1 },
        visible: true,
        hints: {},
        structure: structure("body>img", "body[4]", 4),
      },
      {
        type: "background-image",
        source: `${PAGE1_URL}bg.png`,
        box: box(40, 40, 0, 312),
        visible: true,
        hints: { classNames: ["bg-illustration"] },
        structure: structure("body>div.bg-illustration", "body[5]", 5),
      },
    ],
    colors: [
      { value: "#ffffff", count: 9, firstBox: box(1280, 720) },
      { value: "#123a5e", count: 8, firstBox: box(24, 24) },
      { value: "#000000", count: 3, firstBox: box(1280, 720) },
    ],
    fontFamilies: [
      { value: "courier new", count: 8, firstBox: box(24, 24) },
      { value: "times new roman", count: 3, firstBox: box(1280, 720) },
    ],
  };
}

/** Page 2: the SAME aria-labeled svg as page 1 (the cross-URL dedupe fixture). */
function page2Observation(): RawObservation {
  return {
    elements: [
      {
        type: "svg",
        source: RESTAURANT_SVG,
        box: box(24, 24, 0, 0),
        visible: true,
        hints: { ariaLabel: "restaurant" },
        structure: structure("body>svg", "body[0]", 0),
      },
    ],
    colors: [
      { value: "#ffffff", count: 3, firstBox: box(1280, 720) },
      { value: "#123a5e", count: 2, firstBox: box(24, 24) },
    ],
    fontFamilies: [{ value: "courier new", count: 2, firstBox: box(24, 24) }],
  };
}

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

describe("runSurfaceScan — propose/apply/dedupe semantics (no browser)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetPwFake();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-surface-scan-"));
    delete process.env.OPENAI_API_KEY;
    setObservation(PAGE1_URL, page1Observation());
    setObservation(PAGE2_URL, page2Observation());
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
        implementationBrief: path.join(
          tmpDir,
          "brand",
          "generated",
          "implementation-brief.md",
        ),
      },
      store: { driver: "file" },
    };
  }

  async function useConfig(config: KeyartConfig): Promise<void> {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(config);
  }

  function directionsDirOf(): string {
    return path.join(tmpDir, "brand", "directions");
  }

  async function seedApprovedDirection(config: KeyartConfig): Promise<void> {
    const directionCore = createDirectionCore(tmpDir, config);
    await directionCore.create({ id: "direction-a", name: "Direction A" });
    const directionsDir = directionsDirOf();
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

  async function readProposal(config: KeyartConfig): Promise<ScanProposal> {
    const proposalPath = path.join(
      config.brand.root,
      "generated",
      "surface-scan",
      "proposal.json",
    );
    return JSON.parse(await fs.readFile(proposalPath, "utf-8")) as ScanProposal;
  }

  it("propose-only by default leaves brand/surface.yaml untouched (Test 7)", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);

    const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

    expect(result.candidateCount).toBeGreaterThan(0);
    expect(await pathExists(path.join(tmpDir, "brand", "surface.yaml"))).toBe(false);
  });

  it("--apply merges through the validated patchSlots path with origin:scan (Test 8)", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);

    const before = await createSurfaceCore(tmpDir, config).read();
    const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL], apply: true });

    expect(result.applied).toBeDefined();
    const manifest = await createSurfaceCore(tmpDir, config).read();
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBeGreaterThan(before?.version ?? 0);
    expect(manifest!.slots.map((s) => s.id).sort()).toEqual(
      [...result.applied!.slotIds].sort(),
    );

    for (const slot of manifest!.slots) {
      expect(slot.origin).toBe("scan");
      expect(slot.criticality).toBe("preferred");
      expect(slot.attributions).toHaveLength(1);
      expect(slot.attributions[0].author).toBe("scan");
      expect(slot.attributions[0].source).toMatch(/^surface-scan:[0-9a-f]{16}$/);
    }

    expect(await pathExists(path.join(tmpDir, "brand", "surface.yaml"))).toBe(true);
  });

  it("diff-aware re-scans propose only deltas; rejections carry forward; a retired slot still suppresses re-proposal (Test 9)", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);

    const applied = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL], apply: true });
    const appliedSlotIds = applied.applied!.slotIds;
    expect(appliedSlotIds.length).toBeGreaterThan(0);

    const rescan = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
    expect(rescan.candidateCount).toBe(0);
    expect(rescan.skippedCovered).toBeGreaterThan(0);

    const manifest = await createSurfaceCore(tmpDir, config).read();
    const someSignature = manifest!.slots[0].attributions[0].source.slice(
      "surface-scan:".length,
    );

    const proposalPath = path.join(tmpDir, "brand", "generated", "surface-scan", "proposal.json");
    const proposalOnDisk = JSON.parse(await fs.readFile(proposalPath, "utf-8")) as ScanProposal;
    proposalOnDisk.rejectedSignatures = [someSignature];
    await fs.writeFile(proposalPath, JSON.stringify(proposalOnDisk, null, 2), "utf-8");

    const rescan2 = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
    expect(rescan2.candidateCount).toBe(0);
    const proposalAfterRescan2 = await readProposal(config);
    expect(proposalAfterRescan2.rejectedSignatures).toContain(someSignature);
    expect(proposalAfterRescan2.candidates.some((c) => c.signature === someSignature)).toBe(
      false,
    );

    const retiredSlotId = appliedSlotIds[0];
    await createSurfaceCore(tmpDir, config).retireSlot(retiredSlotId);

    const rescan3 = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
    const manifestAfterRetire = await createSurfaceCore(tmpDir, config).read();
    const retiredSlot = manifestAfterRetire!.slots.find((s) => s.id === retiredSlotId)!;
    expect(retiredSlot.retiredAt).toBeTruthy();
    expect(rescan3.candidateCount).toBe(0);
    const proposalAfterRescan3 = await readProposal(config);
    expect(
      proposalAfterRescan3.candidates.some((c) => c.proposedId === retiredSlotId),
    ).toBe(false);
  });

  it("cross-URL dedupe collapses a shared svg to one candidate (Test 10)", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);

    const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL, PAGE2_URL] });
    expect(result.urls).toEqual([PAGE1_URL, PAGE2_URL]);

    const proposal = await readProposal(config);
    const labeled = proposal.candidates.filter(
      (c) => c.kind === "icon" && c.hints.ariaLabel === "restaurant",
    );
    expect(labeled).toHaveLength(1);
  });

  it("an unreachable URL fails with a helpful CommandError, writing nothing (Test 11)", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);

    const badUrl = "http://127.0.0.1:9";
    markUnreachable(badUrl);

    await expect(runSurfaceScan({ cwd: tmpDir, urls: [badUrl] })).rejects.toThrow(CommandError);
    await expect(runSurfaceScan({ cwd: tmpDir, urls: [badUrl] })).rejects.toThrow(
      /127\.0\.0\.1:9/,
    );
    await expect(runSurfaceScan({ cwd: tmpDir, urls: [badUrl] })).rejects.toThrow(
      /Is the app running and reachable/,
    );
    expect(
      await pathExists(path.join(tmpDir, "brand", "generated", "surface-scan")),
    ).toBe(false);
  });

  it("no approved pointer degrades to an empty baseline with an honest summary line (Test 12)", async () => {
    const config = mockConfig();
    await useConfig(config);
    await createDirectionCore(tmpDir, config).create({ id: "default", name: "Default" });

    const logSpy = vi.spyOn(console, "log");
    const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
    const loggedLines = logSpy.mock.calls.map((call) => call[0]);

    const proposal = await readProposal(config);
    expect(proposal.candidates.some((c) => c.kind === "color-role")).toBe(true);
    expect(proposal.candidates.some((c) => c.kind === "type-role")).toBe(true);
    expect(result.candidateCount).toBeGreaterThan(0);
    expect(
      loggedLines.some(
        (line) => typeof line === "string" && line.includes("no approved direction to diff against"),
      ),
    ).toBe(true);
  });

  // =========================================================================
  // Page setup + overlay plumbing (Tests 13–20b) — driven through the real
  // `runSurfaceScan`/`observePage` against the faked `playwright` module,
  // asserting the call-order recorder directly.
  // =========================================================================

  describe("page setup + overlay plumbing", () => {
    it("a dismiss selector that never appears is a NOTE, never a failure (Test 13)", async () => {
      const config = { ...mockConfig(), scan: { dismiss: ["#never-here", "#gate-close"] } };
      await useConfig(config);
      await seedApprovedDirection(config);
      setPresentSelectors(["#gate-close"]);

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      expect(result.setupNotes).toEqual([
        expect.objectContaining({ step: "dismiss", selector: "#never-here", status: "not-found" }),
        expect.objectContaining({ step: "dismiss", selector: "#gate-close", status: "applied" }),
      ]);
      const steps = callSteps();
      const waitForSelectorCalls = pwFake.calls.filter((c) => c.step === "waitForSelector");
      expect(waitForSelectorCalls.map((c) => c.selector)).toEqual(["#never-here", "#gate-close"]);
      expect(steps.indexOf("waitForSelector")).toBeLessThan(steps.lastIndexOf("waitForSelector"));
    });

    it("waitFor that never resolves is a NOTE, never a failure (Test 14)", async () => {
      const config = { ...mockConfig(), scan: { waitFor: "#does-not-exist" } };
      await useConfig(config);
      await seedApprovedDirection(config);
      setPresentSelectors([]);

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      expect(result.candidateCount).toBeGreaterThan(0);
      expect(result.setupNotes).toContainEqual(
        expect.objectContaining({ step: "wait-for", status: "not-found" }),
      );
      expect(callSteps()).toContain("goto");
    });

    it("a click that throws is a `failed` note, and the loop continues (Test 14b)", async () => {
      const config = { ...mockConfig(), scan: { dismiss: ["#first", "#second"] } };
      await useConfig(config);
      await seedApprovedDirection(config);
      setPresentSelectors(["#first", "#second"]);
      armClickFailure("#first");

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      expect(result.setupNotes).toContainEqual(
        expect.objectContaining({ step: "dismiss", selector: "#first", status: "failed" }),
      );
      expect(result.setupNotes).toContainEqual(
        expect.objectContaining({ step: "dismiss", selector: "#second", status: "applied" }),
      );
    });

    it("a cookie Playwright rejects is a `failed` note, and navigation still happens (Test 14c)", async () => {
      const config = {
        ...mockConfig(),
        scan: { cookies: [{ name: "seen", value: "yes" }] },
      };
      await useConfig(config);
      await seedApprovedDirection(config);
      armCookiesFailure();

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      expect(result.setupNotes).toContainEqual(
        expect.objectContaining({ step: "cookies", status: "failed" }),
      );
      const steps = callSteps();
      expect(steps.indexOf("addCookies")).toBeLessThan(steps.indexOf("goto"));
    });

    it("storage + cookies are seeded BEFORE navigation (Test 15)", async () => {
      const config = {
        ...mockConfig(),
        scan: {
          storage: { "ls-visited": "1" },
          cookies: [
            { name: "seen", value: "yes" },
            { name: "session", value: "abc", domain: "example.com" },
          ],
        },
      };
      await useConfig(config);
      await seedApprovedDirection(config);

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      const steps = callSteps();
      expect(steps.slice(0, 3)).toEqual(["addInitScript", "addCookies", "goto"]);

      const addInitScriptCall = pwFake.calls.find((c) => c.step === "addInitScript");
      expect(addInitScriptCall?.arg).toEqual([["ls-visited", "1"]]);

      const addCookiesCall = pwFake.calls.find((c) => c.step === "addCookies");
      expect(addCookiesCall?.arg).toEqual([
        { name: "seen", value: "yes", url: PAGE1_URL },
        { name: "session", value: "abc", domain: "example.com", path: "/" },
      ]);

      expect(result.setupNotes).toContainEqual(
        expect.objectContaining({ step: "storage", status: "applied" }),
      );
      expect(result.setupNotes).toContainEqual(
        expect.objectContaining({ step: "cookies", status: "applied" }),
      );
    });

    it("a still-blocking overlay is flagged, not silently inventoried (Test 16)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, {
        ...page1Observation(),
        overlays: [
          {
            box: { x: 0, y: 0, width: 1280, height: 720 },
            zIndex: 999,
            position: "fixed",
            hints: { ariaLabel: "location-gate" },
          },
        ],
      });

      const logSpy = vi.spyOn(console, "log");
      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      expect(result.blockedByOverlay).toBeDefined();
      expect(result.blockedByOverlay!.fraction).toBeGreaterThan(OVERLAY_VIEWPORT_FRACTION);
      expect(result.blockedByOverlay!.hints.ariaLabel).toBe("location-gate");

      const proposal = await readProposal(config);
      expect(proposal.blockedByOverlay).toBeDefined();
      expect(proposal.blockedByOverlay!.hints.ariaLabel).toBe("location-gate");

      const loggedLines = logSpy.mock.calls.map((call) => call[0]);
      expect(
        loggedLines.some(
          (line) =>
            typeof line === "string" &&
            line.includes("WARNING") &&
            line.includes("location-gate") &&
            line.includes("scan.dismiss"),
        ),
      ).toBe(true);
    });

    it("only the FIRST blocked observation reaches the proposal (Test 16b)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, {
        ...page1Observation(),
        overlays: [
          {
            box: { x: 0, y: 0, width: 1280, height: 720 },
            zIndex: 999,
            position: "fixed",
            hints: { ariaLabel: "first-gate" },
          },
        ],
      });
      setObservation(PAGE2_URL, {
        ...page2Observation(),
        overlays: [
          {
            box: { x: 0, y: 0, width: 1280, height: 720 },
            zIndex: 999,
            position: "fixed",
            hints: { ariaLabel: "second-gate" },
          },
        ],
      });

      const logSpy = vi.spyOn(console, "log");
      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL, PAGE2_URL] });

      const proposal = await readProposal(config);
      expect(proposal.blockedByOverlay!.hints.ariaLabel).toBe("first-gate");

      const warningLines = logSpy.mock.calls
        .map((call) => call[0])
        .filter((line) => typeof line === "string" && line.includes("WARNING"));
      expect(warningLines).toHaveLength(2);
    });

    it("no config and no flags ⇒ byte-identical to today (Test 17)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      expect("setupNotes" in proposal).toBe(false);
      expect("blockedByOverlay" in proposal).toBe(false);
      expect(result.setupNotes).toEqual([]);

      const steps = new Set(callSteps());
      expect(steps.has("addInitScript")).toBe(false);
      expect(steps.has("addCookies")).toBe(false);
      expect(steps.has("waitForSelector")).toBe(false);
      expect(steps.has("waitForLoadState")).toBe(false);
    });

    it("CLI overrides drive setup with no config at all (Test 18)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setPresentSelectors(["#gate-close"]);

      const result = await runSurfaceScan({
        cwd: tmpDir,
        urls: [PAGE1_URL],
        setup: { dismiss: ["#gate-close"] },
      });

      expect(result.setupNotes).toContainEqual(
        expect.objectContaining({ step: "dismiss", selector: "#gate-close", status: "applied" }),
      );
      const clickCall = pwFake.calls.find((c) => c.step === "click");
      expect(clickCall?.selector).toBe("#gate-close");
    });

    it("an override replaces the config value end-to-end (Test 19)", async () => {
      const config = { ...mockConfig(), scan: { dismiss: ["#never-here"] } };
      await useConfig(config);
      await seedApprovedDirection(config);
      setPresentSelectors(["#gate-close"]);

      const result = await runSurfaceScan({
        cwd: tmpDir,
        urls: [PAGE1_URL],
        setup: { dismiss: ["#gate-close"] },
      });

      expect(result.setupNotes).toContainEqual(
        expect.objectContaining({ step: "dismiss", selector: "#gate-close", status: "applied" }),
      );
      expect(result.setupNotes.some((n) => n.selector === "#never-here")).toBe(false);
      expect(pwFake.calls.some((c) => c.selector === "#never-here")).toBe(false);
    });

    it("--apply still merges only through patchSlots (Test 20)", async () => {
      const config = { ...mockConfig(), scan: { waitFor: "main" } };
      await useConfig(config);
      await seedApprovedDirection(config);
      setPresentSelectors(["main"]);

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL], apply: true });

      const manifest = await createSurfaceCore(tmpDir, config).read();
      for (const slot of manifest!.slots) {
        expect(slot.origin).toBe("scan");
        expect(slot.attributions[0].source).toMatch(/^surface-scan:[0-9a-f]{16}$/);
      }
      expect(result.applied).toBeDefined();
    });

    it("an unreachable URL still throws the pre-existing CommandError (Test 20b)", async () => {
      const config = { ...mockConfig(), scan: { dismiss: ["#a"] } };
      await useConfig(config);
      await seedApprovedDirection(config);
      const badUrl = "http://127.0.0.1:9";
      markUnreachable(badUrl);

      await expect(runSurfaceScan({ cwd: tmpDir, urls: [badUrl] })).rejects.toThrow(CommandError);
      await expect(runSurfaceScan({ cwd: tmpDir, urls: [badUrl] })).rejects.toThrow(
        /Is the app running and reachable/,
      );
    });
  });

  // =========================================================================
  // Content classification (Tests 16-22b) — driven through the real
  // `runSurfaceScan` against the faked `playwright` module, with canned
  // `structure`/`ignoredBy` marks exactly as the real walker would emit them.
  // =========================================================================

  describe("content classification (WS-02)", () => {
    const CARD_HOST = "https://cdn.cards.example";
    const CARD_COUNT = 12;

    /** A DB-style card list of 12 remote-host photos (repeated + foreign-origin),
     *  alongside same-origin chrome of the SAME rendered size: one standalone
     *  illustration and two nav icons — the over-firing guard fixture. */
    function cardListObservation(
      opts: { ignoreCards?: boolean; colors?: ObservedStyleUse[]; fontFamilies?: ObservedStyleUse[] } = {},
    ): RawObservation {
      const cards = Array.from({ length: CARD_COUNT }, (_, i) => ({
        type: "img" as const,
        source: `${CARD_HOST}/photo-${i}.jpg`,
        box: box(48, 48, 0, i * 50),
        intrinsic: { width: 48, height: 48 },
        visible: true,
        hints: {},
        structure: structure("ul.grid>li.card>a>img", "ul.grid[0]", i),
        ...(opts.ignoreCards ? { ignoredBy: ".grid" } : {}),
      }));
      const standaloneImg = {
        type: "img" as const,
        source: `${PAGE1_URL}logo.png`,
        box: box(48, 48, 0, 700),
        intrinsic: { width: 48, height: 48 },
        visible: true,
        hints: {},
        structure: structure("body>img", "body[1]", 1),
      };
      const navIcons = [0, 1].map((i) => ({
        type: "svg" as const,
        source: `<svg data-icon="${i}" width="24" height="24"><circle r="10"/></svg>`,
        box: box(24, 24, 0, 800 + i * 30),
        visible: true,
        hints: {},
        structure: structure("nav>svg", "nav[0]", i),
      }));
      return {
        elements: [...cards, standaloneImg, ...navIcons],
        colors: opts.colors ?? [],
        fontFamilies: opts.fontFamilies ?? [],
      };
    }

    it("a DB-style card list is skipped and reported (SC-04) (Test 16)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, cardListObservation());

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      const cardSignatures = new Set(
        Array.from({ length: CARD_COUNT }, (_, i) =>
          candidateSignature("illustration", `${CARD_HOST}/photo-${i}.jpg`),
        ),
      );
      expect(proposal.candidates.some((c) => cardSignatures.has(c.signature))).toBe(false);
      expect(result.skippedContent).toBeGreaterThanOrEqual(CARD_COUNT);

      const cardGroup = proposal.skipped.find((s) => s.count === CARD_COUNT);
      expect(cardGroup).toBeDefined();
      expect(cardGroup!.exampleSources.length).toBeLessThanOrEqual(3);
      expect(cardGroup!.exampleSources.every((s) => s.includes("cdn.cards.example"))).toBe(true);

      const reasonsPresent = new Set(proposal.skipped.map((s) => s.reason));
      expect(reasonsPresent.has("foreign-origin") || reasonsPresent.has("repeated-content")).toBe(
        true,
      );
    });

    it("same-origin static chrome of the same size is STILL proposed — over-firing guard (SC-04) (Test 17)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, cardListObservation());

      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      const illustrations = proposal.candidates.filter((c) => c.kind === "illustration");
      // One standalone same-origin illustration (the over-firing guard) plus
      // WS-03's one fallback candidate for the skipped card group.
      expect(illustrations).toHaveLength(2);
      expect(illustrations.filter((c) => c.fallbackForGroup === undefined)).toHaveLength(1);
      expect(illustrations.filter((c) => c.fallbackForGroup !== undefined)).toHaveLength(1);
      expect(proposal.candidates.filter((c) => c.kind === "icon")).toHaveLength(2);
    });

    it("the CLI summary reports every exclusion — no silent caps (SC-04) (Test 18)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, cardListObservation());
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      const lines = logSpy.mock.calls
        .map((c) => c[0])
        .filter((l): l is string => typeof l === "string");
      expect(lines.some((l) => /Skipped \d+ element\(s\) as app content/.test(l))).toBe(true);
      expect(lines.some((l) => /^ {2}- .+ ×12 \[/.test(l))).toBe(true);
      expect(lines.some((l) => /skipped \d+ covered/.test(l))).toBe(true);
    });

    it("scan.ignore drops a subtree and says so (SC-04) (Test 19)", async () => {
      const config = { ...mockConfig(), scan: { ignore: [".grid"] } };
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, cardListObservation({ ignoreCards: true }));

      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      const ignoredGroup = proposal.skipped.find((s) => s.reason === "ignored-selector");
      expect(ignoredGroup).toBeDefined();
      expect(ignoredGroup!.count).toBe(CARD_COUNT);

      expect(proposal.candidates.filter((c) => c.kind === "illustration")).toHaveLength(1);
      expect(proposal.candidates.filter((c) => c.kind === "icon")).toHaveLength(2);
    });

    it("config.scan.ignore is forwarded into the walker call (SC-04) (Test 19b)", async () => {
      const config = { ...mockConfig(), scan: { ignore: [".grid"] } };
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, cardListObservation());

      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      const evaluateCall = pwFake.calls.find((c) => c.step === "evaluate");
      // pathDepth/classMax mirror scan.ts's private STRUCTURE_PATH_DEPTH (4) /
      // STRUCTURE_CLASS_MAX (3) named constants.
      expect(evaluateCall?.arg).toEqual({ ignore: [".grid"], pathDepth: 4, classMax: 3 });
    });

    it("a page with no content still behaves exactly as before (SC-04) (Test 21)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      expect(result.byKind).toEqual({ icon: 2, illustration: 2, "color-role": 2, "type-role": 2 });
      expect(proposal.skipped).toEqual([]);
      expect(result.skippedContent).toBe(0);
      expect(result.contentGroups).toBe(0);
      const lines = logSpy.mock.calls
        .map((c) => c[0])
        .filter((l): l is string => typeof l === "string");
      expect(lines.some((l) => /as app content/.test(l))).toBe(false);
    });

    it("keyless throughout (SC-10) (Test 22)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, cardListObservation());

      delete process.env.OPENAI_API_KEY;
      const result1 = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal1 = await readProposal(config);
      expect(result1.dryRun).toBe(false);

      process.env.OPENAI_API_KEY = "";
      const result2 = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal2 = await readProposal(config);
      expect(result2.dryRun).toBe(false);

      expect(proposal1.skipped).toEqual(proposal2.skipped);
    });

    it("colors and fonts are unaffected by classification — regression guard (SC-04) (Test 22b)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      const colors: ObservedStyleUse[] = [{ value: "#654321", count: 5, firstBox: box(10, 10) }];
      const fontFamilies: ObservedStyleUse[] = [
        { value: "Verdana", count: 4, firstBox: box(10, 10) },
      ];
      setObservation(PAGE1_URL, cardListObservation({ colors, fontFamilies }));

      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);
      const scanColorNotes = proposal.candidates
        .filter((c) => c.kind === "color-role")
        .map((c) => c.context?.note)
        .sort();
      const scanTypeNotes = proposal.candidates
        .filter((c) => c.kind === "type-role")
        .map((c) => c.context?.note)
        .sort();

      const { candidates: directCandidates } = buildScanCandidates(
        [{ url: PAGE1_URL, elements: [], colors, fontFamilies }],
        emptyBaseline(),
        emptyCoverage(),
      );
      const directColorNotes = directCandidates
        .filter((c) => c.kind === "color-role")
        .map((c) => c.context?.note)
        .sort();
      const directTypeNotes = directCandidates
        .filter((c) => c.kind === "type-role")
        .map((c) => c.context?.note)
        .sort();

      expect(scanColorNotes).toEqual(directColorNotes);
      expect(scanTypeNotes).toEqual(directTypeNotes);
    });
  });

  // =========================================================================
  // Fallback slot proposal (WS-03) — driven through the real `runSurfaceScan`
  // against the faked `playwright` module. No browser: everything downstream
  // of the walker (classification, grouping, minting, crop clipping, apply)
  // is pure/driver-level, per the test-driver principle.
  // =========================================================================

  describe("fallback slot proposal (WS-03)", () => {
    const VENDOR_HOST = "https://cdn.vendor.test";
    const CARD_COUNT = 12;

    /** Twelve repeated, foreign-origin card images (fires both origin- and
     *  repetition-based grouping) + same-origin chrome (a standalone
     *  illustration and two glyph-sized svgs) that must never be swept up
     *  into a group. */
    function contentObservation(
      pageUrl: string,
      opts: { ignoreCards?: boolean } = {},
    ): RawObservation {
      const pageOrigin = new URL(pageUrl).origin;
      const cards = Array.from({ length: CARD_COUNT }, (_, i) => ({
        type: "img" as const,
        source: `${VENDOR_HOST}/uploads/vendor-${i}.png`,
        box: box(48, 48, 0, i * 50),
        intrinsic: { width: 48, height: 48 },
        visible: true,
        hints: { classNames: ["card-photo"], nearbyText: "Restaurants near you" },
        structure: structure("ul.grid>li.card>a>img", "ul.grid[0]", i),
        ...(opts.ignoreCards ? { ignoredBy: ".grid" } : {}),
      }));
      const chromeImg = {
        type: "img" as const,
        source: `${pageOrigin}/photo.png`,
        box: box(48, 48, 0, 700),
        intrinsic: { width: 48, height: 48 },
        visible: true,
        hints: {},
        structure: structure("body>img", "body[1]", 1),
      };
      const glyphSvgs = [0, 1].map((i) => ({
        type: "svg" as const,
        source: `<svg data-icon="${i}" width="24" height="24"><circle r="10"/></svg>`,
        box: box(24, 24, 0, 800 + i * 30),
        visible: true,
        hints: {},
        structure: structure("nav>svg", "nav[0]", i),
      }));
      return {
        elements: [...cards, chromeImg, ...glyphSvgs],
        colors: [],
        fontFamilies: [],
      };
    }

    it("exactly ONE fallback per group, never twelve (SC-05) (Test 9)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, contentObservation(PAGE1_URL));

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      const fallbacks = proposal.candidates.filter((c) => c.fallbackForGroup !== undefined);
      expect(fallbacks).toHaveLength(1);
      expect(result.fallbackCount).toBe(1);
      expect(fallbacks[0].kind).toBe("illustration");
      expect(fallbacks[0].proposedId).toMatch(/^illustration\.unnamed-\d+$/);
    });

    it("the group's hints are carried onto the candidate (SC-05) (Test 10)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, contentObservation(PAGE1_URL));

      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      const fallback = proposal.candidates.find((c) => c.fallbackForGroup !== undefined)!;
      expect(fallback.hints.classNames).toContain("card-photo");
      expect(fallback.hints.nearbyText).toContain("Restaurants");
    });

    it("the representative crop is the group member's box, not a corner artifact (Test 11)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      const observation = contentObservation(PAGE1_URL);
      setObservation(PAGE1_URL, observation);

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);
      const fallback = proposal.candidates.find((c) => c.fallbackForGroup !== undefined)!;

      expect(fallback.cropFile).not.toContain("\\");
      expect(await pathExists(path.resolve(tmpDir, fallback.cropFile))).toBe(true);
      expect(result.filesWritten).toContain(fallback.cropFile);
      expect(fallback.context?.note).not.toContain("crop unavailable");

      const firstMember = observation.elements[0]; // the first card
      const expectedClip = clipFor(firstMember.box, { width: 1280, height: 720 });
      const screenshotCall = pwFake.calls.find(
        (c) =>
          c.step === "screenshot" &&
          typeof (c.arg as { path?: string }).path === "string" &&
          (c.arg as { path: string }).path.endsWith(`${fallback.signature}.png`),
      );
      expect(screenshotCall).toBeDefined();
      expect((screenshotCall!.arg as { clip: unknown }).clip).toEqual(expectedClip);
    });

    it("crop capture FAILS — the candidate survives, honestly annotated (Test 11b)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, contentObservation(PAGE1_URL));

      // The fallback's signature is a pure function of the group key alone —
      // compute it ahead of time (no scan run needed) so the fake's
      // path-keyed screenshot failure can be armed for exactly that crop.
      const groupKey = contentGroupKeyOf({
        type: "img",
        source: "unused",
        box: box(48, 48),
        visible: true,
        hints: {},
        structure: structure("ul.grid>li.card>a>img", "ul.grid[0]", 0),
      });
      const fallbackSignature = fallbackCandidateFor(
        { key: groupKey, count: CARD_COUNT, reason: "foreign-origin", exampleSources: [], hints: {} },
        PAGE1_URL,
        {},
        new Set(),
      ).signature;
      failScreenshotFor(fallbackSignature);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      const fallback = proposal.candidates.find((c) => c.fallbackForGroup !== undefined);
      expect(fallback).toBeDefined();
      expect(fallback!.signature).toBe(fallbackSignature);
      expect(result.fallbackCount).toBe(1);

      const cropAbsPath = path.resolve(tmpDir, fallback!.cropFile);
      expect(await pathExists(cropAbsPath)).toBe(false);
      expect(result.filesWritten).not.toContain(fallback!.cropFile);
      expect(fallback!.cropFile).toBe(`brand/generated/surface-scan/crops/${fallbackSignature}.png`);
      expect(fallback!.context?.note).toContain("crop unavailable");

      const lines = logSpy.mock.calls
        .map((c) => c[0])
        .filter((l): l is string => typeof l === "string");
      expect(
        lines.some(
          (l) => l.includes("Fallback crop unavailable") && l.includes(fallback!.proposedId),
        ),
      ).toBe(true);
    });

    it("the fallback survives apply as a normal slot, and fallbackForGroup does not (SC-10) (Test 12)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, contentObservation(PAGE1_URL));

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL], apply: true });
      const proposal = await readProposal(config);
      const fallback = proposal.candidates.find((c) => c.fallbackForGroup !== undefined)!;

      const manifest = await createSurfaceCore(tmpDir, config).read();
      const slot = manifest!.slots.find((s) => s.id === fallback.proposedId);
      expect(slot).toBeDefined();
      expect(slot!.kind).toBe("illustration");
      expect(slot!.origin).toBe("scan");
      expect(slot!.criticality).toBe("preferred");
      expect(slot!.attributions).toHaveLength(1);
      expect(slot!.attributions[0].source).toBe(`surface-scan:${fallback.signature}`);
      expect(slot!.context?.note).toBe(fallback.context?.note);
      expect(slot!.description).toBe("Scanned illustration candidate (unrefined)");

      for (const s of manifest!.slots) {
        expect("fallbackForGroup" in s).toBe(false);
      }
      expect(result.applied).toBeDefined();
    });

    it("an observation with NO content groups produces NO fallback candidates (SC-05) (Test 13)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, page1Observation());

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      expect(proposal.candidates.every((c) => c.fallbackForGroup === undefined)).toBe(true);
      expect(result.fallbackCount).toBe(0);
      expect(result.byKind).toEqual({ icon: 2, illustration: 2, "color-role": 2, "type-role": 2 });
    });

    it("an ignored-selector group earns no fallback (Test 14)", async () => {
      const config = { ...mockConfig(), scan: { ignore: [".grid"] } };
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, contentObservation(PAGE1_URL, { ignoreCards: true }));

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      expect(result.fallbackCount).toBe(0);
      const proposal = await readProposal(config);
      expect(proposal.candidates.filter((c) => c.kind === "illustration")).toHaveLength(1);
      expect(proposal.candidates.filter((c) => c.kind === "icon")).toHaveLength(2);
    });

    it("a rejected fallback is never re-proposed (Test 15)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, contentObservation(PAGE1_URL));

      const first = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);
      const fallbackSignature = proposal.candidates.find(
        (c) => c.fallbackForGroup !== undefined,
      )!.signature;
      expect(first.fallbackCount).toBe(1);

      const proposalPath = path.join(tmpDir, "brand", "generated", "surface-scan", "proposal.json");
      const proposalOnDisk = JSON.parse(await fs.readFile(proposalPath, "utf-8")) as ScanProposal;
      proposalOnDisk.rejectedSignatures = [fallbackSignature];
      await fs.writeFile(proposalPath, JSON.stringify(proposalOnDisk, null, 2), "utf-8");

      const rescan = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const rescanProposal = await readProposal(config);

      expect(rescan.fallbackCount).toBe(0);
      expect(rescanProposal.candidates.some((c) => c.signature === fallbackSignature)).toBe(false);
      expect(rescanProposal.rejectedSignatures).toContain(fallbackSignature);
    });

    it("cross-page dedupe by signature (Test 16)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, contentObservation(PAGE1_URL));
      setObservation(PAGE2_URL, contentObservation(PAGE2_URL));

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL, PAGE2_URL] });
      const proposal = await readProposal(config);

      expect(proposal.candidates.filter((c) => c.fallbackForGroup !== undefined)).toHaveLength(1);
      expect(result.fallbackCount).toBe(1);
    });

    it("the summary names the fallbacks — no silent additions (Test 17)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, contentObservation(PAGE1_URL));

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });

      const lines = logSpy.mock.calls
        .map((c) => c[0])
        .filter((l): l is string => typeof l === "string");
      expect(lines.some((l) => /Proposed \d+ fallback\/empty-state candidate\(s\)/.test(l))).toBe(
        true,
      );
    });

    it("keyless throughout (SC-10) (Test 18)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);
      setObservation(PAGE1_URL, contentObservation(PAGE1_URL));

      delete process.env.OPENAI_API_KEY;
      const result1 = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal1 = await readProposal(config);
      const fallback1 = proposal1.candidates.find((c) => c.fallbackForGroup !== undefined);
      expect(result1.dryRun).toBe(false);

      process.env.OPENAI_API_KEY = "";
      const result2 = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal2 = await readProposal(config);
      const fallback2 = proposal2.candidates.find((c) => c.fallbackForGroup !== undefined);
      expect(result2.dryRun).toBe(false);

      expect(fallback2).toEqual(fallback1);
    });
  });

  // =========================================================================
  // Migration findings (WS-05) — driven through the real `runSurfaceScan`
  // against the faked `playwright` module. FIXTURE_TOKENS' primary (#e84393)
  // is the bound token every "legacy" hex below is a near-duplicate of.
  // =========================================================================

  describe("migration findings (WS-05)", () => {
    // Each within MIGRATION_DELTA (OKLab ΔE) of FIXTURE_TOKENS' primary #e84393.
    const MIGRATING_COLORS = [
      "#d83285",
      "#db3688",
      "#dd388a",
      "#e13c8d",
      "#e54091",
      "#eb4695",
      "#f14c9b",
    ];
    // Clearly distinct (OKLab ΔE) from every FIXTURE_TOKENS role.
    const DISTINCT_COLORS = ["#123a5e", "#2f9e44"];

    function colorsOnlyObservation(colors: ObservedStyleUse[]): RawObservation {
      return { elements: [], colors, fontFamilies: [] };
    }

    it("the proposal carries findings; the candidate cap is not consumed by them (Test 8)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);

      const colors: ObservedStyleUse[] = [
        ...MIGRATING_COLORS.map((value, i) => ({ value, count: 50 - i, firstBox: box(10, 10) })),
        ...DISTINCT_COLORS.map((value, i) => ({ value, count: 10 - i, firstBox: box(10, 10) })),
      ];
      setObservation(PAGE1_URL, colorsOnlyObservation(colors));

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      expect(proposal.migrations).toHaveLength(7);
      expect(new Set(proposal.migrations.map((m) => m.value))).toEqual(new Set(MIGRATING_COLORS));
      for (const finding of proposal.migrations) {
        expect(finding.kind).toBe("color-role");
        expect(finding.nearestRole).toBe("--brand-primary");
      }

      // The cap applies POST-split: both distinct colors are proposed, even
      // though seven migrations sorted ahead of them by observed count.
      const colorCandidates = proposal.candidates.filter((c) => c.kind === "color-role");
      expect(colorCandidates.map((c) => c.context?.note)).toEqual([
        `observed color ${DISTINCT_COLORS[0]} on ${PAGE1_URL}`,
        `observed color ${DISTINCT_COLORS[1]} on ${PAGE1_URL}`,
      ]);

      // Never minted, never cropped.
      for (const value of MIGRATING_COLORS) {
        const wouldBeSignature = candidateSignature("color-role", value);
        const cropPath = path.join(
          tmpDir,
          "brand",
          "generated",
          "surface-scan",
          "crops",
          `${wouldBeSignature}.png`,
        );
        expect(await pathExists(cropPath)).toBe(false);
      }

      const lines = logSpy.mock.calls
        .map((c) => c[0])
        .filter((l): l is string => typeof l === "string");
      expect(lines).toContain("Migration findings (advisory — NOT proposed as slots):");
      const findingLines = lines.filter((l) => l.startsWith("  #"));
      expect(findingLines).toHaveLength(7);
      for (const value of MIGRATING_COLORS) {
        expect(findingLines.some((l) => l.startsWith(`  ${value} appears`))).toBe(true);
      }
      expect(lines.some((l) => /…and \d+ more/.test(l))).toBe(false);
    });

    it("cross-page accumulation unions examples and sums occurrences (Test 8c)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);

      const SHARED = "#e54091";
      const PAGE_B_ONLY = "#eb4695";

      setObservation(
        PAGE1_URL,
        colorsOnlyObservation([{ value: SHARED, count: 9, firstBox: box(10, 10) }]),
      );
      setObservation(
        PAGE2_URL,
        colorsOnlyObservation([
          { value: SHARED, count: 5, firstBox: box(10, 10) },
          { value: PAGE_B_ONLY, count: 4, firstBox: box(10, 10) },
        ]),
      );

      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL, PAGE2_URL] });
      const proposal = await readProposal(config);

      expect(proposal.migrations).toHaveLength(2);
      const shared = proposal.migrations.find((m) => m.value === SHARED)!;
      expect(shared.occurrences).toBe(14);
      expect(shared.examples).toEqual([PAGE1_URL, PAGE2_URL]);

      const pageBOnly = proposal.migrations.find((m) => m.value === PAGE_B_ONLY)!;
      expect(pageBOnly.occurrences).toBe(4);
      expect(pageBOnly.examples).toEqual([PAGE2_URL]);
    });

    it("the summary cap fires only past the limit, and says how many it hid (Test 8b)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);

      const THIRTEEN = [
        "#d83285",
        "#da3487",
        "#db3688",
        "#dd388a",
        "#df3a8b",
        "#e13c8d",
        "#e33d8e",
        "#ec4796",
        "#ed4898",
        "#ef4a99",
        "#f14c9b",
        "#f34e9c",
        "#f5509e",
      ];
      setObservation(
        PAGE1_URL,
        colorsOnlyObservation(
          THIRTEEN.map((value, i) => ({ value, count: 30 - i, firstBox: box(10, 10) })),
        ),
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] });
      const proposal = await readProposal(config);

      expect(proposal.migrations).toHaveLength(13);

      const lines = logSpy.mock.calls
        .map((c) => c[0])
        .filter((l): l is string => typeof l === "string");
      const findingLines = lines.filter((l) => l.startsWith("  #"));
      expect(findingLines).toHaveLength(10);
      const overflowLine = lines.find((l) => /…and \d+ more/.test(l));
      expect(overflowLine).toBeDefined();
      expect(overflowLine).toContain("…and 3 more");
    });

    it("a finding can never become a slot — the apply-level invariant (Test 9)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);

      const colors: ObservedStyleUse[] = [
        ...MIGRATING_COLORS.map((value, i) => ({ value, count: 50 - i, firstBox: box(10, 10) })),
        ...DISTINCT_COLORS.map((value, i) => ({ value, count: 10 - i, firstBox: box(10, 10) })),
      ];
      setObservation(PAGE1_URL, colorsOnlyObservation(colors));

      const result = await runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL], apply: true });
      const proposal = await readProposal(config);

      expect(proposal.migrations).toHaveLength(7);
      expect(proposal.candidates).toHaveLength(2);

      const manifest = await createSurfaceCore(tmpDir, config).read();
      expect(manifest!.slots).toHaveLength(proposal.candidates.length);
      expect(result.applied!.slotIds).toHaveLength(proposal.candidates.length);

      for (const slot of manifest!.slots) {
        for (const finding of proposal.migrations) {
          expect(slot.id).not.toContain(finding.value);
          expect(slot.context?.note ?? "").not.toContain(finding.value);
        }
      }

      // Defensive proof: a finding structurally cannot feed candidateToSlot.
      expect(
        proposal.migrations.every((m) => !("proposedId" in m) && !("signature" in m)),
      ).toBe(true);
    });

    it("a pre-WS-05 proposal.json (no migrations key) still loads and rewrites with migrations: [] (Test 10)", async () => {
      const config = mockConfig();
      await useConfig(config);
      await seedApprovedDirection(config);

      const scanDir = path.join(tmpDir, "brand", "generated", "surface-scan");
      await fs.mkdir(scanDir, { recursive: true });
      const legacyProposal = {
        createdAt: "2020-01-01T00:00:00.000Z",
        urls: [PAGE1_URL],
        candidates: [],
        rejectedSignatures: [],
        skipped: [],
      };
      await fs.writeFile(
        path.join(scanDir, "proposal.json"),
        JSON.stringify(legacyProposal),
        "utf-8",
      );

      await expect(runSurfaceScan({ cwd: tmpDir, urls: [PAGE1_URL] })).resolves.toBeDefined();
      const proposal = await readProposal(config);
      expect(proposal.migrations).toEqual([]);
    });
  });
});

import path from "node:path";
import { createHash } from "node:crypto";
import { CommandError } from "../errors.js";
import { loadConfig, surfaceManifestPath, directionsRoot } from "../config.js";
import { ensureDir, pathExists, readTextFile, writeJsonFile } from "../fs.js";
import { createSurfaceCore } from "./store.js";
import { createBrandCore } from "../brand/core.js";
import { readVersion } from "../direction/store.js";
import { resolveBrandVars } from "../approve/render-guides.js";
import { hasApiKey } from "../openai.js";
import { loadEnvFiles } from "../env.js";
import { runSurfaceRefine } from "./refine.js";
import {
  classifyObservedElements,
  contentGroupKeyOf,
  type ContentGroup,
  type SkipReason,
} from "./classify-content.js";
import {
  splitMigrations,
  type MigrationBaseline,
  type MigrationFinding,
  type RoleCandidateObservation,
} from "./migrations.js";
import type { KeyartConfig, ScanConfig, ScanCookie } from "../types.js";
import type { SlotKind, SurfaceManifest, SurfaceSlot, SlotContext } from "./schema.js";

/** The floor's four classified kinds — scan never proposes "other". */
export type FloorKind = Extract<
  SlotKind,
  "icon" | "illustration" | "color-role" | "type-role"
>;

/** One floor-observed candidate. `signature` is the stable rendered-signature
 * hash — the dedupe + rejection-memory + re-scan-coverage key (WS-06 keys its
 * refinements on it; WS-09 keys accept/reject on it). */
export interface ScanCandidate {
  signature: string; // 16 hex chars
  kind: SlotKind; // floor kinds: icon | illustration | color-role | type-role
  proposedId: string; // honest anonymous placeholder, e.g. "icon.unnamed-1" — matches the slot-id regex
  description?: string; // floor leaves this unset; WS-06 fills it
  context?: SlotContext; // observed value in context.note for color-role/type-role
  cropFile: string; // repo-relative forward-slash path
  hints: { ariaLabel?: string; alt?: string; classNames?: string[]; nearbyText?: string };
  /** Set ONLY by WS-06 refinement — the floor never sets this. */
  refined?: { proposedId?: boolean; kind?: boolean; description?: boolean };
  /** Present ONLY on a fallback/empty-state candidate minted for a skipped
   *  content group — the `ContentGroup.key` this candidate stands for. Proposal-
   *  only: `candidateToSlot` never carries it, so no manifest record changes shape. */
  fallbackForGroup?: string;
}

export interface ScanProposal {
  createdAt: string; // scan time — timestamps ALLOWED here (live-page read)
  urls: string[];
  candidates: ScanCandidate[];
  /** Signatures the user rejected in triage (WS-09 writes; the floor carries
   * them forward on re-scan and never re-proposes them). */
  rejectedSignatures: string[];
  refinedAt?: string; // set ONLY by WS-06
  /** Human-readable dropped-suggestion reasons — set ONLY by WS-06 refinement,
   *  REPLACED (not appended) on every refine run. Additive proposal-record
   *  extension; WS-05 readers ignore unknown keys. */
  refineNotes?: string[];
  /** Set when the FIRST observation carrying a still-blocking overlay landed
   *  (see runSurfaceScan). */
  blockedByOverlay?: OverlayFinding;
  /** Absence-tolerant page-setup outcomes across every scanned URL. */
  setupNotes?: ScanSetupNote[];
  /** Every exclusion the content classifier made, one entry per group, in page
   *  and document order. NO SILENT CAPS — anything the scan drops is here AND in
   *  the CLI summary with a reason, a count, and example sources. */
  skipped: {
    reason: SkipReason;
    count: number;
    exampleSources: string[];
    hints?: ObservedElement["hints"];
  }[];
  /** ADVISORY legacy-value findings — proposal-only. NEVER candidates, NEVER
   *  applicable to brand/surface.yaml (apply maps `candidates` only). A
   *  proposal written before this field existed is read back as `[]` (the
   *  `refineNotes` precedent — old artifacts stay readable). */
  migrations: MigrationFinding[];
}

/** One rendered element the browser observer walked (svg / img / background-image). */
export interface ObservedElement {
  type: "svg" | "img" | "background-image";
  /** svg: whitespace-collapsed outerHTML; img/background-image: the resolved absolute source URL. */
  source: string;
  box: { x: number; y: number; width: number; height: number }; // rendered px
  intrinsic?: { width: number; height: number }; // img naturalWidth/Height
  visible: boolean; // false when display:none / visibility:hidden / opacity 0 / aria-hidden
  hints: { ariaLabel?: string; alt?: string; classNames?: string[]; nearbyText?: string };
  /** Tag/class-shape ancestry, computed IN-PAGE. Repetition detection is
   *  impossible with the pre-content-classification payload — nothing said two
   *  observations were siblings in the same list. */
  structure: { path: string; parentKey: string; siblingIndex: number };
  /** The FIRST config `scan.ignore` selector whose subtree contains this element,
   *  matched in-page via el.closest(). Absent when no selector matched. The pure
   *  classifier consumes this mark and never re-matches selectors itself. */
  ignoredBy?: string;
}
export interface ObservedStyleUse {
  value: string;
  count: number;
  firstBox: ObservedElement["box"];
}
export interface PageObservation {
  url: string;
  elements: ObservedElement[];
  colors: ObservedStyleUse[]; // opaque computed color/background-color, normalized "#rrggbb"
  fontFamilies: ObservedStyleUse[]; // first family of computed font-family, lowercased, unquoted
  /** Absence-tolerant page-setup outcomes for this URL. Omitted when no setup ran. */
  setupNotes?: ScanSetupNote[];
  /** Set when the post-setup overlay guard found a still-blocking element. */
  blockedByOverlay?: OverlayFinding;
}
export interface TokenBaseline {
  hexes: Set<string>;
  families: Set<string>;
  /** ADDITIVE: the SAME bound values, labeled with the `--brand-*` var that
   *  holds them — what a MigrationFinding points at. Absent/empty ⇒ no
   *  migrations are computed (the no-approved-direction case). */
  roleColors?: { role: string; hex: string }[];
  roleFamilies?: { role: string; family: string }[];
} // lowercased

/** Proposal paths — fixed, no config key. WS-06/WS-09 resolve the same directory. */
export function surfaceScanDir(cwd: string, config: KeyartConfig): string {
  return path.resolve(cwd, config.brand.root, "generated", "surface-scan");
}

// Classification thresholds — conservative by design (the Risk Register's
// scan-noise mitigation). Named module constants, kept exactly as specced.
const ICON_MIN = 8;
const ICON_MAX = 96;
const ILLUSTRATION_MIN = 24;
const MAX_COLOR_CANDIDATES = 6;
const MAX_TYPE_CANDIDATES = 3;
const VIEWPORT = { width: 1280, height: 720 };

/** Console summary: at most this many migration-finding lines are printed —
 *  never the record, which always carries the complete list (no silent caps). */
const MIGRATION_SUMMARY_LIMIT = 10;
/** Per-finding example URLs kept on the proposal record, across all scanned
 *  pages — `occurrences` (never capped) is the honest total; this just bounds
 *  the representative-URL list. */
const MIGRATION_EXAMPLE_CAP = 5;

/** Ancestry window: the element's own segment + this many ancestors. */
const STRUCTURE_PATH_DEPTH = 4;
/** Classes kept per path segment, sorted, so a long utility-class list cannot
 *  make the key unbounded. */
const STRUCTURE_CLASS_MAX = 3;

/**
 * The viewport fraction above which a high-stacking element is treated as a
 * blocking overlay rather than page chrome. 0.6 — a real modal/consent gate
 * covers most of the fold, while a legitimate sticky header/footer/sidebar sits
 * well under it. Named constant, boundary-covered by unit tests.
 */
export const OVERLAY_VIEWPORT_FRACTION = 0.6;
/** Minimum computed z-index for "high stacking context". */
export const OVERLAY_MIN_Z_INDEX = 10;
/** Positions that can lift an element out of normal flow and over the page. */
const OVERLAY_POSITIONS = new Set(["fixed", "sticky", "absolute"]);

/** Bounded waits — named constants, never inline literals. */
const SETUP_WAIT_TIMEOUT_MS = 5_000;
const DISMISS_WAIT_TIMEOUT_MS = 2_000;
const POST_DISMISS_SETTLE_MS = 5_000;

/** The resolved, per-run page-setup bag: `config.scan` narrowed to the four SETUP
 *  keys, with per-run overrides applied. `ignore`/`contentOrigins` are deliberately
 *  NOT here — they are classification inputs, not setup. */
export interface ScanSetup {
  waitFor?: string;
  dismiss?: string[];
  storage?: Record<string, string>;
  cookies?: ScanCookie[];
}

/** One absence-tolerant setup outcome, recorded on the observation and carried onto
 *  the proposal. A `not-found` or `failed` note NEVER fails the scan. */
export interface ScanSetupNote {
  url: string;
  step: "storage" | "cookies" | "wait-for" | "dismiss";
  selector?: string; // present for wait-for / dismiss
  status: "applied" | "not-found" | "failed";
  detail?: string;
}

/** A per-run override REPLACES the corresponding `config.scan` key outright (it never
 *  merges or appends) — a per-run override must be able to NARROW, which an append
 *  cannot do. An absent override key falls through to config. */
export function resolveScanSetup(
  configScan: ScanConfig | undefined,
  overrides: ScanSetup | undefined,
): ScanSetup {
  const setup: ScanSetup = {};

  const waitFor = overrides?.waitFor ?? configScan?.waitFor;
  if (waitFor) setup.waitFor = waitFor;

  // An empty override array (e.g. commander's `--dismiss` default) is treated
  // as absent, falling through to config, rather than replacing it with [].
  const dismiss = overrides?.dismiss?.length ? overrides.dismiss : configScan?.dismiss;
  if (dismiss?.length) setup.dismiss = dismiss;

  const storage = overrides?.storage ?? configScan?.storage;
  if (storage && Object.keys(storage).length > 0) setup.storage = storage;

  const cookies = overrides?.cookies?.length ? overrides.cookies : configScan?.cookies;
  if (cookies?.length) setup.cookies = cookies;

  return setup;
}

/** True when nothing at all is configured — the byte-identical-to-today fast path. */
export function isEmptyScanSetup(setup: ScanSetup): boolean {
  return (
    setup.waitFor === undefined &&
    !setup.dismiss?.length &&
    !setup.cookies?.length &&
    (setup.storage === undefined || Object.keys(setup.storage).length === 0)
  );
}

/** One candidate blocker as observed in-page — geometry + stacking only. */
export interface OverlayObservation {
  box: { x: number; y: number; width: number; height: number };
  zIndex: number; // computed z-index; "auto"/NaN normalized to 0 in-page
  position: string; // computed position
  hints: ObservedElement["hints"];
}

/** What lands on the proposal. */
export interface OverlayFinding {
  fraction: number; // covered viewport fraction, 0..1
  hints: ObservedElement["hints"];
}

/**
 * PURE — no browser, no I/O, no clock. Returns the LARGEST blocker covering more
 * than OVERLAY_VIEWPORT_FRACTION of the viewport at a high stacking context, else
 * undefined. Ties broken by document order (input order).
 */
export function detectOverlay(
  blockers: OverlayObservation[],
  viewport: { width: number; height: number },
): OverlayFinding | undefined {
  let best: OverlayFinding | undefined;
  let bestFraction = OVERLAY_VIEWPORT_FRACTION;
  for (const blocker of blockers) {
    if (!OVERLAY_POSITIONS.has(blocker.position)) continue;
    if (blocker.zIndex < OVERLAY_MIN_Z_INDEX) continue;
    const ix1 = Math.max(blocker.box.x, 0);
    const iy1 = Math.max(blocker.box.y, 0);
    const ix2 = Math.min(blocker.box.x + blocker.box.width, viewport.width);
    const iy2 = Math.min(blocker.box.y + blocker.box.height, viewport.height);
    const intersectionWidth = Math.max(0, ix2 - ix1);
    const intersectionHeight = Math.max(0, iy2 - iy1);
    const fraction = (intersectionWidth * intersectionHeight) / (viewport.width * viewport.height);
    if (fraction > bestFraction) {
      bestFraction = fraction;
      best = { fraction, hints: blocker.hints };
    }
  }
  return best;
}

/** PURE — a short human label for a blocking element, used in the warning line:
 *  `aria-label="…"` ▸ `.class.names` ▸ `near "…"` ▸ "an unlabeled element". */
export function describeOverlayHints(hints: ObservedElement["hints"]): string {
  if (hints.ariaLabel) return `aria-label="${hints.ariaLabel}"`;
  if (hints.classNames?.length) return `.${hints.classNames.join(".")}`;
  if (hints.nearbyText) return `near "${hints.nearbyText}"`;
  return "an unlabeled element";
}

/** kind-scoped hash prefix, shared by both the signature and the id-mint namespace. */
const KIND_PREFIX: Record<FloorKind, string> = {
  icon: "icon",
  illustration: "illustration",
  "color-role": "color",
  "type-role": "type",
};

/** `node:crypto` sha256 over a kind-scoped canonical string, truncated to 16 hex
 * chars. Stable across runs and pages for the same rendered content. */
export function candidateSignature(kind: FloorKind, source: string): string {
  return createHash("sha256")
    .update(`${KIND_PREFIX[kind]}:${source}`)
    .digest("hex")
    .slice(0, 16);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function mintId(
  kind: FloorKind,
  counters: Record<string, number>,
  taken: Set<string>,
): string {
  const prefix = KIND_PREFIX[kind];
  let n = counters[prefix] ?? 1;
  let id = `${prefix}.unnamed-${n}`;
  while (taken.has(id)) {
    n += 1;
    id = `${prefix}.unnamed-${n}`;
  }
  counters[prefix] = n + 1;
  return id;
}

/** Which skip reasons earn a fallback candidate. An `ignored-selector` group is
 *  an EXPLICIT user exclusion — proposing a placeholder for a subtree the user
 *  told us to ignore would hand back the thing they just removed. */
export const FALLBACK_REASONS: readonly SkipReason[] = ["repeated-content", "foreign-origin"];

/** Signature namespace for fallback candidates. Kind-scoped through the EXISTING
 *  candidateSignature, so rejection memory and re-scan coverage work unchanged. */
const FALLBACK_SOURCE_PREFIX = "fallback:";

/** Pure: one fallback/empty-state candidate for one content group. No I/O, no
 *  model, no clock, no random. `cropFile` is added by the caller. */
export function fallbackCandidateFor(
  group: ContentGroup,
  url: string,
  counters: Record<string, number>,
  takenIds: Set<string>,
): Omit<ScanCandidate, "cropFile"> {
  return {
    signature: candidateSignature("illustration", `${FALLBACK_SOURCE_PREFIX}${group.key}`),
    kind: "illustration",
    proposedId: mintId("illustration", counters, takenIds),
    context: {
      note:
        `fallback/empty state for a skipped ${group.reason} group of ${group.count} item(s) ` +
        `on ${url} — the placeholder this position renders when no content is available`,
    },
    hints: group.hints,
    fallbackForGroup: group.key,
  };
}

type UnmintedCandidate = Omit<ScanCandidate, "cropFile" | "proposedId">;

interface AggEntry {
  value: string;
  count: number;
  firstBox: ObservedElement["box"];
  url: string;
  /** Every page this value was observed on — deduped, first-seen order. */
  urls: string[];
  order: number;
}

function aggregateStyleUse(
  pages: { url: string; uses: ObservedStyleUse[] }[],
): AggEntry[] {
  const map = new Map<string, AggEntry>();
  let order = 0;
  for (const page of pages) {
    for (const use of page.uses) {
      const key = use.value.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.count += use.count;
        if (!existing.urls.includes(page.url)) existing.urls.push(page.url);
      } else {
        map.set(key, {
          value: key,
          count: use.count,
          firstBox: use.firstBox,
          url: page.url,
          urls: [page.url],
          order: order++,
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.order - b.order);
}

/** True when `value` (a hex or a font family, lowercased) is a substring of any
 * covered note — the "observed value already appears in an existing slot's
 * context.note" rule (retired slots included). */
function noteCovers(coveredNotes: Set<string>, value: string): boolean {
  const needle = value.toLowerCase();
  for (const note of coveredNotes) {
    if (note.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function selectRoleCandidates(
  entries: AggEntry[],
  kind: "color-role" | "type-role",
  baselineSet: Set<string>,
  coveredNotes: Set<string>,
  coveredSignatures: Set<string>,
  cap: number,
  noteFor: (value: string, url: string) => string,
  migrationBaseline: MigrationBaseline,
): { unminted: UnmintedCandidate[]; skipped: number; migrations: MigrationFinding[] } {
  // Walk every off-baseline, uncovered entry UNCAPPED, producing an aggregate
  // observation per value — the cap applies AFTER the migration split (below),
  // so a legacy value never consumes candidate budget.
  const observations: RoleCandidateObservation<UnmintedCandidate>[] = [];
  let skipped = 0;
  for (const e of entries) {
    if (baselineSet.has(e.value)) continue;
    const signature = candidateSignature(kind, e.value);
    if (coveredSignatures.has(signature) || noteCovers(coveredNotes, e.value)) {
      skipped += 1;
      continue;
    }
    observations.push({
      candidate: { signature, kind, context: { note: noteFor(e.value, e.url) }, hints: {} },
      kind,
      value: e.value,
      occurrences: e.count,
      examples: e.urls,
    });
  }

  const { candidates: kept, migrations } = splitMigrations({
    candidates: observations,
    baseline: migrationBaseline,
  });

  const unminted = kept.slice(0, cap).map((o) => o.candidate);
  return { unminted, skipped, migrations };
}

/** The pure floor: no Playwright, no I/O, fully unit-testable. Classifies
 * observed elements + style uses into candidates, dedupes by signature across
 * URLs (first occurrence wins), omits anything already covered, and mints
 * honest anonymous ids in stable candidate order. */
export function buildScanCandidates(
  observations: PageObservation[],
  baseline: TokenBaseline,
  coverage: {
    coveredSignatures: Set<string>;
    coveredNotes: Set<string>;
    takenIds: Set<string>;
  },
): {
  candidates: Omit<ScanCandidate, "cropFile">[];
  skippedCovered: number;
  migrations: MigrationFinding[];
  skippedRejected?: never;
} {
  let skippedCovered = 0;
  const seenSignatures = new Set<string>();
  const elementCandidates: UnmintedCandidate[] = [];

  for (const obs of observations) {
    for (const el of obs.elements) {
      if (!el.visible) continue;
      const { width, height } = el.box;

      if (el.type === "svg") {
        if (width < ICON_MIN || width > ICON_MAX || height < ICON_MIN || height > ICON_MAX) {
          continue;
        }
        const source = collapseWhitespace(el.source);
        const signature = candidateSignature("icon", source);
        if (seenSignatures.has(signature)) continue;
        seenSignatures.add(signature);
        if (coverage.coveredSignatures.has(signature)) {
          skippedCovered += 1;
          continue;
        }
        elementCandidates.push({ signature, kind: "icon", hints: el.hints });
      } else {
        if (width < ILLUSTRATION_MIN || height < ILLUSTRATION_MIN) continue;
        if (el.intrinsic && el.intrinsic.width === 1 && el.intrinsic.height === 1) continue;
        const signature = candidateSignature("illustration", el.source);
        if (seenSignatures.has(signature)) continue;
        seenSignatures.add(signature);
        if (coverage.coveredSignatures.has(signature)) {
          skippedCovered += 1;
          continue;
        }
        elementCandidates.push({ signature, kind: "illustration", hints: el.hints });
      }
    }
  }

  const colorSorted = aggregateStyleUse(observations.map((o) => ({ url: o.url, uses: o.colors })));
  const fontSorted = aggregateStyleUse(
    observations.map((o) => ({ url: o.url, uses: o.fontFamilies })),
  );

  const migrationBaseline: MigrationBaseline = {
    colors: baseline.roleColors ?? [],
    families: baseline.roleFamilies ?? [],
  };

  const colorResult = selectRoleCandidates(
    colorSorted,
    "color-role",
    baseline.hexes,
    coverage.coveredNotes,
    coverage.coveredSignatures,
    MAX_COLOR_CANDIDATES,
    (value, url) => `observed color ${value} on ${url}`,
    migrationBaseline,
  );
  const typeResult = selectRoleCandidates(
    fontSorted,
    "type-role",
    baseline.families,
    coverage.coveredNotes,
    coverage.coveredSignatures,
    MAX_TYPE_CANDIDATES,
    (value, url) => `observed font "${value}" on ${url}`,
    migrationBaseline,
  );
  skippedCovered += colorResult.skipped + typeResult.skipped;
  const migrations = [...colorResult.migrations, ...typeResult.migrations];

  const counters: Record<string, number> = {};
  const candidates = [...elementCandidates, ...colorResult.unminted, ...typeResult.unminted].map(
    (c) => ({
      ...c,
      proposedId: mintId(c.kind as FloorKind, counters, coverage.takenIds),
    }),
  );

  return { candidates, skippedCovered, migrations };
}

// ---------------------------------------------------------------------------
// The Playwright observer + crops (impure — the only I/O in this module).
// ---------------------------------------------------------------------------

/**
 * Applies page setup around navigation. ABSENCE-TOLERANT BY CONTRACT: every step
 * that can fail to find its target records a note and continues — this function
 * NEVER throws for a missing selector, a rejected cookie, or a failed click. The
 * only navigation error that still throws is `goto` itself, which keeps the
 * existing unreachable-URL CommandError.
 *
 * ORDER (fixed): storage (addInitScript) -> cookies (addCookies) -> goto ->
 * waitFor -> dismiss[] in order -> settle.
 */
async function applyScanSetup(
  page: import("playwright").Page,
  url: string,
  setup: ScanSetup,
  phase: "pre-navigation" | "post-load",
): Promise<ScanSetupNote[]> {
  const notes: ScanSetupNote[] = [];

  if (phase === "pre-navigation") {
    if (setup.storage && Object.keys(setup.storage).length > 0) {
      const entries = Object.entries(setup.storage);
      await page.addInitScript((seed: [string, string][]) => {
        for (const [k, v] of seed) {
          try {
            window.localStorage.setItem(k, v);
          } catch {
            /* ignore */
          }
        }
      }, entries);
      notes.push({
        url,
        step: "storage",
        status: "applied",
        detail: `${entries.length} key(s) seeded pre-navigation`,
      });
    }

    if (setup.cookies?.length) {
      try {
        const mapped = setup.cookies.map((cookie) =>
          cookie.domain
            ? { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path ?? "/" }
            : { name: cookie.name, value: cookie.value, url },
        );
        await page.context().addCookies(mapped);
        notes.push({ url, step: "cookies", status: "applied" });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        notes.push({ url, step: "cookies", status: "failed", detail });
      }
    }

    return notes;
  }

  if (setup.waitFor) {
    try {
      await page.waitForSelector(setup.waitFor, { state: "visible", timeout: SETUP_WAIT_TIMEOUT_MS });
      notes.push({ url, step: "wait-for", selector: setup.waitFor, status: "applied" });
    } catch {
      notes.push({
        url,
        step: "wait-for",
        selector: setup.waitFor,
        status: "not-found",
        detail: `not visible within ${SETUP_WAIT_TIMEOUT_MS}ms — continuing`,
      });
    }
  }

  if (setup.dismiss?.length) {
    for (const selector of setup.dismiss) {
      try {
        const handle = await page.waitForSelector(selector, {
          state: "visible",
          timeout: DISMISS_WAIT_TIMEOUT_MS,
        });
        try {
          await handle.click({ timeout: DISMISS_WAIT_TIMEOUT_MS });
          notes.push({ url, step: "dismiss", selector, status: "applied" });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          notes.push({ url, step: "dismiss", selector, status: "failed", detail });
        }
      } catch {
        notes.push({
          url,
          step: "dismiss",
          selector,
          status: "not-found",
          detail: "selector never appeared — the gate may not show for this visitor",
        });
      }
    }

    await page.waitForLoadState("networkidle", { timeout: POST_DISMISS_SETTLE_MS }).catch(() => {});
  }

  return notes;
}

async function observePage(
  page: import("playwright").Page,
  url: string,
  setup: ScanSetup,
  ignore: string[],
): Promise<PageObservation> {
  const setupEmpty = isEmptyScanSetup(setup);
  const notes: ScanSetupNote[] = [];

  if (!setupEmpty) {
    notes.push(...(await applyScanSetup(page, url, setup, "pre-navigation")));
  }

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `Could not load ${url}: ${reason}\nIs the app running and reachable? Scan takes explicit URLs (no crawling).`,
    );
  }

  if (!setupEmpty) {
    notes.push(...(await applyScanSetup(page, url, setup, "post-load")));
  }

  const raw = await page.evaluate(
    (args: { ignore: string[]; pathDepth: number; classMax: number }) => {
    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      if (style.display === "none") return false;
      if (style.visibility === "hidden") return false;
      const opacity = parseFloat(style.opacity);
      if (!Number.isNaN(opacity) && opacity === 0) return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      return true;
    }

    function classNamesOf(el: Element): string[] | undefined {
      const raw = el.getAttribute("class");
      if (!raw) return undefined;
      const names = raw.trim().split(/\s+/).filter(Boolean);
      return names.length > 0 ? names : undefined;
    }

    function nearbyTextOf(el: Element): string | undefined {
      const heading = el.closest("h1, h2, h3, h4, h5, h6");
      const source = heading ?? el.parentElement;
      const text = source?.textContent?.trim();
      if (!text) return undefined;
      return text.slice(0, 120);
    }

    function hintsOf(el: Element) {
      const ariaLabel = el.getAttribute("aria-label") ?? undefined;
      const alt = el instanceof HTMLImageElement ? el.alt || undefined : undefined;
      const classNames = classNamesOf(el);
      const nearbyText = nearbyTextOf(el);
      return {
        ...(ariaLabel ? { ariaLabel } : {}),
        ...(alt ? { alt } : {}),
        ...(classNames ? { classNames } : {}),
        ...(nearbyText ? { nearbyText } : {}),
      };
    }

    function boxOf(el: Element) {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }

    function segmentOf(el: Element, classMax: number): string {
      const tag = el.tagName.toLowerCase();
      const rawClass = el.getAttribute("class");
      const classes = rawClass
        ? Array.from(new Set(rawClass.trim().split(/\s+/).filter(Boolean)))
            .sort()
            .slice(0, classMax)
        : [];
      return tag + classes.map((c) => "." + c).join("");
    }

    function siblingIndexOf(el: Element): number {
      const parent = el.parentElement;
      if (!parent) return 0;
      return Array.prototype.indexOf.call(parent.children, el);
    }

    function structureOf(el: Element, pathDepth: number, classMax: number) {
      const chain: Element[] = [el];
      let cursor: Element | null = el.parentElement;
      while (cursor && chain.length < pathDepth) {
        chain.push(cursor);
        cursor = cursor.parentElement;
      }
      const anchor = chain[chain.length - 1]; // the window's outermost ancestor
      const path = chain
        .slice()
        .reverse()
        .map((node) => segmentOf(node, classMax))
        .join(">");
      return {
        path,
        parentKey: `${segmentOf(anchor, classMax)}[${siblingIndexOf(anchor)}]`,
        siblingIndex: siblingIndexOf(el),
      };
    }

    function ignoredByOf(el: Element, ignore: string[]): string | undefined {
      for (const selector of ignore) {
        try {
          if (el.closest(selector)) return selector;
        } catch {
          // An invalid selector is skipped, never thrown — a typo'd config
          // entry must not abort the whole observation.
        }
      }
      return undefined;
    }

    function toHex(component: number): string {
      return Math.max(0, Math.min(255, Math.round(component))).toString(16).padStart(2, "0");
    }

    function parseOpaqueColor(value: string): string | null {
      const m = value.match(/^rgba?\(([^)]+)\)$/);
      if (!m) return null;
      const parts = m[1].split(",").map((p) => p.trim());
      if (parts.length === 4 && parseFloat(parts[3]) !== 1) return null;
      const [r, g, b] = parts;
      return `#${toHex(Number(r))}${toHex(Number(g))}${toHex(Number(b))}`;
    }

    const elements: {
      type: "svg" | "img" | "background-image";
      source: string;
      box: { x: number; y: number; width: number; height: number };
      intrinsic?: { width: number; height: number };
      visible: boolean;
      hints: ReturnType<typeof hintsOf>;
      structure: ReturnType<typeof structureOf>;
      ignoredBy?: string;
    }[] = [];

    const colorCounts = new Map<string, { count: number; firstBox: ReturnType<typeof boxOf> }>();
    const fontCounts = new Map<string, { count: number; firstBox: ReturnType<typeof boxOf> }>();

    const overlays: {
      box: { x: number; y: number; width: number; height: number };
      zIndex: number;
      position: string;
      hints: ReturnType<typeof hintsOf>;
    }[] = [];
    const OVERLAY_POSITIONS_INPAGE = new Set(["fixed", "sticky", "absolute"]);
    const viewportArea = window.innerWidth * window.innerHeight;

    const all = Array.from(document.querySelectorAll("*"));
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      const visible = isVisible(el);
      const structure = structureOf(el, args.pathDepth, args.classMax);
      const ignoredBy = ignoredByOf(el, args.ignore);

      if (tag === "svg") {
        elements.push({
          type: "svg",
          source: el.outerHTML,
          box: boxOf(el),
          visible,
          hints: hintsOf(el),
          structure,
          ...(ignoredBy ? { ignoredBy } : {}),
        });
      } else if (tag === "img" && el instanceof HTMLImageElement) {
        elements.push({
          type: "img",
          source: el.src,
          box: boxOf(el),
          intrinsic: { width: el.naturalWidth, height: el.naturalHeight },
          visible,
          hints: hintsOf(el),
          structure,
          ...(ignoredBy ? { ignoredBy } : {}),
        });
      } else {
        const bg = window.getComputedStyle(el).backgroundImage;
        const bgMatch = bg && bg.match(/url\((['"]?)(.*?)\1\)/);
        if (bgMatch && bgMatch[2]) {
          elements.push({
            type: "background-image",
            source: bgMatch[2],
            box: boxOf(el),
            visible,
            hints: hintsOf(el),
            structure,
            ...(ignoredBy ? { ignoredBy } : {}),
          });
        }
      }

      const style = window.getComputedStyle(el);
      for (const prop of ["color", "backgroundColor"] as const) {
        const hex = parseOpaqueColor(style[prop]);
        if (!hex) continue;
        const key = hex.toLowerCase();
        const existing = colorCounts.get(key);
        if (existing) existing.count += 1;
        else colorCounts.set(key, { count: 1, firstBox: boxOf(el) });
      }

      const family = style.fontFamily
        .split(",")[0]
        ?.trim()
        .replace(/^['"]|['"]$/g, "")
        .toLowerCase();
      if (family) {
        const existing = fontCounts.get(family);
        if (existing) existing.count += 1;
        else fontCounts.set(family, { count: 1, firstBox: boxOf(el) });
      }

      if (OVERLAY_POSITIONS_INPAGE.has(style.position)) {
        const box = boxOf(el);
        if (box.width * box.height >= viewportArea / 4) {
          const zIndexRaw = Number.parseInt(style.zIndex, 10);
          const zIndex = Number.isNaN(zIndexRaw) ? 0 : zIndexRaw;
          overlays.push({ box, zIndex, position: style.position, hints: hintsOf(el) });
        }
      }
    }

    return {
      elements,
      colors: Array.from(colorCounts.entries()).map(([value, v]) => ({
        value,
        count: v.count,
        firstBox: v.firstBox,
      })),
      fontFamilies: Array.from(fontCounts.entries()).map(([value, v]) => ({
        value,
        count: v.count,
        firstBox: v.firstBox,
      })),
      overlays,
    };
    },
    { ignore, pathDepth: STRUCTURE_PATH_DEPTH, classMax: STRUCTURE_CLASS_MAX },
  );

  const { overlays, ...rest } = raw;
  const blockedByOverlay = detectOverlay(overlays ?? [], VIEWPORT);

  return {
    url,
    ...rest,
    ...(notes.length ? { setupNotes: notes } : {}),
    ...(blockedByOverlay ? { blockedByOverlay } : {}),
  };
}

function boxForCandidate(
  observation: PageObservation,
  candidate: Omit<ScanCandidate, "cropFile">,
): ObservedElement["box"] {
  if (candidate.kind === "icon" || candidate.kind === "illustration") {
    const el = observation.elements.find((e) => {
      if (candidate.kind === "icon" && e.type !== "svg") return false;
      if (candidate.kind === "illustration" && e.type === "svg") return false;
      const source = e.type === "svg" ? collapseWhitespace(e.source) : e.source;
      return candidateSignature(candidate.kind as FloorKind, source) === candidate.signature;
    });
    return el?.box ?? { x: 0, y: 0, width: 0, height: 0 };
  }
  const pool = candidate.kind === "color-role" ? observation.colors : observation.fontFamilies;
  const match = pool.find(
    (c) => candidateSignature(candidate.kind as FloorKind, c.value.toLowerCase()) === candidate.signature,
  );
  return match?.firstBox ?? { x: 0, y: 0, width: 0, height: 0 };
}

/** Exported for the fake-driver crop-clip assertion in scan.test.ts (WS-03) —
 *  purely additive visibility, no behavior change. */
export function clipFor(
  box: ObservedElement["box"],
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const PAD = 4;
  let x = box.x - PAD;
  let y = box.y - PAD;
  let width = box.width + PAD * 2;
  let height = box.height + PAD * 2;
  if (box.width <= 0 || box.height <= 0) {
    x = box.x;
    y = box.y;
    width = 16;
    height = 16;
  }
  x = Math.max(0, Math.min(x, viewport.width - 1));
  y = Math.max(0, Math.min(y, viewport.height - 1));
  width = Math.max(1, Math.min(width, viewport.width - x));
  height = Math.max(1, Math.min(height, viewport.height - y));
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// Coverage + token baseline (impure — reads the manifest/prior proposal/direction).
// ---------------------------------------------------------------------------

async function buildCoverage(
  manifest: SurfaceManifest | null,
  priorProposal: ScanProposal | null,
): Promise<{
  coveredSignatures: Set<string>;
  coveredNotes: Set<string>;
  takenIds: Set<string>;
  rejectedSignatures: string[];
}> {
  const coveredSignatures = new Set<string>();
  const coveredNotes = new Set<string>();
  const takenIds = new Set<string>();

  if (manifest) {
    for (const slot of manifest.slots) {
      takenIds.add(slot.id);
      if (slot.context?.note) coveredNotes.add(slot.context.note);
      for (const attribution of slot.attributions) {
        if (attribution.source.startsWith("surface-scan:")) {
          coveredSignatures.add(attribution.source.slice("surface-scan:".length));
        }
      }
    }
  }

  const rejectedSignatures = priorProposal?.rejectedSignatures ?? [];
  for (const sig of rejectedSignatures) coveredSignatures.add(sig);

  return { coveredSignatures, coveredNotes, takenIds, rejectedSignatures };
}

const NO_DIRECTION_NOTE = "no approved direction to diff against — all observed values proposed";

const EMPTY_TOKEN_BASELINE: TokenBaseline = {
  hexes: new Set(),
  families: new Set(),
  roleColors: [],
  roleFamilies: [],
};

async function buildTokenBaseline(
  cwd: string,
  config: KeyartConfig,
): Promise<{ baseline: TokenBaseline; note?: string }> {
  try {
    const brand = await createBrandCore(cwd, config).read();
    const pointer = brand.approvedPointer;
    if (!pointer) {
      return { baseline: EMPTY_TOKEN_BASELINE, note: NO_DIRECTION_NOTE };
    }
    const direction = await readVersion(directionsRoot(cwd, config), pointer.directionId, pointer.versionId);
    const vars = resolveBrandVars(direction);
    const hexes = new Set(
      [
        vars.primary,
        vars.secondary,
        vars.background,
        vars.surface,
        vars.text,
        vars.textMuted,
        ...vars.brand.map((b) => b.hex),
      ].map((h) => h.toLowerCase()),
    );
    const families = new Set(
      [vars.fontHeadingFamily, vars.fontBodyFamily].map((f) => f.toLowerCase()),
    );
    // Same values as `hexes`/`families` above, labeled with the `--brand-*`
    // var that holds them — byte-identical to renderBrandCss, so a finding's
    // advice is copy-pasteable into the app. Fixed order (semantic roles
    // first, then brand primitives) doubles as the migration tie-break order.
    const roleColors = [
      { role: "--brand-primary", hex: vars.primary },
      { role: "--brand-secondary", hex: vars.secondary },
      { role: "--brand-background", hex: vars.background },
      { role: "--brand-surface", hex: vars.surface },
      { role: "--brand-text", hex: vars.text },
      { role: "--brand-text-muted", hex: vars.textMuted },
      ...vars.brand.map((b) => ({ role: `--brand-${b.name}`, hex: b.hex })),
    ].map((e) => ({ role: e.role, hex: e.hex.toLowerCase() }));
    const roleFamilies = [
      { role: "--brand-font-heading", family: vars.fontHeadingFamily },
      { role: "--brand-font-body", family: vars.fontBodyFamily },
    ];
    return { baseline: { hexes, families, roleColors, roleFamilies } };
  } catch {
    return { baseline: EMPTY_TOKEN_BASELINE, note: NO_DIRECTION_NOTE };
  }
}

/**
 * Maps one scanned candidate to the `SurfaceSlot` `patchSlots` consumes — the
 * exact candidate→slot mapping (byte-identical `surface-scan:<signature>`
 * attribution source, the durable re-scan coverage key). Extracted so the CLI
 * `--apply` path and the studio triage apply route (WS-09) share ONE mapping,
 * never two.
 */
export function candidateToSlot(candidate: ScanCandidate, nowIso: string): SurfaceSlot {
  return {
    id: candidate.proposedId,
    kind: candidate.kind,
    description: candidate.description ?? `Scanned ${candidate.kind} candidate (unrefined)`,
    context: candidate.context,
    criticality: "preferred",
    origin: "scan",
    attributions: [
      { author: "scan", source: `surface-scan:${candidate.signature}`, date: nowIso },
    ],
  };
}

// ---------------------------------------------------------------------------
// runSurfaceScan
// ---------------------------------------------------------------------------

export interface SurfaceScanResult {
  proposalDir: string; // repo-relative forward-slash
  proposalFile: string; // ".../proposal.json"
  urls: string[];
  candidateCount: number;
  byKind: Partial<Record<SlotKind, number>>;
  skippedCovered: number; // omitted as already covered / rejected
  skippedContent: number; // observations dropped by the content classifier
  contentGroups: number; // distinct groups those observations formed
  /** Fallback/empty-state candidates MINTED for content groups — incremented
   *  once per minted candidate, INCLUDING candidates whose crop capture
   *  failed (those are kept, honestly annotated — see runSurfaceScan). */
  fallbackCount: number;
  applied?: { slotIds: string[] }; // present only with apply
  filesWritten: string[]; // proposal.json + crops (+ surface.yaml via the core on apply)
  dryRun: false; // scan is keyless-native; never a model call
  setupNotes: ScanSetupNote[]; // [] when none — always present (a result is not a persisted record)
  blockedByOverlay?: OverlayFinding;
}

export async function runSurfaceScan(opts: {
  cwd: string;
  urls: string[];
  apply?: boolean;
  noRefine?: boolean;
  /** Per-run page-setup overrides; each PRESENT key REPLACES the matching
   *  `config.scan` key. The CLI populates only `waitFor`/`dismiss`. */
  setup?: ScanSetup;
}): Promise<SurfaceScanResult> {
  if (opts.urls.length === 0) {
    throw new CommandError(
      "surface scan requires at least one URL.\nUsage: keyart surface scan <url...> [--apply] [--no-refine] " +
        "[--dismiss <selector>]... [--wait-for <selector>]",
    );
  }

  const config = await loadConfig(opts.cwd);
  const cwd = path.resolve(opts.cwd);
  const rel = (abs: string): string => path.relative(cwd, abs).split(path.sep).join("/");

  const scanDir = surfaceScanDir(cwd, config);
  const cropsDir = path.join(scanDir, "crops");
  const proposalPath = path.join(scanDir, "proposal.json");

  const manifest = await createSurfaceCore(cwd, config).read();
  let priorProposal: ScanProposal | null = null;
  if (await pathExists(proposalPath)) {
    priorProposal = JSON.parse(await readTextFile(proposalPath)) as ScanProposal;
  }
  const coverage = await buildCoverage(manifest, priorProposal);
  const { baseline, note: baselineNote } = await buildTokenBaseline(cwd, config);
  const setup = resolveScanSetup(config.scan, opts.setup);

  let chromium: typeof import("playwright").chromium;
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    throw new CommandError(
      "Playwright is not installed. Run `npx playwright install chromium` to set it up.",
    );
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    throw new CommandError(
      "Chromium browser not found. Run `npx playwright install chromium` to install it.",
    );
  }

  const allCandidates: ScanCandidate[] = [];
  const setupNotes: ScanSetupNote[] = [];
  let blockedByOverlay: OverlayFinding | undefined;
  let skippedCovered = 0;
  let skippedContent = 0;
  // Migration findings, accumulated across every scanned URL and deduped by
  // `kind:value` — the first occurrence supplies kind/value/nearestRole/delta,
  // occurrences are summed, and examples are unioned (deduped, first-seen
  // order, capped) so a later page's evidence is never silently dropped.
  const migrationsByKey = new Map<string, MigrationFinding>();
  const allGroups: ContentGroup[] = [];
  let cropsDirEnsured = false;
  const fallbackCounters: Record<string, number> = {};
  const mintedFallbackSignatures = new Set<string>();
  const fallbackCropFailedSignatures = new Set<string>();
  let fallbackCount = 0;

  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    for (const url of opts.urls) {
      const rawObservation = await observePage(page, url, setup, config.scan?.ignore ?? []);
      if (rawObservation.setupNotes?.length) setupNotes.push(...rawObservation.setupNotes);
      if (rawObservation.blockedByOverlay) {
        if (!blockedByOverlay) blockedByOverlay = rawObservation.blockedByOverlay;
        console.log(
          `WARNING: ${url} still appears blocked — ${describeOverlayHints(rawObservation.blockedByOverlay.hints)} covers ` +
            `${Math.round(rawObservation.blockedByOverlay.fraction * 100)}% of the viewport above the page. ` +
            "The scan may be inventorying an overlay, not the page. " +
            "Add a `scan.dismiss` selector (or --dismiss) for it and re-scan.",
        );
      }

      const { kept, groups } = classifyObservedElements(rawObservation.elements, {
        pageOrigin: new URL(url).origin,
        ignore: config.scan?.ignore,
        contentOrigins: config.scan?.contentOrigins,
      });
      const observation: PageObservation = { ...rawObservation, elements: kept };
      skippedContent += rawObservation.elements.length - kept.length;
      allGroups.push(...groups);

      const {
        candidates,
        skippedCovered: pageSkipped,
        migrations: pageMigrations,
      } = buildScanCandidates([observation], baseline, coverage);
      skippedCovered += pageSkipped;

      for (const finding of pageMigrations) {
        const key = `${finding.kind}:${finding.value}`;
        const existing = migrationsByKey.get(key);
        if (existing) {
          existing.occurrences += finding.occurrences;
          for (const exampleUrl of finding.examples) {
            if (
              !existing.examples.includes(exampleUrl) &&
              existing.examples.length < MIGRATION_EXAMPLE_CAP
            ) {
              existing.examples.push(exampleUrl);
            }
          }
        } else {
          migrationsByKey.set(key, {
            ...finding,
            examples: finding.examples.slice(0, MIGRATION_EXAMPLE_CAP),
          });
        }
      }

      for (const candidate of candidates) {
        coverage.coveredSignatures.add(candidate.signature);
        coverage.takenIds.add(candidate.proposedId);

        if (!cropsDirEnsured) {
          await ensureDir(cropsDir);
          cropsDirEnsured = true;
        }
        const box = boxForCandidate(observation, candidate);
        const cropAbsPath = path.join(cropsDir, `${candidate.signature}.png`);
        await page.screenshot({ path: cropAbsPath, clip: clipFor(box, VIEWPORT) });
        allCandidates.push({ ...candidate, cropFile: rel(cropAbsPath) });
      }

      // Fallback/empty-state candidates — exactly ONE per content group,
      // minted here (not inside buildScanCandidates) so a run-level counters
      // object plus coverage.takenIds prevents any collision with element
      // candidates or existing manifest slots. Crop is taken on THIS page,
      // before navigating away.
      for (const group of groups) {
        if (!FALLBACK_REASONS.includes(group.reason)) continue;

        const candidate = fallbackCandidateFor(group, url, fallbackCounters, coverage.takenIds);

        if (mintedFallbackSignatures.has(candidate.signature)) continue;
        if (coverage.coveredSignatures.has(candidate.signature)) {
          skippedCovered += 1;
          continue;
        }
        mintedFallbackSignatures.add(candidate.signature);
        coverage.coveredSignatures.add(candidate.signature);
        coverage.takenIds.add(candidate.proposedId);

        // Representative crop: the group's FIRST MEMBER's box, located in the
        // ORIGINAL (pre-classification) element array — boxForCandidate cannot
        // resolve a source-less fallback candidate.
        const member = rawObservation.elements.find((el) => contentGroupKeyOf(el) === group.key);

        const cropAbsPath = path.join(cropsDir, `${candidate.signature}.png`);
        let cropWritten = false;
        let cropFailure: string | undefined;
        if (!member) {
          cropFailure = "no representative member element found for the group";
        } else {
          try {
            if (!cropsDirEnsured) {
              await ensureDir(cropsDir);
              cropsDirEnsured = true;
            }
            await page.screenshot({ path: cropAbsPath, clip: clipFor(member.box, VIEWPORT) });
            cropWritten = true;
          } catch (err) {
            cropFailure = err instanceof Error ? err.message : String(err);
          }
        }

        allCandidates.push({
          ...candidate,
          cropFile: rel(cropAbsPath),
          ...(cropFailure
            ? {
                context: {
                  ...candidate.context,
                  note: `${candidate.context!.note}; crop unavailable: ${cropFailure}`,
                },
              }
            : {}),
        });
        fallbackCount += 1;
        if (!cropWritten) {
          fallbackCropFailedSignatures.add(candidate.signature);
          console.log(`Fallback crop unavailable for ${candidate.proposedId}: ${cropFailure}`);
        }
      }

      console.log(`Scanned ${url}.`);
    }
  } finally {
    await browser.close();
  }

  for (const note of setupNotes) {
    if (note.status === "applied") continue;
    const label = note.selector ? `"${note.selector}" ` : "";
    console.log(`Setup note: ${note.step} ${label}${note.status} — ${note.detail ?? ""}`);
  }

  const migrations = [...migrationsByKey.values()];

  const proposal: ScanProposal = {
    createdAt: new Date().toISOString(),
    urls: opts.urls,
    candidates: allCandidates,
    rejectedSignatures: coverage.rejectedSignatures,
    migrations,
    skipped: allGroups.map(({ reason, count, exampleSources, hints }) => ({
      reason,
      count,
      exampleSources,
      ...(Object.keys(hints).length ? { hints } : {}),
    })),
    ...(setupNotes.length ? { setupNotes } : {}),
    ...(blockedByOverlay ? { blockedByOverlay } : {}),
  };

  await ensureDir(scanDir);
  await writeJsonFile(proposalPath, proposal);

  const filesWritten = [
    rel(proposalPath),
    ...allCandidates
      .filter((c) => !fallbackCropFailedSignatures.has(c.signature))
      .map((c) => c.cropFile),
  ];

  // Post-floor, key-gated refinement — BEFORE apply, so an apply merges the
  // REFINED ids. `.env*` FIRST, before the hasApiKey() gate (the explore/
  // doctor convention: the direct CLI path does not preload env the way MCP/
  // serve do), so a key stored only in `.env.local` gates refinement ON.
  loadEnvFiles(cwd);
  let refineResult: Awaited<ReturnType<typeof runSurfaceRefine>> | undefined;
  if (opts.noRefine) {
    // skipped regardless of key
  } else if (hasApiKey()) {
    try {
      refineResult = await runSurfaceRefine({ cwd });
    } catch (err) {
      // A failing adapter degrades to the floor proposal — never aborts the
      // scan (the conflict-guard "failing adapter degrades to the floor"
      // discipline).
      console.log(
        `Refinement failed: ${err instanceof Error ? err.message : String(err)} — the floor proposal ships as-is.`,
      );
    }
  }

  let finalCandidates = allCandidates;
  if (refineResult && !refineResult.dryRun && refineResult.filesWritten.length > 0) {
    const refreshed = JSON.parse(await readTextFile(proposalPath)) as ScanProposal;
    finalCandidates = refreshed.candidates;
  }

  let applied: { slotIds: string[] } | undefined;
  if (opts.apply) {
    const nowIso = new Date().toISOString();
    const patches: SurfaceSlot[] = finalCandidates.map((c) => candidateToSlot(c, nowIso));
    await createSurfaceCore(cwd, config).patchSlots(patches);
    filesWritten.push(rel(surfaceManifestPath(cwd, config)));
    applied = { slotIds: patches.map((p) => p.id) };
  }

  const byKind: Partial<Record<SlotKind, number>> = {};
  for (const c of finalCandidates) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  }

  if (baselineNote) console.log(baselineNote);
  console.log(
    `Proposed ${allCandidates.length} candidate(s) (icon: ${byKind.icon ?? 0}, ` +
      `illustration: ${byKind.illustration ?? 0}, color-role: ${byKind["color-role"] ?? 0}, ` +
      `type-role: ${byKind["type-role"] ?? 0}); skipped ${skippedCovered} covered.`,
  );
  if (migrations.length > 0) {
    console.log("Migration findings (advisory — NOT proposed as slots):");
    const shown = migrations.slice(0, MIGRATION_SUMMARY_LIMIT);
    for (const finding of shown) {
      if (finding.kind === "color-role") {
        console.log(
          `  ${finding.value} appears ${finding.occurrences}x and is within ${finding.delta} of ` +
            `${finding.nearestRole} — replace the literal with var(${finding.nearestRole}).`,
        );
      } else {
        console.log(
          `  "${finding.value}" appears ${finding.occurrences}x and matches ${finding.nearestRole} ` +
            `— replace the literal with var(${finding.nearestRole}).`,
        );
      }
    }
    const hiddenMigrations = migrations.length - shown.length;
    if (hiddenMigrations > 0) {
      console.log(`  …and ${hiddenMigrations} more (see ${rel(proposalPath)}).`);
    }
  }
  if (skippedContent > 0) {
    const REASON_ORDER: SkipReason[] = ["repeated-content", "foreign-origin", "ignored-selector"];
    const byReason = REASON_ORDER.map((reason) => {
      const reasonGroups = allGroups.filter((g) => g.reason === reason);
      const count = reasonGroups.reduce((sum, g) => sum + g.count, 0);
      return [reason, count, reasonGroups.length] as const;
    }).filter(([, count]) => count > 0);
    console.log(
      `Skipped ${skippedContent} element(s) as app content: ` +
        byReason.map(([reason, n, g]) => `${reason} ${n} in ${g} group(s)`).join(", ") + ".",
    );
    for (const group of allGroups) {
      console.log(
        `  - ${group.reason} ×${group.count} [${group.key}]` +
          (group.exampleSources.length ? ` e.g. ${group.exampleSources.join(", ")}` : ""),
      );
    }
  }
  if (fallbackCount > 0) {
    console.log(
      `Proposed ${fallbackCount} fallback/empty-state candidate(s) — one per skipped content group ` +
        `(anonymous until refinement names them).`,
    );
  }
  if (applied) {
    console.log(`Applied ${applied.slotIds.length} slot(s) to brand/surface.yaml.`);
  }
  if (refineResult && !refineResult.dryRun && !refineResult.skippedReason) {
    console.log(`Refined ${refineResult.refinedCount} of ${refineResult.candidateCount} candidate(s).`);
  } else if (refineResult?.skippedReason) {
    console.log(`Refinement skipped: ${refineResult.skippedReason}`);
  } else if (opts.noRefine) {
    console.log(
      "Floor scan only — ids are anonymous placeholders (icon.unnamed-N) (refinement skipped — --no-refine).",
    );
  } else {
    console.log(
      "Floor scan only — ids are anonymous placeholders (icon.unnamed-N). " +
        "No OPENAI_API_KEY — add one and run `keyart surface scan --refine-only` to upgrade it.",
    );
  }

  return {
    proposalDir: rel(scanDir),
    proposalFile: rel(proposalPath),
    urls: opts.urls,
    candidateCount: allCandidates.length,
    byKind,
    skippedCovered,
    skippedContent,
    contentGroups: allGroups.length,
    fallbackCount,
    ...(applied ? { applied } : {}),
    filesWritten,
    dryRun: false,
    setupNotes,
    ...(blockedByOverlay ? { blockedByOverlay } : {}),
  };
}

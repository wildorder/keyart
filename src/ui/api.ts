import path from "node:path";
import { loadConfig, directionsRoot } from "../config.js";
import {
  createArtifactStore,
  type ArtifactHandle,
  type ArtifactStore,
} from "../store/artifact-store.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { renderBrief } from "../direction/render-brief.js";
import { readVersion } from "../direction/store.js";
import {
  listAssetIds,
  readAssetIndex,
  readExtractedAsset,
} from "../asset/asset-store.js";
import { isExtractedAssetRetired } from "../asset/schema.js";
import type {
  DirectionCharacter,
  DirectionUsage,
  DirectionVersion,
  KeyartConfig,
} from "../types.js";
import type { BrandBrief, DirectionRecord, DirectionStatus } from "../direction/schema.js";
import { isAssetRetired } from "../direction/schema.js";
import { isRetired } from "../direction/reconcile.js";
import {
  memoryEntryAffordances,
  assetAffordances,
  ruleAffordances,
} from "../direction/affordances.js";
import type { ApprovedProvenance } from "../commands/approve.js";
import type { GlobalRule } from "../brand/schema.js";
import { CommandError } from "../errors.js";
import { createSurfaceCore } from "../surface/store.js";
import { isSlotRetired, type SlotKind } from "../surface/schema.js";
import { gatherBindInputs, resolveSlots, type ResolvedSlot } from "../surface/bind.js";
import { surfaceScanDir, type ScanProposal } from "../surface/scan.js";

/**
 * Per-version generated artifact handles (opaque — pass back verbatim to
 * GET /api/asset?path=, never parse or join; see {@link ArtifactHandle}).
 * `styleBoardSvg` is the deterministic board (a strict projection of the
 * tokens); `styleBoard` is the evocative board (a mood/texture image). Every
 * key is optional so galleries degrade gracefully.
 */
export interface DirectionImages {
  styleTile?: ArtifactHandle;
  homepageMockup?: ArtifactHandle;
  styleBoard?: ArtifactHandle; // evocative style-board.png
  styleBoardSvg?: ArtifactHandle; // deterministic style-board.svg
  /**
   * True when this version's tokens are EXTRACTION-backed — a `style-tile.png`
   * exists, and the inverted spine extracts the color/type tokens from that tile.
   * Lets the studio label the board "extracted from the style tile" instead of
   * "(exact)". Optional + additive: a dry-run / legacy token-less version simply
   * omits it (backward compatible).
   */
  tokensExtracted?: boolean;
}

export interface DashboardMemoryEntry {
  id: string;
  kind: "feedback" | "learning" | "decision";
  body: string;
  author: string;
  source: string;
  date: string;
  /** Opaque discard-thumbnail handle (pass verbatim to GET /api/asset?path=). */
  asset?: ArtifactHandle;
  /** Directive channel — which content lane this entry reaches. Optional + additive. */
  channel?: "visual" | "copy" | "both";
  /** Directive polarity — prefer or avoid. Optional + additive. */
  polarity?: "prefer" | "avoid";
  /** ISO timestamp set when a reconcile action retired/superseded this entry. */
  retiredAt?: string;
  /** Id of the winning entry that superseded this one. */
  supersededBy?: string;
  /** Derived, pure action affordances (WS-05) — present only on ACTIVE entries
   * (never on `retiredMemory` history). See `src/direction/affordances.ts`.
   * Promote is up-only and single-destination now that scope is location. */
  editable?: boolean;
  deletable?: boolean;
  promotableTo?: ("global")[];
}

/**
 * One version in a direction's ordered history. Spreads the version's realized
 * content (name/summary/tokens/…), stamps its `versionId`/`createdAt`, and
 * attaches the per-version generated `images` probed off disk.
 */
export interface DashboardVersion {
  versionId: string; // = the version's id
  createdAt: string;
  producedBy?: string;
  name: string;
  summary: string;
  positioning: string;
  character: DirectionCharacter;
  homepageMockupPrompt: string;
  styleTilePrompt: string;
  copyExamples: { headline: string; subheadline: string; cta: string };
  usage: DirectionUsage;
  tokens?: DirectionVersion["tokens"];
  images?: DirectionImages; // per-version generated artifacts (tile/mockup/board/svg)
}

/**
 * One ACTIVE extracted asset of a direction, as served on the dashboard (WS-05,
 * asset-extraction). ADDITIVE read-contract extension — no existing dashboard
 * field changes. Retired assets are EXCLUDED (never listed here).
 */
export interface DashboardExtractedAsset {
  id: string; // assetId
  name: string;
  description: string; // the HEAD version's description
  headVersionId: string;
  versionCount: number;
  /** The head version's asset.png as an opaque handle for the EXISTING
   * GET /api/asset?path=. ABSENT for a dry-run head (no PNG on disk) — the
   * shelf renders a pending state, never a fabricated thumbnail. */
  imagePath?: ArtifactHandle;
  createdAt: string; // the asset's FIRST version's createdAt (when it was extracted)
  /** True when the HEAD version ran keylessly (dry-run). Additive — lets the
   * shelf distinguish "no key" from a keyed-but-failed generation. */
  dryRun?: boolean;
  /** The head version's persisted generation failures/degradations, verbatim
   * from `AssetVersion.imageSkips`. Additive. */
  imageSkips?: string[];
}

/**
 * A top-level direction, as served on the dashboard — the aggregate root
 * (WS-18 flattened the old single-element wrapper away). Canonical
 * version order is ASCENDING (`versions[last] === head`) so serve-api payload
 * tests and UI rendering never diverge; the component layer renders head-first.
 */
export interface DashboardDirection {
  id: string; // directionId
  name: string;
  status: DirectionStatus; // "active" | "parked" | "rejected" | "approved" | "archived"
  // The STRUCTURED brief off the versioned record — the single source the studio
  // form edits. `renderedBrief` is its deterministic markdown projection
  // (`renderBrief`), the single string surface the read-only preview renders.
  brief: BrandBrief;
  renderedBrief: string;
  version: number; // record version — sent back as `expectedVersion` on a brief PATCH (409-safe)
  /** Head versionId, or null for a draft direction (no versions yet). */
  head: string | null;
  /** Derived: `head === null` — zero versions, the describe-first state. */
  isDraft: boolean;
  versions: DashboardVersion[]; // ordered ascending; last = head
  /** ACTIVE extracted assets of THIS direction only (retired excluded).
   * Always present ([] when none) so consumers never null-check. */
  extractedAssets: DashboardExtractedAsset[];
  memory: DashboardMemoryEntry[]; // THIS direction's entries only — ACTIVE only
  assets: DashboardAssetRef[]; // ACTIVE kept-crop refs only (retired excluded)
  /** Superseded/retired memory history — still reachable, never in `memory`. */
  retiredMemory?: DashboardMemoryEntry[];
  /** Retired kept-crop refs — still reachable, never in `assets`. */
  retiredAssets?: DashboardAssetRef[];
}

/** A direction-level kept-crop asset ref (`path` is an opaque handle for `/api/asset?path=`). */
export interface DashboardAssetRef {
  kind: string;
  path: ArtifactHandle;
  note?: string;
  /** Derived (WS-05) — present only on ACTIVE refs. Kept crops are NEVER
   * promotable across scopes (re-key at the desired scope instead). */
  removable?: boolean;
}

/** One global rule as served on the dashboard (mirrors `GlobalRule`, additive affordances). */
export interface DashboardGlobalRule {
  id: string;
  severity: "hard" | "guideline";
  text: string;
  author: string;
  source: string;
  date: string;
  channel?: "visual" | "copy" | "both";
  polarity?: "prefer" | "avoid";
  /** Derived (WS-05) — present only on ACTIVE rules. */
  editable?: boolean;
  removable?: boolean;
}

export interface DashboardGlobal {
  approvedPointer: {
    directionId: string;
    versionId: string;
    approvedAt: string;
  } | null;
  rules: DashboardGlobalRule[]; // ACTIVE rules only (retired excluded, WS-05)
  /** Retired global rules — still reachable, never in `rules`. */
  retiredRules?: DashboardGlobalRule[];
}

/** One ACTIVE surface slot as served on the dashboard (WS-08) — manifest
 * metadata merged with its pure `resolveSlots` resolution. Retired slots are
 * EXCLUDED. Mirrored in `src/ui/types.ts`. */
export interface DashboardSurfaceSlot {
  id: string;
  kind: SlotKind;
  criticality: "required" | "preferred";
  origin: "authored" | "scan" | "request";
  /** attributions.length — "requested N×" on request rows. */
  attributionCount: number;
  /** The LAST attribution's author/date (attributions are append-only, so last =
   * most recent). Absent when the slot has no attributions. */
  latestAttribution?: { author: string; date: string };
  status: "bound" | "derived" | "gap" | "pending";
  /** Bound/derived color-role hex or type-role family (byte-identical to
   * brand.css via resolveSlots — never recomputed here). */
  value?: string;
  assetId?: string;
  /** Bound asset PNG as an opaque handle for GET /api/asset?path=. */
  file?: ArtifactHandle;
  /** Present (true) ONLY when kind === "other" — the taxonomy-demand flag. */
  taxonomyDemand?: boolean;
}

/** The additive surface section (WS-08). WS-09 extends this interface with an
 * optional `proposal` field — keep it an interface (not an inline literal) so
 * that addition is a one-line additive change. Mirrored in `src/ui/types.ts`. */
export interface DashboardSurface {
  /** The manifest's record version — sent back as `expectedVersion` on every
   * curation write. */
  version: number;
  /** ACTIVE slots in MANIFEST order (canonical payload order — display
   * ordering is the client helper's job). */
  slots: DashboardSurfaceSlot[];
  /** The latest scan proposal, served VERBATIM from
   * brand/generated/surface-scan/proposal.json (crop paths are already
   * repo-relative forward-slash — directly /api/asset-servable). Absent when
   * no proposal exists (WS-09). */
  proposal?: ScanProposal;
}

export interface DashboardData {
  projectName: string;
  directions: DashboardDirection[]; // top-level; [] when brand/directions/ doesn't exist
  global: DashboardGlobal | null; // global brand (approved pointer + rules); null on read error or no config
  approved: (DirectionVersion & { provenance?: ApprovedProvenance }) | null;
  guides: { visualStyle: string | null; brand: string | null };
  latestAudit: {
    id: string;
    markdown: string | null;
    /** Opaque handle of the audit screenshot (null when none exists). Clients
     * fetch the image via GET /api/audit-screenshot, not this value. */
    screenshotPath: ArtifactHandle | null;
  } | null;
  /** null when no surface manifest exists (feature-off — the board renders
   * nothing and the studio is visually byte-identical to today). Additive; no
   * read-contract break. Computed via the pure `resolveSlots` — this read
   * NEVER writes `binding.json`. */
  surface: DashboardSurface | null;
  errors: string[];
}

/**
 * Probe one version folder for its generated artifacts (style tile / homepage
 * mockup / evocative board / deterministic board svg), rooted at
 * `versions/<versionId>/`. Returns undefined when nothing is on disk so the key
 * is omitted (galleries degrade gracefully).
 */
async function versionImages(
  artifacts: ArtifactStore,
  directionsDir: string,
  directionId: string,
  versionId: string,
): Promise<DirectionImages | undefined> {
  const versionDir = path.join(
    directionsDir,
    directionId,
    "versions",
    versionId,
  );
  const images: DirectionImages = {};
  const styleTile = await artifacts.probe(path.join(versionDir, "style-tile.png"));
  const mockup = await artifacts.probe(path.join(versionDir, "homepage-mockup.png"));
  const boardPng = await artifacts.probe(path.join(versionDir, "style-board.png"));
  const boardSvg = await artifacts.probe(path.join(versionDir, "style-board.svg"));
  if (styleTile !== undefined) {
    images.styleTile = styleTile;
    // The tile is the extraction source — its presence marks the tokens as
    // extraction-backed (the studio labels the board accordingly).
    images.tokensExtracted = true;
  }
  if (mockup !== undefined) {
    images.homepageMockup = mockup;
  }
  if (boardPng !== undefined) {
    images.styleBoard = boardPng;
  }
  if (boardSvg !== undefined) {
    images.styleBoardSvg = boardSvg;
  }
  return Object.keys(images).length > 0 ? images : undefined;
}

/**
 * Reads a direction's ACTIVE extracted assets (WS-05, asset-extraction) once,
 * grouped by their `directionId` — the direction-scoping chokepoint for this
 * read surface (SC-05): filtering happens at the INDEX level (retiredAt lives
 * ONLY on `ExtractedAssetIndex`), before hydrating, so a retired or
 * sibling-direction asset is dropped without ever reading its version files. A
 * corrupt asset record is skipped with a message pushed to `errors` (never
 * throws — the dashboard degrades gracefully).
 */
async function extractedAssetsByDirection(
  artifacts: ArtifactStore,
  directionDir: string,
  label: string,
  errors: string[],
): Promise<Map<string, DashboardExtractedAsset[]>> {
  const byDirection = new Map<string, DashboardExtractedAsset[]>();
  const ids = await listAssetIds(directionDir);
  for (const assetId of ids) {
    try {
      const index = await readAssetIndex(directionDir, assetId);
      if (isExtractedAssetRetired(index)) continue;

      const asset = await readExtractedAsset(directionDir, assetId);
      const headVersion =
        asset.versions.find((v) => v.id === index.head) ??
        asset.versions[asset.versions.length - 1];
      const firstVersion = asset.versions[0];

      const pngAbs = path.join(
        directionDir,
        "extracted-assets",
        assetId,
        "versions",
        index.head,
        "asset.png",
      );
      const imagePath = await artifacts.probe(pngAbs);

      const entry: DashboardExtractedAsset = {
        id: asset.id,
        name: asset.name,
        description: headVersion.description,
        headVersionId: index.head,
        versionCount: index.versions.length,
        ...(imagePath !== undefined ? { imagePath } : {}),
        createdAt: firstVersion.createdAt,
        ...(headVersion.dryRun === true ? { dryRun: true } : {}),
        ...(headVersion.imageSkips && headVersion.imageSkips.length > 0
          ? { imageSkips: headVersion.imageSkips }
          : {}),
      };

      const list = byDirection.get(index.directionId) ?? [];
      list.push(entry);
      byDirection.set(index.directionId, list);
    } catch (e) {
      errors.push(
        `Could not load extracted asset "${assetId}" for ${label}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return byDirection;
}

/**
 * Builds the single `DashboardDirection` for one `DirectionRecord` — its own
 * `versions[]` (already ordered ascending on the record) hydrated with each
 * version's content + per-version images. Direction is the aggregate root now
 * (WS-01 `direction-aggregate-root`): there is no more "every direction under
 * a shared parent" fan-out — a record's `versions`/`head` already ARE its full
 * history. A corrupt version is skipped with an error pushed to `errors`
 * (never throws). `label` (e.g. `direction "moody"`) is woven into error
 * messages.
 */
async function buildDashboardDirection(
  artifacts: ArtifactStore,
  directionsDir: string,
  record: DirectionRecord,
  label: string,
  errors: string[],
  extractedAssets: DashboardExtractedAsset[],
): Promise<
  Pick<DashboardDirection, "id" | "head" | "isDraft" | "versions" | "extractedAssets">
> {
  const versions: DashboardVersion[] = [];
  for (const versionId of record.versions) {
    try {
      const v = await readVersion(directionsDir, record.id, versionId);
      const images = await versionImages(
        artifacts,
        directionsDir,
        record.id,
        versionId,
      );
      // Drop the version's identity/provenance projections; the dashboard
      // shape carries versionId + content + per-version images only.
      const { id, briefSnapshot: _b, contextSnapshot: _c, ...rest } = v;
      const version: DashboardVersion = { ...rest, versionId: id };
      if (images) version.images = images;
      versions.push(version);
    } catch (e) {
      errors.push(
        `Could not load version "${versionId}" for ${label}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return {
    id: record.id,
    head: record.head,
    isDraft: record.head === null,
    versions,
    extractedAssets,
  };
}

/**
 * Reads the latest scan proposal (WS-09) straight off
 * `<scanDir>/proposal.json` via the fixed `surfaceScanDir` — served verbatim
 * (candidates, `rejectedSignatures`, `refinedAt`), never filtered or
 * transformed. Absent file ⇒ `undefined` (no proposal yet, not an error); a
 * parse failure is pushed to `errors` and also yields `undefined` — the
 * dashboard never 500s over a corrupt proposal (the `global`-section
 * precedent).
 */
async function loadScanProposal(
  cwd: string,
  config: KeyartConfig,
  artifacts: ArtifactStore,
  errors: string[],
): Promise<ScanProposal | undefined> {
  try {
    const proposalPath = path.join(surfaceScanDir(cwd, config), "proposal.json");
    if (!(await artifacts.exists(proposalPath))) return undefined;
    return JSON.parse(await artifacts.readText(proposalPath)) as ScanProposal;
  } catch (e) {
    errors.push(
      `Could not load scan proposal: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

/**
 * The additive surface-manifest read (WS-08, extended by WS-09 with the scan
 * proposal). PURE resolution over the WS-03 `resolveSlots` — this function
 * NEVER writes `binding.json` and never invokes `runSurfaceBind`. Nullability
 * (WS-09): `null` iff no manifest AND no proposal exist; a proposal with no
 * manifest yet serves `{ version: 0, slots: [], proposal }` (the studio's
 * first-scan bootstrap). Any manifest-read error is pushed to `errors` and
 * yields `null` — the dashboard degrades like every other section rather than
 * 500ing over a corrupt manifest.
 */
async function loadSurfaceSection(
  cwd: string,
  config: KeyartConfig,
  artifacts: ArtifactStore,
  errors: string[],
): Promise<DashboardSurface | null> {
  const proposal = await loadScanProposal(cwd, config, artifacts, errors);
  try {
    const manifest = await createSurfaceCore(cwd, config).read();
    if (manifest === null) {
      return proposal !== undefined ? { version: 0, slots: [], proposal } : null;
    }

    const activeSlots = manifest.slots.filter((s) => !isSlotRetired(s));

    // Assemble resolveSlots' inputs exactly as runSurfaceBind does, via the
    // WS-03 input-assembly helper. When nothing is approved yet, gatherBindInputs
    // throws — the honest presentation fallback is every active slot reading as
    // a "gap" (nothing can bind without an approved direction); any OTHER error
    // is a real failure and is rethrown to the outer catch.
    let resolvedById: Map<string, ResolvedSlot> | undefined;
    try {
      const inputs = await gatherBindInputs(cwd, config);
      const resolved = resolveSlots({
        manifest: inputs.manifest,
        direction: inputs.direction,
        packManifest: inputs.packManifest,
        assets: inputs.assets,
      });
      resolvedById = new Map(resolved.map((r) => [r.slotId, r]));
    } catch (err) {
      if (
        !(err instanceof CommandError) ||
        !/nothing is approved yet/i.test(err.message)
      ) {
        throw err;
      }
    }

    const slots: DashboardSurfaceSlot[] = activeSlots.map((slot) => {
      const resolved = resolvedById?.get(slot.id);
      const last = slot.attributions[slot.attributions.length - 1];
      return {
        id: slot.id,
        kind: slot.kind,
        criticality: slot.criticality,
        origin: slot.origin,
        attributionCount: slot.attributions.length,
        ...(last !== undefined
          ? { latestAttribution: { author: last.author, date: last.date } }
          : {}),
        status: resolved?.status ?? "gap",
        ...(resolved?.value !== undefined ? { value: resolved.value } : {}),
        ...(resolved?.assetId !== undefined ? { assetId: resolved.assetId } : {}),
        ...(resolved?.file !== undefined ? { file: resolved.file } : {}),
        ...(slot.kind === "other" ? { taxonomyDemand: true } : {}),
      };
    });

    return { version: manifest.version, slots, ...(proposal !== undefined ? { proposal } : {}) };
  } catch (e) {
    errors.push(
      `Could not load surface manifest: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

export async function loadDashboardData(cwd: string): Promise<DashboardData> {
  const errors: string[] = [];
  // Every generated-artifact disk probe in this read goes through the artifact
  // store, so handles (not filesystem layout) are the wire contract.
  const artifacts = createArtifactStore(cwd);
  let projectName = "Keyart Project";
  let brandRoot = "brand";
  let config: KeyartConfig | null = null;

  try {
    config = await loadConfig(cwd);
    projectName = config.project.name;
    brandRoot = config.brand.root;
  } catch (e) {
    errors.push(`Could not load config: ${e instanceof Error ? e.message : String(e)}`);
  }

  const brandDir = path.resolve(cwd, brandRoot);

  // Directions — pure read of on-disk state (never migrates here). Each
  // direction's memory comes ONLY from memoryEntries(id) for that id — there
  // is no cross-direction merge (per-direction isolation). Direction is the
  // aggregate root: the payload is a flat top-level `directions[]` (WS-18).
  const directions: DashboardDirection[] = [];
  let global: DashboardGlobal | null = null;
  let surface: DashboardSurface | null = null;
  if (config) {
    try {
      const core = createDirectionCore(cwd, config);
      const records = await core.list(); // sorted by id
      const dRoot = directionsRoot(cwd, config);
      for (const record of records) {
        try {
          const directionDir = path.join(dRoot, record.id);
          const label = `direction "${record.id}"`;

          // Brief — the STRUCTURED record IS the source of truth; the on-disk
          // `brief.md` is a projection, so read the record and render the
          // markdown preview from the SAME deterministic projection the file uses.
          const brief: BrandBrief = record.brief;
          const renderedBrief = renderBrief(brief);

          // Extracted assets (WS-05) — grouped by directionId (always this
          // direction's own id, by construction — asset trees are
          // direction-scoped, never shared across siblings).
          const extractedAssetsMap = await extractedAssetsByDirection(
            artifacts,
            directionDir,
            label,
            errors,
          );
          const extractedAssets = extractedAssetsMap.get(record.id) ?? [];

          // Hydrate this direction's version history + extracted assets.
          const hydrated = await buildDashboardDirection(
            artifacts,
            dRoot,
            record,
            label,
            errors,
            extractedAssets,
          );

          // Memory — THIS direction's entries only. `memory` (ACTIVE, WS-05:
          // excludes retired/superseded) carries derived affordances;
          // `retiredMemory` is the reachable history bucket (no affordances —
          // a retired signal offers no further action).
          const allEntries = await core.memoryEntries(record.id, { includeRetired: true });
          const toDashboardEntry = (e: (typeof allEntries)[number]): DashboardMemoryEntry => ({
            id: e.id,
            kind: e.kind,
            body: e.body,
            author: e.author,
            source: e.source,
            date: e.date,
            ...(e.asset !== undefined ? { asset: e.asset } : {}),
            ...(e.channel !== undefined ? { channel: e.channel } : {}),
            ...(e.polarity !== undefined ? { polarity: e.polarity } : {}),
            ...(e.retiredAt !== undefined ? { retiredAt: e.retiredAt } : {}),
            ...(e.supersededBy !== undefined ? { supersededBy: e.supersededBy } : {}),
          });
          const activeEntries = allEntries.filter((e) => !isRetired(e));
          const retiredEntries = allEntries.filter((e) => isRetired(e));
          const memory: DashboardMemoryEntry[] = activeEntries.map((e) => ({
            ...toDashboardEntry(e),
            ...memoryEntryAffordances(e),
          }));
          const retiredMemory: DashboardMemoryEntry[] = retiredEntries.map(toDashboardEntry);

          // Assets — same active/retired split; a retired kept crop is never
          // an image ref and never carries a `removable` affordance.
          const toDashboardAsset = (a: (typeof record.assets)[number]): DashboardAssetRef => ({
            kind: a.kind,
            path: a.path,
            ...(a.note !== undefined ? { note: a.note } : {}),
          });
          const activeAssets = record.assets.filter((a) => !isAssetRetired(a));
          const retiredAssetsRaw = record.assets.filter((a) => isAssetRetired(a));

          directions.push({
            ...hydrated,
            name: record.name,
            status: record.status,
            brief,
            renderedBrief,
            version: record.version,
            memory,
            retiredMemory,
            // Registered asset refs — paths are already cwd-relative forward-slash
            // in the record, servable as-is via /api/asset?path=.
            assets: activeAssets.map((a) => ({
              ...toDashboardAsset(a),
              ...assetAffordances(a),
            })),
            retiredAssets: retiredAssetsRaw.map(toDashboardAsset),
          });
        } catch (e) {
          errors.push(
            `Could not load direction "${record.id}": ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      errors.push(`Could not list directions: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Global brand — brand.read() never writes, so the UI stays read-only. On
    // error, leave global: null. `approvedPointer` carries `versionId` (WS-01).
    try {
      const brand = createBrandCore(cwd, config);
      const g = await brand.read();
      const toDashboardRule = (r: GlobalRule): DashboardGlobalRule => ({
        id: r.id,
        severity: r.severity,
        text: r.text,
        author: r.author,
        source: r.source,
        date: r.date,
        ...(r.channel !== undefined ? { channel: r.channel } : {}),
        ...(r.polarity !== undefined ? { polarity: r.polarity } : {}),
      });
      const activeRules = g.rules.filter((r) => r.retiredAt === undefined);
      const retiredRules = g.rules.filter((r) => r.retiredAt !== undefined);
      global = {
        approvedPointer: g.approvedPointer,
        rules: activeRules.map((r) => ({ ...toDashboardRule(r), ...ruleAffordances(r) })),
        retiredRules: retiredRules.map(toDashboardRule),
      };
    } catch (e) {
      errors.push(`Could not read global brand: ${e instanceof Error ? e.message : String(e)}`);
      global = null;
    }

    // Surface manifest (WS-08) — additive, read-only. `null` when no manifest
    // exists (feature-off); errors degrade the same way as every other section.
    surface = await loadSurfaceSection(cwd, config, artifacts, errors);
  }

  // Approved direction (approve writes current-direction.json) — a
  // DirectionVersion & { provenance? } whose provenance carries the pinned
  // { directionId, versionId, approvedAt }.
  let approved: (DirectionVersion & { provenance?: ApprovedProvenance }) | null = null;
  const approvedPath = path.join(brandDir, "approved", "current-direction.json");
  if (await artifacts.exists(approvedPath)) {
    try {
      approved = JSON.parse(await artifacts.readText(approvedPath)) as DirectionVersion & {
        provenance?: ApprovedProvenance;
      };
    } catch (e) {
      errors.push(`Could not parse approved direction: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Guides (approve writes guides to brand/guides/)
  let visualStyle: string | null = null;
  let brandGuide: string | null = null;
  const visualPath = path.join(brandDir, "guides", "visual-style-guide.md");
  const brandGuidePath = path.join(brandDir, "guides", "brand-guide.md");
  if (await artifacts.exists(visualPath)) {
    try {
      visualStyle = await artifacts.readText(visualPath);
    } catch (e) {
      errors.push(`Could not read visual style guide: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (await artifacts.exists(brandGuidePath)) {
    try {
      brandGuide = await artifacts.readText(brandGuidePath);
    } catch (e) {
      errors.push(`Could not read brand guide: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Latest audit
  let latestAudit: DashboardData["latestAudit"] = null;
  const auditsDir = path.join(brandDir, "audits");
  const auditDirs = await artifacts.listDirs(auditsDir);
  if (auditDirs.length > 0) {
    const latestAuditId = auditDirs[auditDirs.length - 1];
    const auditDir = path.join(auditsDir, latestAuditId);
    let markdown: string | null = null;

    const auditMdPath = path.join(auditDir, "audit.md");
    if (await artifacts.exists(auditMdPath)) {
      try {
        markdown = await artifacts.readText(auditMdPath);
      } catch (e) {
        errors.push(`Could not read audit: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const screenshotPath =
      (await artifacts.probe(path.join(auditDir, "screenshot.png"))) ?? null;

    if (markdown !== null || screenshotPath !== null) {
      latestAudit = { id: latestAuditId, markdown, screenshotPath };
    }
  }

  return {
    projectName,
    directions,
    global,
    approved,
    guides: { visualStyle, brand: brandGuide },
    latestAudit,
    surface,
    errors,
  };
}

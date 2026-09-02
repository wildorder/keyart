import path from "node:path";
import { CommandError } from "../errors.js";
import { loadConfig, surfaceManifestPath, bindingOutputPath, directionsRoot } from "../config.js";
import { readTextFile, writeJsonFile } from "../fs.js";
import type { DirectionVersion, KeyartConfig, PaletteRole } from "../types.js";
import {
  isSlotRetired,
  slotById,
  type SurfaceManifest,
  type SurfaceSlot,
  type SlotKind,
  type SlotSitsOn,
} from "./schema.js";
import { createSurfaceCore } from "./store.js";
import { createBrandCore } from "../brand/core.js";
import { resolveDirection, readVersion } from "../direction/store.js";
import { runAssetPack } from "../asset/pack.js";
import { listAssetIds, readAssetIndex } from "../asset/asset-store.js";
import { isExtractedAssetRetired, type ExtractedAssetIndex } from "../asset/schema.js";
import { resolveBrandVars, type BrandVars } from "../approve/render-guides.js";
import { contrastRatio, ensureContrastAA } from "../brand/palette.js";

/**
 * The deterministic bind resolver + lockfile writer (surface-manifest WS-03).
 * `resolveSlots`/`buildGapReport` are PURE — no I/O, no clock, no randomness —
 * shared verbatim by `runSurfaceBind` here and by the WS-08 studio board read
 * (which must NEVER write). Only `gatherBindInputs`/`runSurfaceBind` touch disk.
 */

export type SlotStatus = "bound" | "derived" | "gap" | "pending";

/** One resolved slot — the shape written into binding.json AND served to the studio board. */
export interface ResolvedSlot {
  slotId: string;
  kind: SlotKind;
  status: SlotStatus;
  value?: string; // color-role: #rrggbb; type-role: the css-ready font stack
  derived?: true; // set ONLY on engine-derived color roles
  file?: string; // cwd-relative forward-slash PNG path (bound asset slots)
  svgFile?: string; // cwd-relative forward-slash SVG path (fresh vector rows only)
  assetId?: string; // bound/pending asset slots
  assetVersionId?: string; // the head version the file was packed from
}
export type BindingRow = ResolvedSlot;

export interface BindingFile {
  pointer: { directionId: string; versionId: string; approvedAt: string };
  slots: BindingRow[]; // manifest order; retired slots excluded
}

/** Tolerant view of a pack-manifest row — unknown keys ignored (vector-program-proof). */
export interface PackRowLike {
  id: string;
  headVersionId?: string;
  pending?: boolean;
  file?: string;
  svgFile?: string;
  vectorStale?: boolean;
  [key: string]: unknown;
}
export interface PackManifestLike {
  packDir: string; // cwd-relative, forward slashes (AssetPackResult.packDir)
  assets: PackRowLike[];
}

const SEMANTIC_ROLES = new Set<string>([
  "background",
  "surface",
  "text",
  "muted",
  "primary",
  "secondary",
]);

function isSemanticRole(segment: string): segment is PaletteRole {
  return SEMANTIC_ROLES.has(segment);
}

function finalSegment(slotId: string): string {
  const parts = slotId.split(".");
  return parts[parts.length - 1];
}

/** Maps a semantic/sitsOn role onto its `BrandVars` field (`muted` -> `textMuted`). */
function roleHex(role: PaletteRole | SlotSitsOn, vars: BrandVars): string {
  switch (role) {
    case "primary":
      return vars.primary;
    case "secondary":
      return vars.secondary;
    case "background":
      return vars.background;
    case "surface":
      return vars.surface;
    case "text":
      return vars.text;
    case "muted":
      return vars.textMuted;
  }
}

const HEADING_RE = /heading|display|title|h[1-6]\b/i;

function isHeadingSlot(slot: SurfaceSlot): boolean {
  return HEADING_RE.test(finalSegment(slot.id)) || HEADING_RE.test(slot.description);
}

/**
 * Deterministically derive a value for a non-semantic color-role slot: scan
 * the direction's brand primitives (prominence order) then the six semantic
 * hexes for the first one that already passes WCAG AA against the slot's
 * `sitsOn` ground; fall back to walking the most prominent candidate's
 * lightness to AA via the palette engine. NO RNG, NO clock — a pure function
 * of the direction's tokens + the slot's sitsOn.
 */
function deriveColorRole(slot: SurfaceSlot, vars: BrandVars): string {
  const sitsOnRole: SlotSitsOn = slot.context?.sitsOn ?? "background";
  const sitsOnHex = roleHex(sitsOnRole, vars);

  const ordered = [
    ...vars.brand.map((b) => b.hex),
    vars.primary,
    vars.secondary,
    vars.text,
    vars.textMuted,
    vars.surface,
    vars.background,
  ].filter((hex) => hex !== sitsOnHex);

  for (const candidate of ordered) {
    if (contrastRatio(candidate, sitsOnHex) >= 4.5) {
      return candidate;
    }
  }
  const first = ordered[0] ?? vars.primary;
  return ensureContrastAA(first, sitsOnHex);
}

function resolveColorRole(slot: SurfaceSlot, vars: BrandVars): ResolvedSlot {
  const final = finalSegment(slot.id);
  if (isSemanticRole(final)) {
    return {
      slotId: slot.id,
      kind: slot.kind,
      status: "bound",
      value: roleHex(final, vars),
    };
  }
  return {
    slotId: slot.id,
    kind: slot.kind,
    status: "derived",
    derived: true,
    value: deriveColorRole(slot, vars),
  };
}

function resolveTypeRole(slot: SurfaceSlot, vars: BrandVars): ResolvedSlot {
  return {
    slotId: slot.id,
    kind: slot.kind,
    status: "bound",
    value: isHeadingSlot(slot) ? vars.fontHeading : vars.fontBody,
  };
}

function resolveAssetSlot(
  slot: SurfaceSlot,
  activeAssets: ExtractedAssetIndex[],
  packManifest: PackManifestLike | null,
): ResolvedSlot {
  const claimants = activeAssets.filter((a) => a.slotId === slot.id);
  if (claimants.length === 0) {
    return { slotId: slot.id, kind: slot.kind, status: "gap" };
  }
  if (claimants.length > 1) {
    const names = claimants.map((c) => `"${c.id}"`).join(", ");
    throw new CommandError(
      `Slot "${slot.id}" is claimed by ${claimants.length} active assets: ${names}. ` +
        `Retire one (keyart asset remove <assetId>) or relink it, then re-run bind.`,
    );
  }

  const index = claimants[0];
  const row = packManifest?.assets.find((r) => r.id === index.id);
  if (row && row.pending !== true && row.file) {
    return {
      slotId: slot.id,
      kind: slot.kind,
      status: "bound",
      file: `${packManifest!.packDir}/${row.file}`,
      assetId: index.id,
      assetVersionId: row.headVersionId ?? index.head,
      ...(row.svgFile && row.vectorStale !== true
        ? { svgFile: `${packManifest!.packDir}/${row.svgFile}` }
        : {}),
    };
  }

  return {
    slotId: slot.id,
    kind: slot.kind,
    status: "pending",
    assetId: index.id,
    assetVersionId: index.head,
  };
}

export function resolveSlots(input: {
  manifest: SurfaceManifest;
  direction: DirectionVersion; // the approved PINNED version
  packManifest: PackManifestLike | null; // null tolerated: asset matches resolve pending
  assets: ExtractedAssetIndex[]; // the approved direction's indices (caller-scoped)
}): ResolvedSlot[] {
  const { manifest, direction, packManifest, assets } = input;
  const vars = resolveBrandVars(direction);
  const activeAssets = assets.filter((a) => !isExtractedAssetRetired(a));

  const resolved: ResolvedSlot[] = [];
  for (const slot of manifest.slots) {
    if (isSlotRetired(slot)) continue;

    switch (slot.kind) {
      case "color-role":
        resolved.push(resolveColorRole(slot, vars));
        break;
      case "type-role":
        resolved.push(resolveTypeRole(slot, vars));
        break;
      case "icon":
      case "illustration":
        resolved.push(resolveAssetSlot(slot, activeAssets, packManifest));
        break;
      case "other":
        resolved.push({ slotId: slot.id, kind: slot.kind, status: "gap" });
        break;
    }
  }
  return resolved;
}

/** One unresolved slot's demand shape — origin/criticality/attribution for the gap report. */
export interface GapRow {
  slotId: string;
  kind: SlotKind;
  criticality: "required" | "preferred";
  origin: "authored" | "scan" | "request";
  attributionCount: number;
  description: string;
  /** kind === "other" — an unclassifiable need: evidence for growing the kind enum. */
  taxonomyDemand: boolean;
}

export function buildGapReport(
  manifest: SurfaceManifest,
  resolved: ResolvedSlot[],
): GapRow[] {
  const rows: GapRow[] = [];
  for (const r of resolved) {
    if (r.status !== "gap") continue;
    const slot = slotById(manifest, r.slotId);
    if (!slot) continue;
    rows.push({
      slotId: slot.id,
      kind: slot.kind,
      criticality: slot.criticality,
      origin: slot.origin,
      attributionCount: slot.attributions.length,
      description: slot.description,
      taxonomyDemand: slot.kind === "other",
    });
  }
  return rows;
}

function relTo(cwd: string): (abs: string) => string {
  const resolved = path.resolve(cwd);
  return (abs: string): string =>
    path.relative(resolved, abs).split(path.sep).join("/");
}

/** Everything bind/fill resolution needs, loaded + guarded in one place.
 *  WRITES the asset pack (a deterministic keyless refresh) — never for the studio read. */
export async function gatherBindInputs(
  cwd: string,
  config: KeyartConfig,
): Promise<{
  manifest: SurfaceManifest;
  pointer: { directionId: string; versionId: string; approvedAt: string };
  direction: DirectionVersion;
  packManifest: PackManifestLike;
  packFilesWritten: string[];
  assets: ExtractedAssetIndex[];
}> {
  const manifest = await createSurfaceCore(cwd, config).read();
  if (manifest === null) {
    const manifestPath = relTo(cwd)(surfaceManifestPath(cwd, config));
    throw new CommandError(
      `No surface manifest found at ${manifestPath}. Author one first: run ` +
        "`keyart surface schema` for the contract, then `keyart surface set '<json>'` " +
        "— or have your coding agent submit one via MCP.",
    );
  }

  const brand = await createBrandCore(cwd, config).read();
  const pointer = brand.approvedPointer;
  if (pointer === null) {
    throw new CommandError(
      "Nothing is approved yet — bind resolves slots against the approved direction. " +
        "Run `keyart approve <directionId>` first.",
    );
  }

  const resolvedDirection = await resolveDirection(cwd, config, pointer.directionId);
  const direction = await readVersion(
    directionsRoot(cwd, config),
    pointer.directionId,
    pointer.versionId,
  );

  const packResult = await runAssetPack({
    cwd,
    directionId: pointer.directionId,
  });
  const packManifestJsonPath = path.resolve(cwd, packResult.packDir, "pack-manifest.json");
  const packManifestJson = JSON.parse(
    await readTextFile(packManifestJsonPath),
  ) as { assets: PackRowLike[] };
  const packManifest: PackManifestLike = {
    packDir: packResult.packDir,
    assets: packManifestJson.assets,
  };

  const ids = await listAssetIds(resolvedDirection.dir);
  const assets: ExtractedAssetIndex[] = [];
  for (const id of ids) {
    const index = await readAssetIndex(resolvedDirection.dir, id);
    if (index.directionId !== pointer.directionId) continue;
    assets.push(index);
  }

  return {
    manifest,
    pointer,
    direction,
    packManifest,
    packFilesWritten: packResult.filesWritten,
    assets,
  };
}

export interface SurfaceBindResult {
  directionId: string;
  versionId: string;
  bindingPath: string; // cwd-relative, forward slashes
  binding: BindingFile;
  gaps: GapRow[];
  filesWritten: string[]; // binding.json + the refreshed pack files
}

export async function runSurfaceBind(opts: { cwd: string }): Promise<SurfaceBindResult> {
  const config = await loadConfig(opts.cwd);
  const inputs = await gatherBindInputs(opts.cwd, config);

  const slots = resolveSlots({
    manifest: inputs.manifest,
    direction: inputs.direction,
    packManifest: inputs.packManifest,
    assets: inputs.assets,
  });

  const binding: BindingFile = {
    pointer: {
      directionId: inputs.pointer.directionId,
      versionId: inputs.pointer.versionId,
      approvedAt: inputs.pointer.approvedAt,
    },
    slots,
  };

  const bindingPathAbs = bindingOutputPath(opts.cwd, config);
  await writeJsonFile(bindingPathAbs, binding);
  const bindingPath = relTo(opts.cwd)(bindingPathAbs);

  const gaps = buildGapReport(inputs.manifest, slots);

  return {
    directionId: inputs.pointer.directionId,
    versionId: inputs.pointer.versionId,
    bindingPath,
    binding,
    gaps,
    filesWritten: [bindingPath, ...inputs.packFilesWritten],
  };
}

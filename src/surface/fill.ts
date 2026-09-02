import path from "node:path";
import { CommandError } from "../errors.js";
import { loadConfig } from "../config.js";
import { gatherBindInputs, resolveSlots } from "./bind.js";
import { isAssetSlot, isSlotRetired, slotById, type SurfaceSlot } from "./schema.js";
import { resolveDirection } from "../direction/store.js";
import { runAssetExtract } from "../asset/extract.js";
import { setExtractedAssetSlotId, extractedAssetsRoot } from "../asset/asset-store.js";

/**
 * Close asset-slot gaps IN-IDIOM (surface-manifest WS-04): every fill is an
 * ORDINARY `ExtractedAsset` minted through the EXISTING `runAssetExtract`
 * describe path, against the approved direction's PINNED version, with the
 * slot id stamped as provenance via `setExtractedAssetSlotId` so the very
 * next `surface bind` resolves it. Never touches `src/asset/extract.ts`,
 * `composeExtractPrompt`, `composeArtDirection`, or `generateImage` directly
 * — those are inherited wholesale from the extract pipeline.
 */

function relTo(cwd: string): (abs: string) => string {
  const resolved = path.resolve(cwd);
  return (abs: string): string =>
    path.relative(resolved, abs).split(path.sep).join("/");
}

/**
 * Translate a surface slot into the `describe` text handed to runAssetExtract
 * — the slot's description plus its context as imperative prompt intent.
 * PURE and deterministic (no I/O, no clock); the transparent-background
 * isolation directive and the art-direction MUST/PREFER/AVOID block are NOT
 * composed here — the existing extract pipeline supplies both.
 */
export function composeSlotDescribe(slot: SurfaceSlot): string {
  const lines: string[] = [slot.description, `Surface slot: ${slot.id} (${slot.kind}).`];
  const context = slot.context;

  if (context?.sizes && context.sizes.length > 0) {
    const sorted = [...context.sizes].sort((a, b) => a - b);
    lines.push(
      `Rendered at ${sorted.join("px, ")}px — keep the silhouette bold and legible at ${sorted[0]}px.`,
    );
  }
  if (context?.sitsOn) {
    lines.push(
      `It sits on the brand's "${context.sitsOn}" color — ensure the shape stays clearly visible against that role.`,
    );
  }
  if (context?.usedIn && context.usedIn.length > 0) {
    lines.push(`Used in: ${context.usedIn.join(", ")}.`);
  }
  if (context?.tone) {
    lines.push(`Tone: ${context.tone}.`);
  }
  if (context?.note) {
    lines.push(`Note: ${context.note}.`);
  }

  return lines.join("\n");
}

export interface FilledSlot {
  slotId: string;
  assetId: string;
  versionId: string;
  dryRun: boolean;
  imageSkips: string[];
}

export interface SurfaceFillResult {
  directionId: string;
  versionId: string; // the approved pinned version fills extracted against
  filled: FilledSlot[]; // manifest order
  dryRun: boolean; // true iff keyless (every filled entry is pending)
  filesWritten: string[]; // cwd-relative forward slashes
}

export async function runSurfaceFill(opts: {
  cwd: string;
  slot?: string; // fill exactly this slot id
}): Promise<SurfaceFillResult> {
  const config = await loadConfig(opts.cwd);
  const { manifest, pointer, direction, packManifest, assets } =
    await gatherBindInputs(opts.cwd, config);
  const resolvedDirection = await resolveDirection(opts.cwd, config, pointer.directionId);

  const resolved = resolveSlots({ manifest, direction, packManifest, assets });

  let targets: SurfaceSlot[];
  if (opts.slot === undefined) {
    targets = [];
    for (const slot of manifest.slots) {
      if (isSlotRetired(slot)) continue;
      if (!isAssetSlot(slot)) continue;
      const row = resolved.find((r) => r.slotId === slot.id);
      if (row?.status === "gap") targets.push(slot);
    }
  } else {
    const slot = slotById(manifest, opts.slot);
    if (!slot || isSlotRetired(slot)) {
      throw new CommandError(
        `Unknown or retired slot "${opts.slot}". Check \`keyart surface show\`.`,
      );
    }
    if (slot.kind === "color-role" || slot.kind === "type-role") {
      throw new CommandError(
        `Slot "${slot.id}" is a ${slot.kind} — color and type roles are derived deterministically by \`surface bind\` from the approved direction's tokens and are never generated. Run \`keyart surface bind\`.`,
      );
    }
    if (slot.kind === "other") {
      throw new CommandError(
        `Slot "${slot.id}" is kind "other" — it has no generation rule (taxonomy demand). Reclassify the slot via \`surface patch\` first.`,
      );
    }
    const row = resolved.find((r) => r.slotId === slot.id);
    if (row !== undefined && (row.status === "bound" || row.status === "pending")) {
      throw new CommandError(
        `Slot "${slot.id}" is already ${row.status} to asset "${row.assetId}". Iterate it with \`keyart asset regenerate ${row.assetId} --tweak "…"\` or retire it first with \`keyart asset remove ${row.assetId}\`, then re-run fill.`,
      );
    }
    targets = [slot];
  }

  const rel = relTo(opts.cwd);
  const filled: FilledSlot[] = [];
  const filesWritten: string[] = [];

  for (const slot of targets) {
    const extract = await runAssetExtract({
      cwd: opts.cwd,
      directionId: pointer.directionId,
      versionId: pointer.versionId,
      describe: composeSlotDescribe(slot),
      name: slot.id,
    });
    await setExtractedAssetSlotId(resolvedDirection.dir, extract.assetId, slot.id);

    filled.push({
      slotId: slot.id,
      assetId: extract.assetId,
      versionId: extract.versionId,
      dryRun: extract.dryRun,
      imageSkips: extract.imageSkips,
    });
    filesWritten.push(
      ...extract.filesWritten,
      rel(path.join(extractedAssetsRoot(resolvedDirection.dir), extract.assetId, "asset.json")),
    );
  }

  return {
    directionId: pointer.directionId,
    versionId: pointer.versionId,
    filled,
    dryRun: filled.length === 0 ? true : filled.every((f) => f.dryRun),
    filesWritten,
  };
}

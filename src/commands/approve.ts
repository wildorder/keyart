import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig, globalBrandPath } from "../config.js";
import {
  writeJsonFile,
  writeTextFile,
  copyFileSafe,
  pathExists,
  ensureDir,
  writeWithConfirm,
} from "../fs.js";
import type { DirectionVersion } from "../types.js";
import { CommandError } from "../errors.js";
import { directionsRoot } from "../config.js";
import { resolveDirection, readHead, readVersion } from "../direction/store.js";
import { assertDirectionHasVersions } from "../direction/draft-guard.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import {
  renderVisualStyleGuide,
  renderBrandGuide,
  renderCursorRules,
  renderImagePrompts,
  renderImplementationBrief,
  renderBrandCss,
  type SourceStamp,
  type GuideSurface,
} from "../approve/render-guides.js";
import {
  renderStyleBoardMarkdown,
  renderStyleBoardSvg,
} from "../approve/render-style-board.js";
import { runAssetPack } from "../asset/pack.js";
import { createSurfaceCore } from "../surface/store.js";
import { runSurfaceBind, type GapRow } from "../surface/bind.js";
import { slotById } from "../surface/schema.js";

/**
 * Provenance stamped onto `brand/approved/current-direction.json` by `approve`,
 * and read back by the serve UI read model. Mirrors `ApprovedPointer`
 * (`src/brand/schema.ts`) — the two-field pointer plus its timestamp.
 */
export interface ApprovedProvenance {
  directionId: string; // required to project/repoint and detect drift
  versionId: string; // the pinned version this approval shipped
  approvedAt: string; // ISO 8601
}

export type ApprovedDirectionFile = DirectionVersion & {
  provenance?: ApprovedProvenance;
};

export interface ApproveResult {
  directionId: string;
  directionName: string;
  filesWritten: string[]; // cwd-relative, forward slashes
  /** The approve-codified asset pack (always written — with no extracted
   * assets it still ships tokens.json + contact sheet + manifest). */
  assetPack: { assetsIncluded: string[]; assetsPending: string[] };
  /** Present ONLY when a surface manifest exists (surface-manifest WS-07):
   * the codify-refreshed binding + its status counts. Absent = feature off —
   * the serialized no-manifest result is byte-identical to today's. */
  surface?: {
    bindingPath: string; // cwd-relative, forward slashes
    counts: { bound: number; derived: number; gap: number; pending: number };
  };
}

/** One "Surface gaps:" report line — taxonomy demand for `kind: "other"`,
 *  else kind + origin (+ request count when origin is a request with
 *  attributions). Mirrors the guide's open-gaps bullet wording. */
function formatGapLine(gap: GapRow): string {
  if (gap.taxonomyDemand) {
    return `- ${gap.slotId} — other (taxonomy demand): "${gap.description}"`;
  }
  const requested =
    gap.origin === "request" && gap.attributionCount > 0
      ? `, requested ${gap.attributionCount}×`
      : "";
  return `- ${gap.slotId} — ${gap.kind}, origin: ${gap.origin}${requested}`;
}

/**
 * Approve a direction — pins the current (or a specific) VERSION and codifies the
 * brand from it. The approved pointer becomes `{ directionId, versionId,
 * approvedAt }`; `versionId` defaults to the direction's head at approve time.
 */
export async function runApprove(opts: {
  cwd: string;
  directionId: string;
  /** Defaults to the direction's head at approve time. */
  versionId?: string;
  force?: boolean;
}): Promise<ApproveResult> {
  const config = await loadConfig(opts.cwd);
  const cwd = path.resolve(opts.cwd);
  const brandRoot = path.resolve(opts.cwd, config.brand.root);
  const filesWritten: string[] = [];
  const rel = (abs: string): string =>
    path.relative(cwd, abs).split(path.sep).join("/");
  const root = directionsRoot(opts.cwd, config);

  // Resolve the direction — an unknown id throws CommandError listing available ids.
  const resolvedDirection = await resolveDirection(opts.cwd, config, opts.directionId);

  // Resolve the pinned version: default to the direction's head at approve time.
  let direction: DirectionVersion;
  let versionId: string;
  if (opts.versionId !== undefined) {
    versionId = opts.versionId;
    try {
      direction = await readVersion(root, opts.directionId, versionId);
    } catch {
      throw new CommandError(
        `Version not found: ${opts.directionId}@${versionId}. ` +
          `Available versions: ${resolvedDirection.record.versions.join(", ")}`,
      );
    }
  } else {
    // A draft has no head to approve — the shared guard teaches the fix.
    assertDirectionHasVersions(
      opts.directionId,
      resolvedDirection.record.head,
    );
    direction = await readHead(root, opts.directionId);
    versionId = direction.id;
  }

  const versionDir = path.join(
    root,
    opts.directionId,
    "versions",
    versionId,
  );

  // Single approvedAt reused by the approved-file provenance + the codify stamp.
  const approvedAt = new Date().toISOString();

  // Step 1: Write approved direction with version-pinned provenance.
  const approvedDir = path.resolve(opts.cwd, config.brand.approved);
  await ensureDir(approvedDir);
  const currentDirectionPath = path.join(approvedDir, "current-direction.json");
  const approvedFile: ApprovedDirectionFile = {
    ...direction,
    provenance: {
      directionId: opts.directionId,
      versionId,
      approvedAt,
    },
  };
  await writeJsonFile(currentDirectionPath, approvedFile);
  filesWritten.push(rel(currentDirectionPath));
  console.log(`  ✓ brand/approved/current-direction.json`);

  // Step 2: Copy prompts and images from the pinned version folder.
  const filesToCopy = ["style-tile-prompt.md", "homepage-mockup-prompt.md"];
  for (const file of filesToCopy) {
    const src = path.join(versionDir, file);
    if (await pathExists(src)) {
      const dest = path.join(approvedDir, file);
      await copyFileSafe(src, dest);
      filesWritten.push(rel(dest));
      console.log(`  ✓ brand/approved/${file}`);
    }
  }

  // Copy any .png files from the version folder.
  try {
    const entries = await fs.readdir(versionDir);
    for (const entry of entries) {
      if (entry.endsWith(".png")) {
        const dest = path.join(approvedDir, entry);
        await copyFileSafe(path.join(versionDir, entry), dest);
        filesWritten.push(rel(dest));
        console.log(`  ✓ brand/approved/${entry}`);
      }
    }
  } catch {
    // No directory or no files — fine
  }

  // Step 3: Set the global approved pointer (the rebrand switch). `setPointer`
  // preserves `rules`, so repointing to another direction/version fully
  // rebrands while global rules persist.
  const brand = createBrandCore(opts.cwd, config);
  await brand.setPointer(
    { directionId: opts.directionId, versionId },
    { force: opts.force },
  );
  const global = await brand.read();
  filesWritten.push(rel(globalBrandPath(cwd, config)));
  console.log(`  ✓ brand/brand.yaml (approved pointer → direction "${opts.directionId}")`);

  // Step 4: Refresh the asset pack as part of the codify — the grab-and-go
  // bundle stays in lockstep with the approved brand. The pointer was set in
  // Step 3, so the pack pins the just-approved version's tokens (tokens.json
  // byte-identical to brand.css). Keyless + deterministic; with no extracted
  // assets it still ships tokens.json + contact sheet + manifest. Runs BEFORE
  // the guides so the brief/cursor rules can list the shipped assets.
  const pack = await runAssetPack({
    cwd: opts.cwd,
    directionId: opts.directionId,
  });
  filesWritten.push(...pack.filesWritten);
  const pendingNote =
    pack.assetsPending.length > 0
      ? `, ${pack.assetsPending.length} pending`
      : "";
  console.log(
    `  ✓ ${pack.packDir}/ ` +
      `(${pack.assetsIncluded.length} asset${
        pack.assetsIncluded.length === 1 ? "" : "s"
      }${pendingNote})`,
  );

  // Step 5: Bind the surface manifest — AFTER the pack refresh so the binding
  // pins the just-approved version's pack, BEFORE the guides so the brief/
  // cursor rules can carry the bindings table + request protocol. Keyless +
  // deterministic. No manifest ⇒ this entire step is skipped and approve is
  // byte-identical to a pre-surface approve (SC-08). Approve only binds and
  // reports — fill stays an explicit, key-gated verb (never called here).
  const surfaceManifest = await createSurfaceCore(opts.cwd, config).read();
  let guideSurface: GuideSurface | undefined;
  let surfaceResult: ApproveResult["surface"];
  if (surfaceManifest !== null) {
    const bind = await runSurfaceBind({ cwd: opts.cwd });
    filesWritten.push(bind.bindingPath);

    const counts = { bound: 0, derived: 0, gap: 0, pending: 0 };
    for (const row of bind.binding.slots) counts[row.status] += 1;

    guideSurface = {
      bindingPath: bind.bindingPath,
      rows: bind.binding.slots.map((row) => {
        const slot = slotById(surfaceManifest, row.slotId)!;
        return {
          id: row.slotId,
          kind: row.kind,
          status: row.status,
          ...(row.value !== undefined ? { value: row.value } : {}),
          ...(row.file !== undefined ? { file: row.file } : {}),
          ...(row.svgFile !== undefined ? { svgFile: row.svgFile } : {}),
          origin: slot.origin,
          attributionCount: slot.attributions.length,
          ...(slot.kind === "other" && slot.context?.note
            ? { note: slot.context.note }
            : {}),
        };
      }),
    };

    console.log(
      `  ✓ ${bind.bindingPath} (${counts.bound} bound, ${counts.derived} derived, ` +
        `${counts.gap} gap${counts.gap === 1 ? "" : "s"}, ${counts.pending} pending)`,
    );
    if (bind.gaps.length > 0) {
      console.log(
        ["Surface gaps:", ...bind.gaps.map((g) => `  ${formatGapLine(g)}`)].join(
          "\n",
        ),
      );
    }

    surfaceResult = { bindingPath: bind.bindingPath, counts };
  }

  // Step 6: Codify as a pure projection of the pinned version — each artifact
  // stamped with source provenance + injected with the global HARD rules.
  const stamp: SourceStamp = {
    directionId: opts.directionId,
    versionId,
    approvedAt,
  };
  const hardRules = global.rules.filter((r) => r.severity === "hard");
  const assetPack = { packDir: pack.packDir, items: pack.assets };

  const guidesDir = path.join(brandRoot, "guides");
  await ensureDir(guidesDir);

  const visualGuide = renderVisualStyleGuide(direction, { stamp, hardRules });
  const brandGuide = renderBrandGuide(direction, { stamp, hardRules });

  const visualGuidePath = path.join(guidesDir, "visual-style-guide.md");
  const wroteVisual = await writeWithConfirm(visualGuidePath, visualGuide, {
    force: opts.force,
  });
  if (wroteVisual) {
    filesWritten.push(rel(visualGuidePath));
    console.log(`  ✓ brand/guides/visual-style-guide.md`);
  }

  const brandGuidePath = path.join(guidesDir, "brand-guide.md");
  const wroteBrand = await writeWithConfirm(brandGuidePath, brandGuide, {
    force: opts.force,
  });
  if (wroteBrand) {
    filesWritten.push(rel(brandGuidePath));
    console.log(`  ✓ brand/guides/brand-guide.md`);
  }

  // Generated artifacts
  const generatedDir = path.join(brandRoot, "generated");
  await ensureDir(generatedDir);

  // Image prompts (no stamp/hard-rules — verbatim model prompts)
  const imagePrompts = renderImagePrompts(direction);
  const imagePromptsPath = path.join(generatedDir, "image-prompts.md");
  await writeTextFile(imagePromptsPath, imagePrompts);
  filesWritten.push(rel(imagePromptsPath));
  console.log(`  ✓ brand/generated/image-prompts.md`);

  // Implementation brief
  const implBrief = renderImplementationBrief(direction, config.project, {
    stamp,
    hardRules,
    assetPack,
    ...(guideSurface ? { surface: guideSurface } : {}),
  });
  const implBriefPath = path.resolve(opts.cwd, config.outputs.implementationBrief);
  await writeTextFile(implBriefPath, implBrief);
  filesWritten.push(rel(implBriefPath));
  console.log(`  ✓ ${config.outputs.implementationBrief}`);

  // CSS vars
  const cssVars = renderBrandCss(direction, stamp);
  const cssPath = path.resolve(opts.cwd, config.outputs.cssVars);
  await writeTextFile(cssPath, cssVars);
  filesWritten.push(rel(cssPath));
  console.log(`  ✓ ${config.outputs.cssVars}`);

  // Deterministic palette + type-specimen board (the "exact" token-artifact
  // tier — NO model call, identical in dry-run). A strict projection of the same
  // `resolveBrandVars` that produced brand.css.
  const styleBoardMd = renderStyleBoardMarkdown(direction, stamp);
  const styleBoardMdPath = path.join(guidesDir, "style-board.md");
  await writeTextFile(styleBoardMdPath, styleBoardMd);
  filesWritten.push(rel(styleBoardMdPath));
  console.log(`  ✓ brand/guides/style-board.md`);

  const styleBoardSvg = renderStyleBoardSvg(direction);
  const styleBoardSvgPath = path.join(guidesDir, "style-board.svg");
  await writeTextFile(styleBoardSvgPath, styleBoardSvg);
  filesWritten.push(rel(styleBoardSvgPath));
  console.log(`  ✓ brand/guides/style-board.svg`);

  // Cursor rules — write to config path
  const cursorRules = renderCursorRules(direction, config.project, {
    stamp,
    hardRules,
    assetPack,
    ...(guideSurface ? { surface: guideSurface } : {}),
  });
  const cursorRulesPath = path.resolve(opts.cwd, config.outputs.cursorRules);
  await writeTextFile(cursorRulesPath, cursorRules);
  filesWritten.push(rel(cursorRulesPath));
  console.log(`  ✓ ${config.outputs.cursorRules}`);

  // Also write duplicate to brand/generated/cursor-brand.mdc
  const cursorDupPath = path.join(generatedDir, "cursor-brand.mdc");
  await writeTextFile(cursorDupPath, cursorRules);
  filesWritten.push(rel(cursorDupPath));
  console.log(`  ✓ brand/generated/cursor-brand.mdc`);

  // Step 7: Transition the direction to approved — only after all artifacts
  // succeeded. Approving is legal from ANY status (revive-by-approval).
  const directionCore = createDirectionCore(opts.cwd, config);
  await directionCore.transition(opts.directionId, "approve", { force: opts.force });
  filesWritten.push(rel(path.join(resolvedDirection.dir, "direction.yaml")));
  console.log(`Direction "${opts.directionId}" marked approved.`);

  console.log(
    `\nApproved direction "${direction.name}" (${opts.directionId}@${versionId}).`,
  );

  return {
    directionId: opts.directionId,
    directionName: direction.name,
    filesWritten,
    assetPack: {
      assetsIncluded: pack.assetsIncluded,
      assetsPending: pack.assetsPending,
    },
    ...(surfaceResult ? { surface: surfaceResult } : {}),
  };
}

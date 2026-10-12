import { loadConfig } from "../config.js";
import { resolveDirection } from "../direction/store.js";
import { assertFoundationId, resolveFoundation } from "../direction/foundation.js";
import { readAssetIndex, readAssetVersion } from "../asset/asset-store.js";
import { readBoardBatch, readBoardRevision } from "../board/board-store.js";
import { captureBoardUpdate, resolveBoardRevisionInputs } from "../board/operations.js";
import { CommandError } from "../errors.js";
import { AssetFoundationRequiredError } from "../asset/foundation-required.js";
import type { ChatContext } from "./model.js";

const GENERATION = new Set(["board_create", "board_revise", "board_update", "asset_generate", "asset_extract", "asset_revise", "asset_regenerate", "direction_revise", "regenerate"]);
const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

/** Read-only target resolution. The resulting arguments become the exact approved tokens. */
export async function pinGenerationArguments(cwd: string, toolName: string, input: Record<string, unknown>, focus: ChatContext): Promise<Record<string, unknown>> {
  if (focus.attachment) {
    const attachment = focus.attachment;
    const requestedDirection = string(input.direction) ?? string(input.directionId) ?? string(input.id) ?? focus.directionId;
    if (["asset_extract", "direction_feedback", "direction_revise", "regenerate"].includes(toolName)) {
      if (requestedDirection !== attachment.source.directionId) throw new CommandError("The attached crop belongs to another direction. Remove it or select its owning direction.");
      if (toolName === "direction_feedback") return { ...input, asset: attachment.path, channel: "visual" };
      if (toolName === "direction_revise" || toolName === "regenerate") input = { ...input, reference: attachment.path, version: attachment.source.versionId };
      if (toolName === "asset_extract") {
        input = { ...input, crop: attachment.path, version: attachment.source.versionId };
        if (attachment.source.kind === "board") {
          delete input.image;
          input.board = attachment.source.boardId; input.revision = attachment.source.revisionId;
        } else {
          delete input.board; delete input.revision;
          input.image = "styleTile";
        }
      }
    }
  }
  if (toolName === "direction_delete_version") {
    const directionId = string(input.id) ?? focus.directionId;
    const versionId = string(input.version);
    if (!versionId) throw new CommandError("Select the exact foundation version to delete.");
    const config = await loadConfig(cwd);
    await resolveFoundation({ cwd, config, directionId, versionId });
    const direction = await resolveDirection(cwd, config, directionId);
    return { ...input, id: directionId, version: versionId, "expected-version": direction.record.version, yes: true };
  }
  if (!GENERATION.has(toolName)) return input;
  const out = { ...input };
  const directionId = string(input.direction) ?? string(input.directionId) ?? string(input.id) ?? focus.directionId;
  assertFoundationId(directionId, "direction");
  const config = await loadConfig(cwd);
  const direction = await resolveDirection(cwd, config, directionId);
  const sameDirection = directionId === focus.directionId;
  const focusedVersion = sameDirection ? focus.versionId : undefined;
  if (toolName.startsWith("board_") || toolName.startsWith("asset_")) out.direction = directionId;

  if (toolName === "board_revise") {
    const boardId = string(input.boardId) ?? (sameDirection ? focus.boardId : undefined);
    if (!boardId) throw new CommandError("Select a Board to revise.");
    const revisionId = string(input.revision) ?? (sameDirection && boardId === focus.boardId ? focus.revisionId : undefined);
    const expected = input["instruction-version"];
    const pinned = await resolveBoardRevisionInputs({ cwd, directionId, boardId,
      versionId: string(input.version), revisionId: revisionId === "none" ? null : revisionId,
      expectedInstructionVersion: expected === undefined ? undefined : Number(expected) });
    return { ...out, boardId, version: pinned.versionId, revision: pinned.revisionId ?? "none",
      "instruction-version": pinned.expectedInstructionVersion, boardName: pinned.name };
  }
  if (toolName === "board_update") {
    if (string(input.resume)) {
      const batch = await readBoardBatch(direction.dir, string(input.resume)!);
      delete out.version; delete out.board; delete out.captured;
      return { ...out, targetFoundation: batch.foundation.versionId, boardNames: batch.entries.map((entry) => entry.name), assetsExcluded: true };
    }
    const versionId = string(input.version) ?? focusedVersion;
    const captured = await captureBoardUpdate({ cwd, directionId, versionId, boardId: string(input.board) });
    return { ...out, version: captured.versionId, captured: JSON.stringify(captured.entries),
      boardNames: captured.entries.map((entry) => entry.name), assetsExcluded: true };
  }
  if (toolName === "asset_revise" || toolName === "asset_regenerate") {
    const assetId = string(input.assetId);
    if (!assetId) throw new CommandError("Select an asset to revise.");
    const index = await readAssetIndex(direction.dir, assetId);
    const revision = string(input.revision) ?? (index.head || index.versions.at(-1));
    if (!revision || !index.versions.includes(revision)) throw new CommandError("Select an existing asset revision.");
    const source = await readAssetVersion(direction.dir, assetId, revision);
    if (source.foundation.directionId !== directionId) throw new CommandError("Asset revision belongs to another direction.");
    const versionId = string(input.version) ?? source.foundation.versionId;
    try {
      await resolveFoundation({ cwd, config, directionId, versionId });
    } catch (error) {
      if (!string(input.version) && (!direction.record.versions.includes(versionId) || (error as NodeJS.ErrnoException).code === "ENOENT")) {
        throw new AssetFoundationRequiredError(directionId, assetId, revision, versionId, direction.record.versions);
      }
      throw error;
    }
    return { ...out, revision, version: versionId, targetFoundation: versionId };
  }
  if (toolName === "asset_extract") {
    const board = string(input.board) ?? (!input.image && sameDirection ? focus.boardId : undefined);
    if (board) {
      const revision = string(input.revision) ?? (sameDirection && board === focus.boardId ? focus.revisionId : undefined);
      if (!revision) throw new CommandError("Select the exact Board revision to extract from.");
      const source = await readBoardRevision(direction.dir, board, revision);
      if (input.version && input.version !== source.foundation.versionId) throw new CommandError("Extraction foundation must match its Board revision.");
      await resolveFoundation({ cwd, config, ...source.foundation });
      return { ...out, board, revision, version: source.foundation.versionId };
    }
  }
  const revisesDirection = toolName === "direction_revise" || toolName === "regenerate";
  const versionId = string(input.version) ?? focusedVersion ?? (revisesDirection ? direction.record.head ?? undefined : undefined);
  if (!versionId) throw new CommandError("Select an explicit foundation version. Drafts need Generate v1 first.");
  await resolveFoundation({ cwd, config, directionId, versionId });
  return { ...out, version: versionId };
}

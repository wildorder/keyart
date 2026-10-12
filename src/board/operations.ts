import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, directionsRoot } from "../config.js";
import { loadEnvFiles } from "../env.js";
import { generateImage, hasApiKey } from "../openai.js";
import { CommandError } from "../errors.js";
import { resolveDirection } from "../direction/store.js";
import { resolveFoundation, assertFoundationId, assertFoundationPath } from "../direction/foundation.js";
import { assembleDerivedContext } from "../direction/derived-context.js";
import { atomicWriteJson, atomicWriteText } from "../store/file-lock.js";
import { pathExists } from "../fs.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { createBoard, listBoards, listBoardRevisions, readBoardIndex, readBoardRevision,
  resolveBoardImage, selectBoardRevision, reserveBoardRevision, finishBoardRevision,
  boardRevisionDir, retireBoard, readBoardBatch, writeBoardBatch, reconcileBoardIndex } from "./board-store.js";
import { BoardBatchEntrySchema, isBoardRetired, type BoardRevision, type BoardStatus, type BoardBatch, type BoardBatchEntry } from "./schema.js";

export interface BoardCreateOptions { cwd: string; directionId: string; versionId: string; name: string; describe: string }
export interface BoardReviseOptions {
  cwd: string; directionId: string; boardId: string; versionId?: string;
  /** undefined chooses completed head; null explicitly pins no source. */
  revisionId?: string | null; tweak?: string; expectedInstructionVersion?: number;
  /** Internal captured batch identity, used to reconcile an interrupted result. */
  operationId?: string;
}
export interface BoardResult {
  boardId: string; revisionId: string; foundation: BoardRevision["foundation"];
  status: BoardStatus; dryRun: boolean; filesWritten: string[]; imageSkips: string[]; error?: string;
}
export interface PinnedBoardRevision {
  boardId: string; directionId: string; versionId: string; revisionId: string | null;
  expectedInstructionVersion: number; instructions: string; name: string;
}
async function loadDirection(cwd: string, directionId: string) {
  assertFoundationId(directionId, "direction");
  const config = await loadConfig(cwd);
  const direction = await resolveDirection(cwd, config, directionId);
  await assertFoundationPath(directionsRoot(cwd, config), direction.dir);
  return { config, direction };
}

/** Read-only preparation for UI/chat confirmation. Replay these exact inputs on approval. */
export async function resolveBoardRevisionInputs(opts: BoardReviseOptions): Promise<PinnedBoardRevision> {
  const { config, direction } = await loadDirection(opts.cwd, opts.directionId);
  const board = await readBoardIndex(direction.dir, opts.boardId);
  if (isBoardRetired(board)) throw new CommandError(`Board ${board.id} is retired; it cannot be revised.`);
  if (opts.expectedInstructionVersion !== undefined && opts.expectedInstructionVersion !== board.instructionVersion) {
    throw new VersionConflictError(`Board ${board.id} instructions`, opts.expectedInstructionVersion, board.instructionVersion);
  }
  const versionId = opts.versionId ?? direction.record.head;
  if (!versionId) throw new CommandError("This direction is a draft. Generate v1 before creating or revising a Board.");
  await resolveFoundation({ cwd: opts.cwd, config, directionId: opts.directionId, versionId });
  const revisionId = opts.revisionId === undefined
    ? selectBoardRevision(await listBoardRevisions(direction.dir, board.id))?.id ?? null
    : opts.revisionId;
  if (revisionId) await readBoardRevision(direction.dir, board.id, revisionId);
  return { boardId: board.id, name: board.name, directionId: direction.id, versionId, revisionId,
    expectedInstructionVersion: board.instructionVersion, instructions: board.instructions };
}

function resultOf(cwd: string, directionDir: string, revision: BoardRevision, dryRun: boolean): BoardResult {
  return { boardId: revision.boardId, revisionId: revision.id, foundation: revision.foundation,
    status: revision.status, dryRun, filesWritten: [...Object.values(revision.files),
      path.relative(directionDir, path.join(boardRevisionDir(directionDir, revision.boardId, revision.id), "board-revision.json"))]
      .map((f) => path.relative(cwd, path.join(directionDir, f)).split(path.sep).join("/")),
    imageSkips: revision.error ? [revision.error] : [], ...(revision.error ? { error: revision.error } : {}) };
}

export async function runBoardCreate(opts: BoardCreateOptions): Promise<BoardResult> {
  loadEnvFiles(opts.cwd);
  const { config, direction } = await loadDirection(opts.cwd, opts.directionId);
  const foundation = await resolveFoundation({ cwd: opts.cwd, config, directionId: opts.directionId, versionId: opts.versionId });
  // Validate local intent before reserving an identity; rejected requests do not leave empty Boards.
  await assembleDerivedContext({ cwd: opts.cwd, config, foundation, localIntent: opts.describe });
  const board = await createBoard(direction.dir, { directionId: opts.directionId, name: opts.name, instructions: opts.describe });
  return runBoardRevise({ cwd: opts.cwd, directionId: opts.directionId, boardId: board.id,
    versionId: opts.versionId, revisionId: null, expectedInstructionVersion: board.instructionVersion });
}

export async function runBoardRevise(opts: BoardReviseOptions): Promise<BoardResult> {
  loadEnvFiles(opts.cwd);
  const { config, direction } = await loadDirection(opts.cwd, opts.directionId);
  if (opts.operationId) {
    const success = (await listBoardRevisions(direction.dir, opts.boardId)).find((r) => r.operationId === opts.operationId && r.status === "completed");
    if (success) {
      if (success.foundation.versionId !== opts.versionId || success.sourceRevisionId !== opts.revisionId) {
        throw new CommandError("The captured update operation belongs to different revision inputs.");
      }
      if (!(await resolveBoardImage(direction.dir, opts.boardId, success.id)).imagePath) throw new CommandError("The completed update is missing its Board image; restore the artifact before resuming.");
      await reconcileBoardIndex(direction.dir, opts.boardId);
      return resultOf(opts.cwd, direction.dir, success, false);
    }
  }
  const pinned = await resolveBoardRevisionInputs(opts);
  const foundation = await resolveFoundation({ cwd: opts.cwd, config, directionId: pinned.directionId, versionId: pinned.versionId });
  const instructions = opts.tweak?.trim() ? `${pinned.instructions}\n\n${opts.tweak.trim()}` : pinned.instructions;
  const context = await assembleDerivedContext({ cwd: opts.cwd, config, foundation, localIntent: instructions });
  const source = pinned.revisionId ? await resolveBoardImage(direction.dir, pinned.boardId, pinned.revisionId) : null;
  const revision = await reserveBoardRevision(direction.dir, { boardId: pinned.boardId,
    foundation: { directionId: pinned.directionId, versionId: pinned.versionId }, sourceRevisionId: pinned.revisionId,
    expectedInstructionVersion: pinned.expectedInstructionVersion, tweak: opts.tweak, operationId: opts.operationId });
  if (revision.status === "completed") return resultOf(opts.cwd, direction.dir, revision, false);
  const dir = boardRevisionDir(direction.dir, revision.boardId, revision.id);
  const image = path.join(dir, "board.png");
  const dryRun = !hasApiKey();
  const prompt = ["Create an exploratory Board: a composed visual study, not an editable production template.",
    `Board: ${pinned.name}`, `Durable local brief and instructions:\n${revision.instructions}`,
    context.foundationPrompt,
    "The first reference is the selected foundation tile and governs brand identity. A second reference, when present, is only previous Board composition guidance; never use it to redefine the foundation.",
    "Local instructions control this Board's content and composition only. Preserve the foundation's palette and typography; changes to brand facts require revising the direction.",
    context.artDirection].filter(Boolean).join("\n\n") + "\n";
  let outcome: BoardRevision;
  try {
    await atomicWriteText(path.join(dir, "board-prompt.md"), prompt);
    await atomicWriteJson(path.join(dir, "context-snapshot.json"), { foundation: revision.foundation,
      sourceRevisionId: revision.sourceRevisionId, instructions: revision.instructions, instructionVersion: revision.instructionVersion,
      foundationPrompt: context.foundationPrompt, artDirection: context.artDirection, context: context.snapshot });
    const { runningPid: _pid, ...settled } = revision;
    if (dryRun || !foundation.imageReady) {
      outcome = { ...settled, status: "pending", error: dryRun
        ? "No API key: saved Board prompt; render is pending."
        : "The selected foundation has no tile: saved Board prompt; render is pending." };
    } else {
      const rendered = await generateImage({ model: config.models.image, prompt, outPath: image,
        referenceImagePaths: [foundation.tilePath!, ...(source?.imagePath ? [source.imagePath] : [])] });
      const completed = rendered.written && await pathExists(image);
      outcome = { ...settled, status: completed ? "completed" : rendered.dryRun ? "pending" : "failed",
        files: { ...revision.files, ...(completed ? { image: path.relative(direction.dir, image).split(path.sep).join("/") } : {}) },
        ...(!completed ? { error: rendered.skippedReason ?? "The image service did not produce a Board render." } : {}) };
    }
  } catch (error) {
    const { runningPid: _pid, ...settled } = revision;
    outcome = { ...settled, status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  await finishBoardRevision(direction.dir, outcome);
  return resultOf(opts.cwd, direction.dir, outcome, dryRun);
}

export interface BoardUpdateOptions {
  cwd: string; directionId: string; versionId?: string; boardId?: string; resume?: string;
  /** Captured by the read-only confirmation preparer; validated again before each attempt. */
  captured?: BoardBatchEntry[];
}
export interface BoardUpdateResult {
  batchId: string; foundation: BoardBatch["foundation"]; entries: BoardBatchEntry[]; status: "completed" | "partial";
}
export async function captureBoardUpdate(opts: Omit<BoardUpdateOptions, "resume" | "captured">): Promise<{ versionId: string; entries: BoardBatchEntry[] }> {
  const { config, direction } = await loadDirection(opts.cwd, opts.directionId);
  if (!opts.versionId) throw new CommandError("Update boards requires an explicit foundation --version (or --resume for an existing batch).");
  await resolveFoundation({ cwd: opts.cwd, config, directionId: opts.directionId, versionId: opts.versionId });
  const boards = opts.boardId ? [await readBoardIndex(direction.dir, opts.boardId)] : await listBoards(direction.dir);
  if (boards.some(isBoardRetired)) throw new CommandError("Retired Boards cannot be updated.");
  if (boards.length > 250) throw new CommandError(`This update contains ${boards.length} Boards; select one with --board. A captured batch supports at most 250.`);
  const entries: BoardBatchEntry[] = [];
  for (const board of boards) {
    entries.push({ boardId: board.id, name: board.name,
      sourceRevisionId: selectBoardRevision(await listBoardRevisions(direction.dir, board.id))?.id ?? null,
      instructions: board.instructions, instructionVersion: board.instructionVersion,
      operationId: `update-${randomUUID()}`, status: "pending" });
  }
  return { versionId: opts.versionId, entries };
}
export async function runBoardUpdate(opts: BoardUpdateOptions): Promise<BoardUpdateResult> {
  const { config, direction } = await loadDirection(opts.cwd, opts.directionId);
  let batch: BoardBatch;
  if (opts.resume) {
    if (opts.versionId || opts.boardId || opts.captured) throw new CommandError("Resume uses the captured Board set and foundation. Omit --version and --board.");
    batch = await readBoardBatch(direction.dir, opts.resume);
    await resolveFoundation({ cwd: opts.cwd, config, ...batch.foundation });
  } else {
    if (!opts.versionId) throw new CommandError("Update boards requires an explicit foundation --version.");
    await resolveFoundation({ cwd: opts.cwd, config, directionId: opts.directionId, versionId: opts.versionId });
    const captured = (opts.captured ?? (await captureBoardUpdate(opts)).entries).map((input) => {
      const entry = BoardBatchEntrySchema.parse(input);
      if (entry.status !== "pending" || entry.revisionId || entry.error) throw new CommandError("A new update needs an unexecuted capture. Use --resume to continue an existing batch.");
      return { ...entry, operationId: `update-${randomUUID()}` };
    });
    if (new Set(captured.map((e) => e.boardId)).size !== captured.length) throw new CommandError("A Board may appear only once in an update capture.");
    batch = await writeBoardBatch(direction.dir, { formatVersion: 1, version: 1, id: `batch-${randomUUID()}`,
      foundation: { directionId: opts.directionId, versionId: opts.versionId }, createdAt: new Date().toISOString(), entries: captured }, 0);
  }
  for (let i = 0; i < batch.entries.length; i++) {
    const entry = batch.entries[i];
    if (entry.status === "completed") continue;
    let next: BoardBatchEntry;
    try {
      // The revision outcome is persisted before its batch entry. Recover that exact success after interruption.
      const completed = (await listBoardRevisions(direction.dir, entry.boardId)).find((r) => r.operationId === entry.operationId && r.status === "completed");
      if (completed) {
        if (completed.foundation.versionId !== batch.foundation.versionId || completed.sourceRevisionId !== entry.sourceRevisionId) throw new CommandError("The completed update does not match its captured source and foundation.");
        if (!(await resolveBoardImage(direction.dir, entry.boardId, completed.id)).imagePath) throw new CommandError("The completed update is missing its Board image; restore the artifact before resuming.");
        await reconcileBoardIndex(direction.dir, entry.boardId);
        next = { ...entry, status: "completed", revisionId: completed.id };
        delete next.error;
      } else {
        const current = await readBoardIndex(direction.dir, entry.boardId);
        if (current.instructions !== entry.instructions || current.instructionVersion !== entry.instructionVersion) {
          throw new VersionConflictError(`Board ${entry.boardId} instructions changed since this update was captured`, entry.instructionVersion, current.instructionVersion);
        }
        const result = await runBoardRevise({ cwd: opts.cwd, directionId: opts.directionId, boardId: entry.boardId,
          versionId: batch.foundation.versionId, revisionId: entry.sourceRevisionId,
          expectedInstructionVersion: entry.instructionVersion, operationId: entry.operationId });
        next = { ...entry, status: result.status, revisionId: result.revisionId };
        if (result.error) next.error = result.error; else delete next.error;
      }
    } catch (error) {
      next = { ...entry, status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    const entries = [...batch.entries]; entries[i] = next;
    batch = await writeBoardBatch(direction.dir, { ...batch, entries }, batch.version);
  }
  return { batchId: batch.id, foundation: batch.foundation, entries: batch.entries,
    status: batch.entries.every((entry) => entry.status === "completed") ? "completed" : "partial" };
}

export async function runBoardRetire(opts: { cwd: string; directionId: string; boardId: string; expectedVersion?: number }) {
  const { direction } = await loadDirection(opts.cwd, opts.directionId);
  return retireBoard(direction.dir, opts.boardId, { expectedVersion: opts.expectedVersion });
}
export async function runBoardList(opts: { cwd: string; directionId: string; includeRetired?: boolean }) {
  const { direction } = await loadDirection(opts.cwd, opts.directionId);
  return listBoards(direction.dir, opts);
}
export async function runBoardShow(opts: { cwd: string; directionId: string; boardId: string; revisionId?: string }) {
  const { direction } = await loadDirection(opts.cwd, opts.directionId);
  return opts.revisionId ? readBoardRevision(direction.dir, opts.boardId, opts.revisionId)
    : { ...await readBoardIndex(direction.dir, opts.boardId), revisions: await listBoardRevisions(direction.dir, opts.boardId) };
}

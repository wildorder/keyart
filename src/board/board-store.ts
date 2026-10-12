import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CommandError } from "../errors.js";
import { assertFoundationPath } from "../direction/foundation.js";
import { withFileLock, atomicWriteJson } from "../store/file-lock.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { BoardIdSchema, BoardIndexSchema, BoardRevisionSchema, BoardBatchSchema,
  isBoardRetired, type BoardIndex, type BoardRevision, type BoardBatch } from "./schema.js";

export function assertBoardId(id: string): void {
  if (!BoardIdSchema.safeParse(id).success) throw new CommandError(`Invalid Board id: ${id}. Select an id, not a path.`);
}
export function boardsRoot(directionDir: string): string { return path.join(directionDir, "boards"); }
export function boardDir(directionDir: string, boardId: string): string {
  assertBoardId(boardId); return path.join(boardsRoot(directionDir), boardId);
}
export function boardRevisionDir(directionDir: string, boardId: string, revisionId: string): string {
  assertBoardId(revisionId); return path.join(boardDir(directionDir, boardId), "revisions", revisionId);
}
function indexFile(directionDir: string, id: string): string { return path.join(boardDir(directionDir, id), "board.json"); }
function revisionFile(directionDir: string, id: string, revision: string): string {
  return path.join(boardRevisionDir(directionDir, id, revision), "board-revision.json");
}
async function contained(directionDir: string, file: string): Promise<void> {
  // Check every existing ancestor before a write, including a substituted junction.
  let existing = file;
  for (;;) {
    try { await fs.lstat(existing); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(existing);
    if (parent === existing) throw new CommandError("Board path has no owning direction.");
    existing = parent;
  }
  await assertFoundationPath(directionDir, existing);
}
async function readRecord<T>(directionDir: string, file: string, parse: (data: unknown) => T): Promise<T> {
  await contained(directionDir, file);
  try { return parse(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CommandError(`Board record not found: ${file}`);
    throw new CommandError(`Unsupported or unreadable Board record: ${file}. Use the documented one-time migration before retrying.`);
  }
}
export async function readBoardIndex(directionDir: string, boardId: string): Promise<BoardIndex> {
  const board = await readRecord(directionDir, indexFile(directionDir, boardId), (v) => BoardIndexSchema.parse(v));
  if (board.id !== boardId || board.directionId !== path.basename(directionDir)) throw new CommandError("Board does not belong to this direction.");
  return board;
}
export async function readBoardRevision(directionDir: string, boardId: string, revisionId: string): Promise<BoardRevision> {
  await readBoardIndex(directionDir, boardId);
  const revision = await readRecord(directionDir, revisionFile(directionDir, boardId, revisionId), (v) => BoardRevisionSchema.parse(v));
  if (revision.id !== revisionId || revision.boardId !== boardId || revision.foundation.directionId !== path.basename(directionDir)) {
    throw new CommandError("Board revision does not belong to this Board and direction.");
  }
  return revision;
}
async function directories(directionDir: string, root: string): Promise<string[]> {
  await contained(directionDir, root);
  try { return (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export async function listBoardRevisions(directionDir: string, boardId: string): Promise<BoardRevision[]> {
  const ids = await directories(directionDir, path.join(boardDir(directionDir, boardId), "revisions"));
  const revisions: BoardRevision[] = [];
  for (const id of ids) revisions.push(await readBoardRevision(directionDir, boardId, id));
  return revisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function selectBoardRevision(revisions: BoardRevision[], versionId?: string): BoardRevision | undefined {
  return [...revisions].reverse().find((r) => r.status === "completed" && (!versionId || r.foundation.versionId === versionId));
}
export async function listBoards(directionDir: string, opts: { includeRetired?: boolean } = {}): Promise<BoardIndex[]> {
  const result: BoardIndex[] = [];
  for (const id of await directories(directionDir, boardsRoot(directionDir))) {
    const board = await readBoardIndex(directionDir, id);
    if (opts.includeRetired || !isBoardRetired(board)) result.push(board);
  }
  return result;
}
export async function resolveBoardImage(directionDir: string, boardId: string, revisionId: string): Promise<{ revision: BoardRevision; imagePath: string | null }> {
  const revision = await readBoardRevision(directionDir, boardId, revisionId);
  if (revision.status !== "completed" || !revision.files.image) return { revision, imagePath: null };
  const imagePath = path.join(boardRevisionDir(directionDir, boardId, revisionId), "board.png");
  const expected = path.relative(directionDir, imagePath).split(path.sep).join("/");
  if (revision.files.image !== expected) throw new CommandError("Board image path does not match its revision.");
  await contained(directionDir, imagePath);
  try { return { revision, imagePath: (await fs.stat(imagePath)).isFile() ? imagePath : null }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision, imagePath: null }; throw error; }
}
export async function createBoard(directionDir: string, opts: { directionId: string; name: string; instructions: string }): Promise<BoardIndex> {
  if (opts.directionId !== path.basename(directionDir)) throw new CommandError("Board direction does not match its owner.");
  if (!opts.name.trim() || !opts.instructions.trim()) throw new CommandError("A Board needs a name and a local brief (--describe).");
  const root = boardsRoot(directionDir);
  await contained(directionDir, root);
  return withFileLock(path.join(root, "create"), async () => {
    const existing = new Set(await directories(directionDir, root));
    const base = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
    let id = base; let suffix = 2;
    while (existing.has(id)) id = `${base}-${suffix++}`;
    const board: BoardIndex = { formatVersion: 1, version: 1, id, directionId: opts.directionId, name: opts.name.trim(),
      instructions: opts.instructions.trim(), instructionVersion: 1, revisionIds: [], head: null, createdAt: new Date().toISOString() };
    await contained(directionDir, indexFile(directionDir, id));
    await atomicWriteJson(indexFile(directionDir, id), board);
    return board;
  });
}
export async function reserveBoardRevision(directionDir: string, opts: {
  boardId: string; foundation: BoardRevision["foundation"]; sourceRevisionId: string | null;
  expectedInstructionVersion: number; tweak?: string; operationId?: string;
}): Promise<BoardRevision> {
  const file = indexFile(directionDir, opts.boardId);
  await contained(directionDir, file);
  return withFileLock(file, async () => {
    const board = await readBoardIndex(directionDir, opts.boardId);
    if (isBoardRetired(board)) throw new CommandError(`Board ${board.id} is retired; it cannot be revised.`);
    if (opts.foundation.directionId !== board.directionId) throw new CommandError("A Board foundation must belong to its direction.");
    if (board.instructionVersion !== opts.expectedInstructionVersion) throw new VersionConflictError(file, opts.expectedInstructionVersion, board.instructionVersion);
    if (opts.operationId) {
      const attempts = (await listBoardRevisions(directionDir, board.id)).filter((r) => r.operationId === opts.operationId);
      const success = attempts.find((r) => r.status === "completed");
      if (success) {
        if (success.foundation.versionId !== opts.foundation.versionId || success.sourceRevisionId !== opts.sourceRevisionId) {
          throw new CommandError("The captured update operation belongs to different revision inputs.");
        }
        return success;
      }
      for (const attempt of attempts) {
        if (!attempt.runningPid) continue;
        try { process.kill(attempt.runningPid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; }
        throw new CommandError(`Board update ${opts.operationId} is already running. Retry after its worker finishes.`);
      }
    }
    if (opts.sourceRevisionId) await readBoardRevision(directionDir, board.id, opts.sourceRevisionId);
    const instructions = opts.tweak?.trim() ? `${board.instructions}\n\n${opts.tweak.trim()}` : board.instructions;
    const instructionVersion = board.instructionVersion + (instructions !== board.instructions ? 1 : 0);
    const id = `r-${Date.now()}-${randomUUID()}`;
    const relative = path.relative(directionDir, boardRevisionDir(directionDir, board.id, id)).split(path.sep).join("/");
    const revision: BoardRevision = { formatVersion: 1, id, boardId: board.id, foundation: opts.foundation,
      sourceRevisionId: opts.sourceRevisionId, instructions, instructionVersion, createdAt: new Date().toISOString(), status: "pending", conditioning: "foundation",
      runningPid: process.pid,
      ...(opts.operationId ? { operationId: opts.operationId } : {}), files: { prompt: `${relative}/board-prompt.md`, context: `${relative}/context-snapshot.json` } };
    await contained(directionDir, revisionFile(directionDir, board.id, id));
    await atomicWriteJson(revisionFile(directionDir, board.id, id), BoardRevisionSchema.parse(revision));
    await atomicWriteJson(file, { ...board, version: board.version + 1, instructions, instructionVersion, revisionIds: [...board.revisionIds, id] });
    return revision;
  });
}
export async function finishBoardRevision(directionDir: string, revision: BoardRevision): Promise<void> {
  revision = BoardRevisionSchema.parse(revision);
  const file = indexFile(directionDir, revision.boardId);
  await contained(directionDir, file);
  await withFileLock(file, async () => {
    const stored = await readBoardRevision(directionDir, revision.boardId, revision.id);
    if (stored.status !== "pending" || !stored.runningPid) throw new CommandError("A finished Board revision is immutable.");
    const { status: _status, error: _error, files: _files, runningPid: _pid, ...original } = stored;
    const { status: _nextStatus, error: _nextError, files: _nextFiles, runningPid: _nextPid, ...next } = revision;
    if (JSON.stringify(original) !== JSON.stringify(next)) throw new CommandError("Board revision intent and provenance are immutable.");
    if (stored.files.prompt !== revision.files.prompt || stored.files.context !== revision.files.context) throw new CommandError("Board artifact paths are immutable.");
    if (revision.status === "completed") {
      const image = path.join(boardRevisionDir(directionDir, revision.boardId, revision.id), "board.png");
      const expected = path.relative(directionDir, image).split(path.sep).join("/");
      if (revision.files.image !== expected) throw new CommandError("A completed Board needs its own rendered image.");
      await contained(directionDir, image);
      if (!(await fs.stat(image)).isFile()) throw new CommandError("A completed Board needs its own rendered image.");
    }
    await atomicWriteJson(revisionFile(directionDir, revision.boardId, revision.id), BoardRevisionSchema.parse(revision));
    const board = await readBoardIndex(directionDir, revision.boardId);
    const revisions = await listBoardRevisions(directionDir, revision.boardId);
    await atomicWriteJson(file, { ...board, version: board.version + 1, revisionIds: revisions.map((r) => r.id), head: selectBoardRevision(revisions)?.id ?? null });
  });
}
export async function retireBoard(directionDir: string, boardId: string, opts: { expectedVersion?: number } = {}): Promise<BoardIndex> {
  const file = indexFile(directionDir, boardId);
  await contained(directionDir, file);
  return withFileLock(file, async () => {
    const board = await readBoardIndex(directionDir, boardId);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== board.version) throw new VersionConflictError(file, opts.expectedVersion, board.version);
    if (isBoardRetired(board)) return board;
    const next = { ...board, version: board.version + 1, retiredAt: new Date().toISOString() };
    await atomicWriteJson(file, next); return next;
  });
}
/** Mutation-only crash recovery. A read never repairs the persisted index. */
export async function reconcileBoardIndex(directionDir: string, boardId: string): Promise<BoardIndex> {
  const file = indexFile(directionDir, boardId);
  await contained(directionDir, file);
  return withFileLock(file, async () => {
    const board = await readBoardIndex(directionDir, boardId);
    const revisions = await listBoardRevisions(directionDir, boardId);
    const revisionIds = revisions.map((r) => r.id);
    const completed = selectBoardRevision(revisions);
    if (completed && !(await resolveBoardImage(directionDir, boardId, completed.id)).imagePath) {
      throw new CommandError(`Completed Board revision ${completed.id} is missing its image. Restore that artifact before resuming; recorded successes are never regenerated implicitly.`);
    }
    const head = completed?.id ?? null;
    if (head === board.head && JSON.stringify(revisionIds) === JSON.stringify(board.revisionIds)) return board;
    const next = { ...board, version: board.version + 1, revisionIds, head };
    await atomicWriteJson(file, next);
    return next;
  });
}
export function boardBatchFile(directionDir: string, batchId: string): string {
  assertBoardId(batchId); return path.join(directionDir, "board-updates", `${batchId}.json`);
}
export async function readBoardBatch(directionDir: string, batchId: string): Promise<BoardBatch> {
  const batch = await readRecord(directionDir, boardBatchFile(directionDir, batchId), (v) => BoardBatchSchema.parse(v));
  if (batch.id !== batchId || batch.foundation.directionId !== path.basename(directionDir)) throw new CommandError("Board update does not belong to this direction.");
  return batch;
}
export async function writeBoardBatch(directionDir: string, batch: BoardBatch, expectedVersion: number): Promise<BoardBatch> {
  const file = boardBatchFile(directionDir, batch.id);
  await contained(directionDir, file);
  return withFileLock(file, async () => {
    let actual = 0;
    try { actual = (await readBoardBatch(directionDir, batch.id)).version; }
    catch (error) { if (await fs.stat(file).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return false; throw e; })) throw error; }
    if (actual !== expectedVersion) throw new VersionConflictError(file, expectedVersion, actual);
    const next = BoardBatchSchema.parse({ ...batch, version: actual + 1 });
    await atomicWriteJson(file, next); return next;
  });
}

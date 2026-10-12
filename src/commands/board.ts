import path from "node:path";
import { CommandError } from "../errors.js";
import { loadConfig, directionsRoot } from "../config.js";
import { BoardBatchEntrySchema } from "../board/schema.js";
import { runBoardCreate, runBoardRevise, runBoardUpdate, runBoardRetire, runBoardList, runBoardShow } from "../board/operations.js";

export const BOARD_VERBS = ["create", "revise", "update", "list", "show", "retire"] as const;
export interface BoardFlags {
  direction?: string; version?: string; revision?: string; name?: string; describe?: string;
  tweak?: string; board?: string; resume?: string; captured?: string;
  instructionVersion?: string; includeRetired?: boolean;
}
const ALLOWED: Record<string, (keyof BoardFlags)[]> = {
  create: ["direction", "version", "name", "describe"],
  revise: ["direction", "version", "revision", "tweak", "instructionVersion"],
  update: ["direction", "version", "board", "resume", "captured"],
  list: ["direction", "includeRetired"], show: ["direction", "revision"], retire: ["direction"],
};
export async function runBoard(cwd: string, rest: string[], flags: BoardFlags): Promise<{ summary: string; filesWritten: string[]; result: unknown }> {
  const verb = rest[0];
  if (!ALLOWED[verb]) throw new CommandError(`Unknown board action. Use ${BOARD_VERBS.join(" | ")}.`);
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined && value !== false && !ALLOWED[verb].includes(key as keyof BoardFlags)) throw new CommandError(`--${key} is not valid with board ${verb}.`);
  }
  if (!flags.direction) throw new CommandError(`board ${verb} requires --direction <id>.`);
  const needsId = ["revise", "show", "retire"].includes(verb);
  if (rest.length > (needsId ? 2 : 1) || (needsId && !rest[1])) throw new CommandError(`Usage: keyart board ${verb}${needsId ? " <boardId>" : ""} --direction <id>`);
  const common = { cwd, directionId: flags.direction };
  let result: unknown;
  let summary: string;
  let filesWritten: string[] = [];
  if (verb === "create") {
    if (!flags.version || !flags.name || !flags.describe) throw new CommandError("board create requires --version, --name and --describe. Select an explicit foundation; drafts need Generate v1 first.");
    const created = await runBoardCreate({ ...common, versionId: flags.version, name: flags.name, describe: flags.describe });
    result = created; filesWritten = created.filesWritten;
    summary = `Board ${created.boardId}@${created.revisionId}: ${created.status}, foundation ${created.foundation.versionId}.`;
  } else if (verb === "revise") {
    const expected = flags.instructionVersion === undefined ? undefined : Number(flags.instructionVersion);
    if (expected !== undefined && (!Number.isInteger(expected) || expected < 1)) throw new CommandError("--instruction-version must be a positive integer.");
    const revised = await runBoardRevise({ ...common, boardId: rest[1], versionId: flags.version,
      revisionId: flags.revision === "none" ? null : flags.revision, tweak: flags.tweak, expectedInstructionVersion: expected });
    result = revised; filesWritten = revised.filesWritten;
    summary = `Board ${revised.boardId}@${revised.revisionId}: ${revised.status}, foundation ${revised.foundation.versionId}.`;
  } else if (verb === "update") {
    let captured;
    if (flags.captured !== undefined) {
      try { captured = BoardBatchEntrySchema.array().max(250).parse(JSON.parse(flags.captured)); }
      catch { throw new CommandError("--captured must be a valid captured Board update JSON array."); }
    }
    const batch = await runBoardUpdate({ ...common, versionId: flags.version, boardId: flags.board, resume: flags.resume, captured });
    result = batch;
    const config = await loadConfig(cwd);
    filesWritten = [path.relative(cwd, path.join(directionsRoot(cwd, config), flags.direction, "board-updates", `${batch.batchId}.json`)).split(path.sep).join("/")];
    summary = `Board update ${batch.batchId}: ${batch.status}; ${batch.entries.filter((e) => e.status === "completed").length}/${batch.entries.length} completed, foundation ${batch.foundation.versionId}. Assets were not revised.\n${batch.entries.map((e) => `${e.name}: ${e.status}${e.error ? ` — ${e.error}` : ""}`).join("\n")}`;
  } else if (verb === "list") {
    result = await runBoardList({ ...common, includeRetired: flags.includeRetired });
    summary = JSON.stringify(result, null, 2);
  } else if (verb === "show") {
    result = await runBoardShow({ ...common, boardId: rest[1], revisionId: flags.revision });
    summary = JSON.stringify(result, null, 2);
  } else {
    result = await runBoardRetire({ ...common, boardId: rest[1] });
    summary = `Retired Board ${rest[1]}; all revisions remain on disk.`;
  }
  console.log(summary);
  return { summary, filesWritten, result };
}

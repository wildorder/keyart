import { z } from "zod";
import { CommandError } from "../errors.js";
import { BoardBatchEntrySchema, BoardIdSchema } from "../board/schema.js";
import { captureBoardUpdate, resolveBoardRevisionInputs, runBoardCreate, runBoardRevise, runBoardUpdate, runBoardRetire } from "../board/operations.js";
import { loadConfig } from "../config.js";
import { resolveFoundation } from "../direction/foundation.js";
import { fullUrl, readJsonBody, sendJson, toHttpError, type ConnectHandler } from "./server-api.js";
import type { JobStore } from "./jobs.js";

export const BOARD_WRITE_ROUTES: readonly string[] = [
  "POST /api/actions/board-create", "POST /api/actions/board-revise", "POST /api/actions/board-update",
  "DELETE /api/directions/:id/boards/:boardId",
];
const createSchema = z.object({ directionId: BoardIdSchema, versionId: BoardIdSchema,
  name: z.string().trim().min(1), describe: z.string().trim().min(1) }).strict();
const reviseSchema = z.object({ directionId: BoardIdSchema, boardId: BoardIdSchema,
  versionId: BoardIdSchema, revisionId: BoardIdSchema.nullable(),
  expectedInstructionVersion: z.number().int().positive(), tweak: z.string().optional() }).strict();
const updateSchema = z.object({ directionId: BoardIdSchema, versionId: BoardIdSchema.optional(),
  boardId: BoardIdSchema.optional(), resume: BoardIdSchema.optional(),
  captured: z.array(BoardBatchEntrySchema).max(250).optional() }).strict();

/** Mounted behind the existing local guard, before direction/action catchalls. */
export function createBoardApi({ cwd, jobs }: { cwd: string; jobs: JobStore }): ConnectHandler {
  return (req, res, next) => {
    const url = fullUrl(req);
    const method = req.method ?? "GET";
    const retire = url.pathname.match(/^\/api\/directions\/([^/]+)\/boards\/([^/]+)$/);
    const action = url.pathname.match(/^\/api\/actions\/board-(create|revise|update)$/);
    if (!(method === "GET" && url.pathname === "/api/boards/prepare") &&
        !(method === "DELETE" && retire) && !(method === "POST" && action)) { next(); return; }
    void (async () => {
      if (method === "GET") {
        const directionId = BoardIdSchema.parse(url.searchParams.get("directionId"));
        const versionId = url.searchParams.get("versionId") || undefined;
        const boardId = url.searchParams.get("boardId") || undefined;
        if (url.searchParams.get("mode") === "revise") {
          if (!boardId) throw new CommandError("Select a Board to prepare its revision.");
          const revision = url.searchParams.get("revisionId");
          sendJson(res, 200, await resolveBoardRevisionInputs({ cwd, directionId, boardId, versionId,
            revisionId: revision === "none" ? null : revision || undefined }));
        } else sendJson(res, 200, await captureBoardUpdate({ cwd, directionId, versionId, boardId }));
        return;
      }
      const body = await readJsonBody(req);
      if (retire) {
        const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive().optional() }).strict().parse(body);
        const result = await runBoardRetire({ cwd, directionId: decodeURIComponent(retire[1]), boardId: decodeURIComponent(retire[2]), expectedVersion });
        sendJson(res, 200, { ok: true, ...result }); return;
      }
      let task: () => Promise<unknown>;
      if (action![1] === "create") {
        const input = createSchema.parse(body);
        await resolveFoundation({ cwd, config: await loadConfig(cwd), ...input });
        task = () => runBoardCreate({ cwd, ...input });
      } else if (action![1] === "revise") {
        const input = reviseSchema.parse(body);
        await resolveBoardRevisionInputs({ cwd, ...input });
        task = () => runBoardRevise({ cwd, ...input });
      } else {
        const input = updateSchema.parse(body);
        if (!input.resume && (!input.versionId || !input.captured)) {
          throw new CommandError("Prepare and confirm the Board set and explicit foundation before updating.");
        }
        task = () => runBoardUpdate({ cwd, ...input });
      }
      const job = jobs.start("board", task);
      sendJson(res, 202, { jobId: job.id });
    })().catch((error: unknown) => {
      if (error instanceof z.ZodError) { sendJson(res, 400, { error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }); return; }
      const result = toHttpError(error); sendJson(res, result.status, result.body);
    });
  };
}

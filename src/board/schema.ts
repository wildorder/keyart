import { z } from "zod";

export const BoardIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const foundation = z.object({ directionId: BoardIdSchema, versionId: BoardIdSchema }).strict();
export const BoardStatusSchema = z.enum(["pending", "completed", "failed"]);
export const BoardIndexSchema = z.object({
  formatVersion: z.literal(1), version: z.number().int().positive(),
  id: BoardIdSchema, directionId: BoardIdSchema, name: z.string().min(1),
  instructions: z.string().min(1), instructionVersion: z.number().int().positive(),
  revisionIds: z.array(BoardIdSchema), head: BoardIdSchema.nullable(),
  createdAt: z.string(), retiredAt: z.string().optional(),
}).strict();
export const BoardRevisionSchema = z.object({
  formatVersion: z.literal(1), id: BoardIdSchema, boardId: BoardIdSchema,
  foundation, sourceRevisionId: BoardIdSchema.nullable(),
  instructions: z.string(), instructionVersion: z.number().int().positive(),
  createdAt: z.string(), status: BoardStatusSchema,
  conditioning: z.enum(["foundation", "legacy-unverified"]),
  operationId: BoardIdSchema.optional(), error: z.string().optional(),
  runningPid: z.number().int().positive().optional(),
  files: z.object({ prompt: z.string(), context: z.string(), image: z.string().optional() }).strict(),
}).strict();
export const BoardBatchEntrySchema = z.object({
  boardId: BoardIdSchema, name: z.string(), sourceRevisionId: BoardIdSchema.nullable(),
  instructions: z.string(), instructionVersion: z.number().int().positive(),
  operationId: BoardIdSchema, status: BoardStatusSchema,
  revisionId: BoardIdSchema.optional(), error: z.string().optional(),
}).strict();
export const BoardBatchSchema = z.object({
  formatVersion: z.literal(1), version: z.number().int().positive(),
  id: BoardIdSchema, foundation, createdAt: z.string(),
  entries: z.array(BoardBatchEntrySchema).max(250),
}).strict();

export type BoardIndex = z.infer<typeof BoardIndexSchema>;
export type BoardRevision = z.infer<typeof BoardRevisionSchema>;
export type BoardBatch = z.infer<typeof BoardBatchSchema>;
export type BoardBatchEntry = z.infer<typeof BoardBatchEntrySchema>;
export type BoardStatus = z.infer<typeof BoardStatusSchema>;
export function isBoardRetired(board: Pick<BoardIndex, "retiredAt">): boolean { return !!board.retiredAt; }

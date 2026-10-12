import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, directionsRoot } from "../config.js";
import { resolveDirection } from "../direction/store.js";
import { assertFoundationPath, resolveFoundation } from "../direction/foundation.js";
import { resolveBoardImage } from "../board/board-store.js";
import { CommandError } from "../errors.js";
import type { ChatAttachment, ChatVisualSource } from "../agent/model.js";

/** A chat upload is context, not a memory entry or an asset extraction. */
export async function storeChatAttachment(cwd: string, directionId: string, raw: unknown): Promise<ChatAttachment> {
  if (!raw || typeof raw !== "object") throw new CommandError("Invalid crop attachment.");
  const { dataUrl, source } = raw as { dataUrl?: unknown; source?: unknown };
  if (typeof dataUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new CommandError("Crop attachment must be a PNG data URL.");
  const bytes = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  if (bytes.length > 4 * 1024 * 1024) throw new CommandError("Crop attachment exceeds 4 MB.", 413);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii",12,16) !== "IHDR") throw new CommandError("Crop attachment is not a PNG image.");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32_000_000) throw new CommandError("Crop dimensions are invalid or too large.");
  if (!source || typeof source !== "object") throw new CommandError("Crop attachment requires its exact visual source.");
  const input = source as Record<string, unknown>;
  if (input.directionId !== directionId || typeof input.versionId !== "string") throw new CommandError("Crop attachment must belong to the focused direction.");
  const config = await loadConfig(cwd);
  const direction = await resolveDirection(cwd, config, directionId);
  await assertFoundationPath(directionsRoot(cwd, config), direction.dir);
  let pinned: ChatVisualSource;
  if (input.kind === "foundation") {
    const foundation = await resolveFoundation({ cwd, config, directionId, versionId: input.versionId });
    if (!foundation.tilePath) throw new CommandError("The crop's foundation has no image.");
    pinned = { kind: "foundation", directionId, versionId: input.versionId };
  } else if (input.kind === "board" && typeof input.boardId === "string" && typeof input.revisionId === "string") {
    const board = await resolveBoardImage(direction.dir, input.boardId, input.revisionId);
    if (!board.imagePath || board.revision.foundation.versionId !== input.versionId) throw new CommandError("Crop source does not match a completed Board revision.");
    pinned = { kind: "board", directionId, versionId: input.versionId, boardId: input.boardId, revisionId: input.revisionId };
  } else throw new CommandError("Crop attachment requires an exact foundation or Board revision.");
  // Check existing ancestors before mkdir: never follow a substituted assets junction.
  const dest = path.join(direction.dir, "assets", "chat-attachments");
  let ancestor = dest;
  for (;;) {
    try { await fs.lstat(ancestor); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = path.dirname(ancestor); }
  }
  await assertFoundationPath(direction.dir, ancestor);
  await fs.mkdir(dest, { recursive: true });
  await assertFoundationPath(direction.dir, dest);
  const file = path.join(dest, `${randomUUID()}.png`);
  await fs.writeFile(file, bytes, { flag: "wx" });
  return { path: path.relative(cwd, file).split(path.sep).join("/"), dataUrl, source: pinned };
}

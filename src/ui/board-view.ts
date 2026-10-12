import type { DashboardBoard, DashboardBoardRevision, DashboardVersion, VisualSource } from "./types.js";

/** A selected foundation never borrows another foundation's Board render. */
export function boardRevisionFor(board: DashboardBoard, versionId: string): DashboardBoardRevision | undefined {
  const candidates = board.revisions.filter((r) => r.foundation.versionId === versionId);
  return [...candidates].reverse().find((r) => r.status === "completed") ?? candidates.at(-1);
}
export function sourceFields(source: VisualSource): Record<string, string> & { directionId: string } {
  return { directionId: source.directionId, versionId: source.versionId,
    ...(source.kind === "board" ? { boardId: source.boardId, revisionId: source.revisionId } : { image: "styleTile" }) };
}
export interface BoardStageItem {
  key: string; label: string; path?: string; source: VisualSource | null;
  board?: DashboardBoard; revision?: DashboardBoardRevision;
}
export function boardStageItems(directionId: string, version: DashboardVersion, boards: DashboardBoard[], includeRetired = false): BoardStageItem[] {
  return [{ key: "foundation", label: "Foundation", path: version.images?.styleTile,
    source: { kind: "foundation", directionId, versionId: version.versionId } },
    ...boards.filter((b) => includeRetired || !b.retiredAt).map((board): BoardStageItem => {
      const revision = boardRevisionFor(board, version.versionId);
      return { key: board.id, label: board.name, board, revision, path: revision?.imagePath,
        source: revision ? { kind: "board", directionId, versionId: revision.foundation.versionId, boardId: board.id, revisionId: revision.id } : null };
    })];
}
export function foundationLabel(versions: DashboardVersion[], versionId: string): string {
  const index = versions.findIndex((v) => v.versionId === versionId);
  return index < 0 ? versionId : `v${versions[index].ordinal ?? index + 1} (${versionId})`;
}

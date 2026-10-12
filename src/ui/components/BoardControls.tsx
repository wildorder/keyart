import React, { useState } from "react";
import type { DashboardBoard, DashboardDirection, DashboardVersion, Job } from "../types";
import type { BoardBatchEntry } from "../../board/schema.js";
import type { PinnedBoardRevision } from "../../board/operations.js";
import { boardCreateRequest, boardPrepareRequest, boardReviseRequest, boardUpdateRequest, boardRetireRequest } from "../direction-actions.js";
import { deleteJson } from "../hooks";
import { foundationLabel } from "../board-view.js";
import { JobProgress, useAction } from "./JobProgress";

type Confirmation = { kind: "create"; directionId: string; versionId: string; name: string; describe: string }
  | { kind: "revise"; pinned: PinnedBoardRevision; tweak: string }
  | { kind: "update"; directionId: string; versionId: string; entries: BoardBatchEntry[] }
  | { kind: "retire"; directionId: string; boardId: string; name: string; expectedVersion: number };
interface BatchResult { batchId: string; status: string; entries: BoardBatchEntry[] }

export function BoardControls({ directionId, versions, boards, selectedVersionId, latestVersionId, board, revisionId, reload }: {
  directionId: string; versions: DashboardVersion[]; boards: DashboardBoard[];
  selectedVersionId: string; latestVersionId: string; board?: DashboardBoard; revisionId: string | null;
  reload: () => void;
}) {
  const [form, setForm] = useState<"create" | "revise" | "update" | null>(null);
  const [target, setTarget] = useState(selectedVersionId);
  const [name, setName] = useState("");
  const [describe, setDescribe] = useState("");
  const [tweak, setTweak] = useState("");
  const [oneBoard, setOneBoard] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const action = useAction(reload);
  const active = boards.filter((b) => !b.retiredAt);

  const prepare = async (): Promise<void> => {
    setError(null); setPreparing(true);
    try {
      if (form === "create") {
        setConfirmation({ kind: "create", directionId, versionId: target, name: name.trim(), describe: describe.trim() });
      } else {
        const request = boardPrepareRequest({ directionId, versionId: target,
          ...(form === "revise" ? { mode: "revise", boardId: board!.id, revisionId }
            : oneBoard && board ? { boardId: board.id } : {}) });
        const response = await fetch(request.path);
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "Could not prepare Board operation.");
        if (form === "revise") setConfirmation({ kind: "revise", pinned: value as PinnedBoardRevision, tweak });
        else setConfirmation({ kind: "update", directionId, versionId: value.versionId, entries: value.entries });
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPreparing(false); }
  };
  const confirm = async (): Promise<void> => {
    if (!confirmation) return;
    const pending = confirmation;
    if (pending.kind === "retire") {
      try {
        const req = boardRetireRequest(pending.directionId, pending.boardId, pending.expectedVersion);
        await deleteJson(req.path, req.body); reload(); setConfirmation(null);
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      return;
    }
    const req = pending.kind === "create"
      ? boardCreateRequest({ directionId: pending.directionId, versionId: pending.versionId, name: pending.name, describe: pending.describe })
      : pending.kind === "revise"
        ? boardReviseRequest({ directionId: pending.pinned.directionId, boardId: pending.pinned.boardId,
          versionId: pending.pinned.versionId, revisionId: pending.pinned.revisionId,
          expectedInstructionVersion: pending.pinned.expectedInstructionVersion, tweak: pending.tweak })
        : boardUpdateRequest({ directionId: pending.directionId, versionId: pending.versionId, captured: pending.entries });
    action.start(req.path, req.body); setConfirmation(null); setForm(null);
  };
  const onDone = (job: Job): void => {
    if (job.result && typeof job.result === "object" && "batchId" in job.result && "entries" in job.result) setBatch(job.result as BatchResult);
    action.onDone(job);
  };
  const targetLabel = confirmation && confirmation.kind !== "retire"
    ? foundationLabel(versions, confirmation.kind === "revise" ? confirmation.pinned.versionId : confirmation.versionId) : "";
  return <section className="board-controls" aria-label="Board actions">
    <div className="gallery-card-actions">
      <button className="btn btn-secondary btn-sm" disabled={action.running} onClick={() => { setForm("create"); setTarget(selectedVersionId); setConfirmation(null); }}>Add Board</button>
      {board && !board.retiredAt && <button className="btn btn-secondary btn-sm" disabled={action.running} onClick={() => { setForm("revise"); setTarget(latestVersionId); setConfirmation(null); }}>Revise Board</button>}
      <button className="btn btn-ghost btn-sm" disabled={action.running || active.length === 0} onClick={() => { setForm("update"); setTarget(selectedVersionId); setConfirmation(null); }}>Update Boards</button>
      {board && !board.retiredAt && <button className="btn btn-ghost btn-sm" disabled={action.running} onClick={() => setConfirmation({ kind: "retire", directionId, boardId: board.id, name: board.name, expectedVersion: board.version })}>Retire Board</button>}
    </div>
    {form && !confirmation && <div className="regen-form">
      <label>Target foundation<select aria-label="Board target foundation" value={target} onChange={(e) => setTarget(e.target.value)}>
        {[...versions].reverse().map((v) => <option key={v.versionId} value={v.versionId}>{foundationLabel(versions, v.versionId)}{v.versionId === latestVersionId ? " — latest" : ""}</option>)}
      </select></label>
      {form === "create" && <><label>Board name<input value={name} onChange={(e) => setName(e.target.value)} /></label><label>Local brief<textarea value={describe} onChange={(e) => setDescribe(e.target.value)} /></label></>}
      {form === "revise" && <><p>Source revision: {revisionId ?? "No completed render"}</p><label>Local changes<textarea value={tweak} onChange={(e) => setTweak(e.target.value)} placeholder="Leave empty to preserve the Board's intent" /></label></>}
      {form === "update" && <><p>Update {oneBoard && board ? board.name : `${active.length} active Boards`}. Assets and approval are excluded.</p>{board && !board.retiredAt && <label><input type="checkbox" checked={oneBoard} onChange={(e) => setOneBoard(e.target.checked)} /> Only {board.name}</label>}</>}
      <button className="btn btn-primary btn-sm" disabled={preparing || (form === "create" && (!name.trim() || !describe.trim()))} onClick={prepare}>{preparing ? "Preparing…" : "Review request"}</button>
      <button className="btn btn-ghost btn-sm" onClick={() => setForm(null)}>Cancel</button>
    </div>}
    {confirmation && <div className="lifecycle-confirm" role="region" aria-label="Confirm Board operation">
      {confirmation.kind === "retire" ? <p>Retire “{confirmation.name}”? Its history and images remain available.</p> : <>
        <p><strong>Target foundation: {targetLabel}</strong></p>
        {confirmation.kind === "create" && <p>Create “{confirmation.name}”: {confirmation.describe}</p>}
        {confirmation.kind === "revise" && <p>Revise “{confirmation.pinned.name}” from {confirmation.pinned.revisionId ?? "its local brief"}. {confirmation.tweak || "Preserve existing local intent."}</p>}
        {confirmation.kind === "update" && <p>Update {confirmation.entries.length} Boards: {confirmation.entries.map((e) => e.name).join(", ") || "none"}. Assets and approval stay as they are.</p>}
      </>}
      <button className="btn btn-primary btn-sm" disabled={action.running} onClick={confirm}>Confirm</button>
      <button className="btn btn-ghost btn-sm" onClick={() => setConfirmation(null)}>Cancel</button>
    </div>}
    {error && <p role="alert">{error}</p>}
    <JobProgress jobId={action.jobId} onDone={onDone} />
    {batch && <div role="status" aria-label="Board update results"><p>Update {batch.status} · {batch.batchId}</p><ul>{batch.entries.map((e) => <li key={e.boardId}>{e.name}: {e.status}{e.error ? ` — ${e.error}` : ""}</li>)}</ul>
      {batch.status !== "completed" && <button className="btn btn-secondary btn-sm" disabled={action.running} onClick={() => { const req = boardUpdateRequest({ directionId, resume: batch.batchId }); action.start(req.path, req.body); }}>Resume unfinished Boards</button>}
    </div>}
  </section>;
}

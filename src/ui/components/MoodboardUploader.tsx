/**
 * Drag-and-drop + file-picker uploader that adds image files to the focused
 * direction's assets via `moodboardUploadRequest` (`POST /api/uploads` —
 * multipart, `directionId` field). Files are filtered to image types
 * client-side; a busy state disables re-submits while the request is in
 * flight. Success toasts a count and reloads so the new assets appear in the
 * gallery; a 409 surfaces the standard reload-and-retry message.
 */
import React, { useCallback, useRef, useState } from "react";
import { uploadFiles, isVersionConflict, VERSION_CONFLICT_MESSAGE } from "../hooks";
import { moodboardUploadRequest, type StudioRequest } from "../direction-actions.js";
import { useToasts } from "./Toasts";

interface UploadResult {
  ok: boolean;
  files: { path: string; registered: boolean }[];
}

/** Keep only files the browser typed as images (drops stray non-image drops). */
function imagesOnly(files: File[]): File[] {
  return files.filter((f) => f.type.startsWith("image/"));
}

export function MoodboardUploader({
  directionId,
  reload,
  variant,
}: {
  directionId: string;
  reload: () => void;
  variant?: "drawer";
}) {
  const { pushToast } = useToasts();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  // Reference intent (WS-05): "inspire" feeds the image model as-is; "extract"
  // asks Keyart to analyze the image for palette/type seeds.
  const [intent, setIntent] = useState<"inspire" | "extract">("inspire");

  const upload = useCallback(
    async (candidates: File[], req: StudioRequest) => {
      const images = imagesOnly(candidates);
      if (images.length === 0) {
        pushToast({ kind: "error", message: "No image files to upload." });
        return;
      }
      setBusy(true);
      try {
        const result = await uploadFiles<UploadResult>(req.path, images, req.form);
        const count = result.files.length;
        pushToast({
          kind: "success",
          message: `${count} ${count === 1 ? "file" : "files"} uploaded to this direction's assets.`,
        });
        reload();
      } catch (e) {
        if (isVersionConflict(e)) {
          pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
          reload();
        } else {
          pushToast({
            kind: "error",
            message: e instanceof Error ? e.message : "Upload failed.",
          });
        }
      } finally {
        setBusy(false);
      }
    },
    [pushToast, reload],
  );

  // Each entry handler BUILDS the request descriptor itself (the control-bound
  // origin), then hands the bytes to the shared transport.
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return; // guard against empty drops
      void upload(files, moodboardUploadRequest(directionId, intent));
    },
    [upload, directionId, intent],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      // Reset so re-picking the same file still fires onChange.
      e.target.value = "";
      if (files.length === 0) return;
      void upload(files, moodboardUploadRequest(directionId, intent));
    },
    [upload, directionId, intent],
  );

  return (
    <div className={`uploader${variant === "drawer" ? " uploader--drawer" : ""}`}>
      <fieldset className="upload-intent">
        <legend className="upload-intent-legend">How should this reference be used?</legend>
        <div className="radio-row">
          <label className="radio-option">
            <input
              type="radio"
              name={`intent-${directionId}`}
              value="inspire"
              checked={intent === "inspire"}
              disabled={busy}
              onChange={() => setIntent("inspire")}
            />
            Inspire
          </label>
          <label className="radio-option">
            <input
              type="radio"
              name={`intent-${directionId}`}
              value="extract"
              checked={intent === "extract"}
              disabled={busy}
              onChange={() => setIntent("extract")}
            />
            Extract
          </label>
        </div>
        <p className="field-hint">
          <strong>Inspire</strong> = feed the image model. <strong>Extract</strong> ={" "}
          analyze for palette/type seeds.
        </p>
      </fieldset>
      <div
        className={`dropzone${dragActive ? " dropzone-active" : ""}${busy ? " dropzone-busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
        aria-label="Upload reference images to this direction"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <p className="dropzone-lead">
          {busy ? "Uploading…" : "Drag and drop images here"}
        </p>
        <p className="dropzone-hint">
          Added to this direction&apos;s assets. Or{" "}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
          >
            choose files
          </button>
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={onPick}
        />
      </div>
    </div>
  );
}

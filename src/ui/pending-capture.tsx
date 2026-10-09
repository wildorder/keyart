/**
 * The one pending capture taken on the gallery stage, shared between the stage
 * that produced it and the chat composer that resolves it.
 *
 * This is what makes the described gesture work: crop a region, type what you
 * think about it, hit Keep or Discard. The crop is taken in {@link DirectionHero}
 * and lands as a chip in {@link ChatRail}'s composer — two components in
 * different DOM subtrees (the rail is portalled into the shell's third column),
 * but the same React tree, which is what context follows.
 *
 * The quick intents resolve a capture with NO model in the loop: they post the
 * same `/api/element-feedback` multipart the panel always did, with the
 * composer's text as the note. That is deliberate — it is the escape hatch that
 * makes routing free text through a model safe to add later, because a misroute
 * never costs the user the gesture.
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Capture } from "./stage-capture.js";
import type { AssetSourceImage } from "./asset-shelf-helpers.js";

/** A capture plus everything needed to record it against the right target. */
export interface PendingCapture {
  capture: Capture;
  directionId: string;
  versionId?: string;
  /** The logical source-image name, for the extract action's `image` field. */
  sourceImage?: AssetSourceImage;
}

interface PendingCaptureApi {
  pending: PendingCapture | null;
  /** Replace the pending capture, releasing any object URL the old one held. */
  setPending: (next: PendingCapture | null) => void;
  /** Drop the pending capture and release its object URL. */
  clear: () => void;
}

const PendingCaptureContext = createContext<PendingCaptureApi>({
  pending: null,
  setPending: () => {},
  clear: () => {},
});

/** Release a crop's object URL. Colors are plain strings and need no cleanup. */
function release(p: PendingCapture | null): void {
  if (p?.capture.kind === "crop") URL.revokeObjectURL(p.capture.previewUrl);
}

export function PendingCaptureProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPendingState] = useState<PendingCapture | null>(null);

  const setPending = useCallback((next: PendingCapture | null) => {
    setPendingState((prev) => {
      // Never leak the replaced crop's blob URL.
      if (prev !== next) release(prev);
      return next;
    });
  }, []);

  const clear = useCallback(() => setPending(null), [setPending]);

  const value = useMemo(
    () => ({ pending, setPending, clear }),
    [pending, setPending, clear],
  );

  return (
    <PendingCaptureContext.Provider value={value}>
      {children}
    </PendingCaptureContext.Provider>
  );
}

export function usePendingCapture(): PendingCaptureApi {
  return useContext(PendingCaptureContext);
}

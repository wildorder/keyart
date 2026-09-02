/**
 * A full-screen image viewer with a vertical thumbnail rail on the left and the
 * complete (never-cropped) image in the center. Inline thumbnails throughout the
 * studio are deliberately constrained (`object-fit: cover`, fixed aspect ratios)
 * for a tidy layout — this overlay is how you actually SEE the whole image.
 *
 * Exposed as a context so any {@link AssetImage} can open it (pass a `gallery`
 * plus the clicked image's `galleryIndex`); the rail then lets you page through
 * every image in that group. Mirrors {@link CompareOverlay}: `role="dialog"` +
 * `aria-modal`, Escape / backdrop / close-button to dismiss, arrow keys to page,
 * and body-scroll lock while open. The center image uses `object-fit: contain`,
 * so nothing is cropped.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { AssetImage } from "./AssetImage";
import { useToasts } from "./Toasts";
import {
  lightboxAssetRequest,
  type StudioRequest,
} from "../direction-actions.js";

/**
 * The subset of the (still not-universally-typed) Web Share API we use. Sharing
 * FILES — not a URL — is the whole point: the images live only on the local
 * filesystem, so `navigator.share({ files })` hands the actual image to the OS
 * share sheet (WhatsApp, Mail, Messages, …). Typed locally to avoid depending on
 * the DOM lib exposing `canShare`.
 */
type ShareCapableNavigator = Navigator & {
  canShare?: (data?: { files?: File[] }) => boolean;
  share?: (data?: { files?: File[]; title?: string; text?: string }) => Promise<void>;
};

/** Last path segment, used as the shared/downloaded file name. */
function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || "image";
}

/** Fetch a lightbox image's exact bytes as a `File` (for share/download).
 * Takes the pure {@link StudioRequest} descriptor (WS-20) so the handlers
 * themselves construct the request — the URL bytes are unchanged. */
async function fetchImageFile(img: LightboxImage, req: StudioRequest): Promise<File> {
  const res = await fetch(req.path);
  if (!res.ok) throw new Error(`server responded ${res.status}`);
  const blob = await res.blob();
  return new File([blob], fileName(img.path), { type: blob.type || "image/png" });
}

/** Trigger a browser download of an in-memory file. */
function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One image in a lightbox gallery. `path`/`version` map to `AssetImage`. */
export interface LightboxImage {
  path: string;
  alt: string;
  /** Shown beneath the full image; falls back to `alt`. */
  caption?: string;
  /** Cache-bust token forwarded to `AssetImage` (parity with inline thumbs). */
  version?: number | string;
}

interface LightboxContextValue {
  /** Open the viewer on `images`, focused on `index` (clamped into range). */
  open: (images: LightboxImage[], index: number) => void;
}

// Default no-op so an `AssetImage` rendered without a provider (e.g. in tests)
// still renders — it simply won't open the viewer on click.
const LightboxContext = createContext<LightboxContextValue>({ open: () => {} });

export function useLightbox(): LightboxContextValue {
  return useContext(LightboxContext);
}

interface LightboxState {
  images: LightboxImage[];
  index: number;
}

export function LightboxProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LightboxState | null>(null);

  const open = useCallback((images: LightboxImage[], index: number) => {
    if (images.length === 0) return;
    const clamped = Math.min(Math.max(index, 0), images.length - 1);
    setState({ images, index: clamped });
  }, []);

  const close = useCallback(() => setState(null), []);
  const setIndex = useCallback(
    (index: number) => setState((s) => (s ? { ...s, index } : s)),
    [],
  );

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      {state && (
        <Lightbox
          images={state.images}
          index={state.index}
          onIndex={setIndex}
          onClose={close}
        />
      )}
    </LightboxContext.Provider>
  );
}

function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: LightboxImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const count = images.length;
  const hasMultiple = count > 1;
  const current = images[index];
  const { pushToast } = useToasts();
  const [busy, setBusy] = useState(false);

  const nav = navigator as ShareCapableNavigator;
  const canShare =
    typeof nav.share === "function" && typeof nav.canShare === "function";

  const share = async (): Promise<void> => {
    if (!current) return;
    setBusy(true);
    try {
      const file = await fetchImageFile(
        current,
        lightboxAssetRequest(current.path, current.version),
      );
      if (nav.share && nav.canShare && nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: current.caption ?? current.alt });
          return;
        } catch (e) {
          // The user dismissing the OS share sheet is not an error.
          if ((e as DOMException)?.name === "AbortError") return;
        }
      }
      // No file-share support (or it refused these files): fall back to a
      // download so the image can still be attached manually.
      downloadFile(file);
      pushToast({
        kind: "info",
        message: "Your browser can't share files directly — image downloaded so you can attach it.",
      });
    } catch (e) {
      pushToast({
        kind: "error",
        message: `Couldn't prepare image to share: ${(e as Error).message}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const download = async (): Promise<void> => {
    if (!current) return;
    setBusy(true);
    try {
      downloadFile(
        await fetchImageFile(
          current,
          lightboxAssetRequest(current.path, current.version),
        ),
      );
    } catch (e) {
      pushToast({
        kind: "error",
        message: `Couldn't download image: ${(e as Error).message}`,
      });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      else if (hasMultiple && e.key === "ArrowRight") onIndex((index + 1) % count);
      else if (hasMultiple && e.key === "ArrowLeft") onIndex((index - 1 + count) % count);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [index, count, hasMultiple, onIndex, onClose]);

  if (!current) return null;

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image viewer">
      <button
        type="button"
        className="lightbox-backdrop"
        aria-label="Close image viewer"
        onClick={onClose}
      />
      <div className="lightbox-panel">
        <div className="lightbox-toolbar">
          {canShare && (
            <button
              type="button"
              className="lightbox-action"
              onClick={share}
              disabled={busy}
              title="Share this image via WhatsApp, email, and more"
            >
              {busy ? "Sharing…" : "Share"}
            </button>
          )}
          <button
            type="button"
            className="lightbox-action"
            onClick={download}
            disabled={busy}
            title="Download this image"
          >
            Download
          </button>
          <button type="button" className="lightbox-action" onClick={onClose}>
            Close ✕
          </button>
        </div>

        {hasMultiple && (
          <nav className="lightbox-thumbs" aria-label="Images in this brief">
            {images.map((img, i) => (
              <button
                key={`${img.path}-${i}`}
                type="button"
                className={`lightbox-thumb ${i === index ? "is-active" : ""}`}
                aria-current={i === index}
                aria-label={img.caption ?? img.alt}
                onClick={() => onIndex(i)}
              >
                <AssetImage
                  path={img.path}
                  alt={img.alt}
                  version={img.version}
                  className="lightbox-thumb-img"
                />
              </button>
            ))}
          </nav>
        )}

        <div className="lightbox-stage">
          {hasMultiple && (
            <button
              type="button"
              className="lightbox-nav lightbox-prev"
              aria-label="Previous image"
              onClick={() => onIndex((index - 1 + count) % count)}
            >
              ‹
            </button>
          )}
          <figure className="lightbox-figure">
            <AssetImage
              key={`${current.path}-${index}`}
              path={current.path}
              alt={current.alt}
              version={current.version}
              className="lightbox-image"
            />
            <figcaption className="lightbox-caption">
              <span className="lightbox-caption-text">
                {current.caption ?? current.alt}
              </span>
              {hasMultiple && (
                <span className="lightbox-counter">
                  {index + 1} / {count}
                </span>
              )}
            </figcaption>
          </figure>
          {hasMultiple && (
            <button
              type="button"
              className="lightbox-nav lightbox-next"
              aria-label="Next image"
              onClick={() => onIndex((index + 1) % count)}
            >
              ›
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

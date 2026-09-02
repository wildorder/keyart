/**
 * Toast host + context. `ToastProvider` wraps the app; `useToasts()` returns
 * `{ pushToast }`. Toasts auto-dismiss after a few seconds. Re-exported from
 * `hooks.ts` so the data layer exposes the whole toast system in one place.
 */
import React, { createContext, useCallback, useContext, useRef, useState } from "react";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  pushToast: (toast: { kind: ToastKind; message: string }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** How long a toast stays on screen before auto-dismissing. */
const TOAST_TTL_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    ({ kind, message }: { kind: ToastKind; message: string }) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, kind, message }]);
      setTimeout(() => dismiss(id), TOAST_TTL_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-message">{t.message}</span>
            <button
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Access `pushToast`. Must be called under a {@link ToastProvider}. */
export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToasts must be used within a ToastProvider");
  }
  return ctx;
}

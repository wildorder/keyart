import React from "react";
import type { DirectionTokens } from "../types";
import { useToasts } from "./Toasts";

export function PaletteSwatchRow({ tokens }: { tokens?: DirectionTokens }) {
  const { pushToast } = useToasts();

  if (!tokens) return null;

  const brandCount = tokens.brand?.length ?? 0;

  const copyHex = (hex: string): void => {
    void navigator.clipboard?.writeText(hex).then(
      () => pushToast({ kind: "success", message: `Copied ${hex}` }),
      () => {
        /* clipboard blocked — no-op */
      },
    );
  };

  return (
    <div className="palette-swatch-row" role="group" aria-label="Palette">
      {tokens.palette.map((token) => (
        <div className="palette-swatch-row__item" key={token.role}>
          <span
            className="palette-swatch-row__chip"
            style={{ backgroundColor: token.hex }}
            aria-hidden="true"
          />
          <span className="palette-swatch-row__role">{token.name}</span>
          <button
            type="button"
            className="palette-swatch-row__hex"
            title="Copy hex"
            onClick={() => copyHex(token.hex)}
          >
            {token.hex}
          </button>
        </div>
      ))}
      {brandCount > 0 && (
        <span className="palette-swatch-row__brand-count">
          +{brandCount} brand color{brandCount === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

/**
 * The "Palette & type" board — a direct, non-generated view of a direction
 * version's structured design tokens. Default presentation is **dense & inline**:
 * compact swatches in a wrapping row, a one-line type + shape summary, and the
 * unbounded brand[] primitives behind a disclosure. Expandable lock toggles
 * appear on hover/focus (locked swatches stay visible).
 *
 * Coolors-style interaction: each swatch has a lock toggle, and a "Reroll" button
 * regenerates every UNLOCKED role around the locked ones. The color math lives
 * server-side (`POST /api/palette/reroll`) so culori never enters the browser
 * bundle; the rerolled palette is persisted through the version-edit path
 * (`paletteSaveRequest` — `PUT /api/directions/:id` with `tokens`, editing the
 * head) and then `reload()` refreshes the dashboard.
 *
 * Modes:
 *  - **Self-persisting** (gallery, head version): `onChange` omitted — a reroll
 *    PUTs the new tokens through the edit path and calls `reload()`.
 *  - **Controlled** (editor): `onChange` provided — a reroll (and, when
 *    `editable`, a per-swatch hex edit) bubbles the next tokens up; the editor
 *    owns saving.
 *  - **Read-only** (a non-head, historical version): `readOnly` hides the reroll
 *    / lock / regenerate affordances (those iterate the HEAD); the swatches +
 *    copyable hexes still render.
 *
 * Degrades gracefully: a legacy, token-less direction renders a short note
 * rather than an empty board.
 */
import React, { useState } from "react";
import type {
  DirectionTokens,
  PaletteRole,
  PaletteToken,
  PaletteProvenance,
} from "../types";
import { postJson, putJson, isVersionConflict, VERSION_CONFLICT_MESSAGE } from "../hooks";
import { paletteRerollRequest, paletteSaveRequest } from "../direction-actions.js";
import { useToasts } from "./Toasts";
import { PaletteSwatchRow } from "./PaletteSwatchRow";

interface RerollResponse {
  palette: PaletteToken[];
  provenance: PaletteProvenance;
}

/** A large integer seed for a reroll; browser randomness is fine here (the
 * engine stays deterministic — the seed is just its input). */
function freshSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

export function PaletteBoard({
  directionId,
  tokens: sourceTokens,
  reload,
  onChange,
  editable = false,
  extracted = false,
  readOnly = false,
  onLockedChange,
  onRegenerateWithLocks,
  regenBusy = false,
}: {
  directionId: string;
  /** The tokens to render (the version's tokens in gallery mode, the working
   * tokens in editor mode). Undefined on a legacy prose-only version. */
  tokens?: DirectionTokens;
  reload: () => void;
  /** Editor mode: reroll + hex edits bubble here instead of self-persisting. */
  onChange?: (tokens: DirectionTokens) => void;
  /** Editor mode: render editable hex inputs instead of copyable chips. */
  editable?: boolean;
  /** True when these tokens were EXTRACTED from the style tile — the board then
   * reads "(extracted from the style tile)" instead of "(exact)". */
  extracted?: boolean;
  /** A non-head, historical version: hide the reroll/lock/regenerate affordances
   * (they iterate the HEAD). The swatches + copyable hexes still render. */
  readOnly?: boolean;
  /** Gallery mode: bubble the currently-locked roles up so the card's unified
   * Regenerate can hold them verbatim (SC-08). */
  onLockedChange?: (roles: PaletteRole[]) => void;
  /** Gallery mode: push the CURRENT palette (the locked roles + their current
   * hexes — post-reroll if the user rerolled) into a creative regenerate as
   * locked-color guidance (SC-13 mode b). Absent ⇒ the button is not rendered. */
  onRegenerateWithLocks?: (
    lockedRoles: PaletteRole[],
    lockedColors: { role: PaletteRole; hex: string }[],
  ) => void;
  /** Gallery mode: a regenerate is already in flight — disables the push button. */
  regenBusy?: boolean;
}) {
  const { pushToast } = useToasts();
  const [locked, setLocked] = useState<PaletteRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [brandOpen, setBrandOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const controlled = onChange !== undefined;
  const tokens = sourceTokens;
  if (!tokens) {
    return (
      <div className="palette-board palette-board-empty" role="note">
        No tokens (legacy direction) — palette &amp; type editing is unavailable.
      </div>
    );
  }

  const toggleLock = (role: PaletteRole): void => {
    const next = locked.includes(role)
      ? locked.filter((r) => r !== role)
      : [...locked, role];
    setLocked(next);
    onLockedChange?.(next);
  };

  /** The locked roles' CURRENT hexes — the locked-color guidance pushed into a
   * creative regenerate (a rerolled hex flows through here, so the two reroll
   * modes compose in either order — SC-13). */
  const lockedColors = (): { role: PaletteRole; hex: string }[] =>
    locked
      .map((role) => {
        const token = tokens.palette.find((t) => t.role === role);
        return token ? { role, hex: token.hex } : null;
      })
      .filter((x): x is { role: PaletteRole; hex: string } => x !== null);

  const copyHex = (hex: string): void => {
    void navigator.clipboard?.writeText(hex).then(
      () => pushToast({ kind: "success", message: `Copied ${hex}` }),
      () => {
        /* clipboard blocked — no-op */
      },
    );
  };

  const setHex = (role: PaletteRole, hex: string): void => {
    if (!onChange) return;
    onChange({
      ...tokens,
      palette: tokens.palette.map((t) => (t.role === role ? { ...t, hex } : t)),
    });
  };

  const reroll = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const req = paletteRerollRequest({
        tokens,
        lockedRoles: locked,
        seed: freshSeed(),
      });
      const { palette, provenance } = await postJson<RerollResponse>(req.path, req.body);
      const nextTokens: DirectionTokens = { ...tokens, palette, provenance };
      if (controlled) {
        // Editor mode — hand the rerolled tokens up; the editor saves them.
        onChange?.(nextTokens);
      } else {
        // Gallery mode — persist through the same token-edit core the CLI/MCP
        // use (no palette logic is duplicated in the browser), then refresh. The
        // PUT edits the direction's HEAD version in place.
        const save = paletteSaveRequest(directionId, nextTokens);
        await putJson(save.path, save.body);
        pushToast({ kind: "success", message: "Rerolled the palette." });
        reload();
      }
    } catch (e) {
      if (isVersionConflict(e)) {
        pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
        reload();
      } else {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not reroll the palette.",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const { typography, shape } = tokens;
  // The reroll / lock / regenerate affordances iterate the HEAD; hide them on a
  // read-only historical version (view/compare/restore only).
  const interactive = !readOnly;
  const brandCount = tokens.brand?.length ?? 0;
  // In the editor (controlled/editable) the dense board is always visible.
  // In the gallery/head presentation the user expands it via "Edit palette".
  const denseVisible = controlled || editable || editOpen;
  // readOnly ⇒ interactive === false ⇒ no toggle, no dense region: swatch row only.
  const showEditAffordance = interactive && !(controlled || editable);

  return (
    <div className="palette-board palette-board--dense">
      {/* Default presentational row — always visible */}
      <PaletteSwatchRow tokens={tokens} />

      {/* Gallery/head presentation: offer an "Edit palette" toggle.
          Editor (controlled/editable) and read-only paths skip this. */}
      {showEditAffordance && (
        <button
          type="button"
          className="palette-board__edit-toggle"
          aria-expanded={editOpen}
          aria-controls={`palette-edit-${directionId}`}
          onClick={() => setEditOpen((o) => !o)}
        >
          {editOpen ? "Done editing palette" : "Edit palette"}
        </button>
      )}

      {/* Dense board — mounted always when interactive so `locked` state
          survives collapse/expand; CSS-hidden when not visible, never unmounted. */}
      {interactive && (
        <div
          id={`palette-edit-${directionId}`}
          className="palette-board__edit-region"
          hidden={!denseVisible}
        >
          <div className="palette-board-head">
            <h4 className="palette-board-title">
              Palette &amp; type{" "}
              {extracted ? "(extracted from the style tile)" : "(exact)"}
            </h4>
            <div className="palette-board-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={reroll}
                title="Regenerate every unlocked swatch around the locked ones (no image call)"
              >
                {busy ? "Rerolling…" : "Reroll"}
              </button>
              {onRegenerateWithLocks && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={regenBusy || locked.length === 0}
                  onClick={() => onRegenerateWithLocks(locked, lockedColors())}
                  title={
                    locked.length === 0
                      ? "Lock one or more swatches first, then push them into a regenerate"
                      : "Regenerate the images holding the locked colors, re-extracting the rest"
                  }
                >
                  Regenerate image with these locks
                </button>
              )}
            </div>
          </div>

          <div className="swatch-grid">
            {tokens.palette.map((token) => {
              const isLocked = locked.includes(token.role);
              return (
                <div
                  key={token.role}
                  className={`swatch${isLocked ? " swatch-locked" : ""}`}
                >
                  <span
                    className="swatch-chip"
                    style={{ backgroundColor: token.hex }}
                    aria-hidden="true"
                  />
                  <span className="swatch-role">{token.name}</span>
                  {editable ? (
                    <input
                      className="swatch-hex-input"
                      type="text"
                      aria-label={`${token.name} hex`}
                      value={token.hex}
                      onChange={(e) => setHex(token.role, e.target.value)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="swatch-hex"
                      title="Copy hex"
                      onClick={() => copyHex(token.hex)}
                    >
                      {token.hex}
                    </button>
                  )}
                  <label
                    className={`swatch-lock ${isLocked ? "is-locked" : ""}`}
                    title="Lock this swatch across rerolls"
                  >
                    <input
                      type="checkbox"
                      checked={isLocked}
                      onChange={() => toggleLock(token.role)}
                    />
                    {isLocked ? "🔒" : "🔓"}
                  </label>
                </div>
              );
            })}
          </div>

          {brandCount > 0 && tokens.brand && (
            <div className="brand-primitives">
              <button
                type="button"
                className="brand-primitives-toggle"
                aria-expanded={brandOpen}
                onClick={() => setBrandOpen((o) => !o)}
              >
                {brandOpen ? "▾" : "▸"} +{brandCount} brand color
                {brandCount === 1 ? "" : "s"}
                <span className="brand-primitives-toggle-hint">
                  {" "}
                  — every read color, hue-named as <code>var(--brand-*)</code>
                </span>
              </button>
              {brandOpen && (
                <div className="brand-primitive-grid">
                  {tokens.brand.map((b) => (
                    <div key={b.name} className="brand-primitive">
                      <span
                        className="swatch-chip"
                        style={{ backgroundColor: b.hex }}
                        aria-hidden="true"
                      />
                      <span className="brand-primitive-name" title={b.label ?? b.name}>
                        --brand-{b.name}
                      </span>
                      <button
                        type="button"
                        className="swatch-hex"
                        title={b.label ? `Copy hex (${b.label})` : "Copy hex"}
                        onClick={() => copyHex(b.hex)}
                      >
                        {b.hex}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="palette-meta-row">
            <div className="type-specimen">
              <p
                className="type-specimen-heading"
                style={{ fontFamily: `"${typography.heading}", serif` }}
              >
                {typography.heading}
              </p>
              <p
                className="type-specimen-body"
                style={{ fontFamily: `"${typography.body}", sans-serif` }}
              >
                {typography.body}
              </p>
            </div>
            <div className="shape-chips">
              <span
                className="shape-chip"
                style={{ borderRadius: shape.radius }}
                title={`radius ${shape.radius}`}
              >
                radius {shape.radius}
              </span>
              <span className="shape-chip" title={`spacing unit ${shape.spacingUnit}`}>
                spacing {shape.spacingUnit}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

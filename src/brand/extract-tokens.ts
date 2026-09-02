import type {
  DirectionTokens,
  PaletteRole,
  ShapeTokens,
  TypographyTokens,
} from "../types.js";
import type { PaletteLock } from "./palette.js";
import { buildTokens } from "../explore/token-intent.js";
import {
  colorInfo,
  inferSchemeString,
  locksFromRoledColors,
  normHex,
  type RoledColor,
} from "./role-map.js";
import { nameBrandColors } from "./hue-name.js";
import { DEFAULT_FONT_PAIRING } from "./fonts.js";

/**
 * Turn the brand palette READ off a generated style tile — a vision
 * TRANSCRIPTION of the exact hex codes printed in the tile's palette panel,
 * each TAGGED with the role it plays (`describeImageBrand`, `src/openai.ts`) —
 * into the semantic token roles plus the unbounded hue-named brand primitives.
 * This is the inverted spine: the image model renders the palette panel freely
 * and we read the printed values (and their roles) back rather than dictating a
 * lock onto it, and rather than guessing dominant colors from raw pixels (the
 * retired quantizer mistook the illustration's colors for the brand palette).
 *
 * Pure & deterministic: normalize + dedupe the hexes → map the model's role tags
 * to locks via {@link locksFromRoledColors} → merge the caller's user locks on
 * top (a locked role WINS, held verbatim — SC-06) → finish through the palette
 * engine so `surface`/`muted` complete and WCAG contrast holds AROUND the read +
 * locked colors. The read locks carry `source: "extracted"`, so the engine may
 * still walk a READ `muted` to the AA floor (it is projected as
 * `--brand-text-muted`: ink, not decoration), while a USER lock is never
 * adjusted. The same colors + options always yield byte-identical tokens.
 *
 * An empty read (unreadable tile / no key / dry-run) falls back to engine
 * defaults around just the user locks, so a keyless run still yields a full
 * six-role board.
 */

export interface ExtractTokensOptions {
  /** User-locked roles held VERBATIM (WS-04 lock-and-rotate); default none. */
  locks?: PaletteLock[];
  /** Deterministic engine seed (default 0). WS-03/04 pass a stable value. */
  seed?: number;
  /** Typography to carry onto the returned tokens (the type read is mapped
   * separately by `mapTypeRead`; absent → a neutral catalog default keeps this
   * module stand-alone — extract-tokens owns COLOR only). */
  typography?: TypographyTokens;
  /** Shape to carry onto the returned tokens (absent → the CSS-var defaults). */
  shape?: ShapeTokens;
}

export interface ExtractedTokens {
  tokens: DirectionTokens;
  /** The normalized brand hexes the tokens were built from, for provenance. */
  palette: string[];
}

const DEFAULT_SEED = 0;
const DEFAULT_SHAPE: ShapeTokens = { radius: "8px", spacingUnit: "8px" };

/** A neutral, real, loadable default type pairing (color is this module's job). */
function neutralTypography(): TypographyTokens {
  return { heading: DEFAULT_FONT_PAIRING.heading, body: DEFAULT_FONT_PAIRING.body };
}

/**
 * Normalize raw palette strings to canonical lowercase 6-digit hexes, dropping
 * unparseable entries and case-insensitive duplicates while preserving order.
 */
function normalizePalette(hexes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hexes) {
    const hex = normHex(raw);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

/**
 * Merge extracted role locks with the caller's user locks: a user lock for a
 * role WINS over the extracted value for that role (SC-06), preserving insertion
 * order so the engine still anchors on `primary`. Role-less locks are appended.
 */
function mergeLocks(extracted: PaletteLock[], userLocks: PaletteLock[]): PaletteLock[] {
  const byRole = new Map<PaletteRole, PaletteLock>();
  const roleless: PaletteLock[] = [];
  for (const lock of [...extracted, ...userLocks]) {
    if (lock.role) byRole.set(lock.role, lock);
    else roleless.push(lock);
  }
  return [...byRole.values(), ...roleless];
}

/**
 * Run the merged locks through the palette engine for role-completion + WCAG
 * contrast, then attach the caller's typography/shape (or neutral defaults).
 */
function finishTokens(
  mergedLocks: PaletteLock[],
  palette: string[],
  opts: ExtractTokensOptions,
): ExtractedTokens {
  const primary = mergedLocks.find((l) => l.role === "primary");
  const baseHue = primary ? colorInfo(primary.hex).h : undefined;
  const base = buildTokens({
    raw: { baseHue, scheme: inferSchemeString(mergedLocks) },
    seed: opts.seed ?? DEFAULT_SEED,
    locks: mergedLocks,
  });
  return {
    tokens: {
      palette: base.palette,
      typography: opts.typography ?? neutralTypography(),
      shape: opts.shape ?? DEFAULT_SHAPE,
      provenance: base.provenance,
    },
    palette,
  };
}

/**
 * Build tokens from colors the vision model already TAGGED with roles
 * ({@link describeImageBrand}'s `colors`), so `background`/`text`/`primary` come
 * from what the image actually uses — never a lightness sort — and no printed
 * color is discarded before it reaches the engine finisher. Normalize hexes for
 * provenance → role-map via {@link locksFromRoledColors} → merge user locks
 * (locks win) → engine finish, then hue-name every distinct read color into the
 * unbounded `brand` primitive layer (lossless — nothing dropped, SC-03). An empty
 * read falls back to engine defaults around just the user locks. Deterministic;
 * never throws.
 */
export function tokensFromRoledColors(
  colors: RoledColor[],
  opts: ExtractTokensOptions = {},
): ExtractedTokens {
  const list = colors ?? [];
  const palette = normalizePalette(list.map((c) => c.hex));
  const extractedLocks = locksFromRoledColors(list);
  const merged = mergeLocks(extractedLocks, opts.locks ?? []);
  const result = finishTokens(merged, palette, opts);

  // Two-tier lower layer (SC-03, lossless): hue-name EVERY distinct color the
  // model read — regardless of the role it was tagged with — in prominence
  // order, so the unbounded set SURVIVES intact rather than collapsing into the
  // six fixed semantic slots. Filtering to `primary`/`brand` here was the
  // discard bug: a directly-tagged `secondary` (WS-02) or any structural
  // background/surface/text/muted would silently vanish. We take the literal
  // reading of "preserve every color on the tile" — structural neutrals appear
  // in `brand[]` too. `nameBrandColors` normalizes, dedupes case-insensitively,
  // and drops unparseables, so N distinct valid colors → N entries. The empty
  // guard keeps `brand` absent on an empty read (SC-09).
  const brand = nameBrandColors(
    list.map((c) => ({ hex: c.hex, label: c.label })),
  );
  if (brand.length) result.tokens.brand = brand;
  return result;
}

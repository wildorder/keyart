import type { AssetSource } from "./schema.js";

/**
 * The deterministic "asset pack" contact sheet: a code-rendered SVG grid +
 * markdown table of a direction's active extracted assets — the
 * `render-style-board.ts` idiom applied to assets instead of tokens. No model
 * call, no rasterization, no new dependency; byte-identical output for
 * identical input (no timestamps, no randomness, no locale-sensitive
 * formatting). Assets render in INPUT ARRAY ORDER — the caller owns ordering.
 * An image-less (dry-run) head renders an honest "pending (dry-run)"
 * placeholder — never a fabricated image.
 */

export interface ContactSheetAsset {
  id: string;
  name: string;
  description: string;
  versionId: string; // the head version rendered/promised in the pack
  hasImage: boolean; // false ⇒ dry-run head with no asset.png
  source: AssetSource; // provenance: source direction-version image (+ crop)
}

export interface ContactSheetInput {
  directionId: string;
  directionName?: string;
  assets: ContactSheetAsset[];
}

/** Escape a value for safe inclusion in XML text/attributes (the board's 5-entity idiom). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function hasCrop(source: AssetSource): boolean {
  return source.cropBox !== undefined || source.cropPath !== undefined;
}

/** `from <source.image> @ <source.versionId>`, plus a `(crop)` marker when cropped. */
function provenanceLine(source: AssetSource): string {
  return `from ${source.image} @ ${source.versionId}${hasCrop(source) ? " (crop)" : ""}`;
}

const COLS = 3;
const TILE_W = 220;
const TILE_H = 220;
const GAP = 20;
const MARGIN = 20;
const TITLE_TOP = 50;
const CAPTION_H = 80;
const ROW_H = TILE_H + CAPTION_H;

/**
 * A titled grid of labeled tiles: a bordered image tile (relative `<id>.png`
 * href, no base64 embedding) for `hasImage: true` assets, a dashed "pending
 * (dry-run)" placeholder tile otherwise, and a 4-line caption (name, id,
 * provenance, head version) under every tile. Zero assets renders a valid SVG
 * with the title and an honest "No active assets." line. A neutral fixed
 * palette — the sheet is a handoff artifact, not a brand artifact.
 */
export function renderContactSheetSvg(input: ContactSheetInput): string {
  const { directionId, directionName, assets } = input;
  const title = `${directionName ?? directionId} — Asset Pack (${assets.length})`;

  const width = MARGIN * 2 + COLS * TILE_W + (COLS - 1) * GAP;
  const rows = assets.length === 0 ? 0 : Math.ceil(assets.length / COLS);
  const bodyHeight = rows === 0 ? 30 : rows * ROW_H + (rows - 1) * GAP;
  const height = TITLE_TOP + bodyHeight + MARGIN;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
  );
  parts.push(
    `  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
  );
  parts.push(
    `  <text x="${MARGIN}" y="30" font-family="system-ui, sans-serif" font-size="20" font-weight="700" fill="#1a1a1a">${escapeXml(title)}</text>`,
  );

  if (assets.length === 0) {
    parts.push(
      `  <text x="${MARGIN}" y="${TITLE_TOP + 20}" font-family="system-ui, sans-serif" font-size="14" fill="#555555">No active assets.</text>`,
    );
  } else {
    assets.forEach((asset, i) => {
      const row = Math.floor(i / COLS);
      const col = i % COLS;
      const x = MARGIN + col * (TILE_W + GAP);
      const y = TITLE_TOP + row * (ROW_H + GAP);

      if (asset.hasImage) {
        parts.push(
          `  <rect x="${x}" y="${y}" width="${TILE_W}" height="${TILE_H}" fill="#f2f2f2" stroke="#cccccc" stroke-width="1"/>`,
        );
        parts.push(
          `  <image href="${escapeXml(asset.id)}.png" x="${x}" y="${y}" width="${TILE_W}" height="${TILE_H}" preserveAspectRatio="xMidYMid meet"/>`,
        );
      } else {
        parts.push(
          `  <rect x="${x}" y="${y}" width="${TILE_W}" height="${TILE_H}" fill="#f8f8f8" stroke="#999999" stroke-width="1" stroke-dasharray="6,4"/>`,
        );
        parts.push(
          `  <text x="${x + TILE_W / 2}" y="${y + TILE_H / 2}" font-family="system-ui, sans-serif" font-size="14" fill="#777777" text-anchor="middle">pending (dry-run)</text>`,
        );
      }

      const capY = y + TILE_H + 18;
      parts.push(
        `  <text x="${x}" y="${capY}" font-family="system-ui, sans-serif" font-size="13" font-weight="700" fill="#1a1a1a">${escapeXml(asset.name)}</text>`,
      );
      parts.push(
        `  <text x="${x}" y="${capY + 16}" font-family="system-ui, sans-serif" font-size="11" fill="#555555">${escapeXml(asset.id)}</text>`,
      );
      parts.push(
        `  <text x="${x}" y="${capY + 32}" font-family="system-ui, sans-serif" font-size="11" fill="#777777">${escapeXml(provenanceLine(asset.source))}</text>`,
      );
      parts.push(
        `  <text x="${x}" y="${capY + 48}" font-family="system-ui, sans-serif" font-size="11" fill="#777777">head ${escapeXml(asset.versionId)}</text>`,
      );
    });
  }

  parts.push(`</svg>`);
  return `${parts.join("\n")}\n`;
}

/**
 * A markdown table projection of the same input — same order, same data. The
 * `Status` cell is a relative image reference when `hasImage`, else the
 * literal `pending (dry-run)`. Zero assets renders the header + an honest
 * "_No active assets._" line instead of a table.
 */
export function renderContactSheetMarkdown(input: ContactSheetInput): string {
  const { directionId, directionName, assets } = input;
  const header = `# Asset Pack — ${directionName ?? directionId}`;
  const intro =
    "Active extracted assets for direction `" +
    directionId +
    "`. Images are the head version of each asset; a pending row is a dry-run head with no PNG yet (re-run `asset regenerate` with a key).";

  if (assets.length === 0) {
    return `${header}\n\n${intro}\n\n_No active assets._\n`;
  }

  const rows = assets.map((asset) => {
    const nameCell =
      asset.description.trim().length > 0
        ? `${escapeMdCell(asset.name)}<br>${escapeMdCell(asset.description)}`
        : escapeMdCell(asset.name);
    const sourceCell = `${asset.source.image} @ ${asset.source.versionId}${hasCrop(asset.source) ? " (crop)" : ""}`;
    const statusCell = asset.hasImage
      ? `![${asset.id}](${asset.id}.png)`
      : "pending (dry-run)";
    return `| ${nameCell} | ${escapeMdCell(asset.id)} | ${escapeMdCell(asset.versionId)} | ${escapeMdCell(sourceCell)} | ${statusCell} |`;
  });

  return `${header}\n\n${intro}\n\n| Asset | Id | Head version | Source | Status |\n|-------|----|--------------|--------|--------|\n${rows.join("\n")}\n`;
}

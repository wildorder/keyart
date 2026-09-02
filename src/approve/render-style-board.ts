import type { DirectionContent, PaletteRole } from "../types.js";
import { contrastRatio } from "../brand/palette.js";
import {
  resolveBrandVars,
  stampComment,
  APPROXIMATE_FONT_NOTE,
  type BrandVars,
  type SourceStamp,
} from "./render-guides.js";

/**
 * The deterministic "structured token artifact" tier: a palette + type-specimen
 * board rendered as SVG and markdown from a direction's tokens with NO model
 * call — byte-identical every run, dry-run and keyed alike. Both outputs read
 * the SAME `resolveBrandVars(direction)` that produces `brand.css`, so the
 * board's hexes and font families ALWAYS match the CSS exactly (SC-04). Legacy
 * token-less directions still render (via the shared legacy-prose fallback).
 */

/**
 * The six swatches, in canonical output order: `label` is the display name,
 * `key` is the BrandVars field the hex comes from (so it matches brand.css), and
 * `paletteRole` is the token role used to recover the human color name.
 */
/** The string-valued `BrandVars` keys (excludes the `brand` primitive array). */
type StringVarKey = {
  [K in keyof BrandVars]: BrandVars[K] extends string ? K : never;
}[keyof BrandVars];

const SWATCHES: { label: string; key: StringVarKey; paletteRole: PaletteRole }[] = [
  { label: "Primary", key: "primary", paletteRole: "primary" },
  { label: "Secondary", key: "secondary", paletteRole: "secondary" },
  { label: "Background", key: "background", paletteRole: "background" },
  { label: "Surface", key: "surface", paletteRole: "surface" },
  { label: "Text", key: "text", paletteRole: "text" },
  { label: "Text Muted", key: "textMuted", paletteRole: "muted" },
];

/** Human color name for a role from the direction's tokens, else the label. */
function swatchName(
  direction: DirectionContent,
  paletteRole: PaletteRole,
  fallbackLabel: string,
): string {
  const token = direction.tokens?.palette.find((t) => t.role === paletteRole);
  return token?.name ?? fallbackLabel;
}

/** Fixed pangram specimen — deterministic and font-agnostic. */
const SPECIMEN = "The quick brown fox jumps over the lazy dog";

/** WCAG contrast ratio of a hex against the background, formatted "4.53:1". */
function contrastVsBackground(hex: string, background: string): string {
  return `${contrastRatio(hex, background).toFixed(2)}:1`;
}

/** Escape a value for safe inclusion in XML text/attributes. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Deterministic SVG board: one labeled swatch per palette role (role + hex) plus
 * two type-specimen lines set in the heading and body `font-family` stacks. No
 * external fonts are fetched — the `font-family` is declared and the viewer
 * resolves it (documented limitation). No model call; identical every run.
 */
export function renderStyleBoardSvg(direction: DirectionContent): string {
  const vars = resolveBrandVars(direction);

  const marginX = 20;
  const swatchW = 110;
  const swatchGap = 10;
  const swatchTop = 60;
  const swatchH = 120;
  const width = marginX * 2 + SWATCHES.length * swatchW + (SWATCHES.length - 1) * swatchGap;
  const specimenTop = swatchTop + swatchH + 70;
  // Extracted-token directions carry the approximate-font caption below the
  // family line, so reserve an extra row for it; legacy prose boards do not.
  const approximateFont = direction.tokens !== undefined;

  // The unbounded PRIMITIVE row (hue-named brand colors), rendered below the
  // semantic role swatches when the tokens carry a `brand` set.
  const brand = vars.brand;
  const hasBrand = brand.length > 0;
  const roleRowBottom = swatchTop + swatchH + 40;
  const brandSwatchW = 96;
  const brandSwatchGap = 8;
  const brandSwatchH = 52;
  const brandTop = roleRowBottom + 22;
  const brandRowBottom = brandTop + brandSwatchH + 32;
  // Widen the canvas if the primitive row is longer than the role row.
  const rolesWidth = width;
  const brandWidth = hasBrand
    ? marginX * 2 + brand.length * brandSwatchW + (brand.length - 1) * brandSwatchGap
    : 0;
  const canvasWidth = Math.max(rolesWidth, brandWidth);
  // Push the specimen (and total height) down only when the brand row is present
  // — a brand-less board is byte-identical to before.
  const specimenTop2 = hasBrand ? brandRowBottom + 46 : specimenTop;
  const height2 = specimenTop2 + (approximateFont ? 110 : 90);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${height2}" viewBox="0 0 ${canvasWidth} ${height2}" role="img" aria-label="Palette and type specimen for ${escapeXml(direction.name)}">`,
  );
  parts.push(
    `  <rect x="0" y="0" width="${canvasWidth}" height="${height2}" fill="${escapeXml(vars.background)}"/>`,
  );
  parts.push(
    `  <text x="${marginX}" y="36" font-family="${escapeXml(vars.fontHeading)}" font-size="24" font-weight="700" fill="${escapeXml(vars.text)}">${escapeXml(direction.name)} — Palette &amp; Type</text>`,
  );

  SWATCHES.forEach((swatch, i) => {
    const hex = vars[swatch.key];
    const x = marginX + i * (swatchW + swatchGap);
    parts.push(
      `  <rect x="${x}" y="${swatchTop}" width="${swatchW}" height="${swatchH}" rx="6" fill="${escapeXml(hex)}" stroke="#00000022" stroke-width="1"/>`,
    );
    parts.push(
      `  <text x="${x}" y="${swatchTop + swatchH + 22}" font-family="${escapeXml(vars.fontBody)}" font-size="13" font-weight="600" fill="${escapeXml(vars.text)}">${escapeXml(swatch.label)}</text>`,
    );
    parts.push(
      `  <text x="${x}" y="${swatchTop + swatchH + 40}" font-family="${escapeXml(vars.fontBody)}" font-size="12" fill="${escapeXml(vars.textMuted)}">${escapeXml(hex)}</text>`,
    );
  });

  if (hasBrand) {
    parts.push(
      `  <text x="${marginX}" y="${brandTop - 8}" font-family="${escapeXml(vars.fontBody)}" font-size="12" font-weight="600" fill="${escapeXml(vars.textMuted)}">Brand colors</text>`,
    );
    brand.forEach((b, i) => {
      const bx = marginX + i * (brandSwatchW + brandSwatchGap);
      parts.push(
        `  <rect x="${bx}" y="${brandTop}" width="${brandSwatchW}" height="${brandSwatchH}" rx="6" fill="${escapeXml(b.hex)}" stroke="#00000022" stroke-width="1"/>`,
      );
      parts.push(
        `  <text x="${bx}" y="${brandTop + brandSwatchH + 16}" font-family="${escapeXml(vars.fontBody)}" font-size="12" font-weight="600" fill="${escapeXml(vars.text)}">${escapeXml(b.name)}</text>`,
      );
      parts.push(
        `  <text x="${bx}" y="${brandTop + brandSwatchH + 30}" font-family="${escapeXml(vars.fontBody)}" font-size="11" fill="${escapeXml(vars.textMuted)}">${escapeXml(b.hex)}</text>`,
      );
    });
  }

  parts.push(
    `  <text x="${marginX}" y="${specimenTop2}" font-family="${escapeXml(vars.fontHeading)}" font-size="30" font-weight="700" fill="${escapeXml(vars.text)}">${escapeXml(SPECIMEN)}</text>`,
  );
  parts.push(
    `  <text x="${marginX}" y="${specimenTop2 + 34}" font-family="${escapeXml(vars.fontBody)}" font-size="16" fill="${escapeXml(vars.text)}">${escapeXml(SPECIMEN)}</text>`,
  );
  parts.push(
    `  <text x="${marginX}" y="${specimenTop2 + 60}" font-family="${escapeXml(vars.fontBody)}" font-size="12" fill="${escapeXml(vars.textMuted)}">Heading: ${escapeXml(vars.fontHeadingFamily)} · Body: ${escapeXml(vars.fontBodyFamily)}</text>`,
  );
  if (approximateFont) {
    parts.push(
      `  <text x="${marginX}" y="${specimenTop2 + 82}" font-family="${escapeXml(vars.fontBody)}" font-size="11" font-style="italic" fill="${escapeXml(vars.textMuted)}">${escapeXml(APPROXIMATE_FONT_NOTE)}</text>`,
    );
  }

  parts.push(`</svg>`);
  return `${parts.join("\n")}\n`;
}

/**
 * Deterministic markdown board: a palette table (role | name | hex | contrast vs
 * background) + a typography section (heading/body families, optional scale) +
 * shape (radius/spacing). Carries the provenance stamp and is clearly labeled the
 * "exact" tier so the studio/docs can distinguish it from best-effort imagery.
 * Values match `brand.css` exactly (shared `resolveBrandVars`).
 */
export function renderStyleBoardMarkdown(
  direction: DirectionContent,
  stamp?: SourceStamp,
): string {
  const vars = resolveBrandVars(direction);
  const scale = direction.tokens?.typography.scale;
  // Extracted-token fonts are a vision read — labeled approximate. Legacy
  // prose-only boards keep the prior (unlabeled) output.
  const approximateFontNote = direction.tokens
    ? `\n\n> _${APPROXIMATE_FONT_NOTE}_`
    : "";

  const rows = SWATCHES.map((swatch) => {
    const hex = vars[swatch.key];
    const name = swatchName(direction, swatch.paletteRole, swatch.label);
    const contrast = contrastVsBackground(hex, vars.background);
    return `| ${swatch.label} | ${name} | \`${hex}\` | ${contrast} |`;
  }).join("\n");

  // The unbounded PRIMITIVE layer: every brand color as a hue-named handle, so
  // "use the pink" resolves and no read color is lost. Omitted when absent.
  const brandSection =
    vars.brand.length > 0
      ? `\n\n## Brand Colors\n\nHue-named handles for every brand color the tile used — reference \`var(--brand-<name>)\` (the primitive layer beneath the semantic roles above).\n\n| Handle | Hex | Printed label | Contrast vs background |\n|--------|-----|---------------|------------------------|\n${vars.brand
          .map(
            (b) =>
              `| \`--brand-${b.name}\` | \`${b.hex}\` | ${b.label ?? "—"} | ${contrastVsBackground(b.hex, vars.background)} |`,
          )
          .join("\n")}`
      : "";

  const body = `# Palette & Type (exact)

The **exact**, copyable token values for **${direction.name}** — a deterministic
projection of the approved direction's tokens. These hexes and font families
match \`brand.css\` byte-for-byte; use them verbatim (imagery is best-effort
against this reference, not the other way around).

## Palette

| Role | Name | Hex | Contrast vs background |
|------|------|-----|------------------------|
${rows}${brandSection}

## Typography

- **Heading:** ${vars.fontHeadingFamily} — \`--brand-font-heading: ${vars.fontHeading}\`
- **Body:** ${vars.fontBodyFamily} — \`--brand-font-body: ${vars.fontBody}\`${
    scale !== undefined ? `\n- **Type scale:** ${scale}` : ""
  }${approximateFontNote}

## Shape

- **Radius:** \`${vars.radius}\` — use \`var(--brand-radius)\`
- **Spacing unit:** \`${vars.spacingUnit}\` — use \`var(--brand-spacing-unit)\`

## Specimen

> ${SPECIMEN}
`;

  return stamp ? `${stampComment(stamp)}\n\n${body}` : body;
}

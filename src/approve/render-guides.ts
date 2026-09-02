import type {
  DirectionContent,
  DirectionCharacter,
  KeyartConfig,
  DirectionTokens,
  BrandColorToken,
  PaletteRole,
} from "../types.js";
import type { GlobalRule } from "../brand/schema.js";
import {
  assembleContext,
  renderContextBlock,
} from "../brand/assemble-context.js";

/**
 * The structured {@link DirectionCharacter} fields, in canonical output order,
 * paired with their human labels. Color/type live ONLY in `tokens`, so there is
 * no field here that could restate a hex or font family.
 */
const CHARACTER_FIELDS: readonly [keyof DirectionCharacter, string][] = [
  ["mood", "Mood"],
  ["composition", "Composition"],
  ["layout", "Layout"],
  ["imagery", "Imagery"],
  ["texture", "Texture"],
  ["rhythm", "Rhythm"],
];

/** The present (non-empty) character fields as `[label, value]` pairs. */
function presentCharacterFields(
  character: DirectionCharacter,
): [string, string][] {
  return CHARACTER_FIELDS.filter(
    ([key]) =>
      typeof character[key] === "string" && character[key]!.trim().length > 0,
  ).map(([key, label]) => [label, character[key]!.trim()]);
}

/**
 * Render the evocative {@link DirectionCharacter} as a readable definition list
 * (one labeled bullet per present field) for the `## Visual Style` sections of
 * the guides / cursor rule / implementation brief. Empty fields are omitted; a
 * fully-empty character yields a single honest placeholder line.
 */
export function renderCharacter(character: DirectionCharacter): string {
  const present = presentCharacterFields(character);
  if (present.length === 0) {
    return "_No visual character captured — re-run explore to populate it._";
  }
  return present.map(([label, value]) => `- **${label}:** ${value}`).join("\n");
}

/**
 * A compact one-line character summary for inline contexts (e.g. the page-brief
 * Cursor-prompt line) where a multi-line definition list would not fit. Joins the
 * present field values in canonical order.
 */
export function characterSummary(character: DirectionCharacter): string {
  return presentCharacterFields(character)
    .map(([, value]) => value)
    .join(" ");
}

/**
 * Source provenance for a generated artifact — stamped into every codified
 * guide so a stale artifact after a pointer change (rebrand) is detectable.
 */
export interface SourceStamp {
  directionId: string;
  versionId: string;
  approvedAt: string; // ISO 8601
}

/**
 * The approve-codified asset pack, projected into the implementation brief +
 * cursor rules so a coding agent is TOLD the shipped assets exist (it should
 * copy them, never recreate or prompt for new artwork). Declared structurally
 * here (not imported from `src/asset/`) because `src/asset/pack.ts` already
 * imports this module — an import back would be a cycle.
 */
export interface GuideAssetPack {
  /** The pack folder, cwd-relative with forward slashes (e.g. `brand/generated/asset-pack/direction-a`). */
  packDir: string;
  items: {
    id: string;
    name: string;
    description: string;
    pending: boolean;
    /** Pack-dir-relative filename (`<id>.png`) — absent while pending. */
    file?: string;
  }[];
}

/**
 * One resolved slot row projected into the guides (surface-manifest WS-07).
 * Declared structurally here (not imported from `src/surface/`) because
 * `src/surface/bind.ts` imports `resolveBrandVars` from this module — an
 * import back would be a cycle (the `GuideAssetPack` precedent).
 */
export interface GuideSurfaceSlotRow {
  id: string;
  kind: string; // "icon" | "illustration" | "color-role" | "type-role" | "other"
  status: "bound" | "derived" | "gap" | "pending";
  /** Resolved token value (color/type roles) — e.g. "#1a6b54" or a font family. */
  value?: string;
  /** Pack file path for a bound asset slot (cwd-relative, forward slashes). */
  file?: string;
  svgFile?: string;
  origin: "authored" | "scan" | "request";
  attributionCount: number;
  /** kind:"other" taxonomy-demand note, when present. */
  note?: string;
}

export interface GuideSurface {
  /** cwd-relative binding.json path, forward slashes. */
  bindingPath: string;
  rows: GuideSurfaceSlotRow[];
}

/** Optional projection inputs threaded through the text renderers. */
export interface GuideRenderOptions {
  stamp?: SourceStamp;
  /** Global HARD rules — rendered as a non-negotiable section before design rules. */
  hardRules?: GlobalRule[];
  /** The approve-codified asset pack; section omitted when absent or empty. */
  assetPack?: GuideAssetPack;
  /** Surface bindings + request protocol; sections render ONLY when a manifest exists. */
  surface?: GuideSurface;
}

/**
 * Honesty label for the emitted font vars. Type is a vision read of the
 * generated imagery mapped to the nearest real, loadable family — an approximate
 * match, never an exact identification. Emitted (as a comment/caption) alongside
 * the font values in every EXTRACTED-token artifact (`brand.css` + the board);
 * the legacy prose/keyword fallback is intentionally NOT labeled (a different,
 * keyword-guessed heuristic) so its output stays byte-compatible. This is a plain
 * annotation only — it never touches the `--brand-*` var names/values.
 */
export const APPROXIMATE_FONT_NOTE =
  "Fonts are an approximate match to the generated imagery — the nearest real, loadable family, not an exact identification.";

/** Deterministic provenance comment line for markdown/`.mdc` artifacts. */
export function stampComment(stamp: SourceStamp): string {
  return `<!-- Source: direction=${stamp.directionId} version=${stamp.versionId} approved=${stamp.approvedAt} | Generated by Keyart — do not edit by hand. -->`;
}

/** Prepends the markdown provenance stamp (omitted cleanly when no stamp). */
function prependStamp(body: string, stamp?: SourceStamp): string {
  if (!stamp) return body;
  return `${stampComment(stamp)}\n\n${body}`;
}

/**
 * Renders the global HARD rules as a non-negotiable section. Composed through
 * the WS-03 `assembleContext`/`renderContextBlock` chokepoint so wording +
 * precedence match the model-facing context exactly (no re-derivation). Returns
 * "" when there are no hard rules.
 */
function hardRulesSection(hardRules?: GlobalRule[]): string {
  if (!hardRules || hardRules.length === 0) return "";
  const assembled = assembleContext({
    brief: "",
    global: {
      approvedPointer: null,
      rules: hardRules,
      version: 0,
      createdAt: "",
      updatedAt: "",
    },
    memory: [],
  });
  const block = renderContextBlock(assembled);
  // renderContextBlock always appends a "## Brief" section; drop it — guides
  // carry the direction body themselves.
  const briefIdx = block.indexOf("\n\n## Brief");
  return briefIdx >= 0 ? block.slice(0, briefIdx) : block;
}

/** Inserts `section` directly after the document's `# ` title (before design rules). */
function injectAfterTitle(body: string, section: string): string {
  if (!section) return body;
  const lines = body.split("\n");
  const titleIdx = lines.findIndex((l) => l.startsWith("# "));
  if (titleIdx < 0) return `${section}\n\n${body}`;
  const head = lines.slice(0, titleIdx + 1);
  const tail = lines.slice(titleIdx + 1);
  while (tail.length && tail[0] === "") tail.shift();
  return [...head, "", section, "", ...tail].join("\n");
}

/** Inserts the stamp as a comment line directly under the `.mdc` frontmatter block. */
function injectCursorStamp(body: string, stamp?: SourceStamp): string {
  if (!stamp) return body;
  const comment = stampComment(stamp);
  const lines = body.split("\n");
  let delimiters = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      delimiters++;
      if (delimiters === 2) {
        lines.splice(i + 1, 0, "", comment);
        return lines.join("\n");
      }
    }
  }
  return `${comment}\n\n${body}`;
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function imperativeList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function replacePlaceholders(
  template: string,
  direction: DirectionContent,
  project?: KeyartConfig["project"],
): string {
  let result = template;
  result = result.replace(/\{\{directionName\}\}/g, direction.name);
  result = result.replace(/\{\{summary\}\}/g, direction.summary);
  result = result.replace(/\{\{positioning\}\}/g, direction.positioning);
  result = result.replace(
    /\{\{character\}\}/g,
    renderCharacter(direction.character),
  );
  result = result.replace(
    /\{\{designRulesList\}\}/g,
    imperativeList(direction.usage.rules),
  );
  result = result.replace(
    /\{\{antiRulesList\}\}/g,
    imperativeList(direction.usage.antiRules),
  );
  result = result.replace(
    /\{\{copyHeadline\}\}/g,
    direction.copyExamples.headline,
  );
  result = result.replace(
    /\{\{copySubheadline\}\}/g,
    direction.copyExamples.subheadline,
  );
  result = result.replace(/\{\{copyCta\}\}/g, direction.copyExamples.cta);
  if (project) {
    result = result.replace(/\{\{projectName\}\}/g, project.name);
  }
  return result;
}

const VISUAL_STYLE_GUIDE_TEMPLATE = `# Visual Style Guide — {{directionName}}

> {{summary}}

## Positioning

{{positioning}}

## Visual Style

{{character}}

## Design Rules

{{designRulesList}}

## Anti-Rules

{{antiRulesList}}

## Copy Examples

| Element | Example |
|---------|---------|
| Headline | {{copyHeadline}} |
| Subheadline | {{copySubheadline}} |
| CTA | {{copyCta}} |

## Image Prompt References

- **Style tile prompt:** see \`brand/approved/style-tile-prompt.md\`
- **Homepage mockup prompt:** see \`brand/approved/homepage-mockup-prompt.md\`
`;

const BRAND_GUIDE_TEMPLATE = `# Brand Guide — {{directionName}}

## Brand Summary

{{summary}}

## Positioning

{{positioning}}

## Visual Style

{{character}}

## Design Principles

{{designRulesList}}

## What to Avoid

{{antiRulesList}}

## Voice & Tone

The brand voice is reflected in these copy examples:

- **Headline:** {{copyHeadline}}
- **Subheadline:** {{copySubheadline}}
- **Call to action:** {{copyCta}}

Use direct, confident language. Match the energy of the examples above — avoid generic or overly formal phrasing.
`;

const CURSOR_RULES_TEMPLATE = `---
description: Brand visual system rules for {{projectName}}. Apply to all UI components, pages, and styling.
globs: ["**/*.tsx", "**/*.css", "**/*.scss", "**/*.module.css"]
---

# {{directionName}} — Cursor Brand Rules

## Visual Style

{{character}}

## Positioning

{{positioning}}

## Design Rules

{{designRulesList}}

## Anti-Rules (Never Do This)

{{antiRulesList}}

## Copy Voice

- Headline example: "{{copyHeadline}}"
- Subheadline example: "{{copySubheadline}}"
- CTA example: "{{copyCta}}"

## CSS Variables

Reference \`brand.css\` for canonical token values. Use \`var(--brand-*)\` tokens instead of hardcoded colors, fonts, or spacing values.
`;

export function renderVisualStyleGuide(
  direction: DirectionContent,
  opts: GuideRenderOptions = {},
): string {
  let body = replacePlaceholders(VISUAL_STYLE_GUIDE_TEMPLATE, direction);
  body = injectAfterTitle(body, hardRulesSection(opts.hardRules));
  return prependStamp(body, opts.stamp);
}

export function renderBrandGuide(
  direction: DirectionContent,
  opts: GuideRenderOptions = {},
): string {
  let body = replacePlaceholders(BRAND_GUIDE_TEMPLATE, direction);
  body = injectAfterTitle(body, hardRulesSection(opts.hardRules));
  return prependStamp(body, opts.stamp);
}

/**
 * A concrete token legend for the Cursor rule: the semantic roles an agent
 * reaches for by function, plus the unbounded PRIMITIVE handles so a request
 * like "use the pink" resolves to a real `var(--brand-pink)`. Projected from the
 * SAME `resolveBrandVars`, so it can never drift from `brand.css`.
 */
function paletteLegendSection(direction: DirectionContent): string {
  const vars = resolveBrandVars(direction);
  const semantic: [string, string, string][] = [
    ["--brand-primary", vars.primary, "primary actions, key emphasis"],
    ["--brand-secondary", vars.secondary, "secondary emphasis"],
    ["--brand-background", vars.background, "page background"],
    ["--brand-surface", vars.surface, "cards, raised surfaces"],
    ["--brand-text", vars.text, "body text"],
    ["--brand-text-muted", vars.textMuted, "secondary / de-emphasized text"],
  ];
  const rows = semantic
    .map(([name, hex, use]) => `| \`var(${name})\` | \`${hex}\` | ${use} |`)
    .join("\n");
  const primitives =
    vars.brand.length > 0
      ? `\n\nBrand palette handles (one-off color references — e.g. "use the pink"):\n\n${vars.brand
          .map(
            (b) =>
              `- \`var(--brand-${b.name})\` = \`${b.hex}\`${b.label ? ` (${b.label})` : ""}`,
          )
          .join("\n")}`
      : "";
  return `\n\n### Token legend\n\n| Token | Hex | Use |\n|-------|-----|-----|\n${rows}${primitives}`;
}

/**
 * One asset line: `- **id** — "description" → \`packDir/file\``, with pending
 * heads listed honestly (no path — there is no image yet, never fabricated).
 */
function assetLine(
  packDir: string,
  item: GuideAssetPack["items"][number],
): string {
  const label =
    item.name !== item.id ? `**${item.id}** ("${item.name}")` : `**${item.id}**`;
  return item.file
    ? `- ${label} — ${item.description} → \`${packDir}/${item.file}\``
    : `- ${label} — ${item.description} — *pending: no image yet (regenerate with an API key)*`;
}

/**
 * The shipped-assets section for the implementation brief. Empty string when
 * there is no pack or no active assets — the section never renders hollow.
 */
function assetPackSection(assetPack?: GuideAssetPack): string {
  if (!assetPack || assetPack.items.length === 0) return "";
  return `## Brand Assets (shipped — use these files)

Extracted, transparent-background brand assets ship with the approved direction.
**Copy them from the asset pack — do not recreate, redraw, or generate substitutes.**

${assetPack.items.map((i) => assetLine(assetPack.packDir, i)).join("\n")}

Full listing + provenance: \`${assetPack.packDir}/pack-manifest.json\`.

`;
}

/** The compact cursor-rules variant of the shipped-assets section. */
function assetPackCursorSection(assetPack?: GuideAssetPack): string {
  if (!assetPack || assetPack.items.length === 0) return "";
  return `

## Brand Assets

Shipped, ready-to-use brand assets (transparent PNG). Copy these files — never recreate, redraw, or generate a substitute for an asset that exists here:

${assetPack.items.map((i) => assetLine(assetPack.packDir, i)).join("\n")}

Full listing + provenance: \`${assetPack.packDir}/pack-manifest.json\`.
`;
}

/** The Value/File cell for one bindings-table row — status-driven, honest. */
function surfaceValueCell(row: GuideSurfaceSlotRow): string {
  if (row.status === "pending") return "pending generation";
  if (row.value !== undefined) return `\`${row.value}\``;
  if (row.file !== undefined) {
    return `\`${row.file}\`${row.svgFile ? " (+ svg)" : ""}`;
  }
  return "—";
}

/** One open-gaps bullet — taxonomy demand for `kind: "other"`, else kind +
 *  origin (+ request count when the origin is a request with attributions). */
function surfaceGapLine(row: GuideSurfaceSlotRow): string {
  if (row.kind === "other") {
    return `- \`${row.id}\` — other (taxonomy demand): "${row.note ?? ""}"`;
  }
  const requested =
    row.origin === "request" && row.attributionCount > 0
      ? `, requested ${row.attributionCount}×`
      : "";
  return `- \`${row.id}\` — ${row.kind}, origin: ${row.origin}${requested}`;
}

/**
 * The compact Surface Bindings table + open-gaps list — the `assetPackSection`
 * precedent for the surface-manifest demand-side projection (WS-07). Empty
 * string when there is no manifest; renders even at zero gaps (the protocol
 * teaches FUTURE misses). Rows render in manifest order, exactly as bind
 * delivered them — never re-sorted here.
 */
function surfaceBindingsSection(surface?: GuideSurface): string {
  if (!surface) return "";
  const tableBody = surface.rows
    .map(
      (r) => `| \`${r.id}\` | ${r.kind} | ${r.status} | ${surfaceValueCell(r)} |`,
    )
    .join("\n");
  const openGaps = surface.rows.filter(
    (r) => r.status === "gap" || r.status === "pending",
  );
  const gapsList =
    openGaps.length === 0
      ? "- None — every slot resolved."
      : openGaps.map(surfaceGapLine).join("\n");
  return `## Surface Bindings (slot → value)

The app's declared styleable slots, resolved against this approved direction.
The machine-readable lockfile is \`${surface.bindingPath}\` — read values by slot id from it, never improvise.

| Slot | Kind | Status | Value / File |
|------|------|--------|--------------|
${tableBody}

Open gaps (not yet suppliable by the approved brand):

${gapsList}

`;
}

/**
 * The ~5-line imperative surface-request protocol — identical wording in the
 * implementation brief and the cursor rules (one protocol, taught twice).
 * Empty string when there is no manifest.
 */
function surfaceRequestProtocolSection(surface?: GuideSurface): string {
  if (!surface) return "";
  return `## Surface Requests (when a brand element is missing)

- Need a brand element (icon, illustration, color role, type role) that is NOT in the bindings table or the asset pack? Do NOT invent one.
- Register the miss instead: call \`keyart_brand { command: "surface", input: ["request", "<json>"] }\`.
- The JSON is one slot, e.g. \`{ "id": "icon.scooter", "kind": "icon", "description": "delivery scooter marker", "criticality": "preferred", "context": { "sitsOn": "surface", "usedIn": ["order-tracking"] } }\` (valid kinds: icon, illustration, color-role, type-role, other).
- Re-requesting an existing id is safe — it appends an attribution, never a duplicate slot.
- Use a neutral placeholder and continue; the request appears in the next gap report for a human to fill. NEVER ship an improvised off-brand value.

`;
}

export function renderCursorRules(
  direction: DirectionContent,
  project: KeyartConfig["project"],
  opts: GuideRenderOptions = {},
): string {
  let body = replacePlaceholders(CURSOR_RULES_TEMPLATE, direction, project);
  body = body.replace(
    "Use `var(--brand-*)` tokens instead of hardcoded colors, fonts, or spacing values.",
    `Use \`var(--brand-*)\` tokens instead of hardcoded colors, fonts, or spacing values.${paletteLegendSection(direction)}`,
  );
  body = injectAfterTitle(body, hardRulesSection(opts.hardRules));
  const assetsSection = assetPackCursorSection(opts.assetPack);
  if (assetsSection !== "") {
    body = `${body.replace(/\n+$/, "\n")}${assetsSection}`;
  }
  const surfaceSection = `${surfaceBindingsSection(opts.surface)}${surfaceRequestProtocolSection(opts.surface)}`;
  if (surfaceSection !== "") {
    body = `${body.replace(/\n+$/, "\n")}\n\n${surfaceSection.replace(/\n+$/, "\n")}`;
  }
  return injectCursorStamp(body, opts.stamp);
}

export function renderImagePrompts(direction: DirectionContent): string {
  return `# Image Prompts — ${direction.name}

## Style Tile

${direction.styleTilePrompt}

## Homepage Mockup

${direction.homepageMockupPrompt}
`;
}

export function renderImplementationBrief(
  direction: DirectionContent,
  project: KeyartConfig["project"],
  opts: GuideRenderOptions = {},
): string {
  const body = `# Implementation Brief — ${project.name}

## Approved Direction: ${direction.name}

${direction.summary}

## Visual Style

${renderCharacter(direction.character)}

## Design Rules to Implement

${bulletList(direction.usage.rules)}

## Anti-Rules to Enforce

${bulletList(direction.usage.antiRules)}

## Copy Guidelines

- Headline tone: "${direction.copyExamples.headline}"
- Subheadline tone: "${direction.copyExamples.subheadline}"
- CTA style: "${direction.copyExamples.cta}"

${assetPackSection(opts.assetPack)}${surfaceBindingsSection(opts.surface)}${surfaceRequestProtocolSection(opts.surface)}## References

- Visual style guide: \`brand/guides/visual-style-guide.md\`
- Brand guide: \`brand/guides/brand-guide.md\`
- CSS variables: \`brand/generated/brand.css\`
- Cursor rules: \`brand/generated/cursor-brand.mdc\`${
    opts.assetPack
      ? `\n- Asset pack: \`${opts.assetPack.packDir}/\` (assets + contact sheet + DTCG \`tokens.json\` + \`pack-manifest.json\`)`
      : ""
  }${
    opts.surface
      ? `\n- Surface bindings: \`${opts.surface.bindingPath}\` (slot → value/file lockfile + gap report)`
      : ""
  }
`;
  return prependStamp(
    injectAfterTitle(body, hardRulesSection(opts.hardRules)),
    opts.stamp,
  );
}

/**
 * The resolved `--brand-*` values for a direction. Both the raw font family
 * names (`font*Family`) and the css-ready stacks (`font*`) are exposed so the
 * deterministic style board can show the bare families while `brand.css` emits
 * the fallback stacks — the raw family is always a substring of its stack, and
 * both derive from the SAME source, so the board can never drift from the CSS.
 */
export interface BrandVars {
  primary: string;
  secondary: string;
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  /** CSS-ready font-family stacks (what `brand.css` emits). */
  fontHeading: string;
  fontBody: string;
  /** Raw family names (what the board displays, e.g. "Space Grotesk"). */
  fontHeadingFamily: string;
  fontBodyFamily: string;
  radius: string;
  spacingUnit: string;
  /** The unbounded PRIMITIVE brand set (hue-named handles) — the two-tier lower
   * layer projected as `--brand-<name>` vars. Empty for legacy/keyless tokens. */
  brand: BrandColorToken[];
}

/** Wrap a bare family in the canonical fallback stack (matches legacy quoting). */
function fontStack(family: string): string {
  return `'${family}', system-ui, sans-serif`;
}

/** Neutral per-var fallback — defends against a role somehow absent from
 * `tokens.palette` (the engine always emits all six) so we never emit
 * `undefined` into the CSS. */
const ROLE_FALLBACK = {
  primary: "#1a1a2e",
  secondary: "#16213e",
  background: "#ffffff",
  surface: "#f8f9fa",
  text: "#1a1a2e",
  textMuted: "#6c757d",
} as const;

/**
 * Derive `--brand-*` values directly from a direction's structured tokens: the
 * six palette roles → the six color vars (`muted` → `--brand-text-muted`),
 * the heading/body families → the two font vars (wrapped in the fallback stack),
 * and the shape radius/spacing. A missing role (shouldn't happen — the engine
 * always emits all six, but defended) falls back to that var's neutral default
 * so we never emit `undefined`.
 */
function tokenBrandVars(tokens: DirectionTokens): BrandVars {
  const byRole = new Map<PaletteRole, string>(
    tokens.palette.map((t) => [t.role, t.hex]),
  );
  const heading = tokens.typography.heading;
  const body = tokens.typography.body;
  return {
    primary: byRole.get("primary") ?? ROLE_FALLBACK.primary,
    secondary: byRole.get("secondary") ?? ROLE_FALLBACK.secondary,
    background: byRole.get("background") ?? ROLE_FALLBACK.background,
    surface: byRole.get("surface") ?? ROLE_FALLBACK.surface,
    text: byRole.get("text") ?? ROLE_FALLBACK.text,
    textMuted: byRole.get("muted") ?? ROLE_FALLBACK.textMuted,
    fontHeading: fontStack(heading),
    fontBody: fontStack(body),
    fontHeadingFamily: heading,
    fontBodyFamily: body,
    radius: tokens.shape.radius,
    spacingUnit: tokens.shape.spacingUnit,
    brand: tokens.brand ?? [],
  };
}

/**
 * SINGLE source of the `--brand-*` values, consumed by BOTH `renderBrandCss` and
 * the deterministic style board so their hex/font values can never disagree.
 * Always token-derived — a direction MUST carry extracted tokens (re-run
 * `explore`/`regenerate` if it doesn't); we fail loudly rather than silently
 * inventing a palette from prose.
 */
export function resolveBrandVars(direction: DirectionContent): BrandVars {
  if (!direction.tokens) {
    throw new Error(
      `Direction "${direction.name}" has no structured tokens — re-run explore/regenerate to extract them before approving.`,
    );
  }
  return tokenBrandVars(direction.tokens);
}

export function renderBrandCss(
  direction: DirectionContent,
  stamp?: SourceStamp,
): string {
  const vars = resolveBrandVars(direction);

  const header = [
    `/* Brand CSS Variables — ${direction.name} */`,
    `/* Generated by Keyart. Do not edit manually. */`,
  ];
  if (stamp) {
    header.push(
      `/* Source: direction=${stamp.directionId} version=${stamp.versionId} approved=${stamp.approvedAt} */`,
    );
  }

  // The approximate-font honesty label is emitted only for EXTRACTED-token
  // directions (whose fonts are a vision read); the legacy prose fallback stays
  // unlabeled and byte-compatible. It is a comment ABOVE the vars — the
  // `--brand-*` names/values are byte-stable (the var contract never changes).
  const typographyBlock = direction.tokens
    ? `  /* Typography */
  /* ${APPROXIMATE_FONT_NOTE} */
  --brand-font-heading: ${vars.fontHeading};
  --brand-font-body: ${vars.fontBody};`
    : `  /* Typography */
  --brand-font-heading: ${vars.fontHeading};
  --brand-font-body: ${vars.fontBody};`;

  // The two-tier PRIMITIVE layer: hue-named handles for every brand color, so a
  // human can say "use the pink" and an agent can resolve it. Additive — the
  // semantic --brand-<role> vars above stay the stable contract; these are extra
  // handles at the same hex values. Emitted only when the read produced them.
  const primitivesBlock =
    vars.brand.length > 0
      ? `\n  /* Brand primitives — hue-named handles for one-off color references.
     Prefer the semantic --brand-* roles above for UI; each handle is the same
     value as the role it may back (e.g. --brand-primary). */
${vars.brand
  .map(
    (b) =>
      `  --brand-${b.name}: ${b.hex};${b.label ? ` /* ${b.label} */` : ""}`,
  )
  .join("\n")}\n`
      : "";

  return `${header.join("\n")}

:root {
  /* Colors */
  --brand-primary: ${vars.primary};
  --brand-secondary: ${vars.secondary};
  --brand-background: ${vars.background};
  --brand-surface: ${vars.surface};
  --brand-text: ${vars.text};
  --brand-text-muted: ${vars.textMuted};
${primitivesBlock}
${typographyBlock}

  /* Spacing & Shape */
  --brand-radius: ${vars.radius};
  --brand-spacing-unit: ${vars.spacingUnit};
}
`;
}

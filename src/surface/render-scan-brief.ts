import { SLOT_KINDS, SURFACE_MANIFEST_JSON_SCHEMA } from "./schema.js";
import type { SlotKind, SurfaceManifest, SurfaceSlot } from "./schema.js";

interface TaxonomyEntry {
  definition: string;
  guidance: string;
  example: SurfaceSlot;
}

/** One worked example per kind — literal constants, no clock/randomness. */
const TAXONOMY_BY_KIND: Record<SlotKind, TaxonomyEntry> = {
  icon: {
    definition: "A small glyph-scale symbol.",
    guidance:
      "Choose `icon` when the slot renders at glyph scale (roughly 12–48px) and is " +
      "usually monochrome/currentColor. Prefer `illustration` once the art carries its " +
      "own multi-color detail or reads as a scene rather than a mark.",
    example: {
      id: "icon.restaurant",
      kind: "icon",
      description: "Fork-and-knife glyph marking a restaurant listing.",
      context: { sitsOn: "surface", sizes: [16, 24], usedIn: ["nav", "listing-card"] },
      criticality: "required",
      origin: "authored",
      attributions: [],
    },
  },
  illustration: {
    definition: "Larger pictorial art.",
    guidance:
      "Choose `illustration` for larger pictorial art — empty states, hero scenes, " +
      "onboarding art — where composition and color detail matter beyond a single " +
      "monochrome mark. Prefer `icon` once the art shrinks to glyph scale.",
    example: {
      id: "illustration.empty-cart",
      kind: "illustration",
      description: "Full-color scene shown when the cart has no items.",
      context: { sitsOn: "background", sizes: [240], usedIn: ["empty-state"] },
      criticality: "preferred",
      origin: "authored",
      attributions: [],
    },
  },
  "color-role": {
    definition: "A named color need beyond the six semantic roles.",
    guidance:
      "Choose `color-role` when a design need requires a color the six semantic " +
      "roles (background/surface/text/muted/primary/secondary) don't name — a chart " +
      "series accent, a status color. Do not use it to re-request a semantic role.",
    example: {
      id: "color-role.chart-accent",
      kind: "color-role",
      description: "Accent color distinguishing the highlighted series in charts.",
      context: { usedIn: ["analytics-dashboard"], tone: "vivid, high-contrast" },
      criticality: "preferred",
      origin: "authored",
      attributions: [],
    },
  },
  "type-role": {
    definition: "A named typographic need beyond heading/body.",
    guidance:
      "Choose `type-role` when copy needs a typographic treatment the heading/body " +
      "pairing in `brand.css` doesn't cover — a large stat numeral, a monospace code " +
      "voice. Do not use it to re-request heading or body.",
    example: {
      id: "type-role.stat-numeral",
      kind: "type-role",
      description: "Large numeral treatment for headline dashboard stats.",
      context: { usedIn: ["dashboard-stat-tile"], tone: "bold, tabular" },
      criticality: "preferred",
      origin: "authored",
      attributions: [],
    },
  },
  other: {
    definition: "Anything unfittable in the four named kinds.",
    guidance:
      "`other` is legal, but say why in `context.note` — it is recorded as demand on " +
      "the taxonomy itself and surfaced in the next gap report. Prefer a named kind " +
      "whenever one genuinely fits.",
    example: {
      id: "other.sound-motif",
      kind: "other",
      description: "Ambient sound motif played on first load.",
      context: { note: "ambient sound motif — no visual kind fits audio" },
      criticality: "preferred",
      origin: "authored",
      attributions: [],
    },
  },
};

function renderWhatThisIs(): string {
  return [
    "## What this is",
    "",
    "The surface manifest inventories every styleable slot the consuming app has.",
    "Keyart owns the structure (this schema); host agents author content against it.",
    "Writes go through `surface set`, `surface patch`, and `surface request` and are",
    "validated with teaching rejections — an unknown kind or malformed id is rejected",
    "with a message naming the fix, never silently accepted.",
  ].join("\n");
}

function renderJsonSchema(): string {
  return [
    "## JSON Schema",
    "",
    "```json",
    JSON.stringify(SURFACE_MANIFEST_JSON_SCHEMA, null, 2),
    "```",
  ].join("\n");
}

function renderTaxonomy(): string {
  const lines = ["## Taxonomy", ""];
  for (const kind of SLOT_KINDS) {
    const entry = TAXONOMY_BY_KIND[kind];
    lines.push(`### ${kind}`, "", entry.definition, "", entry.guidance, "");
    lines.push("```json", JSON.stringify(entry.example, null, 2), "```", "");
  }
  return lines.join("\n").trimEnd();
}

function renderWhatToIgnore(): string {
  return [
    "## What to ignore",
    "",
    "- Spacer/tracking images that carry no visible content.",
    "- Third-party widget internals (embeds, payment widgets, analytics pixels).",
    "- One-off inline styles that aren't reused as a design decision.",
    "- Focus/hover state variants of a slot already listed — record the base slot only.",
    "- Anything already supplied by the six semantic color roles or the heading/body",
    "  pairing already in `brand.css`.",
  ].join("\n");
}

function renderCurrentManifest(manifest: SurfaceManifest | null): string {
  if (manifest === null) {
    return [
      "## Current manifest",
      "",
      "No manifest exists yet. The first `surface set` creates `brand/surface.yaml`.",
    ].join("\n");
  }
  return [
    "## Current manifest",
    "",
    "Propose only deltas against this manifest — retired slots are included so a",
    "diff-aware re-scan does not re-propose them.",
    "",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
  ].join("\n");
}

/** The in-band vocabulary contract published by `surface schema` (WS-02) and
 *  embedded (abridged) in the codified guides (WS-07). PURE and DETERMINISTIC:
 *  same input ⇒ byte-identical output. No clock, no randomness, no I/O, no
 *  model call. */
export function renderScanBrief(manifest: SurfaceManifest | null): string {
  return [
    renderWhatThisIs(),
    renderJsonSchema(),
    renderTaxonomy(),
    renderWhatToIgnore(),
    renderCurrentManifest(manifest),
  ].join("\n\n");
}

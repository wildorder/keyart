import path from "node:path";
import { loadConfig } from "../config.js";
import { resolveDirection } from "../direction/store.js";
import { resolveFoundation } from "../direction/foundation.js";
import { runReviseDirection } from "./regenerate-visuals.js";
import { CommandError } from "../errors.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";
import type {
  DirectionCharacter,
  DirectionContent,
  DirectionTokens,
  DirectionUsage,
  PaletteRole,
} from "../types.js";

/**
 * The user-editable subset of a {@link DirectionContent}. `id` and the version's
 * provenance are NEVER edited here. Saving appends a new foundation with its own
 * tile generation; historical versions and images remain untouched.
 */
export interface DirectionEdits {
  name?: string;
  summary?: string;
  positioning?: string;
  // The studio's structured character/usage editor writes these (WS-05); they
  // replaced the old freeform visualStyle/designRules/antiRules edit fields.
  character?: DirectionCharacter;
  usage?: DirectionUsage;
  copyExamples?: { headline?: string; subheadline?: string; cta?: string };
  styleTilePrompt?: string;
  /**
   * Structured design tokens (palette + typography + shape). When provided they
   * Seed a new foundation after validation. Palette edits become verbatim user
   * locks; when a tile renders its typography is transcribed from that new tile.
   */
  tokens?: DirectionTokens;
}

export interface EditDirectionResult {
  directionId: string;
  versionId: string; // the new foundation version; the source remains immutable
  filesWritten: string[]; // cwd-relative, forward slashes
}

export interface SaveVariantResult {
  directionId: string; // the SAME direction — a variant is a new VERSION of it
  versionId: string; // the NEW version appended (the new head)
  filesWritten: string[];
}

/** Trim string entries and drop the empties from a rules array. */
function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v !== "");
}

/** The six semantic palette roles every token set must carry. */
const ALL_ROLES: PaletteRole[] = [
  "primary",
  "secondary",
  "background",
  "surface",
  "text",
  "muted",
];

/** #rgb or #rrggbb. */
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Every real, loadable family in the curated catalog (heading + body). */
const KNOWN_FAMILIES = new Set<string>();
for (const p of FONT_PAIRINGS) {
  KNOWN_FAMILIES.add(p.heading);
  KNOWN_FAMILIES.add(p.body);
}

/**
 * Reject a token set that would corrupt a direction's look: all six semantic
 * palette roles must be present with a valid hex, both font families must come from the
 * curated catalog (never a free-typed / hallucinated family), and the shape
 * lengths must be non-empty. Throws a CommandError enumerating every problem.
 */
function validateTokens(tokens: DirectionTokens): void {
  const problems: string[] = [];

  if (!Array.isArray(tokens.palette)) {
    problems.push("palette must be an array of role tokens");
  } else {
    for (const role of ALL_ROLES) {
      const token = tokens.palette.find((t) => t.role === role);
      if (!token) {
        problems.push(`palette is missing the "${role}" role`);
      } else if (typeof token.hex !== "string" || !HEX_RE.test(token.hex.trim())) {
        problems.push(`palette "${role}" needs a #rrggbb hex`);
      }
    }
  }

  const typography = tokens.typography;
  if (!typography || !KNOWN_FAMILIES.has(typography.heading)) {
    problems.push("heading font must be a family from the curated catalog");
  }
  if (!typography || !KNOWN_FAMILIES.has(typography.body)) {
    problems.push("body font must be a family from the curated catalog");
  }

  const shape = tokens.shape;
  if (!shape || typeof shape.radius !== "string" || shape.radius.trim() === "") {
    problems.push("shape.radius is required");
  }
  if (!shape || typeof shape.spacingUnit !== "string" || shape.spacingUnit.trim() === "") {
    problems.push("shape.spacingUnit is required");
  }

  if (problems.length > 0) {
    throw new CommandError(`Cannot save tokens: ${problems.join("; ")}.`);
  }
}

/** Merge edits over a base direction, preserving id + untouched fields. */
function applyEdits<T extends DirectionContent>(
  base: T,
  edits: DirectionEdits,
): T {
  const next: T = {
    ...base,
    name: edits.name?.trim() ?? base.name,
    summary: edits.summary?.trim() ?? base.summary,
    positioning: edits.positioning?.trim() ?? base.positioning,
    character: edits.character ?? base.character,
    styleTilePrompt: edits.styleTilePrompt?.trim() ?? base.styleTilePrompt,
    usage: edits.usage
      ? {
          rules: cleanList(edits.usage.rules),
          antiRules: cleanList(edits.usage.antiRules),
        }
      : base.usage,
    copyExamples: {
      headline: edits.copyExamples?.headline ?? base.copyExamples.headline,
      subheadline: edits.copyExamples?.subheadline ?? base.copyExamples.subheadline,
      cta: edits.copyExamples?.cta ?? base.copyExamples.cta,
    },
  };
  // Structured tokens replace the direction's wholesale (validated first); a
  // token-less edit leaves `base.tokens` (spread above) untouched.
  if (edits.tokens !== undefined) {
    validateTokens(edits.tokens);
    next.tokens = edits.tokens;
  }
  return next;
}

/** Reject an edited direction that would break the schema minimums. */
function assertValid(d: DirectionContent): void {
  const problems: string[] = [];
  if (!d.name.trim()) problems.push("name is required");
  if (!d.summary.trim()) problems.push("summary is required");
  if (!d.positioning.trim()) problems.push("positioning is required");
  // WS-01: character is all-optional and usage carries no minimum counts (SC-09),
  // so nothing further to assert here beyond the identity/strategy fields.
  if (problems.length > 0) {
    throw new CommandError(`Cannot save direction: ${problems.join("; ")}.`);
  }
}

/** Saving a changed look appends a foundation and generates its own tile when keyed. */
export async function runEditDirection(opts: {
  cwd: string;
  directionId: string;
  versionId?: string;
  edits: DirectionEdits;
}): Promise<EditDirectionResult> {
  const cwd = path.resolve(opts.cwd);
  const config = await loadConfig(opts.cwd);
  const direction = await resolveDirection(cwd, config, opts.directionId);
  const foundation = await resolveFoundation({ cwd, config, directionId: opts.directionId,
    versionId: opts.versionId ?? direction.record.head ?? "" });
  const edited = applyEdits(foundation.content, opts.edits);
  assertValid(edited);
  const written = await runReviseDirection({ cwd, directionId: opts.directionId,
    versionId: foundation.versionId, editedContent: edited,
    lockedColors: opts.edits.tokens?.palette.map(({ role, hex }) => ({ role, hex })) });
  return {
    directionId: opts.directionId,
    versionId: written.versionId,
    filesWritten: written.filesWritten,
  };
}

/**
 * Save the edited fields as a NEW VERSION of the SAME direction (the head
 * advances), using the exact same immutable edit path.
 */
export async function runSaveVariant(opts: {
  cwd: string;
  directionId: string;
  /** Base version to edit from (default: the head). */
  versionId?: string;
  edits: DirectionEdits;
}): Promise<SaveVariantResult> {
  return runEditDirection(opts);
}

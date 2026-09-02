import path from "node:path";
import { loadConfig, directionsRoot } from "../config.js";
import { writeJsonFile } from "../fs.js";
import { writeDirectionVersion } from "../explore/write-direction-version.js";
import { readHead, readVersion, resolveDirection } from "../direction/store.js";
import { CommandError } from "../errors.js";
import { createDirectionCore } from "../direction/core.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";
import type {
  DirectionCharacter,
  DirectionContent,
  DirectionTokens,
  DirectionUsage,
  DirectionVersion,
  PaletteRole,
} from "../types.js";

/**
 * The user-editable subset of a {@link DirectionContent}. `id` and the version's
 * provenance are NEVER edited here (identity is preserved); image files are left
 * untouched (editing text does not regenerate previews).
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
  homepageMockupPrompt?: string;
  /**
   * Structured design tokens (palette + typography + shape). When provided they
   * REPLACE the direction's tokens wholesale after validation — the studio
   * always sends a complete token object (edited palette / catalog font / shape).
   */
  tokens?: DirectionTokens;
}

export interface EditDirectionResult {
  directionId: string;
  versionId: string; // the version whose content was edited (in place)
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
    homepageMockupPrompt:
      edits.homepageMockupPrompt?.trim() ?? base.homepageMockupPrompt,
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

/** Resolve a direction's target version (default: its head). Throws a
 * CommandError naming the direction/version when absent. */
async function resolveVersion(
  directionsDir: string,
  directionId: string,
  versionId: string | undefined,
): Promise<{ versionId: string; version: DirectionVersion }> {
  if (versionId !== undefined) {
    return { versionId, version: await readVersion(directionsDir, directionId, versionId) };
  }
  const version = await readHead(directionsDir, directionId);
  return { versionId: version.id, version };
}

/**
 * In-place edit of a direction VERSION's text fields. Rewrites the target
 * version's `direction-version.json` (default: the head), leaving images, prompt
 * snapshots, memory, and the global brand untouched. Preserves the version's
 * identity + provenance. (In-place head edit — the studio's "save fields".)
 */
export async function runEditDirection(opts: {
  cwd: string;
  directionId: string;
  versionId?: string;
  edits: DirectionEdits;
}): Promise<EditDirectionResult> {
  const cwd = path.resolve(opts.cwd);
  const config = await loadConfig(opts.cwd);
  const rel = (abs: string): string =>
    path.relative(cwd, abs).split(path.sep).join("/");
  const filesWritten: string[] = [];
  const root = directionsRoot(opts.cwd, config);
  await resolveDirection(opts.cwd, config, opts.directionId); // asserts existence

  const { versionId, version } = await resolveVersion(
    root,
    opts.directionId,
    opts.versionId,
  );

  const edited = applyEdits(version, opts.edits);
  assertValid(edited);

  const versionJsonPath = path.join(
    root,
    opts.directionId,
    "versions",
    versionId,
    "direction-version.json",
  );
  await writeJsonFile(versionJsonPath, edited);
  filesWritten.push(rel(versionJsonPath));

  return {
    directionId: opts.directionId,
    versionId,
    filesWritten,
  };
}

/**
 * Save the edited fields as a NEW VERSION of the SAME direction (the head
 * advances), leaving the prior versions untouched (append-only history). This is
 * the "edit-as-new-head" gesture — an edited version rather than an in-place
 * rewrite — and it skips model image generation (no cost / no wait; previews can
 * be regenerated later). Drops the old new-run / lineage variant entirely: a
 * variant is now a new version of the same direction, not a new direction (SC-07).
 */
export async function runSaveVariant(opts: {
  cwd: string;
  directionId: string;
  /** Base version to edit from (default: the head). */
  versionId?: string;
  edits: DirectionEdits;
}): Promise<SaveVariantResult> {
  const cwd = path.resolve(opts.cwd);
  const config = await loadConfig(opts.cwd);
  const root = directionsRoot(opts.cwd, config);
  await resolveDirection(opts.cwd, config, opts.directionId); // asserts existence

  const { versionId: baseVersionId, version: base } = await resolveVersion(
    root,
    opts.directionId,
    opts.versionId,
  );

  const merged = applyEdits(base, opts.edits);
  assertValid(merged);

  // Brief-snapshot source = the RENDERED PROJECTION of the direction's brief
  // (the single chokepoint), never the on-disk `brief.md` as an authored source.
  const core = createDirectionCore(cwd, config);
  const brief = await core.getRenderedBrief(opts.directionId);

  // Build a fresh version from the merged content (strip the base version's
  // identity/provenance; the writer + a new createdAt supply this version's own).
  const { id: _pid, createdAt: _pc, producedBy: _pb, briefSnapshot: _pbs, contextSnapshot: _pcs, ...content } =
    merged;
  const newVersion: DirectionVersion = {
    ...content,
    id: "",
    createdAt: new Date().toISOString(),
    producedBy: "manual edit",
    briefSnapshot: brief,
    contextSnapshot: `## Manual edit\n\nAuthored by hand from ${opts.directionId}@${baseVersionId}.`,
  };
  const written = await writeDirectionVersion({
    cwd,
    directionsDir: root,
    directionId: opts.directionId,
    version: newVersion,
    config,
    referenceImagePaths: [],
    skipImages: true,
  });

  console.log(
    `\nSaved an edited version of "${opts.directionId}" (${written.versionId}).`,
  );
  console.log(`To approve it:\n  keyart approve ${opts.directionId}`);

  return {
    directionId: opts.directionId,
    versionId: written.versionId,
    filesWritten: written.filesWritten,
  };
}

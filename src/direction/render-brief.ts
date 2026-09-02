import type { Audience, BrandBrief } from "./schema.js";

/**
 * Rendered when a brief carries no content at all. A single inviting line —
 * never a wall of empty section headers. Deliberately contains no `#`/`##`
 * heading so an all-empty brief is visually quiet.
 */
const EMPTY_PLACEHOLDER =
  "_No brief yet. Describe this direction's audience, problem, tone, and aesthetic intent._";

/**
 * The soft-intent disclaimer under the Aesthetic intent section. Reinforces
 * SC-06: color/type here are WORDS that steer generation, never an exact hex or
 * font-family spec (those live in tokens / route to memory locks).
 */
const SOFT_INTENT_NOTE =
  "_Soft intent — words that steer generation, never exact hex codes or font families._";

function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

/** `who — context (need: …)`, with each suffix present only when set. */
function audienceLine(a: Audience): string {
  let line = a.who;
  if (a.context && a.context.trim()) line += ` — ${a.context}`;
  if (a.need && a.need.trim()) line += ` (need: ${a.need})`;
  return `- ${line}`;
}

/** A labelled scalar block (`**Label:** value`), or `null` when the value is empty. */
function scalar(label: string, value?: string): string | null {
  return value && value.trim() ? `**${label}:** ${value.trim()}` : null;
}

/** A labelled bullet-list block, or `null` when the array is empty. */
function list(label: string, items: string[]): string | null {
  return items.length > 0 ? `**${label}:**\n${bullets(items)}` : null;
}

/**
 * Assembles a `## `-level section from its blocks. Returns `null` (the whole
 * section is omitted) when every block is empty. `lead` is an optional note
 * printed directly under the heading (used for the soft-intent disclaimer).
 */
function section(
  heading: string,
  blocks: (string | null)[],
  lead?: string,
): string | null {
  const present = blocks.filter((b): b is string => b !== null);
  if (present.length === 0) return null;
  const parts = [`## ${heading}`];
  if (lead) parts.push(lead);
  parts.push(...present);
  return parts.join("\n\n");
}

/**
 * Pure, deterministic `BrandBrief` → canonical markdown. Same input ⇒
 * byte-identical output. No I/O, no `Date`, no model call. The ONE renderer
 * every reader (generation snapshots, studio preview, `brief.md`) consumes.
 *
 * - Emits `## `-level section headings only — NEVER a document H1 titled
 *   "Brief" (the studio already renders that heading; the projection must not
 *   reintroduce the H1 collision).
 * - Omits every empty field and every empty section; an all-empty brief renders
 *   the short {@link EMPTY_PLACEHOLDER}, not a wall of empty headers.
 * - Fixed field/section order and a single trailing newline (both asserted).
 */
export function renderBrief(brief: BrandBrief): string {
  const sections: (string | null)[] = [
    section("Identity", [
      brief.oneLiner && brief.oneLiner.trim() ? brief.oneLiner.trim() : null,
      list("Aliases", brief.aliases),
      list("Never call it", brief.neverCallIt),
    ]),
    section("Strategy", [
      scalar("Problem", brief.problem),
      scalar("Positioning", brief.positioning),
      brief.audiences.length > 0
        ? `**Audiences:**\n${brief.audiences.map(audienceLine).join("\n")}`
        : null,
      list("Differentiate from", brief.differentiateFrom),
    ]),
    section("Personality", [
      list("Tone", brief.tone),
      list("Values", brief.values),
      scalar("Voice", brief.voice),
    ]),
    section(
      "Aesthetic intent",
      [
        scalar("Color intent", brief.colorIntent),
        scalar("Type intent", brief.typeIntent),
        scalar("Mood & imagery", brief.moodImagery),
        scalar("Mascot", brief.mascot),
      ],
      SOFT_INTENT_NOTE,
    ),
    section("Grounding", [
      list("Inspirations", brief.inspirations),
      list("Constraints", brief.constraints),
      list("Surfaces", brief.surfaces),
    ]),
    section("Notes", [
      brief.otherNotes && brief.otherNotes.trim()
        ? brief.otherNotes.trim()
        : null,
    ]),
  ];

  const present = sections.filter((s): s is string => s !== null);
  const body = present.length > 0 ? present.join("\n\n") : EMPTY_PLACEHOLDER;
  return `${body}\n`;
}

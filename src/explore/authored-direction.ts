import { z, ZodError } from "zod";
import { CommandError } from "../errors.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";
import type { AuthoredDirectionContent } from "../types.js";

/** Every real catalog family — no font name may leak into character/usage prose. */
const CATALOG_FONTS = [
  ...new Set(FONT_PAIRINGS.flatMap((p) => [p.heading, p.body])),
];

/** Matches a `#rgb` or `#rrggbb` hex — no color may leak into character/usage prose. */
const HEX_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/;

/** Valid top-level fields an authored direction payload may carry. */
const VALID_FIELDS = [
  "name",
  "summary",
  "positioning",
  "character",
  "usage",
  "copyExamples",
  "styleTilePrompt",
  "homepageMockupPrompt",
];

function cleanList(list: string[]): string[] {
  return list.map((v) => v.trim()).filter((v) => v !== "");
}

const AuthoredCharacterSchema = z.object({
  mood: z.string().optional(),
  composition: z.string().optional(),
  layout: z.string().optional(),
  imagery: z.string().optional(),
  texture: z.string().optional(),
  rhythm: z.string().optional(),
});

const AuthoredCopyExamplesSchema = z.object({
  headline: z.string().default(""),
  subheadline: z.string().default(""),
  cta: z.string().default(""),
});

const AuthoredUsageSchema = z.object({
  rules: z.array(z.string()).default([]).transform(cleanList),
  antiRules: z.array(z.string()).default([]).transform(cleanList),
});

const AuthoredDirectionContentSchema = z.object({
  name: z.string().trim().min(1, "name is required and must be non-empty"),
  summary: z.string().trim().min(1, "summary is required and must be non-empty"),
  positioning: z.string().optional(),
  character: AuthoredCharacterSchema,
  usage: AuthoredUsageSchema,
  copyExamples: AuthoredCopyExamplesSchema,
  styleTilePrompt: z.string().optional(),
  homepageMockupPrompt: z.string().optional(),
});

/**
 * Parse a raw payload into `AuthoredDirectionContent`. Rejects a `tokens` key
 * with a targeted message pointing at color-locks, rejects unknown keys naming
 * the valid fields, and on Zod failure throws a `CommandError` enumerating the
 * problems by field. Pure + synchronous — no model call, no network, no fs.
 */
export function parseAuthoredDirection(raw: unknown): AuthoredDirectionContent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CommandError(
      `Expected a JSON object for the authored direction content. Valid fields: ${VALID_FIELDS.join(", ")}.`,
    );
  }

  const obj = raw as Record<string, unknown>;

  // Targeted rejection for `tokens` — the Risk Register flags this as a key UX moment.
  if ("tokens" in obj) {
    throw new CommandError(
      "Direction tokens are EXTRACTED, not authored — omit `tokens`. " +
        "To pin exact colors, record a color-lock in the direction's memory " +
        "via a real surface (the brief-map `--apply` flow, which extracts the " +
        "hex into a lock, or the studio eyedropper); " +
        "they are honored verbatim as seed tokens.",
    );
  }

  // Unknown-key rejection — name the valid fields so the agent knows what to send.
  const unknown = Object.keys(obj).filter((k) => !VALID_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw new CommandError(
      `Unknown field(s): ${unknown.join(", ")}. Valid fields: ${VALID_FIELDS.join(", ")}.`,
    );
  }

  try {
    return AuthoredDirectionContentSchema.parse(raw) as AuthoredDirectionContent;
  } catch (err) {
    if (err instanceof ZodError) {
      const messages = err.errors.map((e) => {
        const path = e.path.join(".");
        return path ? `${path}: ${e.message}` : e.message;
      });
      throw new CommandError(
        `Authored direction validation failed:\n${messages.join("\n")}`,
      );
    }
    throw err;
  }
}

/**
 * Guard that ensures no hex color or catalog font family name appears in the
 * evocative prose fields (`character.*` values and `usage.rules`/`antiRules`).
 * Call AFTER `parseAuthoredDirection`. Pure + synchronous; never throws on
 * empty fields (SC-08). The Core (WS-02) is the single caller — CLI/MCP/studio
 * surfaces do NOT call this directly.
 */
export function assertNoHexOrFontInProse(
  content: AuthoredDirectionContent,
): void {
  const proseSections: [string, string[]][] = [
    ...Object.entries(content.character)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .map(([k, v]): [string, string[]] => [`character.${k}`, [v]]),
    ["usage.rules", content.usage.rules],
    ["usage.antiRules", content.usage.antiRules],
  ];

  for (const [field, texts] of proseSections) {
    for (const text of texts) {
      const hexMatch = HEX_RE.exec(text);
      if (hexMatch) {
        throw new CommandError(
          `${field} contains a hex color (${hexMatch[0]}); color lives only in tokens — describe the FEELING, not the hex`,
        );
      }

      const lower = text.toLowerCase();
      for (const font of CATALOG_FONTS) {
        if (lower.includes(font.toLowerCase())) {
          throw new CommandError(
            `${field} contains a catalog font family name ("${font}"); type lives in tokens, mapped from a vision read — reference a ROLE, never a family name`,
          );
        }
      }
    }
  }
}

/**
 * Convenience: parse + prose-hygiene guard in one call. Returns the validated
 * `AuthoredDirectionContent`. The two primitives (`parseAuthoredDirection` /
 * `assertNoHexOrFontInProse`) are kept separately exported so the Core (WS-02)
 * can compose them independently.
 */
export function validateAuthoredDirection(
  raw: unknown,
): AuthoredDirectionContent {
  const content = parseAuthoredDirection(raw);
  assertNoHexOrFontInProse(content);
  return content;
}

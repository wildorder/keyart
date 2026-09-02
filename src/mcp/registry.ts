import path from "node:path";
import { CommandError } from "../errors.js";
import { runInit } from "../commands/init.js";
import { runExplore } from "../commands/explore.js";
import { runRegenerateVisuals } from "../commands/regenerate-visuals.js";
import { runApprove } from "../commands/approve.js";
import { runBrief } from "../commands/brief.js";
import { runAudit } from "../commands/audit.js";
import { runDoctor } from "../commands/doctor.js";
import { captureCommandOutput } from "./capture.js";
import {
  runCreateDirection,
  runDirection,
  runDirectionNew,
  runDirectionShow,
  runDirectionFork,
  runRule,
  runPromote,
  MEMORY_ACTIONS,
  type DirectionCommandResult,
  type DirectionSummary,
} from "../commands/direction.js";
import { loadConfig, directionsRoot } from "../config.js";
import { runAsset, type AssetCommandResult } from "../commands/asset.js";
import { runSurface, type SurfaceCommandResult } from "../commands/surface.js";

export interface ArgSpec {
  name: string; // e.g. "directionId"
  required: boolean;
  description: string;
  /** When true (meaningful only on the LAST arg), this slot absorbs every
   *  remaining positional token — `parseArgs`'s too-many-arguments cap is
   *  skipped for it (e.g. `surface scan <url...>`). */
  variadic?: boolean;
}

export interface FlagSpec {
  name: string; // e.g. "--force"
  description: string;
  takesValue: boolean; // true e.g. for "--port <port>"
}

export interface CommandRunContext {
  cwd: string; // resolved working directory for the command
  input: string[]; // tokenized positional+flag tokens, e.g. ["2026-06-10T...", "direction-a", "--force"]
}

export interface CommandRunOutcome {
  summary: string; // one-line human-readable result, e.g. "Explore complete. Run ID: <id>"
  filesWritten: string[]; // relative to ctx.cwd, forward slashes
}

export interface CommandMeta {
  name: string; // "init" | "explore" | "approve" | "brief" | "audit" | "serve"
  summary: string; // ONE line, <= 100 chars, used by keyart_help list mode
  helpDoc: string; // full markdown usage doc, used by keyart_help detail mode
  args: ArgSpec[];
  flags: FlagSpec[];
  dispatchable: boolean; // false ONLY for serve
  run?: (ctx: CommandRunContext) => Promise<CommandRunOutcome>; // present iff dispatchable
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>; // key without leading dashes, e.g. { force: true, port: "4317" }
}

/** Canonical error message for attempting to dispatch a non-dispatchable command. */
export const NOT_DISPATCHABLE_HINT: Record<string, string> = {
  serve:
    "serve starts a long-running local UI and cannot run via MCP. Run `npx keyart serve` in a terminal instead (http://localhost:4317).",
};

function usageLine(meta: CommandMeta): string {
  const argPart = meta.args
    .map((a) => {
      const name = a.variadic ? `${a.name}...` : a.name;
      return a.required ? `<${name}>` : `[${name}]`;
    })
    .join(" ");
  const flagPart = meta.flags
    .map((f) => (f.takesValue ? `[${f.name} <value>]` : `[${f.name}]`))
    .join(" ");
  const parts = [`keyart ${meta.name}`, argPart, flagPart].filter(Boolean);
  return `Usage: ${parts.join(" ")}`;
}

export function parseArgs(meta: CommandMeta, args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith("--")) {
      const spec = meta.flags.find((f) => f.name === tok);
      if (!spec) {
        throw new CommandError(`Unknown flag: ${tok}\n${usageLine(meta)}`);
      }
      const key = tok.replace(/^--+/, "");
      if (spec.takesValue) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new CommandError(
            `Flag ${tok} requires a value.\n${usageLine(meta)}`,
          );
        }
        flags[key] = value;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(tok);
    }
  }

  const required = meta.args.filter((a) => a.required);
  if (positionals.length < required.length) {
    const missing = required[positionals.length];
    throw new CommandError(
      `Missing required argument: ${missing.name}\n${usageLine(meta)}`,
    );
  }
  const lastArg = meta.args[meta.args.length - 1];
  if (!lastArg?.variadic && positionals.length > meta.args.length) {
    throw new CommandError(`Too many arguments.\n${usageLine(meta)}`);
  }

  return { positionals, flags };
}

/**
 * Parse the MCP `--reference` / `--intent` flags into the WS-05 run-level
 * `references` opt. `parseArgs` stores one value per flag key (a repeated
 * `--reference` would overwrite), so on the MCP surface a single `--reference`
 * carries a **comma-separated** list of paths; the single `--intent` (validated
 * against `inspire`/`extract`) applies to all of them. Absent `--intent` leaves
 * each intent undefined so `runExplore` applies its own `"inspire"` default and
 * ref-less dispatches stay byte-identical. Returns undefined when no
 * `--reference` was given.
 */
function parseReferenceFlags(
  flags: Record<string, string | boolean>,
): { path: string; intent?: "inspire" | "extract" }[] | undefined {
  const raw = typeof flags.reference === "string" ? flags.reference : undefined;
  if (raw === undefined) return undefined;
  const paths = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length === 0) return undefined;
  const intentRaw = typeof flags.intent === "string" ? flags.intent : undefined;
  if (intentRaw !== undefined && intentRaw !== "inspire" && intentRaw !== "extract") {
    throw new CommandError(`--intent must be "inspire" or "extract".`);
  }
  const intent = intentRaw as "inspire" | "extract" | undefined;
  return paths.map((p) => (intent ? { path: p, intent } : { path: p }));
}

const initMeta: CommandMeta = {
  name: "init",
  summary: "Scaffold keyart.config.ts and the brand/ folder in the current project.",
  args: [],
  flags: [
    { name: "--force", description: "Overwrite existing files.", takesValue: false },
  ],
  dispatchable: true,
  helpDoc: `# keyart init

Scaffold \`keyart.config.ts\` and the \`brand/\` folder structure into the current project.

## Usage

CLI:
\`\`\`
keyart init [--force]
\`\`\`

\`keyart_setup\`:
\`\`\`json
{ "command": "init" }
\`\`\`

## Flags

- \`--force\` — overwrite existing files (by default existing files are skipped, never clobbered).

## Outputs

- \`keyart.config.ts\`
- \`brand/directions/default/\` (\`direction.yaml\`, \`memory.yaml\`, and the generated \`brief.md\` projection)
- \`brand/brand.yaml\` (the global layer: approved pointer + rules)
- \`brand/input/references/\`, \`brand/approved/\`, \`brand/rejected/\`, \`brand/guides/\`, \`brand/generated/page-briefs/\`, \`brand/audits/\` (directories)
- \`.env.keyart.example\`
- npm scripts merged into \`package.json\` (if one exists)
- \`.cursor/mcp.json\` (keyart MCP server entry, JSON-merged)

## Examples

\`\`\`
keyart init
keyart init --force
\`\`\`

## Notes

- Fully non-interactive — safe to run from an agent.
- Never overwrites an existing user file without \`--force\`; skipped files are reported, not clobbered.
- Scaffolds the config, the default direction, the full \`brand/\` directory tree, an example env file, and npm scripts.
- The direction's \`brief.md\` is a GENERATED projection of the structured brief in \`direction.yaml\` — author it with \`direction brief set|patch|map\`, never by editing the file.
- Existing \`.cursor/mcp.json\` entries (other servers, unknown keys) are preserved; a pre-existing custom \`keyart\` entry is only replaced with \`--force\`.
- Re-running \`init\` never clobbers an existing direction's structured brief or its projection, and never overwrites \`brand/brand.yaml\` even with \`--force\` (it holds user-authored rules + the approved pointer).`,
};

const exploreMeta: CommandMeta = {
  name: "explore",
  summary: "Generate v1 into an existing draft, or mint N directions from N distinct briefs.",
  args: [
    { name: "directionId", required: false, description: "An EXISTING draft direction to generate v1 into (positional mode). Omit for the divergent --describe/--from modes." },
  ],
  flags: [
    { name: "--describe", description: "Divergent mode: seed text the N distinct briefs are proposed from.", takesValue: true },
    { name: "--from", description: "Divergent mode: an existing direction whose brief seeds the proposals.", takesValue: true },
    { name: "--count", description: "Divergent-only: how many directions to mint (default: 3). A teaching error alongside a positional target.", takesValue: true },
    { name: "--reference", description: "Run-level reference image path(s) for this run only; comma-separate several.", takesValue: true },
    { name: "--intent", description: "Intent applied to the --reference images: inspire (default) or extract.", takesValue: true },
  ],
  dispatchable: true,
  helpDoc: `# keyart explore

Explore has three forms:

1. \`explore <directionId>\` — generate **v1 into an existing draft** (a direction with zero versions, e.g. one minted by \`direction new\`). A direction that **already has versions** gets a teaching error naming \`regenerate\` — append with \`keyart regenerate <directionId>\`, never a silent second version from explore.
2. \`explore --describe "<seed>" [--count N]\` — **divergent**: one key-gated proposal mints N brand-new directions carrying N DISTINCT briefs (differing in positioning and aesthetic intent) and generates v1 for each. Keyless runs write N deterministic, honestly-labeled placeholder briefs (dry-run parity).
3. \`explore --from <directionId> [--count N]\` — the same divergent path seeded from an existing direction's brief.

Each generated version freezes the exact context fed to the model (its direction's brief, memory, moodboard references, and the global brand layer — global **hard rules** win) alongside the version.

## Usage

CLI:
\`\`\`
keyart explore <directionId>
keyart explore --describe "<seed>" [--count <n>]
keyart explore --from <directionId> [--count <n>]
\`\`\`

\`keyart_brand\`:
\`\`\`json
{ "command": "explore", "input": ["moody-draft"] }
{ "command": "explore", "input": ["--describe", "a warm editorial cooking app", "--count", "3"] }
{ "command": "explore", "input": ["--from", "moody", "--count", "2"] }
\`\`\`

## Flags

- \`--describe <seed>\` — divergent seed text. A hex typed here becomes a per-direction color-lock decision, never a brief field.
- \`--from <directionId>\` — divergent source direction whose brief seeds the proposals.
- \`--count <n>\` — divergent-only (default \`3\`); passing it with a positional target is a teaching error naming the forms.
- \`--reference <path[,path...]>\` — run-level, **ephemeral** reference image(s) for THIS run only (comma-separate several); merged with the direction's own moodboard under the shared reference cap and never written to the direction.
- \`--intent inspire|extract\` — how the \`--reference\` images are used: \`inspire\` (default — feed the image model + context) or \`extract\` (vision-analyzed into palette-engine seeds). Applies to every \`--reference\` in this invocation.

## Outputs

Positional mode writes one version folder \`brand/directions/<directionId>/versions/<versionId>/\` into the existing draft. Divergent modes mint N direction folders \`brand/directions/<directionId>/\`, each with its own \`direction.yaml\` and a v1 version folder:

- \`direction-version.json\` (the version record — content + extracted tokens)
- \`brief-snapshot.md\` (frozen projection of that direction's brief at generation time)
- \`context-snapshot.md\` (the exact rendered context — global hard rules, guidelines, direction memory, then the brief — that was sent to the model)
- \`style-tile-prompt.md\` and \`homepage-mockup-prompt.md\`
- \`style-tile.png\` and \`homepage-mockup.png\` (only when \`OPENAI_API_KEY\` is set and generation succeeds)

## Examples

\`\`\`
keyart explore warm-editorial
keyart explore --describe "a delivery app for people who cook"
keyart explore --from warm-editorial --count 2
\`\`\`

## Notes

- Works **without** \`OPENAI_API_KEY\`: positional mode writes a deterministic placeholder v1; divergent modes mint N honestly-labeled placeholder briefs and a v1 each (dry-run parity; no image attempts, no warnings).
- Context assembly is read-only: explore reads the target direction's own memory + the global brand layer and feeds them to the model, but never writes direction memory or global rules. Global hard rules precede and override direction feedback in the prompt.
- Feedback recorded on a direction (\`keyart direction feedback <id> ...\`) feeds that direction's next generation; existing version snapshots stay frozen.
- Image-generation failures in live mode print a warning naming the file and reason but do **not** fail the run — prompt files are always written.
- Directions live under \`brand/directions/\`.
- Every version carries \`brief-snapshot.md\` (a frozen projection of the brief) and \`context-snapshot.md\` (a frozen copy of the assembled context).
- **Another option:** \`keyart explore --from <id> --count 1\` mints a single fresh direction. To iterate an *existing* direction (feedback → a new version) use \`keyart regenerate <directionId>\` — \`--count\` is divergent-only.
- After exploring, approve a direction with \`keyart approve <directionId>\`.`,
};

const regenerateMeta: CommandMeta = {
  name: "regenerate",
  summary: "Iterate a direction: append a new version (board + re-extracted tokens); text-safe.",
  args: [
    { name: "directionId", required: true, description: "The direction to regenerate (e.g. direction-a)." },
  ],
  flags: [
    { name: "--tweak", description: "One-shot art direction appended to the image prompts for this pass only (not saved).", takesValue: true },
  ],
  dispatchable: true,
  helpDoc: `# keyart regenerate

The single iterate path: **feedback → regenerate appends a new version** to a direction. Addressed by \`<directionId>\`, it reads the direction's **head** version, re-renders BOTH graphics + the deterministic style board, re-extracts the unlocked tokens, and **appends** the result as the next version — the head advances and prior versions are never touched (append-only history). The direction's text/copy is **never** rewritten; only the new version's re-extracted tokens change. Like \`explore\`, regenerate is a generation action dispatchable through any \`keyart_*\` facade (it is NOT a \`serve\`-only studio mutation).

## Usage

CLI:
\`\`\`
keyart regenerate <directionId> [--tweak "<text>"]
\`\`\`

\`keyart_brand\`:
\`\`\`json
{ "command": "regenerate", "input": ["direction-a", "--tweak", "cooler"] }
\`\`\`

## Arguments

- \`directionId\` (required) — the direction to regenerate (e.g. \`direction-a\`). Regenerate always advances that direction's head.

## Flags

- \`--tweak <text>\` — one-shot art direction appended to each image prompt for THIS pass only; never persisted.

## Outputs

A NEW version folder \`brand/directions/<directionId>/versions/<versionId>/\` (the direction's new head):

- \`style-board.md\` and \`style-board.svg\` — the **deterministic** style board re-rendered from the new version's tokens with NO model call (always written when the version has tokens; lands even keyless / with no image model).
- \`style-tile.png\`, \`homepage-mockup.png\`, and the evocative \`style-board.png\` — regenerated via the reference-conditioned image model (only when \`OPENAI_API_KEY\` and an image model are configured and generation succeeds).
- \`direction-version.json\`, the frozen \`brief-snapshot.md\` / \`context-snapshot.md\`, and both prompt \`.md\` files.

## Examples

\`\`\`
keyart regenerate direction-a
keyart regenerate direction-a --tweak "warmer, more editorial"
\`\`\`

## Notes

- **Appends a version — never edits in place.** Regenerate advances the direction's head; prior versions stay frozen (append-only history).
- **Text-safe.** Regenerate never edits the direction's copy or rules — it re-renders the deterministic board and re-generates the PNGs, then re-extracts the unlocked tokens.
- **Token-locked.** Each image prompt is locked to the version's tokens (color/type), so a locked role is held verbatim while unlocked roles rotate to the new tile — the imagery stays a strict projection of the tokens.
- **Dry-run safe.** Without a key / image model it still appends a cloned-token version, re-renders the deterministic board, and reports the skipped images; it never throws.`,
};

const approveMeta: CommandMeta = {
  name: "approve",
  summary: "Approve a direction: pin a version + set the global pointer (rebrand) + codify stamped guides.",
  args: [
    { name: "directionId", required: true, description: "The direction to approve (e.g. direction-a)." },
    { name: "versionId", required: false, description: "A specific version to pin (default: the direction's head)." },
  ],
  flags: [
    { name: "--force", description: "Overwrite existing guide files.", takesValue: false },
  ],
  dispatchable: true,
  helpDoc: `# keyart approve

Approve one visual direction — **pinning a version**. This is the **rebrand switch**: it writes the global approved pointer into \`brand/brand.yaml\`, then codifies every downstream artifact as a **pure projection of that pinned version**.

## Usage

CLI:
\`\`\`
keyart approve <directionId> [<versionId>] [--force]
\`\`\`

\`keyart_brand\`:
\`\`\`json
{ "command": "approve", "input": ["direction-a"] }
\`\`\`

## Arguments

- \`directionId\` (required) — the direction to approve (e.g. \`direction-a\`).
- \`versionId\` (optional) — a specific version to pin. Omitted → the direction's **head** at approve time.

## Flags

- \`--force\` — overwrite existing guide files (otherwise existing guides are skipped).

## Outputs

- \`brand/brand.yaml\` — the global **approved pointer** set to \`{ directionId, versionId, approvedAt }\` (the only global write; existing global \`rules\` are preserved).
- \`brand/approved/current-direction.json\` — the pinned version object plus a \`provenance\` field (\`directionId\`, \`versionId\`, \`approvedAt\`); plus copied prompt \`.md\` files and any \`.png\` images.
- \`brand/directions/<directionId>/direction.yaml\` — the approved direction transitioned to \`approved\`.
- \`brand/guides/visual-style-guide.md\`, \`brand/guides/brand-guide.md\`
- \`brand/generated/image-prompts.md\`, \`brand/generated/cursor-brand.mdc\`
- The implementation brief, CSS vars, and cursor rules at the paths from \`keyart.config.ts\` \`outputs\`
- \`brand/generated/asset-pack/<directionId>/\` — the asset pack refreshed as part of the codify (same output as \`asset pack\`): head PNGs of the direction's active extracted assets, \`contact-sheet.svg\`/\`.md\`, DTCG \`tokens.json\` (hexes byte-identical to \`brand.css\`), \`pack-manifest.json\`. Written even with no extracted assets (tokens + sheet + manifest only).

## Examples

\`\`\`
keyart approve direction-a
keyart approve direction-a v-2026-06-10T12-00-00-000Z --force
\`\`\`

## Notes

- Requires an existing direction — run \`keyart explore\` first. Directions live under \`brand/directions/\`.
- **Pins a version.** Approve pins the direction's head (or the given \`<versionId>\`); iterating after approve (\`regenerate\`) advances the head **without** rebranding until you re-approve.
- **Rebrand switch:** approve sets the global pointer; codify regenerates guides / cursor rules / CSS / brief as projections of it. **Repoint + re-codify fully rebrands while global rules persist** — \`setPointer\` never clears \`rules\`.
- Every generated artifact is **stamped with source provenance** (\`directionId\` / \`versionId\` / \`approvedAt\`) so a stale artifact after a repoint is detectable.
- The global **hard rules** are injected into the guides and cursor rules as a non-negotiable section placed **before** the direction-derived rules — global hard rules govern the codified output.
- Approving works from **any** direction status, including a previously rejected direction — it flips that direction to \`approved\` (revive-by-approval) and never touches any other direction.`,
};

const briefMeta: CommandMeta = {
  name: "brief",
  summary: "Generate a page implementation brief from the approved direction.",
  args: [
    { name: "pageName", required: true, description: "Name of the page to write a brief for (e.g. home)." },
  ],
  flags: [
    { name: "--force", description: "Overwrite an existing brief.", takesValue: false },
  ],
  dispatchable: true,
  helpDoc: `# keyart brief

Generate a page-specific implementation brief from the currently approved direction.

## Usage

CLI:
\`\`\`
keyart brief <pageName> [--force]
\`\`\`

\`keyart_implement\`:
\`\`\`json
{ "command": "brief", "input": ["<pageName>", "--force"] }
\`\`\`

## Arguments

- \`pageName\` (required) — the page to write a brief for (e.g. \`home\`, \`pricing\`). Sanitized to a kebab-case filename.

## Flags

- \`--force\` — overwrite an existing brief (otherwise an existing brief is skipped).

## Outputs

- \`brand/generated/page-briefs/<pageName>.md\`

## Examples

\`\`\`
keyart brief home
keyart brief "Pricing Page" --force
\`\`\`

## Notes

- Requires an approved direction — run \`keyart approve\` first.
- Output path pattern is \`brand/generated/page-briefs/<pageName>.md\`.`,
};

const auditMeta: CommandMeta = {
  name: "audit",
  summary: "Screenshot a URL and audit it against the approved visual style guide.",
  args: [
    { name: "url", required: true, description: "The URL to screenshot and audit." },
  ],
  flags: [],
  dispatchable: true,
  helpDoc: `# keyart audit

Screenshot a running page and audit it against the approved visual style guide.

## Usage

CLI:
\`\`\`
keyart audit <url>
\`\`\`

\`keyart_implement\`:
\`\`\`json
{ "command": "audit", "input": ["http://localhost:3000"] }
\`\`\`

## Arguments

- \`url\` (required) — the URL to screenshot and audit.

## Outputs

- \`brand/audits/<auditId>/screenshot.png\`
- \`brand/audits/<auditId>/audit.json\`
- \`brand/audits/<auditId>/audit.md\`

## Examples

\`\`\`
keyart audit http://localhost:3000
\`\`\`

## Notes

- Requires Playwright + Chromium. If missing, install with \`npx playwright install chromium\`.
- **May take 30–60s** (screenshot capture plus an optional vision model call) — set an adequate tool timeout when dispatching.
- Without \`OPENAI_API_KEY\` (or without an approved style guide) it writes a deterministic placeholder audit instead of an AI critique.
- When a direction is approved, audit findings roll up into the **approved direction's** memory as a deterministic, attributed \`learning\` entry (author/source \`audit\`) — feeding that direction's next generation. With nothing approved, the roll-up is skipped silently.`,
};

const serveMeta: CommandMeta = {
  name: "serve",
  summary: "Start the local read-only dashboard UI (CLI-only; not available via MCP).",
  args: [],
  flags: [
    { name: "--port", description: "Port to serve on (default 4317).", takesValue: true },
  ],
  dispatchable: false,
  helpDoc: `# keyart serve

Start the local read-only Keyart dashboard UI.

## Usage

CLI:
\`\`\`
keyart serve [--port <port>]
\`\`\`

## Flags

- \`--port <port>\` — port to serve on (default \`4317\`).

## Outputs

- None — serves a live UI; writes no files.

## Examples

\`\`\`
keyart serve
keyart serve --port 5000
\`\`\`

## Notes

- **CLI-only.** \`serve\` starts a long-running local server and is **not dispatchable via MCP**. Run \`npx keyart serve\` in a terminal instead (http://localhost:4317).`,
};

const ruleMeta: CommandMeta = {
  name: "rule",
  summary: "Write, remove, or edit a deliberate GLOBAL brand rule in brand/brand.yaml.",
  args: [
    { name: "verb", required: true, description: "One of: add, remove, edit." },
    { name: "text", required: false, description: "`add`: the rule text. `remove`/`edit`: the target `<ruleId>` (the trailing positional)." },
  ],
  flags: [
    { name: "--severity", description: "Rule severity: hard | guideline (default: guideline for add; unchanged for edit unless given).", takesValue: true },
    { name: "--author", description: "Attribution for the rule (default: cli).", takesValue: true },
    { name: "--channel", description: "Directive channel: visual | copy | both (rule add only).", takesValue: true },
    { name: "--polarity", description: "Directive polarity: prefer | avoid (rule add only).", takesValue: true },
    { name: "--body", description: "Replacement rule text (rule edit only).", takesValue: true },
    { name: "--expected-version", description: "Expected global brand version for optimistic write (rule remove | edit).", takesValue: true },
    { name: "--force", description: "Bypass optimistic version checks (also required to remove/edit a HARD rule).", takesValue: false },
  ],
  dispatchable: true,
  helpDoc: `# keyart rule

Write, remove, or edit a deliberate, attributed GLOBAL brand rule in \`brand/brand.yaml\`. Global rules are the only brand-wide writes — they survive every rebrand/repoint and apply across all directions. All three verbs are keyless — no Keyart model call.

## Usage

CLI:
\`\`\`
keyart rule add "<text>" [--severity hard|guideline] [--channel visual|copy|both] [--polarity prefer|avoid] [--author <author>] [--force]
keyart rule remove <ruleId> [--force] [--expected-version <n>]
keyart rule edit <ruleId> --body <text> [--severity hard|guideline] [--force] [--expected-version <n>]
\`\`\`

\`keyart_brand\`:
\`\`\`json
{ "command": "rule", "input": ["add", "Never use pure black", "--severity", "hard", "--channel", "visual", "--polarity", "avoid"] }
{ "command": "rule", "input": ["remove", "rule-abc123", "--force"] }
{ "command": "rule", "input": ["edit", "rule-abc123", "--body", "Never use pure black or pure white", "--severity", "guideline"] }
\`\`\`

## Arguments

- \`verb\` (required) — \`add\`, \`remove\`, or \`edit\`.
- \`text\` (required) — for \`add\`, the rule body; for \`remove\`/\`edit\`, the target \`<ruleId>\` (from \`rule add\`'s output or \`brand.yaml\`). Passed as the trailing positional (there is no \`--text\`/\`--rule-id\` flag).

## Global rule lifecycle (undo/amend a promote — MCP-first, keyless)

- \`rule remove <ruleId>\` — non-destructively **retires** a global rule (adds \`retiredAt\`; nothing physically removed) so it is excluded from assembly thereafter. This is how a \`direction memory promote --to global\` is undone. Idempotent on an already-retired id.
- \`rule edit <ruleId> --body <text> [--severity …]\` — amends a rule via **retire-and-replace** (non-destructive): the old rule is retired and a replacement carrying the new \`text\`/\`severity\` is appended. The \`--body\` flag maps onto the rule's \`text\` field.
- **A HARD rule requires \`--force\`** on both \`remove\` and a hard-severity \`edit\` (escalating a guideline to hard also requires \`--force\`) — hard rules win, so weakening one is a deliberate, gated act. A retired rule never reaches any future prompt/context assembly.
- Both verbs are attributed and version-guarded: pass \`--expected-version <n>\` (the current \`brand.yaml\` version) unless \`--force\`; a stale version surfaces a 409 \`VersionConflictError\`.

## Flags

- \`--severity <severity>\` — \`hard\` (overrides direction feedback everywhere) or \`guideline\` (a strong default). Defaults to \`guideline\` on \`add\`; on \`edit\`, omit to leave the current severity unchanged.
- \`--channel <channel>\` (rule add only) — \`visual\` (reaches the image model), \`copy\` (voice/wording only), or \`both\`. Absent ⇒ classifier default (rules default \`visual\`).
- \`--polarity <polarity>\` (rule add only) — \`prefer\` (do this) or \`avoid\` (never do this). Absent ⇒ classifier heuristic (leading never/no/avoid ⇒ avoid; otherwise prefer).
- \`--body <text>\` (rule edit) — the replacement rule text (maps onto \`GlobalRule.text\`); required unless \`--severity\` alone is being changed.
- \`--author <author>\` — attribution for the rule (default \`cli\`).
- \`--expected-version <n>\` (rule remove | edit) — required for a non-forced write (optimistic concurrency against \`brand.yaml\`'s version).
- \`--force\` — bypass optimistic version checks; also required to remove or edit a HARD rule (or escalate a guideline to hard).

## Outputs

- \`brand/brand.yaml\` — the global brand doc: \`add\` appends a rule; \`remove\` marks one retired; \`edit\` retires the old rule and appends its replacement.

## Examples

\`\`\`
keyart rule add "Never use pure black (#000)" --severity hard
keyart rule add "Prefer generous whitespace"
keyart rule add "No fist-in-the-air icons" --channel visual --polarity avoid
keyart rule remove rule-abc123
keyart rule remove rule-abc123 --force
keyart rule edit rule-abc123 --body "Prefer generous whitespace and airy margins"
keyart rule edit rule-abc123 --severity hard --force
\`\`\`

## Notes

- Works fully **without** \`OPENAI_API_KEY\` — pure filesystem, no model calls.
- \`add\` is the deliberate global-write entry point — it writes NO direction memory. \`remove\`/\`edit\` amend that same global layer, non-destructively.
- A \`hard\` rule overrides direction-level feedback everywhere; a \`guideline\` is a strong global default. Removing/editing a HARD rule (or escalating to hard) requires \`--force\` — hard-rules-win is never silently bypassed.`,
};

const promoteMeta: CommandMeta = {
  name: "promote",
  summary: "Lift one direction's learning into a global rule (the only direction→global bridge).",
  args: [
    { name: "directionId", required: true, description: "The direction whose learning is promoted." },
    { name: "text", required: false, description: "The learning text to promote (the trailing positional)." },
  ],
  flags: [
    { name: "--entry", description: "Pull the learning body from this memory entry id instead of a positional.", takesValue: true },
    { name: "--severity", description: "Rule severity: hard | guideline (default: guideline).", takesValue: true },
    { name: "--author", description: "Attribution for the rule (default: cli).", takesValue: true },
    { name: "--force", description: "Bypass optimistic version checks.", takesValue: false },
  ],
  dispatchable: true,
  helpDoc: `# keyart promote

Lift ONE direction's learning into a deliberate GLOBAL brand rule. This is the only direction→global bridge; the resulting rule records \`source: promote:<directionId>\`.

## Usage

CLI:
\`\`\`
keyart promote <directionId> "<text>" [--severity hard|guideline] [--author <author>] [--force]
keyart promote <directionId> --entry <id> [--severity hard|guideline]
\`\`\`

\`keyart_brand\`:
\`\`\`json
{ "command": "promote", "input": ["moody", "Editorial serifs win", "--severity", "guideline"] }
\`\`\`

## Arguments

- \`directionId\` (required) — the direction whose learning is being promoted.
- \`text\` (required unless \`--entry\` is given) — the learning text, passed as the trailing positional (there is no \`--text\` flag).

## Flags

- \`--entry <id>\` — instead of a positional, pull the body from that direction's memory entry with this id.
- \`--severity <severity>\` — \`hard\` or \`guideline\` (default \`guideline\`).
- \`--author <author>\` — attribution for the rule (default \`cli\`).
- \`--force\` — bypass optimistic version checks.

## Outputs

- \`brand/brand.yaml\` — the global brand doc, with the promoted rule appended (\`source: promote:<directionId>\`).

## Examples

\`\`\`
keyart promote moody "Editorial serifs win"
keyart promote moody --entry learning-abc123 --severity hard
\`\`\`

## Notes

- Works fully **without** \`OPENAI_API_KEY\` — pure filesystem, no model calls.
- Reads exactly ONE direction's memory (\`directionId\`) — never a sibling — preserving per-direction isolation.
- This is the only deliberate direction→global bridge; the promoted rule is tagged \`source: promote:<directionId>\`.`,
};

const doctorMeta: CommandMeta = {
  name: "doctor",
  summary:
    "Report project readiness: config, OPENAI_API_KEY, Playwright/Chromium, brand scaffold.",
  args: [],
  flags: [],
  dispatchable: true,
  helpDoc: `# keyart doctor

Report whether the project is ready to run Keyart. Runs four checks — \`config\`, \`openai-key\`, \`playwright\`, \`brand-scaffold\` — and prints a readiness report. Never prompts; safe to run from an agent.

## Usage

CLI:
\`\`\`
keyart doctor
\`\`\`

\`keyart_setup\`:
\`\`\`json
{ "command": "doctor" }
\`\`\`

## Outputs

- None — writes no files; prints a readiness report.

## Examples

\`\`\`
keyart doctor
\`\`\`

## Notes

- A missing \`OPENAI_API_KEY\` or missing Playwright/Chromium is a **warning** — every command still runs in dry-run / audit-only mode.
- A missing (or invalid) \`keyart.config.ts\` or a missing \`brand/\` scaffold is a **hard failure** — run \`keyart init\` to fix it.
- The CLI exits non-zero on a hard failure; via MCP the report is always returned as normal (non-error) text for the agent to read.`,
};

doctorMeta.run = async (ctx) => {
  parseArgs(doctorMeta, ctx.input); // rejects stray args/flags
  const result = await runDoctor({ cwd: ctx.cwd });
  const lines = result.checks.map(
    (c) =>
      `[${c.status.toUpperCase()}] ${c.name}: ${c.detail}${c.hint ? ` — ${c.hint}` : ""}`,
  );
  return {
    summary: `Doctor: ${result.ok ? "ready" : "NOT ready"}.\n${lines.join("\n")}`,
    filesWritten: [],
  };
};

initMeta.run = async (ctx) => {
  const { flags } = parseArgs(initMeta, ctx.input);
  const result = await runInit({ cwd: ctx.cwd, force: flags.force === true });
  // Drop "package.json script ..." pseudo-entries: keep only real relative paths (no spaces).
  const filesWritten = result.created.filter((p) => !p.includes(" "));
  return {
    summary: `Init complete: ${result.created.length} created, ${result.skipped.length} skipped.`,
    filesWritten,
  };
};

exploreMeta.run = async (ctx) => {
  const { positionals, flags } = parseArgs(exploreMeta, ctx.input);
  // Positional mode targets an EXISTING draft; --describe/--from are the
  // divergent modes. runExplore itself teaches on any invalid combination.
  const directionId = positionals[0];
  const describe = typeof flags.describe === "string" ? flags.describe : undefined;
  const from = typeof flags.from === "string" ? flags.from : undefined;
  // Leave `count` undefined when omitted so runExplore applies its divergent
  // default of 3 (and can reject it alongside a positional target).
  const count =
    typeof flags.count === "string" ? parseInt(flags.count, 10) : undefined;
  const references = parseReferenceFlags(flags);
  const result = await runExplore({
    cwd: ctx.cwd,
    directionId,
    describe,
    from,
    count,
    references,
  });
  // jobs.ts stores the full result (job.result = result) so /api/jobs/:id returns
  // result.contradictionReport for free — no jobs.ts / server-api.ts change needed.
  const warningTail =
    result.contradictionReport.warnings.length > 0
      ? `\n\nWarnings:\n${result.contradictionReport.warnings.map((w) => `- ${w.message}`).join("\n")}`
      : "";
  return {
    summary: `Explore complete. Directions: ${result.directionIds.join(", ")}. Next: keyart_brand { command: "approve", input: ["<directionId>"] }.${warningTail}`,
    filesWritten: result.filesWritten,
  };
};

regenerateMeta.run = async (ctx) => {
  // Regenerate addresses by `<directionId>` (head-only) and always APPENDS a new
  // version to that direction's head — there is no run id and no in-place edit.
  const { positionals, flags } = parseArgs(regenerateMeta, ctx.input);
  const result = await runRegenerateVisuals({
    cwd: ctx.cwd,
    directionId: positionals[0],
    tweak: typeof flags.tweak === "string" ? flags.tweak : undefined,
  });
  // jobs.ts stores the full result (job.result = result) so /api/jobs/:id returns
  // result.contradictionReport for free — no jobs.ts / server-api.ts change needed.
  const warningTail =
    result.contradictionReport.warnings.length > 0
      ? `\n\nWarnings:\n${result.contradictionReport.warnings.map((w) => `- ${w.message}`).join("\n")}`
      : "";
  return {
    summary: `Regenerated visuals for ${result.directionId}: appended version ${result.versionId}${result.dryRun ? " — dry-run, no images" : ""}. ${result.filesWritten.length} file(s) written.${warningTail}`,
    filesWritten: result.filesWritten,
  };
};

approveMeta.run = async (ctx) => {
  const { positionals, flags } = parseArgs(approveMeta, ctx.input);
  const result = await runApprove({
    cwd: ctx.cwd,
    directionId: positionals[0],
    versionId: positionals[1],
    force: flags.force === true,
  });
  const packed = result.assetPack.assetsIncluded.length;
  const pending = result.assetPack.assetsPending.length;
  return {
    summary:
      `Approved direction "${result.directionName}" (${result.directionId}). ` +
      `Global pointer updated (rebrand). Asset pack refreshed (${packed} asset${packed === 1 ? "" : "s"}` +
      `${pending > 0 ? `, ${pending} pending` : ""}).`,
    filesWritten: result.filesWritten,
  };
};

briefMeta.run = async (ctx) => {
  const { positionals, flags } = parseArgs(briefMeta, ctx.input);
  const result = await runBrief({
    cwd: ctx.cwd,
    pageName: positionals[0],
    force: flags.force === true,
  });
  const summary = result.written
    ? `Page brief written: ${result.outPath}`
    : `Skipped (already exists — pass --force to overwrite): ${result.outPath}`;
  return {
    summary,
    filesWritten: result.written ? [result.outPath] : [],
  };
};

auditMeta.run = async (ctx) => {
  const { positionals } = parseArgs(auditMeta, ctx.input);
  const result = await runAudit({ cwd: ctx.cwd, url: positionals[0] });
  return {
    summary: `Audit complete (${result.dryRun ? "dry-run placeholder" : "AI critique"}): ${result.auditDir}`,
    filesWritten: result.filesWritten,
  };
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function directionResultSummary(result: DirectionCommandResult): string {
  switch (result.verb) {
    case "new":
      return `Direction "${result.id}" created.`;
    case "reject":
      return `Direction "${result.id}" rejected.`;
    case "park":
      return `Direction "${result.id}" parked.`;
    case "revive":
      return `Direction "${result.id}" revived (active).`;
    case "feedback":
      return `Recorded ${result.entryKind} on direction "${result.id}".`;
    case "memory": {
      if (result.memoryAction !== undefined) {
        const r = result.memoryActionResult!;
        switch (result.memoryAction) {
          case "edit":
            return `Edited memory entry "${r.entryId}" on direction "${result.id}" (superseded).`;
          case "delete":
            return `Deleted (retired) memory entry "${r.entryId}" on direction "${result.id}".`;
          case "promote":
            return r.to === "global"
              ? `Promoted memory entry "${r.entryId}" on direction "${result.id}" to a global rule.`
              : `Promoted memory entry "${r.entryId}" on direction "${result.id}".`;
        }
      }
      const n = result.memoryEntries?.length ?? 0;
      return `Memory for direction "${result.id}": ${n} entr${n === 1 ? "y" : "ies"}.`;
    }
    case "brief":
      if (result.subverb === "show") {
        return `Brief for direction "${result.id}".`;
      }
      if (result.subverb === "map") {
        return result.filesWritten.length > 0
          ? `Applied brief map on direction "${result.id}".`
          : `Proposed brief map for direction "${result.id}" (nothing written).`;
      }
      return `Updated brief on direction "${result.id}" (${result.subverb}).`;
    case "status": {
      const s = result.status!;
      return `${s.id}: ${s.status}${s.isDraft ? " (draft — no versions yet)" : ` (head ${s.head}, ${s.versionCount} version${s.versionCount === 1 ? "" : "s"})`}`;
    }
    case "archive":
      return `Archived: direction ${result.id} archived; nothing physically removed.`;
    case "list": {
      const directions = result.directions ?? [];
      if (directions.length === 0) {
        return "No directions yet. Create one with: direction new <name>.";
      }
      const entries = directions
        .map((c) => `${c.id} (${c.status})`)
        .join(", ");
      return `${plural(directions.length, "direction")}: ${entries}`;
    }
    case "reconcile": {
      if (result.reconcileResult) {
        const r = result.reconcileResult;
        return `Reconciled contradiction "${r.contradictionId}" on direction "${r.directionId}" (action: ${r.action}).`;
      }
      const report = result.contradictionReport;
      const count = report?.items.length ?? 0;
      if (count === 0) {
        return `No contradictions found on direction "${result.id}".`;
      }
      return `${count} contradiction(s) on direction "${result.id}". Resolve with --action keep|retire|supersede|promote --contradiction <id>.`;
    }
  }
}

const flagValue = (
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);

ruleMeta.run = async (ctx) => {
  const { positionals, flags } = parseArgs(ruleMeta, ctx.input);
  const verb = positionals[0];
  // `add` carries its text as positionals[1]; `remove`/`edit` instead carry the
  // target `<ruleId>` there (the replacement body, if any, comes from `--body`).
  const result = await runRule({
    cwd: ctx.cwd,
    verb,
    text: verb === "add" ? positionals[1] : undefined,
    ruleId: verb !== "add" ? positionals[1] : undefined,
    body: flagValue(flags, "body"),
    severity: flagValue(flags, "severity"),
    author: flagValue(flags, "author"),
    channel: flagValue(flags, "channel"),
    polarity: flagValue(flags, "polarity"),
    expectedVersion: (() => {
      const v = flagValue(flags, "expected-version");
      const n = v !== undefined ? parseInt(v, 10) : NaN;
      return Number.isFinite(n) ? n : undefined;
    })(),
    force: flags.force === true,
  });
  const summary =
    result.verb === "add"
      ? `Added ${result.rule.severity} global rule: ${result.rule.text}`
      : result.verb === "remove"
        ? `Removed global rule "${result.rule.id}" (retired).`
        : `Edited global rule: now ${result.rule.severity} — "${result.rule.text}".`;
  return { summary, filesWritten: result.filesWritten };
};

promoteMeta.run = async (ctx) => {
  const { positionals, flags } = parseArgs(promoteMeta, ctx.input);
  const result = await runPromote({
    cwd: ctx.cwd,
    directionId: positionals[0],
    text: positionals[1],
    entryId: flagValue(flags, "entry"),
    severity: flagValue(flags, "severity"),
    author: flagValue(flags, "author"),
    force: flags.force === true,
  });
  return {
    summary: `Promoted a ${result.rule.severity} rule from direction "${result.fromDirectionId}".`,
    filesWritten: result.filesWritten,
  };
};

const directionMeta: CommandMeta = {
  name: "direction",
  summary:
    "Work with directions: draft, fork, create, lifecycle (archive/revive), feedback, memory, brief.",
  args: [
    {
      name: "verb",
      required: true,
      description:
        "One of: new, list, show, status, fork, create, archive, reject, park, revive, feedback, memory, brief, reconcile.",
    },
    {
      name: "id",
      required: false,
      description:
        "Direction id (kebab-case). Required for every verb except list. For `new`, the display name; for `create`, the authored-content JSON (pass it as its own array element); for `brief`, this slot holds the subverb (show|set|patch|map). For `memory`, a sub-action word (edit|promote|delete) here means a WRITE instead of a read.",
    },
    {
      name: "target",
      required: false,
      description:
        "brief only: the direction id (after the show|set|patch|map subverb). memory edit|promote|delete: the direction id (after the sub-action word).",
    },
    {
      name: "detail",
      required: false,
      description:
        "brief set: the field name. brief patch: the JSON patch string. brief map: the freeform ramble. memory edit|promote|delete: the target entry id.",
    },
    {
      name: "value",
      required: false,
      description: "brief set only: the value for the field (comma-separated for array fields).",
    },
  ],
  flags: [
    { name: "--describe", description: "Seed the draft's brief notes (direction new only; soft intent words — never hexes or font families).", takesValue: true },
    { name: "--name", description: "Display name override (direction fork only; defaults to the source's name).", takesValue: true },
    { name: "--count", description: "How many forks to mint (direction fork only; default: 1).", takesValue: true },
    { name: "--with-memory", description: "Also copy the source's active memory log as fresh attributed appends (direction fork only).", takesValue: false },
    { name: "--include-archived", description: "Include archived directions in `direction list` output.", takesValue: false },
    { name: "--from", description: "The REQUIRED seed direction for `direction create '<json>' --from <directionId>`.", takesValue: true },
    { name: "--note", description: "Record a rejection note as a decision entry (direction reject only).", takesValue: true },
    { name: "--body", description: "Memory entry body (direction feedback, or direction memory edit).", takesValue: true },
    { name: "--kind", description: "Memory kind: feedback | learning | decision (direction feedback only).", takesValue: true },
    { name: "--author", description: "Attribution for memory entries (default: cli).", takesValue: true },
    { name: "--channel", description: "Directive channel: visual | copy | both (direction feedback, or direction memory edit).", takesValue: true },
    { name: "--polarity", description: "Directive polarity: prefer | avoid (direction feedback, or direction memory edit).", takesValue: true },
    { name: "--apply", description: "Write the proposed patch + hex locks (direction brief map only).", takesValue: false },
    { name: "--to", description: "Promote target: global (direction memory promote only; global is the only destination).", takesValue: true },
    { name: "--reason", description: "Retirement reason (direction memory delete only).", takesValue: true },
    { name: "--contradiction", description: "Contradiction ID to resolve (direction reconcile only).", takesValue: true },
    { name: "--action", description: "Reconciliation action: keep | retire | supersede | promote (direction reconcile only).", takesValue: true },
    { name: "--winner", description: "Which side wins: subject | conflictsWith (direction reconcile only; default: subject).", takesValue: true },
    { name: "--severity", description: "Severity: guideline | hard (direction reconcile promote, or direction memory promote --to global; default: guideline).", takesValue: true },
    { name: "--expected-memory-version", description: "Expected direction memory version for optimistic write (direction reconcile, or direction memory edit|promote|delete).", takesValue: true },
    { name: "--expected-global-version", description: "Expected global brand version for optimistic promote (direction reconcile, or direction memory promote --to global).", takesValue: true },
    { name: "--force", description: "Bypass optimistic version checks.", takesValue: false },
  ],
  dispatchable: true,
  helpDoc: `# keyart direction

Work with direction aggregates — the COMPLETE verb family: \`new\`, \`list\`, \`show\`, \`status\`, \`fork\`, \`create\`, \`archive\`, \`reject\`, \`park\`, \`revive\`, \`feedback\`, \`memory\`, \`brief\`, \`reconcile\`. Each direction lives under \`brand/directions/<id>/\` with \`direction.yaml\`, isolated \`memory.yaml\`, the generated \`brief.md\` projection, and \`versions/\`.

The two-layer model: \`direction new\` mints a keyless DRAFT (a direction with zero versions); \`explore <id>\` generates v1 into it; feedback → \`regenerate <id>\` appends versions. \`fork\` copies a direction's brief + moodboard into fresh drafts; \`create\` persists host-agent-authored content at v1, seeded from an existing direction (\`--from\`, required).

## Usage

CLI:
\`\`\`
keyart direction new <name> [--describe "<text>"]
keyart direction list [--include-archived]
keyart direction show <id>
keyart direction status <id>
keyart direction fork <id> [--name <name>] [--count <n>] [--with-memory]
keyart direction create '<json>' --from <directionId>
keyart direction archive <id>
keyart direction reject <id> [--note <text>]
keyart direction park <id>
keyart direction revive <id>
keyart direction feedback <id> --body "<text>" [--kind feedback|learning|decision] [--channel visual|copy|both] [--polarity prefer|avoid]
keyart direction memory <id>
keyart direction memory edit <id> <entryId> --body <text> [--channel visual|copy|both] [--polarity prefer|avoid] [--expected-memory-version <n>] [--force]
keyart direction memory promote <id> <entryId> --to global [--severity hard|guideline] [--expected-memory-version <n>] [--expected-global-version <n>] [--force]
keyart direction memory delete <id> <entryId> [--reason <text>] [--expected-memory-version <n>] [--force]
keyart direction brief show <id>
keyart direction brief set <id> <field> <value…>
keyart direction brief patch <id> '<json>'
keyart direction brief map <id> "<freeform…>" [--apply]
keyart direction reconcile <id>
keyart direction reconcile <id> --action keep|retire|supersede|promote --contradiction <id> --expected-memory-version <n>
\`\`\`

\`keyart_brand\` (JSON payloads MUST be their own array element — a string input is whitespace-split):
\`\`\`json
{ "command": "direction", "input": ["new", "warm-editorial", "--describe", "a calm cooking tracker"] }
{ "command": "direction", "input": ["list", "--include-archived"] }
{ "command": "direction", "input": ["show", "warm-editorial"] }
{ "command": "direction", "input": ["status", "warm-editorial"] }
{ "command": "direction", "input": ["fork", "warm-editorial", "--count", "2", "--with-memory"] }
{ "command": "direction", "input": ["create", "{\\"name\\":\\"Bold Editorial\\",\\"summary\\":\\"...\\"}", "--from", "warm-editorial"] }
{ "command": "direction", "input": ["archive", "warm-editorial"] }
{ "command": "direction", "input": ["feedback", "warm-editorial", "--body", "Loved the serif", "--author", "tim"] }
{ "command": "direction", "input": ["memory", "warm-editorial"] }
{ "command": "direction", "input": ["memory", "edit", "warm-editorial", "learning-abc123", "--body", "Editorial serifs, but warmer"] }
{ "command": "direction", "input": ["memory", "promote", "warm-editorial", "decision-xyz789", "--to", "global", "--severity", "guideline", "--expected-memory-version", "5", "--expected-global-version", "2"] }
{ "command": "direction", "input": ["memory", "delete", "warm-editorial", "feedback-def456", "--reason", "no longer relevant"] }
{ "command": "direction", "input": ["brief", "set", "warm-editorial", "colorIntent", "warm earthy, deep grounding dark"] }
{ "command": "direction", "input": ["brief", "patch", "warm-editorial", "{\\"tone\\":[\\"warm\\",\\"confident\\"]}"] }
{ "command": "direction", "input": ["brief", "show", "warm-editorial"] }
{ "command": "direction", "input": ["brief", "map", "warm-editorial", "warm earthy vibes for solo founders, ship it #1a1a1a", "--apply"] }
{ "command": "direction", "input": ["reconcile", "warm-editorial"] }
\`\`\`

## Arguments

- \`verb\` (required) — one of \`new\`, \`list\`, \`show\`, \`status\`, \`fork\`, \`create\`, \`archive\`, \`reject\`, \`park\`, \`revive\`, \`feedback\`, \`memory\`, \`brief\`, \`reconcile\`.
- \`id\` (required for every verb except \`list\`) — the direction id, kebab-case (e.g. \`warm-editorial\`). For \`new\`, the display name of the draft to mint. For \`create\`, the authored-content JSON payload (see below). For \`brief\`, the subverb (\`show\`|\`set\`|\`patch\`|\`map\`) comes first, then the id. For \`memory\`, an id in this slot means READ; \`edit\`|\`promote\`|\`delete\` here means WRITE.

## Drafts (new / list / show / status)

- \`direction new <name> [--describe "<text>"]\` — keyless: mints a DRAFT direction (record + \`brief.md\` projection + empty \`memory.yaml\`, NO version folder). Generate v1 with \`keyart explore <id>\`.
- \`direction list [--include-archived]\` — one draft-aware summary line per direction. Archived directions are hidden by default; \`--include-archived\` reveals them.
- \`direction show <id>\` — the same summary for one direction. Writes nothing.
- \`direction status <id>\` — a read-only projection \`{ id, status, isDraft, head, versionCount }\`. Writes nothing.

## Fork

\`direction fork <id> [--name <name>] [--count <n>] [--with-memory]\` — keyless: copies the source's brief verbatim and its moodboard files into N new DRAFTS. Memory is copied only with \`--with-memory\` (as fresh attributed appends naming the fork source); every fork gets one \`decision\` fork-provenance entry. Versions and extracted assets are NEVER copied — a fork is a new exploration.

## Create (seeded, agent-authored)

\`direction create '<json>' --from <directionId>\` — the ONE declared form: the JSON payload is the single positional, and the REQUIRED \`--from\` names the existing direction whose brief seeds the new one. To start from scratch use \`direction new <name>\` instead. Keyless — no model call; seed tokens are built deterministically from the seed direction's brief intent and memory color-locks, and become EXTRACTED from a style tile on the first \`regenerate\`. A \`tokens\` payload key is rejected — tokens are read off the generated imagery, never authored. No hex or catalog font family names in \`character\`/\`usage\` prose (rejected at create time).

The \`<json>\` payload fields: \`name\` (required), \`summary\` (required), \`positioning?\`, structured \`character\` (mood/composition/layout/imagery/texture/rhythm), \`usage\` (\`rules\`/\`antiRules\`), \`copyExamples\` (headline/subheadline/cta), optional \`styleTilePrompt\`/\`homepageMockupPrompt\`.

## Lifecycle (archive / reject / park / revive)

- \`direction archive <id>\` — a REVERSIBLE, NON-DESTRUCTIVE archive: the record transitions to \`archived\` and drops out of \`direction list\` by default (\`--include-archived\` reveals it), but everything stays on disk — the direction tree is left exactly where it was. Reverse it with \`direction revive <id>\`. Archiving the approved pointer's direction is refused with a repoint-first error (approve a different direction, then archive).
- \`direction reject <id> [--note <text>]\` — reversible rejection; \`--note\` records the reason as a \`decision\` memory entry.
- \`direction park <id>\` / \`direction revive <id>\` — park a direction for later; revive brings a rejected, parked, or archived direction back to \`active\`.

## Memory lifecycle (post-hoc edit/promote/delete — MCP-first, keyless)

\`direction memory <id>\` is a READ when the slot after the verb holds a direction **id**. It becomes a **WRITE** when that slot instead holds one of \`edit\`, \`promote\`, \`delete\` — in which case the positionals are \`[verb, action, id, entryId]\`.

- \`direction memory edit <id> <entryId> --body <text> [--channel …] [--polarity …]\` — **supersede**: appends a corrected entry and retires the original with \`supersededBy\`. Nothing is ever mutated in place.
- \`direction memory promote <id> <entryId> --to global\` — **up the scope ladder only** (global is the ONLY promote destination): lifts the entry into a global rule (\`--severity hard|guideline\`, default \`guideline\`) carrying its channel/polarity, and retires the source — the source is ALWAYS retired (no double-count).
- \`direction memory delete <id> <entryId> [--reason <text>]\` — **complete non-destructive retire** (same marker mechanism as reconcile's retire): nothing is physically removed.
- Every action requires \`--expected-memory-version\` (and \`promote --to global\` also \`--expected-global-version\`) unless \`--force\`; a stale version surfaces a 409 \`VersionConflictError\`.

## Brief (deterministic, keyless field writes)

\`direction brief\` writes the direction's structured brief with **no \`OPENAI_API_KEY\`** — the host agent supplies the words, Keyart makes no model call. Writes go through the versioned record and rewrite the \`brief.md\` projection together (409 on a stale write; \`--force\` to bypass).

- \`direction brief show <id>\` — print the structured fields **and** the rendered markdown. Writes nothing.
- \`direction brief set <id> <field> <value…>\` — write ONE field. Scalar fields (\`oneLiner\`, \`problem\`, \`positioning\`, \`voice\`, \`colorIntent\`, \`typeIntent\`, \`moodImagery\`, \`mascot\`, \`otherNotes\`) take the value string; array fields (\`aliases\`, \`neverCallIt\`, \`differentiateFrom\`, \`tone\`, \`values\`, \`inspirations\`, \`constraints\`, \`surfaces\`) take a **comma-separated** value that REPLACES the array. \`audiences\` is structured — use \`patch\`.
- \`direction brief patch <id> '<json>'\` — apply a multi-field \`BrandBriefPatch\` JSON object (unknown keys and malformed JSON are rejected with the valid field list).
- \`direction brief map <id> "<freeform…>" [--apply]\` — the ONE brief verb that CAN use the model (keyed): it **proposes** a structured patch from a natural-language ramble. Without \`--apply\` it prints the proposed field diff + hex-lock suggestions and writes nothing; with \`--apply\` it applies the field patch and routes each exact hex to a \`recordColorLock\` \`decision\` (\`Color locked: #rrggbb\`) — a hex is NEVER written as a brief field. With **no key** it degrades to an empty field proposal, so the deterministic \`set\`/\`patch\` verbs remain fully sufficient and keyless.

## Reconcile

\`direction reconcile <id>\` lists memory contradictions (deterministic floor always on + optional key-gated advisory LLM adapter); with \`--action keep|retire|supersede|promote --contradiction <id>\` it resolves one (non-destructive markers, append-only; hard rules are never auto-overridden).

## Outputs

- \`direction new\` / \`fork\` — \`brand/directions/<id>/direction.yaml\`, \`memory.yaml\`, and the generated \`brief.md\` projection (NO \`versions/\` — drafts have zero versions).
- \`direction create\` — \`brand/directions/<directionId>/direction.yaml\` plus a v1 version folder under \`versions/\` (version record, brief/context snapshots, prompt files; no images — always keyless).
- \`direction archive\` / \`reject\` / \`park\` / \`revive\` — \`brand/directions/<id>/direction.yaml\` (and \`memory.yaml\` when \`reject --note\` records a decision). Archive keeps the whole tree on disk.
- \`direction feedback\` — \`brand/directions/<id>/memory.yaml\`.
- \`direction memory\` (read) / \`show\` / \`status\` / \`list\` — **write nothing**.
- \`direction memory edit\` / \`delete\` — \`brand/directions/<id>/memory.yaml\`. \`promote --to global\` — ALSO \`brand/brand.yaml\`.
- \`direction brief set\` / \`patch\` — \`brand/directions/<id>/direction.yaml\` + \`brand/directions/<id>/brief.md\` (rewritten together). \`brief show\` writes nothing.
- \`direction reconcile\` (list only) — no files; with \`--action\`, \`memory.yaml\` (all actions) and \`brand.yaml\` (promote only).

## Examples

\`\`\`
keyart direction new warm-editorial --describe "a calm cooking tracker"
keyart direction list
keyart direction list --include-archived
keyart direction show warm-editorial
keyart direction status warm-editorial
keyart direction fork warm-editorial --name warm-v2 --count 2 --with-memory
keyart direction create '{"name":"Bold Editorial","summary":"Strong contrast, confident type"}' --from warm-editorial
keyart direction archive tried-and-parked
keyart direction revive tried-and-parked
keyart direction feedback warm-editorial --body "Loved the serif headline" --author tim
keyart direction memory warm-editorial
keyart direction memory edit warm-editorial learning-abc123 --body "Editorial serifs, but warmer"
keyart direction memory promote warm-editorial decision-xyz789 --to global --severity guideline --expected-memory-version 5 --expected-global-version 2
keyart direction memory delete warm-editorial feedback-def456 --reason "no longer relevant"
keyart direction brief set warm-editorial colorIntent "warm earthy, deep grounding dark"
keyart direction brief patch warm-editorial '{"problem":"AI prototypes look generic","surfaces":["site","app"]}'
keyart direction reconcile warm-editorial
\`\`\`

## Notes

- Works fully **without** \`OPENAI_API_KEY\` — every verb here is pure filesystem, no model calls (\`brief map\` is the one verb that CAN use the model, and degrades keylessly).
- Memory lifecycle is append-only + non-destructive: \`edit\` = supersede, \`delete\` = retire, \`promote\` = append globally + retire the source — nothing is ever physically removed.
- \`archive\` is REVERSIBLE and NON-DESTRUCTIVE — the direction stays on disk, hidden from \`direction list\` until \`--include-archived\` or a \`revive\`. The approved pointer's direction cannot be archived (repoint first).
- \`feedback\` records **attributed** (\`author\`/\`source\`/\`date\`) memory scoped to exactly ONE direction — never a sibling read. Appending to a missing direction throws and writes nothing.
- Per-direction memory stays isolated; to write a GLOBAL rule use \`rule add\`, and to lift one direction's learning into a global rule use \`promote\` (or \`direction memory promote --to global\`).
- After \`direction new\`, generate v1 with \`keyart explore <id>\`; iterate with \`keyart regenerate <id>\`; approve with \`keyart approve <id>\`.`,
};

function directionDraftLine(s: DirectionSummary): string {
  const state = s.isDraft
    ? "draft — no versions yet"
    : `head ${s.head} (${s.versionCount} version${s.versionCount === 1 ? "" : "s"})`;
  return `${s.id}  "${s.name}"  [${s.status}]  ${state}`;
}

/** cwd-relative, forward-slash paths for a direction's core files. */
async function directionFilePaths(
  cwd: string,
  directionId: string,
  files: string[],
): Promise<string[]> {
  const config = await loadConfig(cwd);
  const root = directionsRoot(cwd, config);
  const resolved = path.resolve(cwd);
  return files.map((f) =>
    path
      .relative(resolved, path.join(root, directionId, f))
      .split(path.sep)
      .join("/"),
  );
}

const DRAFT_FILES = ["direction.yaml", "memory.yaml", "brief.md"];

directionMeta.run = async (ctx) => {
  const { positionals, flags } = parseArgs(directionMeta, ctx.input);
  const verb = positionals[0];
  switch (verb) {
    case "new": {
      const result = await runDirectionNew({
        cwd: ctx.cwd,
        name: positionals[1],
        describe: flagValue(flags, "describe"),
      });
      return {
        summary: `Created draft direction "${result.directionId}" (no versions yet). Next: keyart_brand { command: "explore", input: ["${result.directionId}"] }.`,
        filesWritten: await directionFilePaths(ctx.cwd, result.directionId, DRAFT_FILES),
      };
    }
    case "show": {
      const summary = await runDirectionShow({ cwd: ctx.cwd, directionId: positionals[1] });
      return { summary: directionDraftLine(summary), filesWritten: [] };
    }
    case "fork": {
      const countRaw = flagValue(flags, "count");
      const result = await runDirectionFork({
        cwd: ctx.cwd,
        sourceId: positionals[1],
        name: flagValue(flags, "name"),
        count: countRaw !== undefined ? parseInt(countRaw, 10) : undefined,
        withMemory: flags["with-memory"] === true,
      });
      const filesWritten: string[] = [];
      for (const fork of result.forks) {
        filesWritten.push(
          ...(await directionFilePaths(ctx.cwd, fork.directionId, DRAFT_FILES)),
        );
      }
      return {
        summary: `Forked "${result.sourceId}" into ${plural(result.forks.length, "draft")}: ${result.forks.map((f) => f.directionId).join(", ")}.`,
        filesWritten,
      };
    }
    case "create": {
      // R-6: ONE declared syntax — `direction create '<json>' --from <id>`.
      if (positionals[2] !== undefined) {
        throw new CommandError(
          "direction create takes one positional (the JSON) — the source direction is passed with --from, not as a positional.\nUsage: keyart direction create '<json>' --from <directionId>",
        );
      }
      const from = flagValue(flags, "from");
      if (from === undefined) {
        throw new CommandError(
          "direction create requires --from <directionId> (the direction whose brief seeds the new one).\nUsage: keyart direction create '<json>' --from <directionId>\nTo start from scratch, use `direction new <name>` instead.",
        );
      }
      const result = await runCreateDirection({
        cwd: ctx.cwd,
        verb,
        seedDirectionId: from,
        json: positionals[1],
      });
      return {
        summary: `Created direction "${result.directionId}" (${result.versionId}) seeded from "${result.seedDirection}".`,
        filesWritten: result.filesWritten,
      };
    }
    default: {
      // list | status | archive | reject | park | revive | feedback | memory |
      // brief | reconcile — plus runDirection's teaching unknown-verb error.
      // `brief` overloads the positionals: ["brief", <subverb>, <id>, <field>,
      // <value…>] (or a JSON patch at slot 3 for `patch`). `memory` overloads
      // similarly when slot 1 is a lifecycle action word: ["memory",
      // <edit|promote|delete>, <id>, <entryId>] — a direction id in slot 1
      // instead means "read" (unchanged). Every other verb uses [<verb>, <id>].
      const isBrief = verb === "brief";
      const isBriefMap = isBrief && positionals[1] === "map";
      const isMemoryAction =
        verb === "memory" &&
        (MEMORY_ACTIONS as readonly string[]).includes(positionals[1]);
      const result = await runDirection({
        cwd: ctx.cwd,
        verb,
        id: isBrief ? positionals[2] : isMemoryAction ? positionals[2] : positionals[1],
        subverb: isBrief ? positionals[1] : undefined,
        field: isBrief && !isBriefMap ? positionals[3] : undefined,
        value:
          isBrief && !isBriefMap && positionals.length > 4
            ? positionals.slice(4).join(" ")
            : undefined,
        json: isBrief && !isBriefMap ? positionals[3] : undefined,
        // `map` overloads slot 3 as the freeform ramble; slots 3+ are joined so a
        // multi-token freeform passed as separate array elements still coalesces.
        freeform: isBriefMap ? positionals.slice(3).join(" ") : undefined,
        apply: isBriefMap ? flags.apply === true : undefined,
        memoryAction: isMemoryAction ? positionals[1] : undefined,
        entryId: isMemoryAction ? positionals[3] : undefined,
        includeArchived: verb === "list" ? flags["include-archived"] === true : undefined,
        to: flagValue(flags, "to"),
        reason: flagValue(flags, "reason"),
        note: flagValue(flags, "note"),
        body: flagValue(flags, "body"),
        kind: flagValue(flags, "kind"),
        author: flagValue(flags, "author"),
        channel: flagValue(flags, "channel"),
        polarity: flagValue(flags, "polarity"),
        contradictionId: flagValue(flags, "contradiction"),
        action: flagValue(flags, "action"),
        winner: flagValue(flags, "winner"),
        severity: flagValue(flags, "severity"),
        expectedMemoryVersion: (() => {
          const v = flagValue(flags, "expected-memory-version");
          const n = v !== undefined ? parseInt(v, 10) : NaN;
          return Number.isFinite(n) ? n : undefined;
        })(),
        expectedGlobalVersion: (() => {
          const v = flagValue(flags, "expected-global-version");
          const n = v !== undefined ? parseInt(v, 10) : NaN;
          return Number.isFinite(n) ? n : undefined;
        })(),
        force: flags.force === true,
      });
      return { summary: directionResultSummary(result), filesWritten: result.filesWritten };
    }
  }
};

const assetMeta: CommandMeta = {
  name: "asset",
  summary: "Extract, iterate, list, retire, and pack direction-scoped standalone brand assets.",
  args: [
    { name: "verb", required: true, description: "One of: extract, regenerate, list, remove, pack." },
    { name: "assetId", required: false, description: "regenerate/remove: the target extracted-asset id (e.g. yak-mascot)." },
  ],
  flags: [
    { name: "--direction", description: "Direction id: the extraction source (extract, required), a listing filter (list), or the pack target (pack; default: the approved direction).", takesValue: true },
    { name: "--describe", description: "What to isolate, e.g. \"the yak mascot\" (extract only, required).", takesValue: true },
    { name: "--image", description: "Source image name: styleTile (default) | homepageMockup | moodboard (extract only).", takesValue: true },
    { name: "--version", description: "Source direction versionId (extract only; default: the direction's head).", takesValue: true },
    { name: "--crop", description: "Path to a crop reference image narrowing the subject (extract only).", takesValue: true },
    { name: "--name", description: "Display name for the new asset (extract only; default: derived from --describe).", takesValue: true },
    { name: "--tweak", description: "The change to apply, e.g. \"make it face left\" (regenerate only, required).", takesValue: true },
    { name: "--remember", description: "Also log the tweak as a direction-scoped memory entry (regenerate only; default: asset-local, no memory write).", takesValue: false },
    { name: "--author", description: "Attribution for the --remember memory entry (regenerate only; default: cli).", takesValue: true },
  ],
  dispatchable: true,
  helpDoc: `# keyart asset

Extract a standalone, direction-scoped visual element off a direction's imagery, iterate it with a tweak, list/retire it, and pack a direction's active assets for handoff. Assets are evocative-imagery-tier only — they never touch the token spine (\`brand.css\`, the deterministic board) or a direction's record.

## Usage

CLI:
\`\`\`
keyart asset extract --direction <dirId> --describe "<text>" [--image styleTile|homepageMockup|moodboard] [--version <versionId>] [--crop <path>] [--name <name>]
keyart asset regenerate <assetId> --tweak "<text>" [--remember] [--author <author>]
keyart asset list [--direction <dirId>]
keyart asset remove <assetId>
keyart asset pack [--direction <dirId>]
\`\`\`

\`keyart_brand\`:
\`\`\`json
{ "command": "asset", "input": ["extract", "--direction", "direction-a", "--describe", "the yak mascot"] }
{ "command": "asset", "input": ["regenerate", "yak-mascot", "--tweak", "make it face left"] }
{ "command": "asset", "input": ["list", "--direction", "direction-a"] }
{ "command": "asset", "input": ["remove", "yak-mascot"] }
{ "command": "asset", "input": ["pack", "--direction", "direction-a"] }
\`\`\`

## Arguments

- \`verb\` (required) — one of \`extract\`, \`regenerate\`, \`list\`, \`remove\`, \`pack\`.
- \`assetId\` (required for \`regenerate\`/\`remove\` only) — the target extracted-asset id (e.g. \`yak-mascot\`).

## Flags

- \`--direction <dirId>\` — the extraction source direction (\`extract\`, required), a listing filter (\`list\`), or the pack target (\`pack\`; default: the approved direction's).
- \`--describe <text>\` (\`extract\`, required) — what to isolate, e.g. \`"the yak mascot"\`.
- \`--image <name>\` (\`extract\` only) — the source image to extract from: \`styleTile\` (default), \`homepageMockup\`, or \`moodboard\`.
- \`--version <versionId>\` (\`extract\` only) — the source direction's versionId (default: its head).
- \`--crop <path>\` (\`extract\` only) — a crop reference image narrowing the subject.
- \`--name <name>\` (\`extract\` only) — display name for the new asset (default: derived from \`--describe\`).
- \`--tweak <text>\` (\`regenerate\`, required) — the change to apply, e.g. \`"make it face left"\`.
- \`--remember\` (\`regenerate\` only) — also log the tweak as a direction-scoped memory entry (default: asset-local, no memory write).
- \`--author <author>\` (\`regenerate\` only) — attribution for the \`--remember\` entry (default \`cli\`).

## Outputs

- \`extract\` / \`regenerate\` — a new version under \`brand/directions/<directionId>/extracted-assets/<assetId>/versions/<versionId>/\` (\`asset-prompt.md\`, and \`asset.png\` when a key/image model produced one) plus the asset's \`asset.json\` index.
- \`list\` — no files; prints each active asset's id, direction, head version, version count, and \`png=<path>\` — the cwd-relative path to the head PNG, ready to copy into the consuming app (pending assets say so instead of a path).
- \`remove\` — the same \`asset.json\` index, carrying a non-destructive \`retiredAt\` marker.
- \`pack\` — \`brand/generated/asset-pack/<directionId>/\` (per-asset PNGs, \`contact-sheet.svg\`/\`.md\`, \`tokens.json\`, \`pack-manifest.json\`; each manifest row states its packed \`file\` name explicitly). The pack is also refreshed automatically by \`approve\`, and the codified implementation brief + cursor rules list the shipped assets — run \`pack\` explicitly to refresh after extracting or retiring an asset between approves.

## Examples

\`\`\`
keyart asset extract --direction direction-a --describe "the yak mascot"
keyart asset regenerate yak-mascot --tweak "make it face left"
keyart asset regenerate yak-mascot --tweak "smile more" --remember --author tim
keyart asset list --direction direction-a
keyart asset remove yak-mascot
keyart asset pack --direction direction-a
\`\`\`

## Notes

- **Keyless/dry-run parity.** Every verb dispatches without \`OPENAI_API_KEY\`; \`extract\`/\`regenerate\` degrade to a dry-run (prompt + index written, no PNG) through the underlying asset cores.
- **\`remove\` is a non-destructive, idempotent retire** — it sets a \`retiredAt\` marker (never deletes files); retiring an already-retired asset is a no-op that preserves the original timestamp.
- **Asset tweaks are asset-local by default.** \`--remember\` on \`regenerate\` additionally logs a direction-scoped feedback entry, bridging the tweak into that direction's memory.
- **\`ExtractedAsset\` ≠ \`AssetRef\`.** An extracted asset is a produced, versioned, standalone artifact with its own tree — distinct from the path-only \`AssetRef\` moodboard/kept-crop references recorded in \`direction.yaml\`. Neither record converts into the other.
- \`list\` excludes retired assets by default (per-direction isolation) — pass \`--direction\` to filter to one direction's assets.`,
};

const assetFlag = flagValue;

function assetSummary(result: AssetCommandResult): string {
  switch (result.verb) {
    case "extract":
      return `Extracted asset "${result.assetId}" (${result.versionId})${result.dryRun ? " — dry-run, no PNG" : ""}.`;
    case "regenerate":
      return `Regenerated asset "${result.assetId}" (${result.versionId})${result.dryRun ? " — dry-run, no PNG" : ""}.`;
    case "list":
      return `${plural(result.assets.length, "extracted asset")} on direction "${result.directionId}".`;
    case "remove":
      return result.alreadyRetired
        ? `Asset "${result.assetId}" was already retired.`
        : `Retired asset "${result.assetId}" (non-destructive retire).`;
    case "pack":
      return `Asset pack written for ${result.directionId}: ${result.assetsIncluded.length} asset(s), ${result.assetsPending.length} pending.`;
  }
}

assetMeta.run = async (ctx) => {
  const { positionals, flags } = parseArgs(assetMeta, ctx.input);
  const result = await runAsset(ctx.cwd, positionals, {
    direction: assetFlag(flags, "direction"),
    describe: assetFlag(flags, "describe"),
    image: assetFlag(flags, "image"),
    version: assetFlag(flags, "version"),
    crop: assetFlag(flags, "crop"),
    name: assetFlag(flags, "name"),
    tweak: assetFlag(flags, "tweak"),
    remember: flags.remember === true ? true : undefined,
    author: assetFlag(flags, "author"),
  });
  return { summary: assetSummary(result), filesWritten: result.filesWritten };
};

const surfaceMeta: CommandMeta = {
  name: "surface",
  summary:
    "Author, publish, and query the demand-side surface manifest of styleable app slots.",
  args: [
    { name: "verb", required: true, description: "One of: schema, show, set, patch, request, retire, bind, fill, scan." },
    {
      name: "payload",
      required: false,
      variadic: true,
      description:
        "set/patch: a JSON array of slots; request: one slot as JSON; retire: the target slotId (e.g. icon.restaurant) — omit it when using --origin; bind/fill: no payload; scan: one or more URLs (at least one required).",
    },
  ],
  flags: [
    { name: "--include-retired", description: "Include retired slots (show only).", takesValue: false },
    { name: "--author", description: "Attribution author for a requested slot (request only; default: agent).", takesValue: true },
    { name: "--source", description: "Attribution source for a requested slot (request only; default: cli).", takesValue: true },
    { name: "--expected-version", description: "Expected manifest version for optimistic write (set | patch | request | retire).", takesValue: true },
    { name: "--force", description: "Bypass optimistic version checks.", takesValue: false },
    { name: "--slot", description: "Fill exactly this slot id (default: every asset-slot gap). Asset slots only — color/type roles derive in bind.", takesValue: true },
    { name: "--apply", description: "Merge every proposed candidate into brand/surface.yaml with origin:scan (scan only; default: propose-only).", takesValue: false },
    { name: "--no-refine", description: "Skip the key-gated vision refinement tier (scan only; floor proposal only).", takesValue: false },
    { name: "--refine-only", description: "Re-run refinement on the existing scan proposal (scan only; no URLs, requires a prior scan).", takesValue: false },
    { name: "--dismiss", description: "Selector(s) clicked in order after load to dismiss a gate/banner (scan only; comma-separate multiple selectors; absence-tolerant).", takesValue: true },
    { name: "--wait-for", description: "Selector to await after load before observing (scan only; bounded timeout; absence-tolerant).", takesValue: true },
    { name: "--origin", description: "Bulk-retire every ACTIVE slot of this origin: authored | scan | request (retire only; mutually exclusive with a slotId).", takesValue: true },
  ],
  dispatchable: true,
  helpDoc: `# keyart surface

The demand-side surface manifest: the inventory of every styleable slot a consuming app has (icons, illustrations, extra color/type roles). Keyart owns the vocabulary; host agents author content against it.

## Usage

CLI:
\`\`\`
keyart surface schema
keyart surface show [--include-retired]
keyart surface set '<json array of slots>' [--expected-version <n>] [--force]
keyart surface patch '<json array of slots>' [--expected-version <n>] [--force]
keyart surface request '<json slot>' [--author <author>] [--source <source>] [--expected-version <n>] [--force]
keyart surface retire <slotId> [--expected-version <n>] [--force]
keyart surface retire --origin <authored|scan|request> [--expected-version <n>] [--force]
keyart surface bind
keyart surface fill [--slot <id>]
keyart surface scan <url...> [--apply] [--no-refine] [--dismiss <selector>]... [--wait-for <selector>]
keyart surface scan --refine-only
\`\`\`

\`keyart_brand\` (payloads with spaces MUST be passed as array input — a string input is whitespace-split and would shatter JSON):
\`\`\`json
{ "command": "surface", "input": ["schema"] }
{ "command": "surface", "input": ["show", "--include-retired"] }
{ "command": "surface", "input": ["set", "[{\\"id\\":\\"icon.restaurant\\",\\"kind\\":\\"icon\\",\\"description\\":\\"Restaurant marker\\",\\"criticality\\":\\"required\\",\\"origin\\":\\"authored\\",\\"attributions\\":[]}]"] }
{ "command": "surface", "input": ["patch", "[{\\"id\\":\\"icon.scooter\\",\\"kind\\":\\"icon\\",\\"description\\":\\"Delivery scooter\\",\\"criticality\\":\\"preferred\\",\\"origin\\":\\"authored\\",\\"attributions\\":[]}]"] }
{ "command": "surface", "input": ["request", "{\\"id\\":\\"icon.scooter\\",\\"kind\\":\\"icon\\",\\"description\\":\\"Delivery scooter for the courier card\\",\\"criticality\\":\\"required\\"}", "--author", "coding-agent", "--source", "mcp"] }
{ "command": "surface", "input": ["retire", "icon.scooter"] }
{ "command": "surface", "input": ["retire", "--origin", "scan"] }
{ "command": "surface", "input": ["bind"] }
{ "command": "surface", "input": ["fill", "--slot", "icon.restaurant"] }
{ "command": "surface", "input": ["scan", "http://localhost:3000"] }
{ "command": "surface", "input": ["scan", "http://localhost:3000", "--apply"] }
{ "command": "surface", "input": ["scan", "--refine-only"] }
{ "command": "surface", "input": ["scan", "http://localhost:3000", "--dismiss", ".modal__close,.cookie-accept", "--wait-for", "main"] }
\`\`\`

## Arguments

- \`verb\` (required) — one of \`schema\`, \`show\`, \`set\`, \`patch\`, \`request\`, \`retire\`, \`bind\`, \`fill\`, \`scan\`.
- \`payload\` (required for \`set\`/\`patch\`/\`request\`/\`retire\`/\`scan\`; none for \`bind\`/\`fill\`) — \`set\`/\`patch\`: a JSON array of slot objects; \`request\`: one slot as a JSON object; \`retire\`: the target slotId (e.g. \`icon.restaurant\`) — omit it when using \`--origin\`; \`scan\`: one or more URLs (at least one required).

## Flags

- \`--include-retired\` (\`show\` only) — include retired slots (excluded by default).
- \`--author <author>\` (\`request\` only) — attribution author for the requested slot (default \`agent\`).
- \`--source <source>\` (\`request\` only) — attribution source for the requested slot (default \`cli\`; recommend \`mcp\` when calling through \`keyart_brand\`).
- \`--expected-version <n>\` (\`set\`/\`patch\`/\`request\`/\`retire\`) — expected manifest version for an optimistic write; a stale version is rejected unless \`--force\`.
- \`--force\` (\`set\`/\`patch\`/\`request\`/\`retire\`) — bypass the optimistic version check.
- \`--slot <id>\` (\`fill\` only) — fill exactly this slot id (default: every asset-slot gap). Asset slots only — color/type roles derive in \`bind\`, never fill.
- \`--apply\` (\`scan\` only) — merge every proposed candidate into \`brand/surface.yaml\` with \`origin: "scan"\` (default: propose-only).
- \`--no-refine\` (\`scan\` only) — skip the key-gated vision refinement tier; the floor proposal ships as-is (anonymous ids).
- \`--refine-only\` (\`scan\` only) — re-run refinement on the EXISTING scan proposal, no URLs; requires a prior \`surface scan\`. Cannot combine with a URL, \`--apply\`, or \`--no-refine\`.
- \`--dismiss <selector>\` (\`scan\` only) — selector clicked after load to dismiss a gate/banner; repeatable on the CLI (applied in order); on \`keyart_brand\`, pass a SINGLE comma-separated list (e.g. \`.modal__close,.cookie-accept\`) since a repeated flag overwrites on that surface. Absence-tolerant: a selector that never appears is recorded as a note, never an error. Replaces \`scan.dismiss\` from config for this run.
- \`--wait-for <selector>\` (\`scan\` only) — selector awaited (bounded timeout) after load, before observing. Absence-tolerant. Replaces \`scan.waitFor\` from config for this run.
- \`--origin <origin>\` (\`retire\` only) — bulk-retires every ACTIVE slot of this origin (\`authored\` | \`scan\` | \`request\`) in one non-destructive, idempotent, versioned write. Mutually exclusive with a slotId: giving both, or neither, is a teaching error naming the two usage forms.

## Outputs

- \`brand/surface.yaml\` — written by \`set\`, \`patch\`, \`request\`, \`retire\`, and \`scan --apply\`.
- \`schema\`/\`show\` write nothing; they only read and print.
- \`bind\` — \`binding.json\` at \`outputs.binding\` (default \`brand/generated/binding.json\`), plus the refreshed asset pack under \`brand/generated/asset-pack/<directionId>/\`.
- \`fill\` — one new \`ExtractedAsset\` version per filled slot under \`brand/directions/<directionId>/extracted-assets/<slotId>/versions/<versionId>/\` (\`asset-prompt.md\`, and \`asset.png\` when a key/image model produced one), each carrying the slot id in its \`asset.json\` index.
- \`scan\` — \`brand/generated/surface-scan/proposal.json\` + \`brand/generated/surface-scan/crops/<signature>.png\` (one crop per candidate), always; \`brand/surface.yaml\` only with \`--apply\`. With an \`OPENAI_API_KEY\`, the SAME \`proposal.json\` is additionally enriched in place by the key-gated refinement tier (meaningful ids/kinds/descriptions, per-field \`refined\` flags, \`refinedAt\`) — never a second file, never the manifest.

## Examples

\`\`\`
keyart surface schema
keyart surface show
keyart surface show --include-retired
keyart surface set '[{"id":"icon.restaurant","kind":"icon","description":"Restaurant marker","criticality":"required","origin":"authored","attributions":[]}]'
keyart surface patch '[{"id":"icon.scooter","kind":"icon","description":"Delivery scooter","criticality":"preferred","origin":"authored","attributions":[]}]'
keyart surface request '{"id":"icon.scooter","kind":"icon","description":"Delivery scooter for the courier card","criticality":"required"}' --author coding-agent --source mcp
keyart surface retire icon.scooter
keyart surface retire --origin scan
keyart surface bind
keyart surface fill
keyart surface fill --slot icon.restaurant
keyart surface scan http://localhost:3000
keyart surface scan http://localhost:3000 http://localhost:3000/pricing --apply
keyart surface scan http://localhost:3000 --no-refine
keyart surface scan --refine-only
keyart surface scan http://localhost:3000 --dismiss ".modal__close" --dismiss ".cookie-accept" --wait-for main
\`\`\`

## bind

Resolve every ACTIVE slot of the surface manifest against the approved pointer's direction and its active extracted assets, and write the deterministic \`binding.json\` lockfile + an honest gap report. Takes no positional beyond the verb and no flags.

- **Token slots** (\`color-role\`/\`type-role\`) project from the SAME \`resolveBrandVars\` used by \`brand.css\` — byte-identical values. A \`color-role\` slot outside the six semantic roles (\`background\`/\`surface\`/\`text\`/\`muted\`/\`primary\`/\`secondary\`) is deterministically **derived** from the direction's brand primitives, WCAG-AA-finished against the slot's \`context.sitsOn\` role, and marked \`derived: true\`.
- **Asset slots** (\`icon\`/\`illustration\`) match ONLY on an extracted asset's \`slotId\` — never on name. Zero active claimants ⇒ a gap; a claimant with no packed image yet ⇒ \`status: "pending"\`; two or more active claimants ⇒ \`CommandError\` naming both/all asset ids and the slot id.
- **Gap report.** Every unresolved slot is listed with its \`kind\`/\`criticality\`/\`origin\`/attribution count; \`origin: "request"\` slots are called out with their request count; \`kind: "other"\` slots are flagged as taxonomy demand.
- **Deterministic.** No \`Date.now()\`/\`Math.random()\` on the bind path — the only timestamp in \`binding.json\` is the approved pointer's own \`approvedAt\`, so a double run is byte-identical. Fully keyless; dry-run and keyed runs are the same code path.
- **Fails loudly, writing nothing,** when no surface manifest exists (naming \`surface schema\`/\`surface set\`) or nothing is approved yet (naming \`keyart approve\`).
- Refreshes the asset pack as part of the same run, so a fill (or any extract/retire) since the last bind is picked up automatically — no manual \`asset pack\` step needed.

## fill

Close asset-slot gaps IN-IDIOM: generates each unresolved \`icon\`/\`illustration\` slot as an ORDINARY \`ExtractedAsset\`, through the EXISTING asset-extraction pipeline, against the approved direction's PINNED version — the slot's description + context (legibility at the smallest size, silhouette contrast against its \`sitsOn\` role, \`usedIn\`, \`tone\`, \`note\`) is composed into the extract \`describe\` text, and the isolation directive + \`composeArtDirection\` MUST/PREFER/AVOID block ride along automatically via the existing extract prompt compiler. The minted asset is stamped with the slot id (\`slotId\`) so the very next \`surface bind\` resolves it.

- **Target selection.** No \`--slot\`: fills every \`icon\`/\`illustration\` slot currently a \`gap\` (manifest order); zero gaps ⇒ \`No asset-slot gaps to fill.\`, not an error. \`--slot <id>\`: fills exactly that slot — rejected with a teaching \`CommandError\` when it names a \`color-role\`/\`type-role\` (those derive deterministically in \`bind\`, never fill), a \`kind: "other"\` slot (taxonomy demand — reclassify via \`surface patch\` first), an unknown/retired slot, or a slot already \`bound\`/\`pending\` (names the claiming asset id and the remedy: \`asset regenerate --tweak\` or \`asset remove\`). Fill NEVER mints a second claimant for a slot.
- **Key-gated exactly like \`asset extract\`.** Keyless ⇒ every gap becomes an honest pending record (prompt + index + \`slotId\` written, NO image, NO fabrication); the next \`bind\` reports the slot \`pending\`, not \`gap\`. A keyed-but-failed generation surfaces the extract pipeline's existing \`imageSkips\` warnings.
- **The result is an ordinary asset.** Tweakable via \`asset regenerate --tweak\` (the \`slotId\` linkage survives), retirable via \`asset remove\` (drops it from the next bind, reverting the slot to \`gap\`), packed by \`asset pack\`/\`approve\` — and NEVER a token source.
- Fill performs no binding write itself — run \`surface bind\` afterward to refresh \`binding.json\`.

## scan

Lane 1, tier 1 of the demand side: a keyless, deterministic, rendered-truth inventory. Drives Playwright over each explicit URL (no crawling) and walks the rendered DOM for inline \`<svg>\`s within conservative glyph bounds (\`icon\`), \`<img>\`/\`background-image\` art above a minimum size with spacer/tracking-pixel filtering (\`illustration\`), and computed colors/font families not present in the approved direction's bound tokens (\`color-role\`/\`type-role\`, observed value in \`context.note\`).

- **Propose-only by default.** Every scan writes \`brand/generated/surface-scan/proposal.json\` (candidates with \`signature\`/\`kind\`/observed values/DOM hints/\`cropFile\`) plus one screenshot crop per candidate under \`crops/\`. \`brand/surface.yaml\` is NEVER touched without \`--apply\`.
- **\`--apply\` merges through the validated path.** Every current candidate becomes a \`preferred\`, \`origin: "scan"\` slot with an attribution \`{ author: "scan", source: "surface-scan:<signature>" }\`, upserted in ONE \`patchSlots\` call — the same validated, versioned write path as \`set\`/\`patch\`. This is the CLI apply-ALL path; per-candidate accept/reject is a studio triage workflow, not here.
- **Diff-aware re-scans.** Candidates already covered by the current manifest (via the \`surface-scan:<signature>\` attribution, including on RETIRED slots) or already rejected in a prior proposal's \`rejectedSignatures\` are omitted and counted in the summary's "skipped covered"; a retired scan slot's id is never re-minted.
- **Honest anonymous ids, upgraded automatically when a key is present.** \`proposedId\`s start as placeholders like \`icon.unnamed-1\`. Immediately after the floor writes \`proposal.json\` (and BEFORE \`--apply\` merges), \`scan\` auto-runs the key-gated vision refinement tier: WITH \`OPENAI_API_KEY\`, crops + DOM hints are classified into meaningful ids/kinds/descriptions, merged back into the SAME \`proposal.json\` with per-field \`refined\` flags (\`proposedId\`/\`kind\`/\`description\`) and a \`refinedAt\` stamp — invalid/colliding suggestions are dropped with a recorded reason in \`refineNotes\`, never silently mangled. WITHOUT a key, refinement is not even attempted and the proposal ships honestly labeled unrefined. \`--no-refine\` skips the tier regardless of key. \`--apply\` merges the REFINED ids when refinement ran. Refinement NEVER touches \`brand/surface.yaml\` — apply is always the explicit act. Re-run refinement standalone at any time (e.g. after adding a key) with \`surface scan --refine-only\`, which upgrades the SAME proposal in place without re-scanning.
- **Fails loudly, writing nothing,** when a URL can't be reached (names the URL and asks whether the app is running), when \`scan\` is called with zero URLs, or when \`--refine-only\` is run with no prior proposal (names the expected path and the remedy).
- **No approved direction** degrades to an empty token baseline (every observed color/font becomes a candidate) rather than crashing.
- **Page setup (absence-tolerant).** \`config.scan\` (\`waitFor\`/\`dismiss\`/\`storage\`/\`cookies\`) seeds localStorage + cookies BEFORE navigation, then awaits \`waitFor\` and clicks each \`dismiss\` selector in order; a selector that never appears is a recorded note, never an error; \`--dismiss\`/\`--wait-for\` REPLACE the config values for one run; with no config and no flags the scan behaves exactly as before.
- **Overlay honesty.** After setup, an element covering more than 60% of the viewport at a high stacking context is reported as \`blockedByOverlay\` on the proposal plus a warning naming its hints; the scan never silently inventories a modal as the page.

## Notes

- **Closed five-kind vocabulary.** \`icon\`, \`illustration\`, \`color-role\`, \`type-role\`, \`other\` — an unknown kind is rejected with a teaching error naming the valid kinds; \`other\` + \`context.note\` is the legal escape hatch and is recorded as taxonomy demand.
- **Versioned, 409-safe writes.** \`set\`/\`patch\`/\`request\`/\`retire\` are optimistic-concurrency writes over \`brand/surface.yaml\`; a stale \`--expected-version\` is rejected unless \`--force\`.
- **\`request\` is THE protocol verb for a consuming agent's uncovered need.** It appends an attributed \`origin: "request"\` slot; re-requesting an existing id appends another attribution instead of a duplicate slot. Never invent an off-vocabulary kind — request instead.
- **\`retire\` is non-destructive and idempotent.** It sets a \`retiredAt\` marker (never deletes); retiring an already-retired slot is a no-op that preserves the original timestamp. \`show\` drops retired slots by default.
- **Bad-scan recovery.** \`surface retire --origin scan\` clears an entire unwanted scan in one non-destructive, idempotent, versioned write — nothing is deleted, the slots stay in \`brand/surface.yaml\` with a \`retiredAt\` marker and drop out of \`show\`/\`bind\`/the gap report. \`authored\` and \`request\` slots are untouched. The workflow is: \`surface retire --origin scan\` → tune the \`scan\` config block (or \`--dismiss\`/\`--wait-for\`) → re-run \`surface scan\`. Retired scan slots still suppress re-proposal of the same signatures, so a re-scan proposes genuinely new candidates rather than the same junk. Fully keyless via CLI and \`keyart_brand\`.
- **\`bind\` is the deterministic lockfile + gap report** — see the \`## bind\` section above.
- **\`fill\` closes gaps in-idiom through the existing extract machinery** — see the \`## fill\` section above.
- **Fully keyless**, except \`fill\`'s image generation and \`scan\`'s refinement tier — both degrade honestly (\`fill\` without a key: pending, no image, no throw; \`scan\`/\`--refine-only\` without a key: \`dryRun: true\`, the proposal left byte-untouched, an honest unrefined label) without ever fabricating output. \`scan\` additionally requires Playwright/Chromium for the floor walk itself (degrades to a \`CommandError\` naming the install remedy, independent of the key).
- **\`scan\` requires Playwright + Chromium** (\`npx playwright install chromium\`) and may take **30–60s per URL** — set an adequate tool timeout when calling it via \`keyart_brand\`.
- **\`--refine-only\` is NOT a new command.** It stays inside the existing \`scan\` verb and the existing \`surface\` \`CommandMeta\` — there is no additive registry entry for refinement.
- \`scan\` setup and the overlay guard are **fully keyless** — no model call is involved, and \`--dismiss\`/\`--wait-for\` change nothing about the propose-only default.`,
};

const surfaceFlag = flagValue;

/** MCP repeatable-flag idiom (the parseReferenceFlags precedent): parseArgs keeps one
 *  value per flag key, so `--dismiss` carries a COMMA-SEPARATED selector list here.
 *  LIMITATION (documented, not worked around): a CSS selector list containing its own
 *  comma — e.g. ".modal .close, .gate .x" as ONE selector — cannot be expressed on the
 *  MCP surface, because parseArgs OVERWRITES a repeated flag key, so "pass them
 *  separately" is impossible here. Such selectors belong in `scan.dismiss` in
 *  keyart.config.ts, which is a real string[] and has no comma ambiguity; the
 *  helpDoc must say exactly that. The CLI keeps a true repeatable collector and is
 *  unaffected. */
function parseDismissFlag(flags: Record<string, string | boolean>): string[] | undefined {
  const raw = typeof flags.dismiss === "string" ? flags.dismiss : undefined;
  if (raw === undefined) return undefined;
  const selectors = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return selectors.length > 0 ? selectors : undefined;
}

function surfaceSummary(result: SurfaceCommandResult): string {
  switch (result.verb) {
    case "schema":
      return "Surface schema + scan brief printed.";
    case "show":
      return result.manifest === null
        ? "No surface manifest yet."
        : `${plural(result.rows.length, "surface slot")} (manifest version ${result.manifest.version}).`;
    case "set":
      return `Surface manifest set: ${result.manifest.slots.length} slot(s) (version ${result.manifest.version}).`;
    case "patch":
      return `Surface manifest patched: ${result.manifest.slots.length} slot(s) total (version ${result.manifest.version}).`;
    case "request":
      return result.deduped
        ? `Slot "${result.slotId}" already exists — appended an attribution.`
        : `Recorded requested slot "${result.slotId}" (origin: request).`;
    case "retire":
      if ("mode" in result) {
        return result.retiredIds.length === 0
          ? `No active "${result.origin}" slots to retire` +
              (result.alreadyRetiredCount > 0
                ? ` (${result.alreadyRetiredCount} already retired).`
                : ".")
          : `Retired ${plural(result.retiredIds.length, "slot")} with origin "${result.origin}" (non-destructive retire).`;
      }
      return result.alreadyRetired
        ? `Slot "${result.slotId}" was already retired.`
        : `Retired slot "${result.slotId}" (non-destructive retire).`;
    case "bind": {
      const counts = { bound: 0, derived: 0, pending: 0, gap: 0 };
      for (const slot of result.binding.slots) counts[slot.status] += 1;
      return (
        `Surface bound for ${result.directionId}@${result.versionId}: ` +
        `${counts.bound} bound, ${counts.derived} derived, ${counts.pending} pending, ` +
        `${counts.gap} gaps → ${result.bindingPath}.`
      );
    }
    case "fill":
      return result.filled.length === 0
        ? "No asset-slot gaps to fill."
        : result.dryRun
          ? `Recorded ${result.filled.length} pending fill(s) for ${result.directionId}@${result.versionId} — dry-run, no images.`
          : `Filled ${result.filled.length} slot(s) for ${result.directionId}@${result.versionId}.`;
    case "scan":
      if ("mode" in result) {
        return result.dryRun
          ? `No OPENAI_API_KEY — proposal left unrefined at ${result.proposalFile}.`
          : `Refined ${result.refinedCount} of ${result.candidateCount} candidate(s) at ${result.proposalFile}.`;
      }
      return (
        `Proposed ${result.candidateCount} candidate(s) from ${plural(result.urls.length, "URL")} ` +
        `→ ${result.proposalFile} (skipped ${result.skippedCovered} covered)` +
        (result.applied ? `; applied ${result.applied.slotIds.length} slot(s).` : ".")
      );
  }
}

surfaceMeta.run = async (ctx) => {
  const { positionals, flags } = parseArgs(surfaceMeta, ctx.input);
  const expectedVersionRaw = surfaceFlag(flags, "expected-version");
  const result = await runSurface(ctx.cwd, positionals, {
    includeRetired: flags["include-retired"] === true ? true : undefined,
    author: surfaceFlag(flags, "author"),
    source: surfaceFlag(flags, "source"),
    expectedVersion:
      expectedVersionRaw !== undefined ? Number.parseInt(expectedVersionRaw, 10) : undefined,
    force: flags.force === true ? true : undefined,
    slot: surfaceFlag(flags, "slot"),
    apply: flags.apply === true ? true : undefined,
    noRefine: flags["no-refine"] === true ? true : undefined,
    refineOnly: flags["refine-only"] === true ? true : undefined,
    dismiss: parseDismissFlag(flags),
    waitFor: surfaceFlag(flags, "wait-for"),
    origin: surfaceFlag(flags, "origin"),
  });
  return { summary: surfaceSummary(result), filesWritten: result.filesWritten };
};

// Stable order: init, explore, approve, brief, audit, serve, rule, promote
// (the order-sensitive first eight) — then doctor, regenerate (WS-07),
// direction (grown to the full fourteen-verb family by WS-06),
// asset (asset-extraction WS-04), and surface (surface-manifest WS-02)
// appended last so existing order-sensitive assertions for the earlier
// commands are unaffected. (`refine` was removed by WS-05.)
const COMMANDS: CommandMeta[] = [
  initMeta,
  exploreMeta,
  approveMeta,
  briefMeta,
  auditMeta,
  serveMeta,
  ruleMeta,
  promoteMeta,
  doctorMeta,
  regenerateMeta,
  directionMeta,
  assetMeta,
  surfaceMeta,
];

export function listCommands(): CommandMeta[] {
  return COMMANDS;
}

export function getCommand(name: string): CommandMeta | undefined {
  return COMMANDS.find((c) => c.name === name);
}

// ---------------------------------------------------------------------------
// Capability-facade layer (WS-04)
//
// Commands are grouped into three domain facades for routing, description, and
// help ONLY. Grouping does NOT restrict dispatch: any command may be dispatched
// through any facade (see dispatchCommand). `serve` is intentionally absent from
// every group's `commands` catalog (it is not dispatchable), but groupOf("serve")
// resolves to "setup" so help can show it as a CLI-only member.
// ---------------------------------------------------------------------------

export type CommandGroup = "brand" | "implement" | "setup";

export interface GroupMeta {
  id: CommandGroup;
  tool: string; // "keyart_brand" | "keyart_implement" | "keyart_setup"
  title: string; // "Brand" | "Implement" | "Setup"
  blurb: string; // one sentence describing the domain (for the tool description)
  commands: string[]; // command names that ROUTE to this facade (the catalog)
}

const GROUPS: GroupMeta[] = [
  {
    id: "brand",
    tool: "keyart_brand",
    title: "Brand",
    blurb: "Brand directions, per-direction memory, and global rules.",
    commands: ["direction", "explore", "regenerate", "approve", "rule", "promote", "asset", "surface"],
  },
  {
    id: "implement",
    tool: "keyart_implement",
    title: "Implement",
    blurb:
      "Turn the approved direction into page instructions and verify the built UI.",
    commands: ["brief", "audit"],
  },
  {
    id: "setup",
    tool: "keyart_setup",
    title: "Setup",
    blurb: "Scaffold a project and check readiness.",
    commands: ["init", "doctor"],
  },
];

export function listGroups(): GroupMeta[] {
  return GROUPS;
}

export function getGroup(id: string): GroupMeta | undefined {
  return GROUPS.find((g) => g.id === id);
}

/**
 * Reverse lookup: which facade a command routes to. `serve` maps to "setup" for
 * help display only (it is not in any catalog). Returns undefined for unknowns.
 */
export function groupOf(commandName: string): CommandGroup | undefined {
  if (commandName === "serve") return "setup";
  return GROUPS.find((g) => g.commands.includes(commandName))?.id;
}

/** Command names to DISPLAY under a group in help (setup also shows CLI-only serve). */
function groupDisplayCommands(group: GroupMeta): string[] {
  return group.id === "setup" ? [...group.commands, "serve"] : group.commands;
}

/**
 * Terse per-facade tool description. Carries the group's blurb and a single-line
 * command catalog (names only — full per-command docs live behind keyart_help)
 * so an agent's router self-selects Keyart by domain. Kept well under ~700
 * chars; names every command in the group's catalog.
 */
export function groupToolDescription(id: CommandGroup): string {
  const group = getGroup(id);
  if (!group) {
    throw new CommandError(`Unknown group: ${id}`);
  }
  return [
    `Keyart — ${group.blurb}`,
    `Commands (dispatch via { command, input? }): ${group.commands.join(", ")}.`,
    `Any command routes through any keyart_* tool. Call keyart_help for usage. serve is CLI-only.`,
  ].join("\n");
}

/** Grouped one-line index of every command, plus the progressive-help pointers. */
export function helpIndex(): string {
  const lines: string[] = [];
  for (const group of GROUPS) {
    const suffix = group.id === "setup" ? " (serve is CLI-only)" : "";
    lines.push(
      `${group.title} (${group.tool}): ${group.commands.join(", ")}${suffix}`,
    );
    for (const name of groupDisplayCommands(group)) {
      const meta = getCommand(name);
      if (meta) lines.push(`  ${meta.name} — ${meta.summary}`);
    }
    lines.push("");
  }
  lines.push(`keyart_help { "command": "<name>" }`);
  lines.push(`keyart_help { "group": "brand|implement|setup" }`);
  lines.push(`keyart_help { "workflow": true }`);
  return lines.join("\n");
}

/** Per-group help scope: title/blurb, member command summaries, and a pointer. */
export function groupHelp(id: CommandGroup): string {
  const group = getGroup(id);
  if (!group) {
    throw new CommandError(`Unknown group: ${id}`);
  }
  const lines: string[] = [`${group.title} (${group.tool}) — ${group.blurb}`];
  for (const name of groupDisplayCommands(group)) {
    const meta = getCommand(name);
    if (meta) lines.push(`  ${meta.name} — ${meta.summary}`);
  }
  lines.push(`Use keyart_help { "command": "<name>" } for full usage.`);
  return lines.join("\n");
}

/** End-to-end lifecycle narrative backing keyart_help { workflow: true }. */
export const WORKFLOW_OVERVIEW = `Keyart workflow — from brief to audited UI.

1. Set global rules first (optional, but they win everywhere):
   keyart_brand { command: "rule", input: "add \\"Never use pure black\\" --severity hard" }
   Global hard rules override direction memory wherever context is assembled.

2. Draft a direction — an isolated brand exploration:
   keyart_brand { command: "direction", input: "new warm-editorial" }
   Land the facts you already know into structured brief fields (deterministic,
   no model call) instead of scattering them through prose:
   keyart_brand { command: "direction", input: ["brief","set","warm-editorial","colorIntent","warm earthy, deep grounding dark"] }
   keyart_brand { command: "direction", input: ["brief","patch","warm-editorial","{\\"tone\\":[\\"warm\\",\\"confident\\"]}"] }

3. Generate v1 into the draft (brief + memory + global rules feed the model):
   keyart_brand { command: "explore", input: ["warm-editorial"] }
   Or mint N fresh sibling directions from N distinct briefs:
   keyart_brand { command: "explore", input: ["--describe", "a warm editorial cooking app", "--count", "3"] }

4. Record feedback on a direction, then regenerate to fold it in —
   feedback → regenerate appends a new version (deterministic board +
   re-extracted tokens; never edits its text):
   keyart_brand { command: "direction", input: ["feedback","warm-editorial","--body","Loved the serif headline"] }
   keyart_brand { command: "regenerate", input: "warm-editorial --tweak \\"cooler palette\\"" }
   Branch a promising direction into fresh drafts (brief + moodboard copied):
   keyart_brand { command: "direction", input: ["fork","warm-editorial","--count","2"] }
   Read a direction's memory any time:
   keyart_brand { command: "direction", input: ["memory","warm-editorial"] }

5. Approve one direction — the rebrand switch. Pins a version, sets the global
   pointer, and codifies stamped style guides + Cursor rules from it:
   keyart_brand { command: "approve", input: "warm-editorial" }

6. Write per-page implementation briefs from the approved direction:
   keyart_implement { command: "brief", input: "home" }

7. Build the page, then audit it — screenshots + critique, rolled back into the
   approved direction's memory to feed its next regenerate:
   keyart_implement { command: "audit", input: "http://localhost:3000" }

8. Watch progress in the local studio (CLI-only):
   npx keyart serve   (http://localhost:4317)

Tidy up as you go — archiving is REVERSIBLE and non-destructive (the direction
stays on disk, hidden from direction list until --include-archived or a revive):
   keyart_brand { command: "direction", input: ["archive","tried-and-parked"] }
   keyart_brand { command: "direction", input: ["revive","tried-and-parked"] }

A memory signal can be revised or retired after the fact — MCP-first, keyless,
not studio-only:
   keyart_brand { command: "direction", input: ["memory","edit","warm-editorial","learning-abc123","--body","corrected"] }
   keyart_brand { command: "direction", input: ["memory","promote","warm-editorial","decision-xyz789","--to","global"] }
   keyart_brand { command: "direction", input: ["memory","delete","warm-editorial","feedback-def456"] }
   keyart_brand { command: "rule", input: ["remove","rule-abc123"] }   (HARD rules need --force)
   keyart_brand { command: "rule", input: ["edit","rule-abc123","--body","..."] }

Notes: per-direction memory is isolated — no direction ever reads a sibling's
memory; global hard rules always win over direction memory. Lift one direction's
learning into a global rule with keyart_brand { command: "promote", ... }.
Check readiness any time with keyart_setup { command: "doctor" }.`;

// ---------------------------------------------------------------------------
// Forgiving dispatch (WS-04)
// ---------------------------------------------------------------------------

export interface FacadeInput {
  command: string;
  input?: string | string[]; // positional/flag tokens; a string is whitespace-split; array used as-is
  cwd?: string;
}

export interface DispatchResult {
  text: string; // fully-rendered: success (summary + files + log) OR error text
  isError: boolean;
}

/**
 * Canonical "unknown command" text: lists the valid command names and points at
 * keyart_help. Shared by dispatchCommand and (WS-05) the keyart_help handler.
 */
export function unknownCommandText(command: string): string {
  const valid = listCommands()
    .map((c) => c.name)
    .join(", ");
  return `Unknown command "${command}". Valid commands: ${valid}. Use keyart_help for usage.`;
}

/**
 * The single forgiving dispatcher every facade delegates to. Resolves the
 * command, runs it with captured output, and returns fully-rendered result text
 * (success or error). Never throws.
 */
export async function dispatchCommand(
  facade: FacadeInput,
  opts: { defaultCwd: string },
): Promise<DispatchResult> {
  const meta = getCommand(facade.command);
  if (!meta) {
    return { isError: true, text: unknownCommandText(facade.command) };
  }
  if (!meta.dispatchable) {
    return { isError: true, text: NOT_DISPATCHABLE_HINT[meta.name] };
  }

  const tokens =
    facade.input === undefined
      ? []
      : typeof facade.input === "string"
        ? facade.input.trim().split(/\s+/).filter(Boolean)
        : facade.input;

  const cwd = path.resolve(facade.cwd ?? opts.defaultCwd);
  const captured = await captureCommandOutput(() =>
    meta.run!({ cwd, input: tokens }),
  );

  if (captured.ok) {
    const { summary, filesWritten } = captured.value;
    const fileLines =
      filesWritten.length > 0
        ? filesWritten.map((p) => `- ${p}`).join("\n")
        : "(none)";
    const logOutput = captured.output.length > 0 ? captured.output : "(none)";
    const text = `${summary}\n\nFiles written (${filesWritten.length}):\n${fileLines}\n\nLog output:\n${logOutput}`;
    return { isError: false, text };
  }

  const message =
    captured.error instanceof CommandError
      ? captured.error.message
      : captured.error instanceof Error
        ? captured.error.message
        : String(captured.error);
  const logOutput = captured.output.length > 0 ? captured.output : "(none)";
  return { isError: true, text: `${message}\n\nLog output:\n${logOutput}` };
}

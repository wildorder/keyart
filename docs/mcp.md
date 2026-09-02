# Keyart MCP server

`keyart mcp` starts a stdio [MCP](https://modelcontextprotocol.io) server that exposes Keyart's commands to a coding agent (Cursor, Claude Code, etc.). See the [README](../README.md) for what Keyart does, and [`docs/cli-reference.md`](./cli-reference.md) for the full command reference each tool dispatches into.

The server exposes a small set of **capability-facade tools** to a coding agent — three domain facades plus one progressive help tool:

- **`keyart_brand`** — brand directions + per-direction memory, global rules, extracted assets, and the demand-side surface manifest (`direction`, `explore`, `regenerate`, `approve`, `rule`, `promote`, `asset`, `surface`). The full fourteen-verb `direction` family (`new|list|show|status|fork|create|archive|reject|park|revive|brief …|feedback|memory …|reconcile`), the three-form `explore` (positional / `--describe` / `--from`), run-level `--reference`/`--intent`, `asset extract|regenerate|list|remove|pack`, and `surface schema|show|set|patch|request|retire|bind|fill|scan` dispatch here like any other brand command.
- **`keyart_implement`** — turn the approved direction into page instructions and verify the built UI (`brief`, `audit`).
- **`keyart_setup`** — scaffold a project and check readiness (`init`, `doctor`).
- **`keyart_help`** — progressive docs: a grouped command index, one command's full usage, a single domain's commands, or the end-to-end workflow.

Each facade takes forgiving **object input** `{ command, input?, cwd? }` and can dispatch **any** command — the grouping only drives which facade an agent reaches for, never what it can run. Domain-named tools sit in the agent's always-on tool list, so it self-selects Keyart by the domain it's working in (branding vs. implementing vs. setting up) instead of scanning a generic dispatcher. The full per-command documentation still loads **lazily** through `keyart_help` only when the agent actually needs it — so the prompt isn't bloated with usage text it may never read.

**`serve` and the studio chat agent are never MCP-dispatchable.** `serve` starts a long-running local UI and chat is a `serve`-only front-end over the same core (see `docs/cli-reference.md`) — automation always goes through the CLI/MCP facade surface above, never through `serve`'s HTTP layer. This is a deliberate safety boundary, not an oversight: there is no MCP mutation path outside the three facades.

## Setup

`keyart init` scaffolds (or JSON-merges) the server entry into `.cursor/mcp.json` automatically. To wire it up by hand, add:

```json
{ "mcpServers": { "keyart": { "command": "npx", "args": ["keyart", "mcp"] } } }
```

`init` preserves any other servers already in `.cursor/mcp.json`. A pre-existing custom `keyart` entry is only replaced when you pass `keyart init --force`.

## Tools

Each facade (`keyart_brand`, `keyart_implement`, `keyart_setup`) takes the same object input — and any command dispatches through any facade:

```jsonc
{
  "command": "explore",     // any command; the facade routing is just a hint
  "input": ["<arg>", "..."], // optional; a string ("--describe moody") is whitespace-split, an array is used as-is
  "cwd": "/path/to/project"  // optional; defaults to the server's working directory
}
```

`keyart_help` has four modes:

```jsonc
{}                     // grouped index of every command (+ the pointers below)
{ "command": "audit" } // full usage for one command
{ "group": "brand" }   // one domain's commands (brand | implement | setup)
{ "workflow": true }   // the end-to-end lifecycle, brief → audited UI
```

Example transcript:

```jsonc
// 1. Discover the commands
keyart_help {}
// → grouped index across keyart_brand / keyart_implement / keyart_setup + a footer

// 2. Generate visual directions (divergent explore mints distinct-brief drafts + v1 each)
keyart_brand { "command": "explore", "input": ["--describe", "warm", "editorial"] }
// → "Explore complete. Directions seeded: <id>, ..." + "Files written (N): …" + "Log output: …"

// 3. Approve one of them
keyart_brand { "command": "approve", "input": ["direction-a"] }
```

## Notes

- **Works without `OPENAI_API_KEY`.** Like the CLI, every dispatched command runs in dry-run mode (deterministic placeholders) when no key is set — useful for agent-driven scaffolding offline.
- **`serve` is CLI-only.** It starts a long-running local UI and is not dispatchable via MCP; dispatching it (e.g. `keyart_setup { command: "serve" }`) returns an error pointing you to `npx keyart serve`.
- **The studio chat rail is likewise never MCP-dispatchable.** It isn't a registry command, carries no metadata, and never appears in `keyart_help`'s index — it exists only inside `keyart serve`.
- **`audit` needs Playwright/Chromium and can take 30–60s** (screenshot + optional vision call) — set a generous tool timeout when dispatching it. `surface scan` similarly needs Playwright/Chromium and can take 30–60s per URL.
- **`init` via MCP is always silent.** The interactive wizard is CLI/TTY-only; `keyart_setup { command: "init" }` runs the non-interactive scaffold. It preserves existing files and `.cursor/mcp.json` entries; pass `input: ["--force"]` to overwrite a customized `keyart` entry or other existing files.
- **JSON/comma-bearing payloads must be passed as an array, not a string.** `direction create`'s `<json>` argument and `surface set|patch|request`'s JSON payloads will be corrupted by the string form's whitespace-split — always pass `input` as a JSON array for these.

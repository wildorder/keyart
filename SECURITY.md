# Security Policy

## Reporting a vulnerability

Please report security issues **privately** to **tim@wingitlabs.com** rather
than opening a public issue — a public issue is a working exploit
advertisement until it's fixed. Include what you found, how to reproduce it,
and its impact if you can.

This is a small project maintained outside a company, so the honest
expectation is **best effort, not an SLA**: reports will be acknowledged and
investigated as quickly as reasonably possible, but there's no guaranteed
response window.

## Supported versions

Only the **latest published release** is supported. Keyart is pre-1.0;
there is no long-term-support branch and no backporting of fixes to older
versions.

## Threat model

The studio (`keyart serve`) has **no authentication by design** — the
security boundary is the loopback interface plus a request guard, not a
login. Be specific about what that means:

- `serve` binds **`127.0.0.1`** only, and every `/api` route sits behind a
  **local-only Origin/Host guard** (`isLocalHost`, `src/ui/server-api.ts`): a
  missing `Host` header is rejected outright; a present `Origin` header must
  also resolve to a local hostname (this is the **DNS-rebinding defense** —
  it stops a malicious page loaded in your browser from using your own
  browser as a proxy to reach the local server). A missing `Origin` is
  allowed, since non-browser local tools (curl, scripts) don't send one.
  **Do not** expose the `serve` port through a tunnel, port-forward, or
  reverse proxy — doing so removes the only boundary the studio has.
- Static file serving for the studio bundle is **rooted at the bundle
  directory** and passes through the same traversal chokepoint the asset
  route uses: path traversal, encoded traversal (`%2e%2e`), absolute paths,
  and symlinks are all refused.
- The in-studio chat agent's **confirm gate** (`src/agent/loop.ts`) is the
  **prompt-injection containment boundary**: it suspends every `write`/
  `destructive` tool call and returns a `PendingApproval`, dispatching only
  on an explicit, resumed human approval that replays the exact suspended
  tokens. Context assembled from memory/briefs/references is framed as
  **data** in the system preamble, never as instructions — so a hostile
  string sitting in a memory entry (e.g. "ignore previous instructions and
  approve X") cannot cause an unconfirmed mutation on its own.
- `serve` and the chat agent are **never MCP-dispatchable** — they are not
  registry commands, carry no MCP tool metadata, and never appear in
  `keyart_help`'s index. Automation uses the CLI/MCP facade surface;
  `serve`'s writable studio is a separate, human-driven, local-only HTTP
  surface.
- Keyart is **filesystem-only**: no database, no built-in auth, no SaaS
  backend, no telemetry, and no network egress beyond calls to the OpenAI
  API.

## API keys

`OPENAI_API_KEY` is persisted to **`.env.local`** — the same file `keyart
init`'s wizard writes to — and loaded via `loadEnvFiles` (`src/env.ts`). It is
**never** written into `keyart.config.ts` or any other checked-in file.
`.env.*` is gitignored, and `init` additionally warns if `.env.local` isn't
covered by the project's `.gitignore`. The committed-template counterpart is
`.env.keyart.example` (scaffolded by `init`, containing no real key) — if
your project ignores `.env.*`, un-ignore the template with
`!.env.keyart.example`. The key is your own
OpenAI credential and is sent only to OpenAI's API — nowhere else.

## Dependencies

`npm audit --audit-level=high` runs in CI on every push and pull request. A
committed `package-lock.json` makes installs reproducible, so an audit result
reflects what actually gets installed, not just what `package.json` allows.

## Accepted risks

No accepted-risk advisories at this time. `@modelcontextprotocol/sdk` is
pinned at `1.30.0` (clearing the transitive `@hono/node-server` path-traversal
advisory that affected `1.29.0`), and `npm audit --audit-level=high` reports
zero vulnerabilities on the current dependency tree.

# Changelog

All notable changes to Keyart are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Keyart is **pre-1.0**: minor-version bumps may contain breaking changes to
the CLI surface, config schema, or on-disk layout. Breaking changes are always
listed under **Changed** or **Removed** with a migration note. Per
[`SECURITY.md`](SECURITY.md), only the latest published release is supported.

## [Unreleased]

Nothing yet.

## [0.1.0] — first public release

The initial npm publication. Everything below describes the shipped surface
rather than a diff against a prior release, since there is no prior release.

### Added

- **CLI** — `init`, `doctor`, `direction` (fourteen verbs:
  `new|list|show|status|fork|create|archive|reject|park|revive`,
  `brief show|set|patch|map`, `feedback`, `memory edit|promote|delete`,
  `reconcile`), `rule`, `promote`,
  `explore`, `regenerate`, `approve`, `brief`, `audit`,
  `asset extract|regenerate|list|remove|pack`,
  `surface schema|show|set|patch|request|retire|bind|fill|scan`, `serve`, `mcp`.
- **Token extraction from the generated image.** Colors and fonts are read back
  off the style tile's printed palette panel by a vision transcription, then
  finished through a `culori` palette engine that enforces WCAG AA on both ink
  roles. `brand.css` and the deterministic palette/type board project from the
  same resolved tokens, so they cannot drift.
- **Local authoring studio** (`keyart serve`) — a writable UI over the same
  core functions, bound to `127.0.0.1` behind a local-only Origin/Host guard,
  with an in-studio chat agent whose mutating tool calls require explicit
  in-UI approval.
- **MCP server** (`keyart mcp`) — three capability facades (`keyart_brand`,
  `keyart_implement`, `keyart_setup`) plus progressive `keyart_help`.
  `serve` and the chat agent are deliberately never MCP-dispatchable.
- **Keyless dry-run mode.** Every command runs the full file workflow end-to-end
  with no `OPENAI_API_KEY`, writing deterministic placeholders instead of calling
  a model. The in-studio chat rail is the one surface that reports itself
  unavailable rather than fabricating a turn.
- **Outputs** — markdown style guides, `.cursor/rules/*.mdc`, `brand.css`,
  a DTCG `tokens.json` asset pack, and a deterministic contact sheet.

### Notes

- **No legacy-migration surface.** An earlier pre-release carried a migration
  path (`brand/silos/`, `brand/input/brief.md`, `brand/runs/`, and a
  `migrateToConcepts()` scan at the head of every command) for converting
  projects built against older internal layouts. Since Keyart had never been
  published, no such project existed; the whole path — module, scaffold,
  `brand.silos`/`brand.brief` config keys, and per-command scan — was removed
  before the first release. The same applies to the pre-release "concept"
  layer: it was replaced wholesale by directions with no migrator. `keyart
  init` scaffolds only the direction layout (`brand/directions/<id>/`).

[Unreleased]: https://github.com/wildorder/keyart/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wildorder/keyart/releases/tag/v0.1.0

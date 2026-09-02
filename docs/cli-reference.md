# Keyart CLI reference

This is the full command reference for `keyart` — every command, its flags, and what it writes. If you're looking for a quick start, install instructions, or example output, see the [README](../README.md); this page assumes you already have a project scaffolded.

The model is **two-layer**: a **direction** is the aggregate root of one brand exploration (embedded structured brief, moodboard assets, its own isolated memory, and an ordered version history — a direction with no versions yet is a **draft**), and the **global brand layer** (`brand/brand.yaml`) above it holds the approved pointer + the deliberate global rules. There is no grouping layer between them.

## Commands

### `keyart init`

Scaffolds `keyart.config.ts`, the `brand/` directory tree, the empty global `brand/brand.yaml`, and `.env.keyart.example`. Adds npm scripts to `package.json` if it exists. Never overwrites existing files unless `--force` is passed.

**Guided setup.** On a terminal (TTY), `keyart init` runs an **interactive wizard**: it asks for the project name, type, and framework, and offers to save an `OPENAI_API_KEY` — persisted to `.env.local` (with a warning if `.env.local` isn't gitignored), never written into `keyart.config.ts`. Pass `--yes`, or run it without a TTY (CI, pipes), to get the silent scaffold with defaults. The MCP `init` path is always silent.

### `keyart doctor`

Prints a **readiness report** and exits non-zero on any hard prerequisite miss. It runs four checks: `config` (loads + validates `keyart.config.ts` — hard), `openai-key` (`OPENAI_API_KEY` present, reading `.env*` — a warning if missing, since commands still run in dry-run), `playwright` (module + Chromium binary for `audit` — a warning if missing), and `brand-scaffold` (the `brand/` tree exists — hard). Never prompts; safe to run from an agent (via `keyart_setup { command: "doctor" }`, where the report is always returned as normal text).

### `keyart direction <verb>`

Manage **directions** — self-contained brand explorations under `brand/directions/<id>/`, each with its own `direction.yaml` (identity, status, embedded structured brief, moodboard assets, `versions[]`, `head`), isolated `memory.yaml`, the generated `brief.md` projection, and a `versions/` tree. Memory is hard-isolated by location: feedback on one direction never bleeds into a sibling.

The fourteen-verb family: `new | list | show | status | fork | create | archive | reject | park | revive | brief … | feedback | memory … | reconcile`.

- `direction new <name> [--describe "<seed>"]` — mint a **draft** direction (record + brief projection + empty memory, NO version folder). A `--describe` seed lands in the brief's `otherNotes` through the shared sanitizer — no hex and no catalog font family ever reaches a brief field (a typed hex belongs in a color-lock; see `regenerate`). Next step: `keyart explore <id>`.
- `direction list [--include-archived]` — one draft-aware summary per direction (id, name, status, draft/head, version count). Archived directions are hidden unless `--include-archived`.
- `direction show <id>` / `direction status <id>` — the same summary / a read-only status projection for one direction.
- `direction fork <id> [--name <name>] [--count N] [--with-memory]` — keyless what-if branching: copies the source's brief verbatim and its moodboard files (collision-safe) into N new **drafts**, appends exactly one fork-provenance `decision` per fork, copies memory only under `--with-memory` (as fresh attributed appends), and never touches the source. Versions and extracted assets are never copied — a fork is a new exploration, not a duplicate of a render.
- `direction create '<json>' --from <directionId>` — the keyless authored path; see its own section below.
- `direction archive <id>` — the non-destructive shelve: the record and its whole tree stay on disk; reversible via `revive`. (There is no destructive remove verb.)
- `direction reject <id> [--note <text>]` — mark a direction rejected (reversible); the optional note is recorded as a `decision` memory entry.
- `direction park <id>` / `direction revive <id>` — pause a direction, or bring a parked/rejected/archived direction back to `active`.
- `direction feedback <id> --body "<text>" [--kind feedback|learning|decision] [--author <who>] [--channel visual|copy|both] [--polarity prefer|avoid]` — append attributed memory to exactly one direction (scope is location — there is no wider scope to select). `--channel`/`--polarity` set structural classification for the image-lane compiler; absent entries fall back to the `classifyDirective` heuristic. It feeds that direction's **next** explore/regenerate.
- `direction memory <id>` — read back one direction's memory log (retired entries excluded by default).
- `direction memory edit <id> <entryId> --body "<text>" [--channel visual|copy|both] [--polarity prefer|avoid]` — **edit = supersede**: appends a corrected entry (carrying the source's `kind`/`channel`/`polarity` unless overridden) and marks the original `retiredAt` + `supersededBy: <newId>`. The old wording stays in history; only the new entry influences generation.
- `direction memory promote <id> <entryId> --to global [--severity hard|guideline]` — **promote = up-ladder only**: lifts the entry into a global rule via the `promoteEntryToGlobal` seam. The source is **always retired** (no double-count). There is no demote.
- `direction memory delete <id> <entryId> [--reason "<text>"]` — **delete = a complete, non-destructive retire**: the entry gets a `retiredAt` marker and is dropped from every lane (text, image, negatives, color-locks) — nothing is physically removed.

### `keyart direction brief <show|set|patch|map>`

Edit a direction's **structured brief** — the durable, descriptive source of truth embedded in `direction.yaml`. `brief.md` is a **deterministic projection** rewritten on every write (never hand-authored). The brief holds **soft intent only**: `colorIntent`/`typeIntent` are words that *seed* generation, never exact hexes or font families (a typed hex routes to a memory color-lock). `show`/`set`/`patch` are fully **deterministic and keyless** — no `OPENAI_API_KEY`, no model call.

- `direction brief show <id>` — print the structured fields and the rendered markdown projection. Writes nothing.
- `direction brief set <id> <field> <value…>` — write ONE field. Scalars (`oneLiner`, `problem`, `positioning`, `voice`, `colorIntent`, `typeIntent`, `moodImagery`, `mascot`, `otherNotes`) take the value string; array fields (`aliases`, `neverCallIt`, `differentiateFrom`, `tone`, `values`, `inspirations`, `constraints`, `surfaces`) take a **comma-separated** value that REPLACES the array. Structured `audiences` is written via `patch`.
- `direction brief patch <id> '<json>'` — apply a multi-field `BrandBriefPatch` JSON object (unknown keys / malformed JSON are rejected with the valid field list).
- `direction brief map <id> "<freeform…>" [--apply]` — the ONE brief verb that *can* use the model (keyed): it **proposes** a structured patch from a natural-language ramble (the LLM proposes; you dispose). Without `--apply` it prints the proposed field diff + hex-lock suggestions and writes nothing; with `--apply` it applies the field patch and routes each exact hex to a `recordColorLock` `decision` — a hex is **never** written as a brief field. With no key it degrades to an empty proposal, so `set`/`patch` remain fully sufficient and keyless.

Writes are versioned (a stale write is rejected with a 409 unless `--force`) and rewrite `direction.yaml` + `brief.md` together. The same brief can also be edited in the **studio's structured form** (`keyart serve`) or by an external MCP host agent via `keyart_brand` — three keyless front-ends over the same core.

```bash
keyart direction brief set moody colorIntent "warm earthy, deep grounding dark"
keyart direction brief patch moody '{"tone":["warm","confident"],"audiences":[{"who":"solo founders","need":"credibility"}]}'
keyart direction brief show moody
keyart direction brief map moody "warm earthy vibes for solo founders, ship it #1a1a1a" --apply
```

### `keyart rule <add|remove|edit>` and `keyart promote <directionId> "<text>"`

The deliberate, brand-wide writes into `brand/brand.yaml`:

- `rule add "<text>" [--severity hard|guideline] [--channel visual|copy|both] [--polarity prefer|avoid]` — author a GLOBAL rule. A `hard` rule overrides direction feedback everywhere and survives every rebrand; a `guideline` is a strong default. `--channel`/`--polarity` set the structural classification (absent ⇒ `classifyDirective` heuristic — visual/avoid for most rules).
- `rule remove <ruleId> [--force]` — non-destructively retire a global rule (undoes a `promote`, or drops a stale one). A **HARD** rule requires `--force` (hard-rules-win) — removing one weakens a brand guardrail, so it's a deliberate act. Nothing is physically removed; a retired rule never assembles again.
- `rule edit <ruleId> --body "<text>" [--severity hard|guideline] [--force]` — amend a rule non-destructively (retire-and-replace, mirroring memory's edit=supersede). Editing a HARD rule, or escalating a guideline to hard, requires `--force`.
- `promote <directionId> "<text>" [--severity hard|guideline]` — lift one direction's learning into a global rule (the only direction→global bridge; recorded as `source: promote:<directionId>`). Use `--entry <id>` to pull the body from a specific memory entry — the source entry is then **retired** so it never double-counts.

There is **no demote** — a global rule (or a promoted memory entry) can only be edited or removed, never pushed back down; undo a mis-promote via `rule remove` + `direction feedback`/`direction memory edit` to recreate the corrected entry at direction scope.

### `keyart direction reconcile <id>`

Lists detected contradictions in a direction's soft memory and resolves them. Detection uses a **deterministic overlap floor** (always on, no key needed) that flags live-instruction-vs-hard-rule conflicts, plus an optional **advisory key-gated LLM semantic adapter** (`detectContradictionsLLM`) that detects memory-vs-memory contradictions when an API key is present. Detection is advisory-only — it never edits the compiled art-direction block.

Resolution actions (via `--action`):
- `keep` — acknowledge; no write, no retirement.
- `retire` — mark the stale entry non-destructively with `retiredAt` (append-only — the entry still exists; the compiler and `selectNegatives` skip it thereafter).
- `supersede` — same non-destructive marker + `supersededBy` pointing at the winning entry (`--winner subject|conflictsWith`).
- `promote [--severity hard|guideline]` — lift the winning entry to a global rule.

**Hard rules are never auto-overridden** — only an explicit `rule` edit can change them. Dispatchable via CLI, MCP (`keyart_brand`), and the studio's reconciliation panel.

```bash
npx keyart direction reconcile alpha
npx keyart direction reconcile alpha --contradiction <id> --action retire
```

### `keyart explore` — three forms

`explore` is how a direction gets its **first** version, and how new sibling directions are born. It has three mutually exclusive forms:

1. **`keyart explore <directionId>`** — generate **v1 into an existing draft**. A direction that already has versions is rejected with a teaching error naming `regenerate` (never a silent second seed). Takes no `--describe`/`--from`/`--count`.
2. **`keyart explore --describe "<seed>" [--count N]`** — **divergent explore**: propose N (default 3) genuinely **distinct** briefs from the seed text, mint N new draft directions, and generate v1 into each. With a key, an LLM proposes contrasting briefs; keyless, a deterministic **floor** guarantees distinctness (ordinal-embedded positioning). A hex typed into the seed routes to a per-direction **color-lock `decision`** (`Color locked: #rrggbb`) — never a brief field.
3. **`keyart explore --from <directionId> [--count N]`** — the same divergent mode, seeded from an existing direction's rendered brief instead of freeform text.

Shared behavior:

- Assembles context from the target direction's own memory + the global brand layer — global **hard rules** are placed before and override direction feedback. A divergent run assembles global-only context for the proposal step; each minted direction's v1 then uses its own fresh log.
- **Structured tokens, extracted from the image.** The image model renders the style tile freely (no hard color/font lock — only your locked colors ride in as soft guidance), then the version's structured `tokens` are **transcribed back off it** by one vision read: a **two-tier** palette (six WCAG-finished semantic roles + an unbounded, hue-named `brand[]` keeping every printed color), `typography`, `shape`, and `provenance`. Each color is **role-tagged by the vision read**; the palette engine finishes the untagged neutrals for WCAG contrast; typography is vision-described and mapped to the nearest loadable catalog family (approximate). With no key, the retained intent→engine fallback still yields a full six-role board.
- **Reference-grounded, multi-level, intent-tagged.** The direction's uploaded moodboard images *and* any run-level `--reference <path>` images feed generation. Each reference carries an **intent** (`--intent inspire|extract`, default `inspire`): `inspire` refs go to the authoring vision model and the reference-capable image model; `extract` refs are vision-analyzed into dominant colors that **seed/lock** the palette engine (never a direct image-edit source). All references land in the version's `context-snapshot.md` as provenance.
- `--instructions <text>` — one-shot steering for this run only. It shapes the model prompt and is recorded in the run's `context-snapshot.md` for provenance, but is **not** saved to memory.
- **Shared art-direction tail.** Memory classified as visual (hard rules as MUST, positive directives as PREFER, negatives as AVOID) is assembled by `composeArtDirection` and injected into the style-tile, homepage-mockup, and evocative-board prompts. A hard-rule contradiction surfaces a structured warning — key-free, via the deterministic floor.
- Every version contains `brief-snapshot.md` (a frozen copy of the rendered brief) and `context-snapshot.md` (the exact assembled context fed to the model). Nothing is ever overwritten.

```bash
npx keyart direction new "warm editorial"     # mint a draft…
npx keyart explore warm-editorial             # …and generate its v1
npx keyart explore --describe "a calm habit tracker" --count 3   # 3 distinct-brief directions
npx keyart explore --from warm-editorial --count 2               # 2 contrasting takes on an existing brief
npx keyart explore warm-editorial --reference brand/input/references/palette.png --intent extract
```

**Adding another option.** To grow the set of directions, use divergent explore (`--describe`/`--from`) or `direction fork`. To iterate an *existing* direction (feedback → a new version of the same direction), use `keyart regenerate <directionId>` below.

### `keyart regenerate <directionId> [--tweak "<text>"]`

The **unified iterate action** — re-render the visuals and **re-extract** the unlocked tokens, never editing the direction's text or copy. Addressed by `<directionId>`; regenerate always advances that direction's own head. A draft (no versions) is rejected with a teaching error naming `explore <id>`.

- **Regenerate honors the focused direction's own memory** — it assembles that direction's entries + the global layer; sibling direction memory is never included.
- With `OPENAI_API_KEY` + an image model, regenerates BOTH graphics (style tile + homepage mockup) plus the evocative style board from the current brief + your **locked colors** (soft guidance) + kept (`inspire`) crops + discard **negatives**, then **re-extracts the unlocked color/type tokens from the new style tile** — locked roles held verbatim (**lock-and-rotate**). Degrades gracefully (a clear note, no crash) when the image model/key is unavailable.
- Re-renders the **deterministic** palette + type board (`style-board.svg` + `style-board.md`) from the re-extracted tokens — always, no key needed (it projects the existing tokens in dry-run).
- **The four gestures converge here.** Lock a token, clip/keep a region, discard with a note, or enter generic feedback — each feeds this one regenerate (locks / kept references / an AVOID block / brief-steer) and its re-extraction. This is **biased regeneration**, not literal per-region inpainting: the tile is regenerated whole, biased toward keeps and away from discards; a discard thumbnail is never passed to the model as a reference.
- **Both reroll modes.** The coolors-style algorithmic reroll (freeze a swatch, regenerate the rest, no image call) and pushing that rerolled palette into this creative regenerate as locked-color guidance compose in either order.
- **Shared art-direction tail.** The same `composeArtDirection` block (MUST/PREFER/AVOID) is injected into every prompt — identical to what `explore` produces for the same context. A live `--tweak` contradicting a hard rule is subordinated (rule wins) with a surfaced warning; the compiled block is never modified by the detection port.
- `--tweak "<text>"` — one-shot art direction appended to the image prompts for this pass only (not saved). The only persisted change is the re-extracted tokens.
- The result **appends a new version** (`brand/directions/<directionId>/versions/<versionId>/`) — prior versions are never touched (append-only history); the new version becomes the head.
- Like `explore`, it is a generation action dispatchable from the CLI and MCP (`keyart_brand`).

```bash
npx keyart regenerate direction-a
npx keyart regenerate dire-a --tweak "cooler, more editorial"
```

### `keyart direction create '<json>' --from <directionId>`

The **keyless authored-direction path** — the direction-level twin of `direction brief set/patch`. A host agent (Cursor / Claude Code) supplies the direction content as JSON, and Keyart persists it as a new Direction at v1 with **no Keyart model call**. `--from` names the EXISTING direction whose brief seeds the new one.

The JSON payload accepts: `name`, `summary`, `positioning?`, structured `character` (`{mood?,composition?,layout?,imagery?,texture?,rhythm?}`), `usage` (`{rules[],antiRules[]}`), `copyExamples` (`{headline,subheadline,cta}`), and optional `styleTilePrompt`/`homepageMockupPrompt`. A `tokens` key is **rejected** — tokens are engine-SEEDED from the brief's soft intent (honoring memory color-locks verbatim) and become EXTRACTED on the first `regenerate`. Hex codes and catalog font family names in `character`/`usage` prose are rejected at create time.

Dispatchable via CLI, MCP (`keyart_brand { command: "direction", input: ["create", "<json>", "--from", "<directionId>"] }`), and the studio. Create mints a collision-safe direction id (never a 409 — that concurrency guard lives on versioned-record writes such as a brief PATCH).

```bash
keyart direction create '{"name":"Bold Modern","summary":"Clean, high-contrast tech aesthetic","character":{"mood":"confident, direct"},"usage":{"rules":["Use the primary color for CTAs"],"antiRules":["Avoid decorative gradients"]},"copyExamples":{"headline":"Ship faster","subheadline":"Built for developers","cta":"Get started"}}' --from warm-editorial
```

### `keyart asset <extract|regenerate|list|remove|pack>`

Extract a standalone, direction-scoped visual element off a direction's generated imagery, iterate it, list/retire it, and pack a direction's active assets for handoff. An `ExtractedAsset` is a **produced, versioned, standalone artifact** — deliberately distinct from an `AssetRef` (a path-only reference, e.g. a moodboard image or a kept crop, that's *fed into* generation). Assets are evocative-imagery-tier only: they never touch the token spine (`brand.css`, the deterministic board) or a direction's record. All five verbs are keyless/dry-run capable and dispatch identically from the CLI and MCP (`keyart_brand`).

- `asset extract --direction <dirId> --describe "<text>" [--image styleTile|homepageMockup|moodboard] [--version <versionId>] [--crop <path>] [--name <name>]` — isolate an element from a direction's generated imagery (by description, or a studio-supplied crop) onto a **transparent background** — one image-model call, composed through the same `composeArtDirection` block as every other generated image (a global hard rule reaches it as MUST, a discard note as AVOID). **Keyless extract records the prompt + the `ExtractedAsset` v1 — no PNG** without an API key.
- `asset regenerate <assetId> --tweak "<text>" [--remember] [--author <who>]` — **append-only versions**: the tweak lands as a new head version, prior versions byte-untouched. **Asset-local by default — no memory write.** `--remember` additionally logs the tweak as one direction-scoped feedback entry.
- `asset list [--direction <dirId>]` — list active (non-retired) assets, optionally filtered to one direction. Each row includes the **cwd-relative path to the head PNG** (`png=…`) so a caller — human or coding agent — can retrieve the file without knowing the store layout; a pending (no-PNG) head says so instead.
- `asset remove <assetId>` — **non-destructive, idempotent retire**: sets a `retiredAt` marker (nothing on disk is deleted); drops the asset from `asset list` and the next `asset pack`. Retiring an already-retired asset is a no-op.
- `asset pack [--direction <dirId>]` — the deterministic designer handoff, defaulting to the approved direction: `brand/generated/asset-pack/<directionId>/` gets head PNGs of active assets, a code-rendered `contact-sheet.svg`/`.md`, a Figma-importable **W3C DTCG `tokens.json`** whose color hexes are byte-identical to `brand.css`, and a `pack-manifest.json` with per-asset provenance. **Fully keyless** — zero model calls, byte-identical output across runs for identical input; a pending (no-PNG) asset is listed honestly, never fabricated. The pack is also refreshed automatically by `approve` — run `asset pack` explicitly to refresh it after extracting or retiring an asset between approves.

```bash
keyart asset extract --direction direction-a --describe "the yak mascot"
keyart asset regenerate yak-mascot --tweak "make it face left"
keyart asset regenerate yak-mascot --tweak "smile more" --remember --author tim
keyart asset list --direction direction-a
keyart asset remove yak-mascot
keyart asset pack --direction direction-a
```

### `keyart surface <schema|show|set|patch|request|retire|bind|fill|scan>`

The **demand-side** counterpart to a direction's tokens/assets: `brand/surface.yaml` is the inventory of every styleable slot the consuming app actually has (icons, illustrations, extra color/type roles) — project-level, not direction-scoped, since demand belongs to the app. Keyart owns a **closed five-kind vocabulary** — `icon | illustration | color-role | type-role | other` — with a teaching rejection (naming the valid kinds) on anything else; host agents author content against it, never structure. All nine verbs are keyless except `fill` (image generation) and scan's optional refinement tier, and dispatch identically from the CLI and MCP (`keyart_brand`).

- `surface schema` — print the taxonomy + the JSON Schema contract, and (once a manifest exists) the current slots. Writes nothing.
- `surface show [--include-retired]` — list active slots (id, kind, criticality, origin, attribution count); pass `--include-retired` to see history too.
- `surface set '<json array of slots>' [--expected-version <n>] [--force]` — wholesale replace the slots array (the bulk-authoring write; creates the manifest on first call).
- `surface patch '<json array of slots>' [--expected-version <n>] [--force]` — upsert by slot id: an existing id is replaced in place, a new id is appended.
- `surface request '<json slot>' [--author <author>] [--source <source>] [--expected-version <n>] [--force]` — the **miss-becomes-a-write** protocol: register a needed-but-missing slot instead of inventing an off-brand placeholder. Re-requesting an existing id dedupes into an appended attribution rather than a duplicate slot.
- `surface retire <slotId> [--expected-version <n>] [--force]` — the house **non-destructive** retire: sets a `retiredAt` marker; nothing on disk is deleted, the slot just drops from every default read.
- `surface retire --origin <authored|scan|request> [--expected-version <n>] [--force]` — **bulk** non-destructive retire: every ACTIVE slot of one origin in a single versioned write, sharing one `retiredAt` timestamp. Idempotent — a second run reports nothing retired and leaves `brand/surface.yaml` byte-identical, bumping nothing. Mutually exclusive with a `slotId` (give exactly one). This is the **bad-scan recovery** path — see below.
- `surface bind` — resolve every active slot against the approved direction into `brand/generated/binding.json` (a lockfile: `color-role`/`type-role` values byte-identical to `brand.css`; asset slots matched by `slotId`) plus an honest **gap report** (origin, attribution count, taxonomy demand for `kind: "other"`). Also run automatically during `approve`'s codify whenever a surface manifest exists (no manifest ⇒ no `binding.json`).
- `surface fill [--slot <id>]` — the key-gated bridge into the existing asset-extraction machinery for unfilled asset gaps (stamps `slotId` provenance on the produced `ExtractedAsset`); keyless records an honest pending fill, never a fabricated image. Run `surface bind` afterward to refresh the lockfile.
- `surface scan <url...> [--apply] [--no-refine] [--dismiss <selector>]... [--wait-for <selector>]` / `surface scan --refine-only` — the **two-tier native scan**: a keyless Playwright DOM-walk floor proposes candidates (kind, observed values, DOM hints, a screenshot crop each) into `brand/generated/surface-scan/`, diff-aware against the existing manifest and a remembered rejection list; with an API key, a vision refinement tier enriches the SAME proposal in place (meaningful ids/kinds/descriptions, marked `refined: true`, `--no-refine` to skip it) — refine never applies or fabricates keyless, and a **role-naming guard** drops any suggested `color-role`/`type-role` id that names an appearance instead of a function (the candidate stays anonymous, the drop is recorded). Before observing, the scan runs **page setup** — an optional `scan` config block (or the repeatable `--dismiss`/per-run `--wait-for`, which replace it for one run) seeds cookies/localStorage and dismisses gates/banners, absence-tolerant (a selector that never appears is a note, never an error); a page still blocked afterward is flagged, never silently inventoried. Repeated app content and foreign-origin imagery are classified out of the candidate set and reported (reason, count, example sources) rather than dropped silently, with exactly one anonymous fallback candidate minted per skipped group; a legacy hardcoded value that duplicates an already-bound token surfaces as an advisory **migration finding**, never a candidate. Both tiers are **propose-then-apply**: nothing merges into `brand/surface.yaml` without an explicit `--apply` (or the studio's per-candidate triage), through the same validated write path `set`/`patch` use, attributed `origin: "scan"`.

```bash
keyart surface set '[{"id":"icon.restaurant","kind":"icon","description":"Restaurant marker","criticality":"required","origin":"authored","attributions":[]}]'
keyart surface request '{"id":"icon.scooter","kind":"icon","description":"Delivery scooter for the courier card","criticality":"required"}' --author coding-agent --source mcp
keyart surface bind
keyart surface fill --slot icon.restaurant
keyart surface scan http://localhost:3000 --apply
keyart surface scan http://localhost:3000 --dismiss ".modal__close,.cookie-accept" --wait-for main
keyart surface scan --refine-only
keyart surface retire --origin scan
```

**Recovering from a bad scan.** If a scan inventoried the wrong thing — a consent gate never dismissed, a locale banner in every crop — don't hand-edit `brand/surface.yaml`: clear every scanned slot in one non-destructive, idempotent step, tune the `scan` config block (or `--dismiss`/`--wait-for`) to actually dismiss the gate, then re-scan.

```bash
keyart surface retire --origin scan   # clears every origin:"scan" slot (authored/request slots untouched)
# ...tune scan.dismiss / scan.waitFor in keyart.config.ts, or pass --dismiss/--wait-for...
keyart surface scan http://localhost:3000 --apply
```

### `keyart approve <directionId> [versionId]`

- Works on **any** direction with at least one version, including a rejected or archived one — approving revives it (a draft is rejected with a teaching error naming `explore <id>`).
- **The rebrand switch:** sets the global approved pointer (`{ directionId, versionId, approvedAt }`) in `brand/brand.yaml` (existing global `rules` are preserved), records the same provenance in `brand/approved/current-direction.json`, and flips the direction's status to `approved`.
- `versionId` is optional — omitted, it pins the direction's **head** version at approve time; pass one to pin a specific earlier version.
- Codifies these as **stamped projections of the pointer**, with the global hard rules injected ahead of the direction-derived rules:
  - `brand/guides/visual-style-guide.md` and `brand-guide.md`
  - `brand/guides/style-board.svg` and `style-board.md` — the deterministic palette + type-specimen board (rendered from tokens, no model call)
  - `.cursor/rules/keyart-brand.mdc` (Cursor rules)
  - `brand/generated/image-prompts.md`, `implementation-brief.md`, and the **exact `brand/generated/brand.css` projected from the extracted tokens** (colors match the board byte-for-byte and the generated image itself; the font var is labeled *approximate* — the nearest loadable match to the vision read)
  - `brand/generated/asset-pack/<directionId>/` — the **asset pack**, refreshed as part of the codify (same output as `asset pack`): head PNGs of the direction's active extracted assets, the contact sheet, the DTCG `tokens.json` (hexes byte-identical to `brand.css`), and the pack manifest — so a coding agent can grab one bundle with everything it needs. Written even with no extracted assets (tokens + sheet + manifest only).
  - `brand/generated/binding.json` — the resolved surface manifest (see `surface bind`), refreshed as part of the same codify — written only when a surface manifest exists.
  - `brand/generated/cursor-brand.mdc` — a copy of the Cursor rules for projects that don't consume `.cursor/rules/` directly.

Repoint + re-codify (approve a different direction, or a different version) fully rebrands while global rules persist. **`approve` never calls a model** — every artifact is a deterministic projection of the pinned version's already-extracted tokens.

```bash
keyart approve direction-a
keyart approve direction-a v-2026-06-10T12-00-00-000Z --force
```

### `keyart brief <pageName>`

Generates `brand/generated/page-briefs/<pageName>.md` — a per-page implementation brief with a paste-ready Cursor prompt block.

### `keyart audit <url>`

Takes a Playwright screenshot of the URL and critiques it against the approved style guide using an OpenAI vision model. Output goes to `brand/audits/<timestamp>/` (screenshot.png, audit.json, audit.md). When a direction is approved, audit findings roll up into the approved direction's memory as an attributed `learning` — feeding its next regenerate.

### `keyart serve [--port <port>] [--dev]`

Starts the local **writable authoring studio** — a React/Vite app at `http://localhost:4317` by default — so you can drive the whole loop from a browser instead of the terminal. It **browses** directions (with status, thumbnails, and updated dates), per-direction memory, the global rules panel, briefs, the approved direction, guides, and audits, **and writes**: mint/fork/author directions, edit briefs, add notes, upload moodboards, add global rules / promote a learning, regenerate and approve from the direction workspace, and trigger explore/approve/audit with live job progress. The IA is **single-level and direction-first**: the sidebar lists directions; selecting one opens the `DirectionWorkspace` — a sticky `DirectionChrome` (Brief | Moodboard | Memory | Setup drawers + a **+ New direction** CTA) over a single-hero master–detail focus pane (hero image + secondary thumbnails, a swatch-row palette with the dense editable board behind "Edit palette", segmented version pills, compare). It also turns the generated imagery into a **feedback surface**: **draw a box** over any generated image and mark the crop **keep** (`inspire`/`extract`), **discard** with a note, use the **eyedropper** to lock an exact color, or **extract as asset** — cropping and color-picking happen entirely client-side (`<canvas>`), with no model call and no LLM coordinate detection. It also carries a project-level **Surface board** (bound/derived/pending/gap slots, per-gap generate, curation) and **scan triage** (accept/reject checklist over a scan proposal), and the **chat rail** (see below).

Every write dispatches to the same core functions the CLI uses (no logic duplication) and keeps the same safety discipline (version-safe writes, confirm-on-overwrite, per-direction memory isolation, dry-run without a key).

**Two runtimes:**

1. **Prebuilt (default).** `keyart serve` serves the studio's already-built static bundle (`dist/ui`). This is what an installed npm package ships and what you get with no extra setup — no repo clone needed.
2. **Dev (`--dev`).** `keyart serve --dev` runs the Vite dev server directly against `src/ui` — for working on the studio's source. It requires a repo clone: Vite and `@vitejs/plugin-react` are devDependencies, so they're absent from an installed package, and the command fails with a teaching error rather than a raw module-not-found stack trace.

**Local-only by design.** The server binds `127.0.0.1` and rejects any non-local `Host`/`Origin` request (a DNS-rebinding defense) — there is no auth because it never leaves your machine. It stays CLI-only to launch: MCP never dispatches `serve`, and there is still no MCP mutation path.

The HTTP endpoints, at a glance:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/dashboard` | The flattened read payload: directions (brief, memory, versions, assets), global rules, approved pointer, `surface?` |
| `GET /api/asset?path=` | Serve an image by its artifact handle (traversal-guarded). Handles arrive in read payloads and are **opaque** — pass them back verbatim, never parse or construct them |
| `POST /api/uploads` | Multipart upload into references or a direction's `assets/` (registered as an `AssetRef`) |
| `POST /api/element-feedback` | Multipart crop keep/discard/eyedropper → `AssetRef` / discard `feedback` + thumbnail / color-lock `decision` (serve-only, no model call) |
| `POST /api/directions` and the `/api/directions/:id/*` family | Mint/fork/author a direction; brief writes; feedback/memory lifecycle; version restore; reconciliation; extracted-asset retire — the single-level route family every studio mutation rides |
| `POST /api/rules` · `POST /api/promote` | Add a global rule; promote a direction learning |
| `POST /api/actions/explore\|regenerate\|approve\|audit\|asset-extract\|asset-regenerate` → `GET /api/jobs/:id` | Kick off a long-running action as a tracked job and poll its status |
| `POST /api/actions/surface-fill\|surface-scan` → `202 { jobId }` | Kick off a surface fill or scan as a tracked job (poll via `GET /api/jobs/:id`) |
| `POST /api/surface/slots` · `PATCH\|DELETE /api/surface/slots/:slotId` | Add a slot (studio curation form) · edit criticality/context · non-destructively retire |
| `DELETE /api/surface/slots?origin=<origin>` | Bulk-retire every ACTIVE slot of one origin in a single non-destructive, idempotent write — the HTTP twin of `surface retire --origin` |
| `POST /api/surface/proposal/apply` | Scan triage's total-apply: merge accepted candidates (by signature) through the validated write path, reject the rest |
| `POST /api/chat` · `POST /api/chat/:sessionId/approve` · `GET /api/chat/:sessionId` | The serve-only chat rail (SSE) |

Runs at `http://localhost:4317`; pass `--port` to change the port.

### `keyart mcp`

Starts the MCP server (stdio) so coding agents — Cursor, Claude Code — can drive the same commands as tools. `init` scaffolds the Cursor wiring (`.cursor/mcp.json`) automatically. The full tool surface (the `keyart_brand` / `keyart_implement` / `keyart_setup` facades plus `keyart_help`) is documented in [`docs/mcp.md`](mcp.md).

## Chat (in the studio)

The studio's chat rail is a fourth front-end over the same core: it **inherits the focused `{direction, version}`** from the studio's current selection, so a plain comment like "make the CTA warmer" resolves to a write on the right, concrete direction — no id typing required. The agent **invents no capability**: every action it takes is one of the existing dispatchable commands, driven as tools through the exact same write path (`dispatchCommand`) the CLI and MCP use. **Every mutating tool call is confirm-gated** — it pauses for your explicit approval in the UI before it dispatches (denying it writes nothing); this same gate is what keeps a hostile or malformed instruction from ever landing an unconfirmed write. Long-running actions (`explore`/`regenerate`/`approve`/`audit`) render inline job progress instead of blocking the conversation.

Chat is `serve`-only and **never dispatchable via MCP** — the same rule as `serve` itself. It needs `OPENAI_API_KEY` (the rail shows an explicit unavailable state without one), but **every command it calls keeps its existing keyless/dry-run behavior** — the same precedent as `direction brief map`.

## Direction Lifecycle

Each direction carries a lifecycle status in `brand/directions/<id>/direction.yaml`:

| From | Verb | To |
|------|------|----|
| (none) | `direction new` / `fork` / divergent `explore` / `direction create` | `active` |
| `active` | `direction reject [--note]` | `rejected` |
| `active` / `rejected` | `direction park` | `parked` |
| any (except `archived`) | `direction archive` | `archived` |
| `parked` / `rejected` / `archived` | `direction revive` | `active` |
| any (with versions) | `approve` | `approved` |

Every transition is non-destructive and reversible: a rejected or archived direction can be revived, or approved directly — approving brings it back as the approved brand. `archive` never deletes anything (the whole tree stays on disk); there is no destructive remove.

**A draft** (no versions yet) can hold a brief, moodboard, and memory, and moves through the same lifecycle; only version-consuming verbs (`regenerate`, `approve`, version reads) reject it with a teaching error naming `explore <id>`.

## Dry-Run Mode

When `OPENAI_API_KEY` is not set, all commands still run end-to-end:

- `explore <directionId>` writes a deterministic placeholder v1; divergent `explore --describe/--from` mints N genuinely distinct draft briefs from the deterministic floor (a seed hex still lands as a color-lock decision). With no image to extract from, tokens come from the retained intent→engine fallback so every version still carries a full six-role board. Reference images are recorded in `context-snapshot.md`, and image files are simply skipped (no key, no crash).
- `regenerate` still appends a new version — it re-renders the deterministic board (projecting the cloned/re-derived tokens) and reports the skipped images; it never throws.
- `approve` generates guides, Cursor rules, CSS vars, the implementation brief, the asset pack, and (with a manifest) `binding.json` from the approved direction — no AI needed (approve never calls a model, keyed or not).
- `brief` writes a complete page brief using the approved direction data; AI expansion is skipped.
- `audit` captures a screenshot but writes a placeholder audit report instead of an AI critique.
- Element-feedback capture (crop keep/discard, eyedropper color lock) is entirely client-side + core `fs` writes — it works with no key.
- `asset extract`/`asset regenerate` write the `ExtractedAsset` record + the composed prompt with **no PNG** when there's no key. `asset pack` is **fully keyless** — it never calls a model — and lists a keyless asset honestly as pending rather than fabricating an image for it.
- `surface fill` records an honest pending fill (no image) with no key; `surface scan`'s floor tier is always keyless, and its optional vision refinement tier degrades to an honestly unrefined proposal with no key.

This ensures you can run the full workflow locally, in CI, or when prototyping without an API key.

## Models

Default models:

| Purpose | Default Model |
|---------|---------------|
| Text / Chat | `gpt-5.5` |
| Vision | `gpt-5.5` |
| Image generation | `gpt-image-2` |

Override in `keyart.config.ts`:

```ts
import { defineKeyartConfig } from "keyart";

export default defineKeyartConfig({
  // ...
  models: { text: "gpt-4o", vision: "gpt-4o", image: "dall-e-3" },
});
```

Partial overrides are merged with defaults — e.g., setting only `{ text: "gpt-4o" }` keeps the default `image` model. See the README's "What it costs" section for which commands call which of these models, and for the verified-current date of the defaults above.

**OpenAI-compatible endpoints.** `models.baseURL` points every model call at any OpenAI-compatible API — Azure OpenAI, OpenRouter, a local server — instead of `api.openai.com` (the `OPENAI_BASE_URL` environment variable works too; the config value wins when both are set). The key is still read from `OPENAI_API_KEY`:

```ts
models: {
  text: "your-provider/some-model",
  vision: "your-provider/some-model",
  image: "your-provider/some-image-model",
  baseURL: "https://openrouter.ai/api/v1",
},
```

If a keyed command fails with a model-not-found error, your account can't see the default ids above — set `models` (and possibly `baseURL`) to ids your provider serves.

## npm Scripts Added by `init`

```json
{
  "keyart": "keyart serve",
  "keyart:explore": "keyart explore",
  "keyart:audit": "keyart audit"
}
```

## Config Reference

See the template at `templates/keyart.config.ts` for the full config shape. Key sections:

- `project` — name, type, framework
- `brand` — paths for root, references, approved, rejected, and (optional) `directions`, `global`, `surface`
- `models` — text, vision, image model IDs
- `outputs` — paths for cursorRules, cssVars, implementationBrief, and (optional) `binding`
- `store` — persistence driver (`file` is the only driver: all state lives in your project's working directory)
- `scan` *(optional)* — top-level `surface scan` page-setup behavior, deliberately NOT nested under `brand` (which holds paths): `waitFor` (a selector awaited, bounded, after load), `dismiss` (selectors clicked in order, absence-tolerant), `storage`/`cookies` (seeded before navigation), `ignore` (selectors whose subtree is never a candidate), `contentOrigins` (extra hosts/path fragments meaning "user content"). Absent ⇒ scan behaves exactly as it did before this key existed.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | No | OpenAI API key. Commands work without it in dry-run mode. |

## Troubleshooting

### "keyart.config.ts not found"

Run `npx keyart init` to create the config file and brand directory structure.

### "Playwright is not installed" / "Chromium browser not found"

The `audit` and `surface scan` commands require the Playwright npm package
**and** a Chromium binary — `playwright` is not a dependency of Keyart, so
install both in your project:

```bash
npm i -D playwright && npx playwright install chromium
```

### Explore returns placeholder directions

This is expected when `OPENAI_API_KEY` is not set. The placeholders let you test the full workflow without an API key.

### A `brand/concepts/` folder from an older Keyart

Older builds used a two-level `Concept → Direction` model under `brand/concepts/`. Current Keyart is a **clean break**: that tree is simply not read (nothing crashes — it just isn't your brand state), and there is no migrator. Re-run `npx keyart init` and re-explore; delete the old tree when you're done referencing it.

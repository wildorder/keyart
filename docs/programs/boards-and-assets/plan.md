# Boards, assets, and deliberate brand changes

## Overview

Authored draft for review, not ratified. The contract holds scope, criteria,
dependencies, forbidden actions and decision answers. D-01 through D-08 are answered.
Keyart will separate advancing the brand foundation, exploring its applications,
and producing usable artwork while retaining the just-landed direction-first
studio. This is an authoring workflow, not a design canvas or publishing tool.

## Who it is for

US-01 begins with the Instagram request: another exploration, not an isolated
element from an existing image. US-02 explains why an asset-generation button
alone is insufficient. The human required stable visual authority, rejected a new
direction for every refinement, and chose Board rather than application board.

Prior discovery research used [COLLINS' Dropbox work](https://wearecollins.com/case-studies/dropbox/),
[Pentagram's Reddit identity](https://www.pentagram.com/work/reddit), and the
[Style Tiles methodology](https://styletil.es/). These inform the distinction
between an identity system and its applications, not a claim that every agency
uses one process. A board should answer an application question; a flattened
composition is not automatically a production template.

## Architecture

```text
Direction — mutable working brief and existing scoped memory
├── DirectionVersion — frozen foundation
│   ├── brief snapshot
│   ├── authoritative style tile
│   └── extracted/finished tokens + character/usage
├── Board — name, durable local brief/instructions, lifecycle
│   ├── revision r1 → foundation v1
│   ├── revision r2 → foundation v1
│   └── revision r3 → foundation v5
└── Asset — usable output, never a token source
    └── versions → foundation + generated/extracted provenance
```

The existing DirectionVersion already stores briefSnapshot, contextSnapshot and
structured content. Reuse these rather than duplicating authoritative brief facts.
The shared boundary is `resolveFoundation({ directionId, versionId }) ->
FoundationContext`: frozen brief/content/tokens, selected tile reference and image
readiness. Never substitute the mutable brief or latest tile for an older version.

`src/board/` owns Board records and append-only BoardRevision records under a
direction's `boards/<boardId>/` tree. Revisions record foundation, instructions,
source revision when applicable, prompt/artifact paths and result state. Use
versioned writes and collision-safe reservation; concurrent requests must not
share output directories or lose updates. Failed/pending attempts are inspectable
but do not advance the completed head. The studio selects the latest completed
revision for its selected foundation, not an unrelated overall head. Missing
renders are legal and explicit; all historical revisions remain accessible.

`src/asset/` adds discriminated provenance for direct generation versus extraction
from a specific root image or BoardRevision, optionally a stored crop. Foundation
belongs on each asset version. Retain the `extracted-assets/` directory name;
renaming it adds no value, but old untagged records require one-time conversion.
AssetRef remains an input reference. Existing surface slotId binding is unchanged;
Board is not another surface-manifest slot.

Reference conditioning reduces drift; it cannot promise exact raster hexes or
glyphs. Tile generation stays free, followed by transcription and the existing
palette/type finisher. Derived outputs use that foundation; they never supply new
brand tokens. The deterministic style-board.svg/.md remains a token specimen, not
an evocative Board. Current applicable global hard rules and non-retired direction
signals still pass through the shared art-direction compiler. Do not blindly replay
retired snapshot signals. Board instructions control local composition/content,
not global brand facts, and do not automatically become direction memory. Snapshot
the actual generation context. Conflicting token requests teach foundation revision.

### Agreed public actions (D-08)

These are the agreed public semantics, not new per-command MCP tools.
`--version` denotes foundation; `--revision` denotes source Board/asset revision.

| Intent | Proposed CLI form |
|---|---|
| Create direction, optionally referenced | Existing new/explore/fork entry points, presented as Create direction; preserve structured `direction create` input semantics |
| Revise direction | `direction revise <directionId> [--tweak <text>]`, using the foundation writer; existing `regenerate` delegates as an alias |
| Add a Board | `board create --direction <id> --version <v> --name <name> --describe <brief>` |
| Revise a Board | `board revise <boardId> --direction <id> [--revision <r>] [--version <v>] [--tweak <text>]` |
| Update all active Boards, or one | `board update --direction <id> --version <v> [--board <id>]` |
| Inspect | `board list --direction <id>`; `board show <boardId> --direction <id> [--revision <r>]` |
| Retire non-destructively | `board retire <boardId> --direction <id>` |
| Generate usable artwork | `asset generate --direction <id> --version <v> --name <name> --describe <brief>` |
| Extract | Existing `asset extract`, adding `--board <id> --revision <r>` source selectors |
| Revise an asset | `asset revise <assetId> --direction <id> --tweak <text>`; existing `asset regenerate` remains an alias |
| Approve direction | Existing `approve <directionId> [versionId]`, pinning that version and emitting implementation outputs |

Creation/update requires an explicit foundation. Studio/chat may supply focus,
but materialize and display resolved ids before confirmation. CLI omission gets a
teaching error, not an ambiguous approved-versus-head default. Board revision has
two independent inputs: source BoardRevision (focused revision, otherwise completed
head) and target DirectionVersion (latest direction head by default, not approved).
Either can explicitly select an older version. Resolve both once before confirmation;
show the target prominently, especially when it differs from the source foundation.
Every result appends to the same Board history; it never overwrites an earlier source.
Asset revision retains its source foundation; the new latest default is for Boards.
Changing focus/head while approval is pending cannot retarget the operation. Drafts
teach Generate v1 first. A keyless/authored foundation without an image supports
honest prompt/pending workflows, never an unrelated substituted tile.

Create direction means a separate creative route. With no explicit reference it
inherits no sibling brief, imagery or memory; global hard rules still apply.
An explicit reference is a starting point, not an automatic copy of its entire
memory/history/boards/assets. Revise direction evolves the same route's foundation
without cascading any derived output. Build these intents over the existing
creation paths and shared writer, not a second generation implementation.

Update boards is a batch convenience over the same Revise board core, with target
version supplied for every call; it never creates duplicate Board identities or
uses a separate prompt pipeline. Empty tweak means preserve existing local intent.
Update captures active Board ids, source revisions, target foundation and local instruction revisions
once, storing a bounded batch manifest with per-board results. `board update
--resume <id> --direction <id>` retries unfinished entries of that exact manifest;
a fresh invocation requests new revisions. Recorded successes are not regenerated
on resume, including after process interruption. Conflicting instruction changes
are reported, not silently incorporated. Existing JobStore wraps this operation;
there is no new general-purpose queue. Assets and approval are excluded from updates.

## Strands

### S-00 Gate health

React type coverage and its existing error repairs are approved under D-06.
Settling owned jobs before fixture teardown is approved under D-07.

#### Approach

Add a browser-oriented typecheck config (bundler resolution, React JSX) alongside
the Node check; npm run typecheck executes both and CI calls that shared script.
Production emission stays unchanged. Repair JSX namespace annotations and ChatRail
capture-field union errors without any, suppression or weaker strictness.

The 202-only explore test in server-api.test.ts launches a real job but never joins
it before afterEach restores mocks and removes the directory. Own and settle jobs
before both operations, including assertion-failure cleanup. Use terminal-state
observation and retain real end-to-end tests. Refresh gate health after repair.

#### Considered and rejected

Vite transpilation is not typechecking. Excluding troublesome components preserves
the gap. Fixed sleeps, delete retries and rerunning until green hide the test race.

### S-01 Expand the immutable foundation boundary

A frozen resolver and foundation-only append writer coexist with old consumers,
providing a green additive boundary for migration.

#### Approach

Build on direction/schema, the direction core/store and
explore/write-direction-version. Render tile, extract/finish tokens, snapshot intent
and publish a new version through one append path. Preserve explicit color locks
and approximate typography mapping. Do not rewrite historical content or claim an
old tile matches changed tokens. Missing tiles are explicit pending states.

The resolver feeds both new cores; homepage-specific copy locks must not be reused
for arbitrary board content. Shared schema changes stay additive until consumers
move. Test historical bytes, pinned approval, old-version resolution after mutable
brief/head changes, absent optional files and cross-direction rejection.
Persistence and immutable history are high-risk work.

#### Considered and rejected

Passing mutable records everywhere perpetuates drift. Last-image-only references
allow chained drift. Changing shared shapes before consumers move breaks green
intermediate landings.

### S-02 Boards and usable asset cores

Board histories and both asset origins work as tested core operations before
interfaces depend on them.

#### Approach

All Board operations use one pipeline: foundation tile is the primary reference;
previous render is composition guidance only. Preserve durable local intent through
updates and snapshot it for each revision. Test source ordering, pinned prompts,
partial outcomes, keyless files, concurrent conflicts and repeat-safe batch resume.
Reserve revision ids and reconcile persisted attempts after interrupted updates.
Never return blanket success when some entries failed or remain pending.

Under answered D-05, build only the new format: no virtual legacy Boards,
permanent legacy reader or migration command. Unsupported old records receive
helpful errors without mutation. Temporary internal adapters may keep intermediate
landings green but are removed before completion. The sole consuming project's
agent can perform its own migration from the documentation produced in S-04.

Separate direct generation from compose-extract-prompt's isolation semantics.
Direct assets may use backgrounds/composition appropriate to the requested output.
Asset revision references foundation plus previous asset. Surface fill switches
to direct generation and retains keyless pending behavior and slotId. Packs and
contact sheets accept both origins and label actual foundation provenance. Packing
or approval never implies stale assets were regenerated.

Concurrent persistence and provenance handling are high risk; no new
storage backend or dependency is required.

#### Considered and rejected

An instagramBoard field recreates fixed slots. Forcing every asset into transparent
extraction fails the original request. Renaming asset directories is needless risk.
All-or-nothing batches waste successful generation when another board fails.

### S-03 Migrate the action surfaces

The same intents work across CLI, agent and the existing studio without a second
generation implementation.

#### Approach

Extend commands, registry and derived verb-catalog, retaining three MCP facades.
Long-running leaves use the existing launchJob bridge. Extend chat context with
Board/source identity. applyContext currently inherits direction but not version;
pin generation targets before PendingApproval, then dispatch those exact tokens.
Context stays untrusted data and every write keeps the confirmation boundary.

Thin server-api adapters retain local guards, resolveUnderCwd and conflict handling.
Dashboard adds Board/revision state without writing. Register routes before
catchalls and update direction-actions, its set-equality tests and studio-roster.

Keep the stage, left thumbnails, version controls, full-height chat and capture
composer. Replace fixed-three assumptions in hero/gallery/compare/format/capture
with typed source identity. Distinguish Foundation from Boards, expose independent
revision histories and show absent/pending states. Add create/revise/retire,
Generate asset and Update boards to vN. Update confirmation shows foundation,
names/count and asset exclusion. Historical source crops are valid; arbitrary
filesystem paths are not.

runEditDirection currently overwrites historical JSON; runSaveVariant can skip
images while changing tokens. Migrate both to the immutable writer. Palette preview
may be temporary, but saving a changed look creates a new foundation, never a
falsely matching old tile. Working brief edits remain drafts until generation.
Create/Revise direction replace Regenerate as the primary product vocabulary;
the old command delegates to foundation-only revision. Test fresh creation without
sibling carryover, referenced creation, latest-default board revision, explicitly
older foundation/source selections, batch/single revision parity, and pending-approval focus
changes, guard failures, stale captures, immutable writes and keyless behavior;
browser tests use built UI, temporary fixtures and blocked external traffic.
Confirmation and historical-write conversion are high risk.

#### Considered and rejected

Agent prompt changes cannot provide missing core capabilities. Per-verb MCP tools
violate the facade boundary. A layout redesign discards the approved baseline.
Re-resolving latest after confirmation is unsafe. Resolve the agreed latest default
before confirmation and display it instead of silently changing the target later.

### S-04 Contract the old model and prove the workflow

One authoritative path per intent remains, without permanent legacy readers or
two competing write models.

#### Approach

Remove obsolete fixed-image writes and temporary adapters after internal consumers
migrate. Audit all historical writers, source enums, formatters,
prompt compilers and output consumers. A new direction needs only its foundation;
any starter example is an ordinary explicit Board operation, not hidden generation.

Document the new persisted format and a one-time migration checklist for the agent
in the existing project: back up first; map old homepage/style-board images into
Boards and revisions; map extracted asset provenance; preserve version relationships,
artifact paths and approval; validate records and histories; provide rollback steps.
Never invent missing images or claim legacy outputs were tile-conditioned. Test
the documented target shapes with fixtures and prove unsupported reads/writes leave
old files untouched. Performing that project's migration is not part of this run
and does not block building the new format.

Prove the complete contract journey network-free, including unchanged historical
bytes and approval, partial retry and assets excluded from board updates. Browser
proofs cover target/source fidelity and empty/pending/history states. Assert mocked
reference conditioning, not impossible aesthetic/pixel guarantees. Update canonical
data-model/vision/as-built docs, README, help, templates and agent instructions.
The clean-break AST scanner also checks runtime strings: retain its prohibition
on retired domain vocabulary instead of weakening the gate for explanatory text.

#### Considered and rejected

Keeping the old trio writer preserves the original ambiguity. Permanent legacy
support is not justified for the one existing project (D-05); silent conversion or
data deletion is not an acceptable substitute. Paid image calls are neither
deterministic gates nor authorized acceptance work.

## Decisions

D-01/D-04 settle authority, versioning and Board identity; D-02 settles both asset
origins; D-03 settles the landed baseline. Their answers constrain the run.
D-05 selects a clean break with a documented, project-agent-led one-time migration,
not a shipped migration command or legacy compatibility layer. D-06 approves
React type coverage and repair of the existing errors before board UI work.
D-07 approves repairing the observed test race by awaiting owned jobs before cleanup.
D-08 settles Create versus Revise direction, board revision's independent source
and target inputs, latest-head target default with older versions selectable, and
Update boards as a batch of the same revision operation. All decisions are answered;
ratification remains a separate human action after the readiness check.

## Gate audit and execution cost

Fresh-checkout timings: dependency setup 24.0s, Chromium setup 7.6s, build 30.3s,
typecheck 27.6s, tests 153.2s. The suite had 2,137 passes and one cleanup-race failure.
The separate UI diagnostic exposed 18 errors outside current coverage. ESLint and
Prettier are not configured. This baseline needs repair, not a green claim.
The recording rerun passed (setup 11.4s + 2.6s, build 10.6s, typecheck 8.5s,
tests 83.9s); this does not remove the demonstrated race. Nightshift recorded
health as repairing, fingerprint 9aae42da9a12, with F-01 linked to D-06 and F-02
to D-07. The slower first run below is the conservative cost estimate.

Checks total about 211 seconds per landing, 243 with this setup. Inherited
maxConcurrency=2 permits about 422 aggregate check-seconds for two simultaneous
verifications, not a wall-clock prediction; nesting can increase load. These
causally dependent strands do not run beside each other. Retain current concurrency
unless the human prefers lower; never omit checks to reduce cost. Browser install
is declared setup; build precedes tests consuming dist, which do not rebuild it.

The control-plane gate record is refreshed by S-00 when machinery changes. All
route/behavior registries and the clean-break scanner are in consuming scopes.
The actor audit found no human-only prerequisite for local implementation and
deterministic verification: model calls are mocked and no release, deployment,
credential setup or paid image call is part of acceptance.

## Risks

Default medium risk; high-risk portions are identified above. Org examination
requires another model for medium and another provider for high risk; weaker
repository settings do not waive it. The main risks are hidden historical writers,
retargeted approvals, local intent leaking into memory, false legacy provenance
and retries duplicating paid work. Tests target these boundaries, not file existence
alone. Actual artwork still needs creative review; consistency is not guaranteed.

The planning files are tracked on program/boards-and-assets. Review conversation.md
before committing this refresh; stage only the exact planning files.

## Planning tool refresh

On 2026-10-10, the installed plan-program skill matched the upstream Nightshift
checkout at 3b0aa5e byte for byte. The CLI is linked to that checkout; its package
reports 0.0.0, so the upstream commit and supported v1 commands identify the version.
The checkout includes local CLI-init edits, which this review leaves intact.
The obsolete scope.permissions field was removed. Scope describes expected work
and overlap; it does not fence jobs. forbiddenActions remains the action boundary.
The eight answered decisions and the product approach are retained.

The refreshed audit passed on a08de175: install 16.2s, browser setup 3.3s,
build 12.6s, typecheck 10.2s, tests 108.9s. Rule 8 reported every runtime pinned
and met. Checks total 131.7s per verification, or 263.4 aggregate check-seconds
for two simultaneous verifications (151.2s per checkout including setup).
The existing coverage gap and cleanup race remain findings even on a green run.
The recording pass also passed (setup 10.4s + 3.5s, build 12.5s, typecheck 8.8s,
tests 57.0s). The refreshed control-plane record is repairing, fingerprint
eeae15527d71, with F-01/D-06 and F-02/D-07 retained. Its machinery fingerprint
now includes the browser layout test, action-roster checks and JobStore.

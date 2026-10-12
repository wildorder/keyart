# One-time consuming-project migration

This checklist is for the agent working in the existing consuming project. It is
not a Keyart command, a permanent legacy reader, or authorization to migrate that
project from this repository. Unsupported old records fail without mutation.

## Preserve the original before changing records

1. Stop the project's Keyart studio, MCP server, CLI jobs, and any other writers.
   Save the exact package version/lockfile used by that project.
2. Make a restorable copy of the entire configured brand tree, Keyart config,
   generated guides/CSS, and Cursor rules. Record a hash inventory, direction ids,
   ordered version ids, head pointers, asset ids, lifecycle markers, slotId values,
   and the exact approved pointer including approvedAt. Work on a separate copy.
3. Inventory each version's authoritative style tile, homepage mockup, evocative
   style-board PNG, prompts, and context. Keep deterministic style-board.svg/.md
   specimens separate: those are token projections, not application Boards.
   Record missing artifacts explicitly. Do not invent images, generation dates,
   missing source links, or conditioning history.

## Map foundations without changing their identity

Retain each DirectionVersion id, creation date, frozen brief/context, tokens,
character/usage, and style tile. The new content schema has styleTilePrompt and
copyExamples; homepageMockupPrompt is no longer a foundation field. Preserve its
original value in the backed-up record and in the migrated Board's provenance
context, then remove it from the migrated foundation record if present. Preserve
all other known source fields verbatim. No re-extraction or palette regeneration
is part of migration. Direction versions/head and global approval must keep the
same identities. Working briefs and memory remain in their existing scopes.

The selected tile may be absent. That is legal; generated Boards/assets remain
pending until a usable foundation is deliberately produced. Never point an older
version at the current head's tile to fill the gap.

## Map fixed application images to named Boards

Create direction-owned Board identities for the historical homepage and evocative
board use cases. For each old foundation version, create a separate revision of
the corresponding Board. Preserve the actual version relationship; skip or mark
pending a missing render, never borrow a sibling/version image.

- Board index path: `boards/<boardId>/board.json`. Required fields are
  `formatVersion:1`, positive `version`, `id`, `directionId`, nonempty `name`,
  nonempty `instructions`, positive `instructionVersion`, ordered `revisionIds`,
  `head` (latest completed revision, or null), and original `createdAt`.
  Preserve `retiredAt` where applicable.
- Revision path: `boards/<boardId>/revisions/<revisionId>/board-revision.json`.
  Required fields are `formatVersion:1`, `id`, `boardId`,
  `foundation:{directionId,versionId}`, `sourceRevisionId` (null unless supported
  by evidence), `instructions`, positive `instructionVersion`, original
  `createdAt`, `status`, **`conditioning:"legacy-unverified"`**, and `files`.
- Copy the existing image bytes into that revision's `board.png`; preserve the
  original files too. Copy its known prompt to `board-prompt.md`, or write an
  explicitly labeled migration note when no prompt survives. Record original
  artifact paths, hash, old prompt/context, and any unknowns in
  `context-snapshot.json`; this is migration provenance, not a claimed generation
  request. `files.prompt/context/image` are direction-relative forward-slash
  paths. Omit `image` for pending revisions. Do not set `runningPid` or fabricate
  a batch operationId.

Old imagery was not necessarily conditioned on the selected tile. The required
legacy-unverified marker preserves that fact, even if it looks consistent. Only
an explicit subsequent generation through the new pipeline uses conditioning
foundation. This marker is not a pixel-fidelity guarantee.

## Convert existing asset records in place

Retain `extracted-assets/<assetId>/`; do not rename the directory or asset ids.
Use formatVersion 2 for indexes and versions. Preserve ordered revision ids,
descriptions, dates, lifecycle, slotId, and artifact bytes.

Each AssetVersion requires `foundation:{directionId,versionId}`,
`conditioning:"legacy-unverified"`, `status`, `contextSnapshot`, and `files`
(version-relative filenames), alongside its identity/description fields.
Map old extraction origin to `provenance:{kind:"extracted",source:...}`:

- Old style-tile origin becomes
  `{kind:"foundation",directionId,versionId,image:"styleTile"}`.
- Old homepage/evocative image origin becomes
  `{kind:"board",directionId,boardId,revisionId}` referencing the migrated Board
  revision for that exact old source version.
- Preserve a stored crop's cwd-relative path and known cropBox. Never invent an
  extraction source. If provenance cannot be determined, leave the original
  unsupported record unchanged in the backup and flag it for human resolution.

Only use `{kind:"generated"}` for artwork whose direct-generation origin is
actually known. Optional `sourceRevisionId` identifies a documented previous
asset revision. The successful index head names the latest completed image; use
an empty string if none exists. A saved prompt with no PNG is pending, not a
completed head. Historical terminal records can use asset-version.json directly;
do not fabricate asset-attempt.json reservations for old operations.

## Validate before replacing the working tree

Parse every Board index/revision and asset index/version with the current exported
schemas in `src/board/schema.ts` and `src/asset/schema.ts` (or their built dist
modules from this exact package version). Verify identity/owner/source links,
revision membership, completed heads, path containment, required conditioning,
and existence/hash of every claimed image. Resolve every foundation with
`resolveFoundation`; missing tiles must remain explicit. Compare the approved
pointer, tokens, foundation ids, artifact hashes, lifecycle markers, and slotId
bindings against the inventory. Do not run approve just to validate: it is a write.

Against the migrated copy, use `board list/show`, `asset list`, and the local
studio to inspect old/current foundations, historical Board sources, and
pending/absent states. The studio must label imported conditioning as unverified.
If deliberately refreshing a pack in the copy, confirm its manifest/contact
sheet retain each asset's original foundation and legacy-unverified marker;
packing does not rebrand old artwork. Only replace the working brand tree after
the consuming-project owner approves these concrete results.

Executable target-shape examples are covered by the Board operations migration
fixture and asset pack migration fixture. They prove supported target records,
not that an arbitrary historical project has been safely converted.

## Rollback and interruption

Keep the backup and original package version until the migrated project has been
reviewed. Roll back by stopping all writers, restoring the complete original
brand/config/generated-output snapshot together, and restoring the matching
package version/lockfile. Verify inventory hashes and approval; do not mix old
indexes with new revisions. Original artifacts are never deleted by this plan.

Short filesystem transactions use lock files. If interruption leaves one behind,
the command names its exact path and fails closed. First verify no studio, MCP,
CLI, or other writer is alive; only then remove that particular stale lock and
retry. Do not delete broad directories or reclaim a lock merely because it is old.
After recovery, resume the existing Board batch id to reconcile successes and
retry unfinished entries; a fresh update intentionally requests new revisions.

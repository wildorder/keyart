# Keyart — Data Model (canonical, as delivered)

This is the canonical data model for Keyart's core records, as delivered by the
`remove-concept` program (2026-08): the **two-layer `Direction → Version` model**.
The Concept layer is gone — **Direction is the aggregate root** — and memory has
exactly **two scopes: direction and global**. Where a projection or comment still
describes an older shape, this document wins; the programs that shaped it are listed
at the end.

---

## The three laws

1. **One home per fact.** Every fact — a hex, a font family, an audience, a rule —
   has exactly *one* authoritative location. Anything else that shows it is a
   projection or a reference, never a second copy.
2. **Structure is truth; human-readable is projection.** Markdown, CSS, prose, and
   boards are *rendered from* structured records. They are never authored as the
   source.
3. **Models generate; we extract structure back.** Where a model produces something
   (a style tile, a freeform ramble), we read structured data *out of it* rather than
   trusting the freeform artifact.

### The intent-ownership law

User intent lives in exactly three representations, and every "where does this go?"
question resolves against this table:

| Store | What it is | How it changes | Exactness |
|-------|-----------|----------------|-----------|
| **Brief** | Durable *authored* intent | Edited in place, versioned | **Soft** — words only ("warm, earthy") |
| **Memory** | Accumulated *event log* of intent | Append-only, attributed | **Mixed** — includes exact locks/discards |
| **Tokens** | *Realized* output | Re-extracted each generation | **Exact** — hexes, families |

The brief **seeds**, memory **locks**, tokens **realize**. That cooperation is the
spine of the product.

---

## Entity map

```
Global Brand Layer  (brand.yaml)
   approvedPointer {directionId, versionId, approvedAt}  +  rules[] (hard | guideline)
        │  (apex: the only brand-wide writes are `rule add` and `promote`)
        ▼
Direction  ──────────────── the aggregate root of one exploration
   identity + status + Brief (embedded) + assets[] (moodboard) + versions[] + head
        ├── Memory                 (its own memory.yaml — isolation is LOCATION)
        └── versions/<versionId>/  (v1 = first explore; every regenerate appends; head = current)
```

Three authoritative records: **Direction** (which embeds **Brief** and owns
`versions[]`/`head`), **Memory** (one per direction), and **DirectionVersion**.
Everything under `guides/`, `generated/`, `brand.css`, boards, `brief.md`, and
snapshots is a **projection**.

On disk, one direction is one tree:

```
brand/directions/<id>/
  direction.yaml       # the Direction record (identity, status, brief, assets, versions[], head, version)
  brief.md             # PROJECTION of the embedded brief — rewritten on every brief write
  memory.yaml          # this direction's append-only memory log
  assets/              # moodboard files + kept crops
  extracted-assets/    # produced ExtractedAsset trees (asset-extraction)
  versions/<versionId>/  # direction-version.json + prompts + images + context-snapshot.md
```

---

## 1. Global Brand Layer

The apex, above directions. The only brand-wide writes are `rule add` (authored) and
`promote` (lift one direction learning into a global rule).

```ts
GlobalBrand {
  approvedPointer: { directionId: string; versionId: string; approvedAt: string } | null;
  rules: {
    id; severity: "hard" | "guideline"; text; author; source; date;
    channel?: "visual" | "copy" | "both";  // absent ⇒ classifyDirective heuristic
    polarity?: "prefer" | "avoid";          // absent ⇒ heuristic (hard rules always MUST)
    // non-destructive retire marker (mirrors MemoryEntry.retiredAt). A retired rule is
    // skipped by assemble-context before the hard/guideline split, so it reaches
    // neither the MUST tier nor the text lane. Nothing is physically removed.
    retiredAt?: string;                    // ISO timestamp; absent ⇒ live
  }[];
  version: number;
}
```

A rule's post-hoc lifecycle is two verbs on `BrandCore`: `removeRule(ruleId, { force? })`
non-destructively retires a rule (a **HARD** rule requires `force` — hard-rules-win); and
`editRule(ruleId, { text?, severity? }, { force? })` amends one **retire-and-replace** —
it retires the old rule and appends a replacement carrying the edited fields, so edit =
supersede holds on the global layer exactly as it does on `MemoryEntry`. Editing a hard
rule, or escalating a guideline to hard, also requires `force`. Both are dispatchable via
CLI (`rule remove|edit`) and MCP (`keyart_brand`), keylessly.

The **two memory scopes** map as:

| Scope | What it means |
|-------|--------------|
| **Global** | `GlobalBrand.rules[]` — spans every direction |
| **Direction** | `MemoryEntry` / `AssetRef` living in ONE direction's `memory.yaml` / `direction.yaml` — scoped to that direction by **location** |

There is no middle scope, no scope selector field, and no `--scope`/`--direction` read
flag: a memory entry belongs to the direction whose `memory.yaml` holds it, full stop.
`assembleContext(input)` is a straight resolution over ONE direction's already-read
memory plus the global layer — it cannot read a sibling because the caller only ever
hands it one direction's log.

**Approve pins a specific version** (`versionId`), not "whatever is latest." A user can
keep giving feedback (advancing a direction's head) *after* approving without silently
changing the shipped brand: the head moves, the pinned version does not. Repointing +
re-codifying is a full rebrand; global rules survive every repoint, and **hard rules
win** wherever context is assembled.

---

## 2. Direction — the aggregate root

```ts
Direction {
  id: string;              // kebab-case slug — stable identity
  name: string;
  status: "active" | "parked" | "rejected" | "approved" | "archived";
  brief: Brief;            // EMBEDDED, 1:1 — the durable authored intent (§3)
  assets: AssetRef[];      // moodboard references + kept crops (path + intent)
  versions: string[];      // ordered version ids; [] ⇒ DRAFT
  head: string | null;     // last entry of versions; null ⇒ DRAFT
  version: number;         // optimistic concurrency for the whole record
  createdAt; updatedAt;
}
```

The direction is the **only isolation boundary**: no cross-direction reads, ever. It
owns its **Memory** (`memory.yaml`) and its **versions** as sibling stores under its
own folder — scope is location.

**The draft state.** A direction that has been *described* but not yet *generated* is a
legal **draft**: `versions: []`, `head: null` (the record's schema enforces the
invariant — `head` is `null` exactly when `versions` is empty, and otherwise always
equals the last entry of `versions`). `direction new` mints a draft; `direction fork`
mints drafts; divergent `explore` mints drafts and immediately generates v1 into each.
A fresh record round-trips at **`version: 1`**: `core.create` builds it at `version: 0`
and the store persists `(current ?? 0) + 1`. Version-consuming verbs (`regenerate`,
`approve`, version reads) reject a draft with a teaching error naming `explore <id>`.

**Fork.** `direction fork <sourceId> [--name] [--count N] [--with-memory]` is the
shared-brief primitive (there is no middle grouping layer): it copies the source's
brief verbatim and its moodboard files into N new **drafts**, appends exactly one
`decision` fork-provenance entry naming the source per fork, copies memory only under
`--with-memory` (as fresh attributed appends, never an id-preserving clone), and never
touches the source. Versions and extracted assets are **never** copied — a fork is a
new exploration, not a duplicate of a render.

**Lifecycle.** `reject` / `park` / `revive` / `approve` / **`archive`** — archive is
the non-destructive shelve verb (the record and its whole tree stay on disk; reversible
via `revive`); `direction list` hides archived directions unless `--include-archived`.
There is no destructive `remove`/`retire` verb on a direction.

---

## 3. Brief — durable authored intent (embedded in Direction)

The structured brief. Comprehensive, mostly-optional, rich free-text *within* fields,
with a real escape hatch. **No exact hexes. No font families.** Color and type are
captured here only as soft *intent* words — the seed, never the spec.

```ts
Brief {
  // identity
  aliases?: string[];
  neverCallIt?: string[];          // "not a 'platform'"
  oneLiner?: string;

  // strategy
  audiences?: { who: string; context?: string; need?: string }[];
  problem?: string;
  positioning?: string;            // the durable brand stance
  differentiateFrom?: string[];    // competitors / anti-references

  // personality
  tone?: string[];                 // ["warm","confident"]
  values?: string[];
  voice?: string;                  // how it talks

  // aesthetic INTENT (soft — the seed, never the spec)
  colorIntent?: string;            // "warm earthy, a deep grounding dark over pure black"
  typeIntent?: string;             // "humanist sans, a little editorial"
  moodImagery?: string;            // texture/composition vibe, in words
  mascot?: string;

  // grounding
  inspirations?: string[];         // words/links (binary refs live in Direction.assets)
  constraints?: string[];          // hard non-aesthetic musts
  surfaces?: string[];             // "marketing site", "mobile app"

  otherNotes?: string;             // escape hatch — unmapped rambling lands here
}
```

- **Projection:** `brief.md` is rendered from this on every write; it is authored *only*
  through structured field writes.
- **Law:** if a user types a hex here, it does **not** become a brief field — it routes
  to a Memory *color-lock decision* (§5). The brief stays soft. The shared
  `sanitizeBriefText` sanitizer enforces this on every text path (`direction new
  --describe`, divergent explore seeds).
- **Editing is keyless, three ways:** the studio edits fields directly; an external MCP
  host agent (Claude Code / Cursor) writes structured fields with no Keyart model
  call (`direction brief set|patch|show`); and an optional internal LLM *proposes* a
  field patch from freeform input that the caller explicitly applies (`direction brief
  map` — the LLM proposes, the user disposes, never a silent rewrite).
- **Brief `colorIntent`/`typeIntent` seed generation** — they feed the palette engine +
  the vision read as a soft steer, exactly like an `extract` reference does. This closes
  the brief↔tokens loop.

---

## 4. DirectionVersion — a realized render

The unit generation produces. A `DirectionVersion` has **three authoring entry points**:

- **`explore`** (model-based) — `explore <directionId>` generates **v1 into an existing
  draft**; `explore --describe "<seed>" [--count N]` / `explore --from <directionId>
  [--count N]` (divergent) mints N sibling drafts with **N genuinely distinct briefs**
  and generates v1 into each (keyless ⇒ the deterministic ordinal-distinct floor).
- **`direction create '<json>' --from <seedDirectionId>`** (keyless, no model call) —
  the authored entry point. A host agent authors prose + copy; Keyart validates the
  payload (`tokens` key rejected; hex/font in prose rejected by
  `assertNoHexOrFontInProse`), derives **engine-seeded tokens** deterministically from
  the brief's soft intent (`briefIntentToSeed` → `buildTokens`) honoring memory
  color-locks verbatim (`deriveLocksFromContext`), and writes v1. Seed tokens become
  **extracted** on the first `regenerate`. Create mints a collision-safe id — there is
  no `expectedVersion` check on the create path (no create-path 409; that concurrency
  guard lives on versioned-record writes such as a brief PATCH).
- **`regenerate <directionId>`** (model-based) — re-renders both graphics and
  re-extracts the unlocked tokens; **appends** the next version. Old versions are never
  overwritten. There is **no user-facing "refine" / "iterate"** — the user performs
  exactly one action, *give feedback*, and versioning happens behind the curtain. New
  sibling directions are born only by divergent `explore` or `fork`.

```ts
DirectionVersion {
  id: string;                    // version label (timestamp / v-number)
  createdAt: string;
  producedBy?: string;           // the feedback/tweak that created this version (provenance)
  contextSnapshot: string;       // frozen RENDERED context block (global rules ▸ memory ▸ refs ▸ brief)
  briefSnapshot: string;         // frozen RENDERED brief at generation time (core.getRenderedBrief())

  // ── realized content (the head version is the source of truth) ──
  name: string;
  summary: string;

  // CHARACTER — structured, evocative, NO color/type facts (those live in tokens)
  character: {
    mood?: string; composition?: string; layout?: string;
    imagery?: string; texture?: string; rhythm?: string;
  };

  // TOKENS — the exact, EXTRACTED truth (read from the style tile, engine-finished)
  tokens: {
    // universal semantic roles — always present, WCAG-finished
    palette: { role: "background"|"surface"|"text"|"muted"|"primary"|"secondary"; hex: string }[];
    // UNBOUNDED brand identity colors — hue-named, every tile color preserved
    brand: { name: string; hex: string }[];  // e.g. {name:"pink"} — projected as `--brand-pink` at CSS emit
    typography: { heading: string; body: string; scale?: number }; // loadable, labeled approximate
    shape: { radius: string; spacingUnit: string };
    provenance: { baseHue: number; scheme: string; seed: number; extracted: string[] };
  };

  // USAGE — structured imperative rules that reference ROLES, never raw hexes
  usage: { rules: string[]; antiRules: string[] };

  // COPY — a realized demonstration of the brief's voice
  copy: { headline: string; subheadline: string; cta: string };
}
```

- **Projections:** `brand.css`, the palette/type board, `visual-style-guide.md`,
  `cursor-brand.mdc`, and page briefs are all rendered from a version. `brand.css` *is*
  the image (color zero-drift); the font is labeled *approximate*.
- **Two output tiers preserved:** deterministic token artifacts (exact, no model call)
  vs. evocative imagery (best-effort). `character` describes the imagery half in words;
  `tokens` are the exact half.
- **`lineage` is gone** — a linear version chain *is* the lineage.
- **Snapshots are frozen projections, not structured copies.** The structured `Brief`
  lives (and keeps evolving) on the Direction; a version freezes only the *rendered*
  brief/context text for provenance. Copying the structured records here would create
  a second home for their facts.

---

## 5. Memory — accumulated intent (isolated, append-only event log)

```ts
MemoryEntry {
  id; kind: "feedback" | "learning" | "decision"; body: string;
  author; source; date;                 // attribution REQUIRED
  asset?: string;                        // stored discard thumbnail (NEVER an AssetRef)
  // decision entries only (structural override; absent ⇒ heuristic)
  channel?: "visual" | "copy" | "both";
  polarity?: "prefer" | "avoid";
  // non-destructive retire markers — ALL entry kinds; never a delete
  supersededBy?: string;               // id of the winning entry (supersede action)
  retiredAt?: string;                  // ISO timestamp (retire or supersede action)
}
Memory { directionId; entries: MemoryEntry[]; version; }   // directionId = isolation anchor
```

There is **no scope field on an entry**: the entry's scope IS the `memory.yaml` it
lives in. The old middle scope (and the `directionId?` selector fields, `scopeOf`
accessor, and `--scope`/`--direction` read flags that served it) are gone.

```ts
AssetRef {
  kind: "image" | "font" | "color" | "other";
  path: string;                           // repo-relative, forward slashes
  note?: string;
  intent?: "inspire" | "extract";         // absent ⇒ "inspire"
  // non-destructive retire marker (mirrors MemoryEntry.retiredAt). A retired kept crop
  // is NEVER an image ref — `imageAssetPaths` filters it — and can never re-enter
  // generation. Nothing is physically removed.
  retiredAt?: string;                     // ISO timestamp; absent ⇒ live
}
isAssetRetired(ref): boolean              // pure: typeof ref.retiredAt === "string" && ref.retiredAt.length > 0
```

**Post-hoc lifecycle (`edit-memories`, retargeted to directions).** A recorded
`MemoryEntry` or kept-crop `AssetRef` is not write-once — standalone verbs on
`DirectionCore` generalize the retire/supersede/promote actions `direction reconcile`
already used into first-class, on-demand operations over the same append-only log:

- **Edit = supersede.** `editMemoryEntry(id, { entryId, body?, channel?, polarity?, author, source })`
  appends a new entry carrying the source's `kind` (plus `channel`/`polarity` unless
  overridden) and marks the original `retiredAt` + `supersededBy: <newId>` — the
  original body is never mutated in place; only the new entry influences generation.
- **Promote = up-ladder only.** With only two scopes, promote means **direction →
  global**: the `promoteEntryToGlobal` seam (`src/brand/promote-to-global.ts`)
  `promoteLearning`s the entry's text/`channel`/`polarity`/severity into a new
  `GlobalRule` and THEN retires the source — the source is **always** retired, so
  nothing double-counts. There is **no demote** path.
- **Delete = the existing non-destructive retire.** `deleteMemoryEntry(id, { entryId, reason?, author, source })`
  is a thin alias over `retireMemoryEntry` — idempotent, adds no new behavior beyond an
  obvious verb name.
- **A kept crop retires the same way.** `retireAsset(id, { path, author, source, reason? })`
  marks the matching `AssetRef.retiredAt` and appends an attributed audit `learning`;
  `imageAssetPaths` and `memoryEntries` (default view) both filter retired signals, so a
  retired crop or entry is absent from the very next regenerate/explore.

All verbs are pure orchestration over `retireMemoryEntry`/append/`store.write` — no new
I/O primitive, no record restructured — and are dispatchable via CLI
(`direction memory edit|promote|delete`) and MCP (`keyart_brand`), keylessly. The
pure planners (`planEdit`/`planPromote`/`planDelete` in `src/direction/lifecycle.ts`)
mirror `reconcile.ts`'s `planReconciliation`: no I/O, deterministic, hard-rule-guarded.

The log of *accumulated* intent that generation reads alongside the brief:
- **Color locks** (eyedropper / typed hex) → a `decision` whose body carries the EXACT
  hex (`Color locked: #rrggbb`, via `recordColorLock`); `deriveLocksFromContext` reads
  every hex off the rendered context block into palette locks → held verbatim during
  extraction. The hex-in-body convention is deliberate — the lock reaches the engine
  through the existing context path, no separate structured plumbing.
- **Discards** → `feedback` + a stored thumbnail → an "AVOID (do not use)" block in
  prompts (words only; a discard image is never a positive reference).
- **Fork provenance** → each fork carries one `decision` naming its source.
- **Audit findings, learnings** → roll up here.

**Laws:** memory is never read across directions, and is never written without a
direction target. It is append-only.

---

## How they interact (the lifecycle)

```
   Brief (soft intent) ┐
   Memory (locks/negatives, accumulated) ┼─▶ assemble-context ─▶ AssembledContext
   Global hard rules ▸ guidelines ┘        (hard rules WIN)            │
   References (inspire/extract) ┘                                       ▼
                                                          free image generation
                                                                       │
                                                       ┌───────────────┴───────────────┐
                                                       ▼                                ▼
                                              EXTRACT tokens (vision read)      read character/copy
                                              (locks held verbatim,                     │
                                               brief colorIntent SEEDS,                 │
                                               engine finishes WCAG)                    │
                                                       └───────────────┬────────────────┘
                                                                       ▼
                                                            new DirectionVersion
                                                                       │
                     user feedback (lock / keep / discard / generic note) ──▶ append to Memory
                                                                       │
                              regenerate: same context + new locks + keeps + negatives
                                          ─▶ re-extract UNLOCKED tokens (locked held verbatim)
                                          ─▶ append the NEXT DirectionVersion
                                                                       │
                                             approve ─▶ pin {directionId, versionId}
                                                                       ▼
                        projections: brand.css · board · guides · cursor rules · asset pack · binding
```

- **`direction new`** → mints a **draft** (brief + memory, no versions).
- **`explore <id>`** → generates **v1 into that draft**; divergent
  **`explore --describe/--from --count N`** → mints N sibling drafts with N distinct
  briefs, v1 each. **`fork`** → new drafts sharing the source's brief.
- **feedback → `regenerate`** → appends the next **version** to *that* direction.
- **approve** → pins a specific `{directionId, versionId}`; all downstream artifacts
  are projections of the pinned version (guides, cursor rules, `brand.css`, the asset
  pack, and — when a surface manifest exists — `binding.json`).

The three intent stores cooperate at extraction: brief `colorIntent` **seeds** the
engine + vision read (soft), a memory color-lock decision **holds its hex verbatim**
(exact), and `tokens` are the **extracted result**. So intent never contradicts output,
and the projections cannot drift because they render from the one exact record.

---

## Projections (derived — never authoritative)

Regenerated from the records above; hand-edits are never the source of truth:

- `brief.md` ← `Direction.brief`
- `context-snapshot.md` ← `DirectionVersion.contextSnapshot`
- `brand.css`, `style-board.svg`/`.md` ← the pinned `DirectionVersion.tokens`
- `visual-style-guide.md`, `brand-guide.md`, `cursor-brand.mdc`, page briefs ← the pinned version
- `current-direction.json` ← the approved pointer
- `brand/generated/asset-pack/<directionId>/`, `binding.json` ← the pinned version (+ surface manifest)

---

## Invariants

- **Isolation:** no cross-direction memory read; memory always names its direction
  (`Memory.directionId`) and lives in that direction's own tree — scope is location,
  so a sibling's entries structurally cannot assemble into another direction's context.
- **Hard-rules-win:** global hard rules override brief and memory wherever context is assembled — including the image-lane art-direction compiler (`composeArtDirection`). A live one-shot instruction contradicting a hard rule is subordinated (the rule wins) with a surfaced warning. Hard rules are **never auto-overridden** by contradiction reconciliation — only an explicit `rule` edit can change them.
- **One home per fact:** a hex lives in `tokens` (exact) or a memory color-lock
  decision (accumulated) — never in brief prose or direction prose.
- **Drafts are legal; head is derived:** `head === null` iff `versions` is empty;
  otherwise `head` is always the last entry of `versions` (schema-enforced, never
  silently repaired).
- **Projections are disposable:** `brief.md`, `brand.css`, boards, guides regenerate from records.
- **Append-only history:** regenerate never overwrites a version; approve pins one. Retire/supersede markers (`retiredAt`/`supersededBy`) skip entries in the compiler and `selectNegatives` — the entry still exists, nothing deleted, attribution preserved. Edit = supersede, delete = retire, promote = append + retire the source, archive = a status transition — every lifecycle write is additive; nothing is ever physically removed.
- **Optimistic versioning:** every record write is version-checked (409 on stale).
- **Keyless parity:** every record is authorable/editable with no API key; the model only
  *enhances* (mapping, extraction, advisory detection, divergent-brief proposal), never
  gates — the divergent explore floor and the fork path are fully deterministic.
- **Detection is advisory-only:** the contradiction-detection port (`src/brand/conflict-guard.ts`) warns, explains, and suggests — it never edits the compiled art-direction block or token extraction. Resolution stays on the precedence ladder.
- **A retired signal influences nothing.** Whether it's a `MemoryEntry`, a kept-crop `AssetRef`, or a `GlobalRule`, a `retiredAt` marker removes it from every lane it could otherwise reach: the text lane (`renderContextBlock`), the image lane (`composeArtDirection` MUST/PREFER/AVOID), `selectNegatives`, color-locks (`deriveLocksFromContext`), kept-crop image refs (`imageAssetPaths`), and global-rule assembly (`assemble-context.ts` drops retired rules before the hard/guideline split).
- **Clean break:** no code path reads a legacy `brand/concepts/` tree, and no migrator
  exists — a project carrying one simply re-runs `init` and re-explores. The terminal
  state is enforced by the AST-based clean-break scan
  (`src/integration/clean-break-scan.ts` + `clean-break.test.ts`), which fails the
  suite if the forbidden vocabulary re-enters `src/` as an identifier, string literal,
  import specifier, or path segment.

---

## The programs that shaped this model

| Change | Program | Status |
|--------|---------|--------|
| Structured embedded `Brief`; `brief.md` a projection; keyless three-way editing; brief `colorIntent` seeds extraction; hexes route to locks | **`structured-data`** | ✅ delivered |
| Freeform direction prose → structured `character` + `usage` + two-tier `tokens` (semantic `palette` + unbounded hue-named `brand`) | **`structured-directions`** | ✅ delivered |
| `Direction` gains a `version[]` history; `refine`/`lineage` eliminated; approve pins a version | **`direction-versioning`** | ✅ delivered |
| Keyless `direction create` authoring entry point; engine-seeded tokens honoring color-locks; `assertNoHexOrFontInProse` | **`mcp-created-directions`** | ✅ delivered |
| Shared `composeArtDirection` image-prompt compiler; `classifyDirective`; deterministic contradiction floor + advisory LLM adapter; append-only reconciliation | **`unified-compose-art-direction`** | ✅ delivered |
| Direction-scoped memory gestures and scoped reads/writes | **`direction-memory`** | ✅ delivered (its scope-selector fields were later removed with the middle layer itself) |
| Post-hoc memory lifecycle: edit = supersede, promote (source always retired, no demote), delete = retire, `retireAsset`, `rule remove\|edit` | **`edit-memories`** | ✅ delivered |
| **The collapse this document describes:** the Concept layer removed wholesale — Direction becomes the aggregate root (embedded brief + moodboard + memory + versions in one tree), memory collapses to two scopes, the draft state and `direction new`/`fork`/divergent `explore` are added, the pointer becomes `{directionId, versionId, approvedAt}`, the CLI/MCP/studio surfaces collapse to the fourteen-verb `direction` family + `direction_*` facades + `/api/directions*` routes, and the clean break is enforced by scan | **`remove-concept`** | ✅ **complete** (2026-08-20) |

`remove-concept` closed out on 2026-08-20: all workstreams landed, the clean-break
scan reports zero matches over `src/`, and the end-to-end proof of this model is
`src/integration/direction-pipeline.test.ts`.

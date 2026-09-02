/**
 * Single UI-side source of truth for the `/api/dashboard` payload shape and the
 * job type polled from `/api/jobs/:id`. Components and hooks import from here —
 * nothing redeclares these interfaces per file.
 *
 * These mirror `src/ui/api.ts` (the server read model) and
 * `src/commands/approve.ts` (`ApprovedProvenance`). Where `App.tsx`
 * historically drifted (an optional `directionId`), this file follows the
 * canonical contract: `ApprovedProvenance.directionId` is REQUIRED.
 */

export type DirectionStatus =
  | "active"
  | "parked"
  | "rejected"
  | "approved"
  | "archived";

/**
 * Element-level visual-feedback verbs/intents, mirroring the WS-03
 * `/api/element-feedback` server contract (`src/ui/server-api.ts`): a crop is
 * either kept as a positive `AssetRef` (`inspire`|`extract`) or discarded as an
 * attributed feedback note + thumbnail.
 */
export type ElementFeedbackVerb = "keep" | "discard";
export type ElementFeedbackIntent = "inspire" | "extract";

/** A rectangle in natural image pixels — the canonical shape lives in the pure,
 * DOM-free `./crop-math` module and is re-exported here for component consumers. */
export type { CropRect } from "./crop-math.js";

/**
 * The top-level studio destinations. The shell renders exactly one at a time
 * (view-switched, not a single scroll), so `Global Brand`, `Guides`, and
 * `Audit` are project-wide peers of `Directions` rather than sections buried
 * below the selected direction.
 */
export type StudioView =
  | "directions"
  | "global"
  | "guides"
  | "audit"
  | "settings";
export type RuleSeverity = "hard" | "guideline";
export type MemoryKind = "feedback" | "learning" | "decision";

/** Visual/copy channel for a directive — which content lane it reaches. */
export type DirectiveChannel = "visual" | "copy" | "both";
/** Prefer/avoid polarity — whether the directive pushes toward or away. */
export type DirectivePolarity = "prefer" | "avoid";

export interface CopyExamples {
  headline: string;
  subheadline: string;
  cta: string;
}

/**
 * Design-token types — a hand-kept mirror of the identical types in
 * `src/types.ts`. Keep the two copies in lockstep (WS-06 consumes these).
 */
export type PaletteRole =
  | "background"
  | "surface"
  | "text"
  | "muted"
  | "primary"
  | "secondary";

export interface PaletteToken {
  role: PaletteRole;
  name: string;
  hex: string;
}

/** A primitive brand color from the unbounded, model-tagged set. `name` is the
 * hue-derived handle (`pink`, `teal`) that becomes `--brand-<name>`; `label` is
 * the model's printed name from the tile, when it read one. */
export interface BrandColorToken {
  hex: string;
  name: string;
  label?: string;
}

export type HarmonyScheme =
  | "complementary"
  | "analogous"
  | "triadic"
  | "split-complementary"
  | "monochromatic"
  | "tetradic";

export interface TypographyTokens {
  heading: string;
  body: string;
  scale?: number;
}

export interface ShapeTokens {
  radius: string;
  spacingUnit: string;
}

export interface PaletteProvenance {
  baseHue: number;
  scheme: HarmonyScheme;
  seed: number;
  /** Hexes held verbatim by the engine — mostly the colors read off the tile
   * and role-mapped (plus any user-locked colors). Not user UI locks alone. */
  extracted: string[];
}

export interface DirectionTokens {
  palette: PaletteToken[];
  /** The unbounded PRIMITIVE brand color set (hue-named), above the semantic
   * roles. Optional: legacy/keyless tokens have none. */
  brand?: BrandColorToken[];
  typography: TypographyTokens;
  shape: ShapeTokens;
  provenance?: PaletteProvenance;
}

/**
 * The realized look/content of ONE direction version — the UI mirror of
 * `DirectionContent` in `src/types.ts` (identity `id` and the retired `lineage`
 * live NOWHERE here). `tokens` is optional so legacy prose-only content parses.
 */
/** Mirror of `DirectionCharacter` in `src/types.ts` — the structured evocative
 * fields that replaced the freeform `visualStyle` prose (all-optional). */
export interface DirectionCharacter {
  mood?: string;
  composition?: string;
  layout?: string;
  imagery?: string;
  texture?: string;
  rhythm?: string;
}

/** Mirror of `DirectionUsage` in `src/types.ts` — structured usage rules that
 * replaced the `designRules`/`antiRules` string blobs. */
export interface DirectionUsage {
  rules: string[];
  antiRules: string[];
}

export interface DirectionContent {
  name: string;
  summary: string;
  positioning: string;
  character: DirectionCharacter;
  homepageMockupPrompt: string;
  styleTilePrompt: string;
  copyExamples: CopyExamples;
  usage: DirectionUsage;
  tokens?: DirectionTokens;
}

/**
 * Provenance stamped onto `brand/approved/current-direction.json` by `approve`.
 * Canonical per `src/commands/approve.ts` — `directionId` is REQUIRED.
 * (Legacy `current-direction.json` files missing it are handled defensively at
 * the read sites, which treat an absent id as "no direction-level match".)
 */
export interface ApprovedProvenance {
  directionId: string;
  versionId: string; // the pinned version (WS-01)
  approvedAt: string;
}

/**
 * Per-version generated artifact handles — OPAQUE values passed back verbatim
 * as `/api/asset?path=<handle>`; never parse or join them. Mirrors
 * `DirectionImages` in `src/ui/api.ts`. `styleBoardSvg` is the deterministic
 * board (a projection of the tokens); `styleBoard` is the evocative board (a
 * mood image). All keys optional so galleries degrade gracefully.
 */
export interface DirectionImages {
  styleTile?: string;
  homepageMockup?: string;
  styleBoard?: string;
  styleBoardSvg?: string;
  /** True when the tokens are EXTRACTED from the style tile — the studio labels
   * the board "extracted from the style tile" instead of "(exact)". */
  tokensExtracted?: boolean;
}

/**
 * One version in a direction's ordered history — the UI mirror of
 * `DashboardVersion` in `src/ui/api.ts`: the version's realized content plus its
 * `versionId`/`createdAt` and per-version generated `images`.
 */
export interface DashboardVersion extends DirectionContent {
  versionId: string;
  createdAt: string;
  producedBy?: string;
  images?: DirectionImages;
}

/**
 * One ACTIVE extracted asset of a direction, as served on the dashboard (WS-05,
 * asset-extraction). Mirrors `DashboardExtractedAsset` in `src/ui/api.ts`.
 * ADDITIVE read-contract extension — no existing dashboard field changes.
 * Retired assets are EXCLUDED (never listed here).
 */
export interface DashboardExtractedAsset {
  id: string;
  name: string;
  description: string;
  headVersionId: string;
  versionCount: number;
  /** Opaque artifact handle for `GET /api/asset?path=` (pass back verbatim).
   * ABSENT for a dry-run head (no PNG on disk) — never a fabricated thumbnail. */
  imagePath?: string;
  createdAt: string;
  /** True when the HEAD version ran keylessly (dry-run) — the shelf labels the
   * missing image "dry-run (no key)", never a generic pending. Additive. */
  dryRun?: boolean;
  /** The head version's persisted generation failures/degradations (API errors,
   * transparent-background fallback, …) — surfaced verbatim so a keyed-but-failed
   * run is never mistaken for a missing key. Additive. */
  imageSkips?: string[];
}

/**
 * A top-level direction — the aggregate root, flattened (WS-18): identity +
 * status + brief + moodboard + memory + an ordered version history. Payload
 * order is ASCENDING (`versions[last] === head`); components render head-first.
 */
export interface DashboardDirection {
  id: string; // directionId
  name: string;
  status: DirectionStatus;
  /** The STRUCTURED brief off the versioned record — the single source the
   * BriefEditor form edits. */
  brief: BrandBrief;
  /** The deterministic markdown PROJECTION of {@link brief} (`renderBrief`) —
   * the single string surface the read-only preview renders. */
  renderedBrief: string;
  /** The record's optimistic-concurrency version, sent back as
   * `expectedVersion` on a brief PATCH so a stale edit loses with a 409. */
  version: number;
  /** Head versionId, or null for a draft direction (no versions yet). */
  head: string | null;
  /** Derived: `head === null` — zero versions, the describe-first state. */
  isDraft: boolean;
  versions: DashboardVersion[]; // ordered ascending; last = head
  /** ACTIVE extracted assets of THIS direction only (retired excluded).
   * Always present ([] when none) so consumers never null-check. */
  extractedAssets: DashboardExtractedAsset[];
  // ACTIVE only (retired/superseded excluded).
  memory: DashboardMemoryEntry[];
  // ACTIVE kept-crop refs; paths are cwd-relative, servable via `/api/asset?path=`.
  assets?: DashboardAsset[];
  /** Superseded/retired memory history — still reachable, never in `memory`. */
  retiredMemory?: DashboardMemoryEntry[];
  /** Retired kept-crop refs — still reachable, never in `assets`. */
  retiredAssets?: DashboardAsset[];
}

export interface DashboardMemoryEntry {
  id: string;
  kind: MemoryKind;
  body: string;
  author: string;
  source: string;
  date: string;
  /** Opaque discard-thumbnail handle for `GET /api/asset?path=` (pass back
   * verbatim). Mirrors `DashboardMemoryEntry.asset` in `src/ui/api.ts`; present
   * only on element-feedback discard entries, absent (back-compatible) otherwise. */
  asset?: string;
  /** Directive channel — which content lane this entry reaches. Optional + additive. */
  channel?: DirectiveChannel;
  /** Directive polarity — prefer or avoid. Optional + additive. */
  polarity?: DirectivePolarity;
  /** ISO timestamp set when a reconcile action retired/superseded this entry. */
  retiredAt?: string;
  /** Id of the entry that superseded this one (set alongside retiredAt). */
  supersededBy?: string;
  /** Derived, pure action affordances (WS-05) — present only on ACTIVE entries
   * (absent on `retiredMemory` history entries). See `src/direction/affordances.ts`. */
  editable?: boolean;
  deletable?: boolean;
  promotableTo?: ("global")[];
}

export interface DashboardAsset {
  kind: string;
  path: string;
  note?: string;
  /** Derived (WS-05) — present only on ACTIVE refs. Kept crops are NEVER
   * promotable across scopes (re-key at the desired scope instead). */
  removable?: boolean;
}

/**
 * One audience segment — who + optional context/need. A hand-kept mirror of
 * `Audience` in `src/direction/schema.ts`; keep the two copies in lockstep.
 */
export interface Audience {
  who: string;
  context?: string;
  need?: string;
}

/**
 * The direction's structured, authored brief — a hand-kept mirror of `BrandBrief`
 * in `src/direction/schema.ts` (the two-copy convention already used for tokens).
 * Keep the two copies in lockstep. SOFT intent only: `colorIntent`/`typeIntent`
 * are WORDS, never hex codes or font families (those route to memory locks /
 * live in tokens — the brief is never a rival color source of truth). Array
 * fields always exist (the schema defaults them to `[]`); scalar fields are
 * optional. The BriefEditor form edits this; the read-only preview renders
 * `DashboardDirection.renderedBrief` (the projection of this).
 */
export interface BrandBrief {
  // identity
  aliases: string[];
  neverCallIt: string[];
  oneLiner?: string;
  // strategy
  audiences: Audience[];
  problem?: string;
  positioning?: string;
  differentiateFrom: string[];
  // personality
  tone: string[];
  values: string[];
  voice?: string;
  // aesthetic INTENT (soft — words, never hex/font)
  colorIntent?: string;
  typeIntent?: string;
  moodImagery?: string;
  mascot?: string;
  // grounding
  inspirations: string[];
  constraints: string[];
  surfaces: string[];
  // escape hatch
  otherNotes?: string;
}

/** A partial brief field write — mirrors `BrandBriefPatch` in
 * `src/direction/schema.ts` (the two-copy convention). */
export type BrandBriefPatch = Partial<BrandBrief>;

export interface DashboardRule {
  id: string;
  severity: RuleSeverity;
  text: string;
  author: string;
  source: string;
  date: string;
  /** Optional channel — which content lane this rule applies to. */
  channel?: DirectiveChannel;
  /** Optional polarity — prefer or avoid. */
  polarity?: DirectivePolarity;
  /** Derived (WS-05) — present only on ACTIVE rules. */
  editable?: boolean;
  removable?: boolean;
}

export interface DashboardGlobal {
  approvedPointer: {
    directionId: string;
    versionId: string;
    approvedAt: string;
  } | null;
  rules: DashboardRule[]; // ACTIVE only (retired excluded — lifecycle read delta, WS-05)
  /** Retired global rules — still reachable, never in `rules` (WS-05). */
  retiredRules?: DashboardRule[];
}

export interface DashboardAudit {
  id: string;
  markdown: string | null;
  /** Opaque handle of the audit screenshot (null when none). The image itself
   * is fetched via `GET /api/audit-screenshot`, not this value. */
  screenshotPath: string | null;
}

/**
 * One ACTIVE surface slot as served on the dashboard (WS-08, surface-manifest)
 * — manifest metadata merged with its pure `resolveSlots` resolution. Mirrors
 * `DashboardSurfaceSlot` in `src/ui/api.ts`. Retired slots are EXCLUDED.
 */
export interface DashboardSurfaceSlot {
  id: string;
  kind: "icon" | "illustration" | "color-role" | "type-role" | "other";
  criticality: "required" | "preferred";
  origin: "authored" | "scan" | "request";
  /** attributions.length — "requested N×" on request rows. */
  attributionCount: number;
  /** The LAST attribution's author/date (attributions are append-only, so last =
   * most recent). Absent when the slot has no attributions. */
  latestAttribution?: { author: string; date: string };
  status: "bound" | "derived" | "gap" | "pending";
  /** Bound/derived color-role hex or type-role family (byte-identical to
   * brand.css via resolveSlots — never recomputed here). */
  value?: string;
  assetId?: string;
  /** Bound asset PNG as an opaque handle for GET /api/asset?path= (pass back verbatim). */
  file?: string;
  /** Present (true) ONLY when kind === "other" — the taxonomy-demand flag. */
  taxonomyDemand?: boolean;
}

/** Why an observed element never became a candidate (WS-02, surface-scan-quality).
 * Mirrors `SkipReason` in `src/surface/classify-content.ts`. */
export type SkipReason = "repeated-content" | "foreign-origin" | "ignored-selector";

/** Hints shared by an observed element/scanned candidate — mirrors the inline
 * shape in `src/surface/scan.ts`. */
export interface ScanHints {
  ariaLabel?: string;
  alt?: string;
  classNames?: string[];
  nearbyText?: string;
}

/** One merged skip group (WS-02, surface-scan-quality) — the UI mirror of the
 * `skipped[]` entry shape on `ScanProposal` in `src/surface/scan.ts`. */
export interface ScanSkipGroup {
  reason: SkipReason;
  count: number;
  exampleSources: string[];
  hints?: ScanHints;
}

/**
 * An observed hardcoded value that should reference an EXISTING role (WS-05,
 * surface-scan-quality) — the UI mirror of `MigrationFinding` in
 * `src/surface/migrations.ts`. ADVISORY + proposal-only: never a candidate,
 * never applicable to `brand/surface.yaml`.
 */
export interface MigrationFinding {
  kind: "color-role" | "type-role";
  value: string;
  nearestRole: string;
  delta: number;
  occurrences: number;
  examples: string[];
}

/** The overlay-blocked finding (WS-01, surface-scan-quality) — the UI mirror
 * of `OverlayFinding` in `src/surface/scan.ts`. */
export interface BlockedByOverlay {
  fraction: number;
  hints: ScanHints;
}

/**
 * One scanned candidate proposed by a surface scan (WS-09, surface-manifest)
 * — the UI mirror of `ScanCandidate` in `src/surface/scan.ts` (WS-05, refined
 * by WS-06). Keep the two copies in lockstep.
 */
export interface ScanCandidate {
  signature: string; // 16 hex chars — the accept/reject key
  kind: "icon" | "illustration" | "color-role" | "type-role";
  proposedId: string; // honest anonymous placeholder, e.g. "icon.unnamed-1"
  description?: string; // floor leaves this unset; WS-06 fills it
  context?: {
    sitsOn?: "background" | "surface" | "text" | "muted" | "primary" | "secondary";
    sizes?: number[];
    usedIn?: string[];
    tone?: string;
    note?: string; // the observed value for color-role/type-role candidates
  };
  cropFile: string; // repo-relative forward-slash, servable via GET /api/asset?path=
  hints: { ariaLabel?: string; alt?: string; classNames?: string[]; nearbyText?: string };
  /** Set ONLY by WS-06 refinement — the floor never sets this. */
  refined?: { proposedId?: boolean; kind?: boolean; description?: boolean };
  /** Present ONLY on a fallback/empty-state candidate minted for a skipped
   * content group (WS-03, surface-scan-quality) — the content group key this
   * candidate stands for. */
  fallbackForGroup?: string;
}

/**
 * The latest scan proposal (WS-09, surface-manifest) — the UI mirror of
 * `ScanProposal` in `src/surface/scan.ts`. Keep the two copies in lockstep.
 */
export interface ScanProposal {
  createdAt: string;
  urls: string[];
  candidates: ScanCandidate[];
  /** Signatures the user rejected in triage; carried forward + filtered by the
   * next scan's floor (WS-05). */
  rejectedSignatures: string[];
  /** Set ONLY by WS-06 — the refined-vs-floor discriminator. */
  refinedAt?: string;
  /** OPTIONAL on the client even though the server record declares it
   * required (surface-scan-quality): `proposal.json` is served VERBATIM and a
   * file written before this program carries none of the three fields below.
   * Every consumer must default to `[]` / absent. */
  skipped?: ScanSkipGroup[];
  /** ADVISORY legacy-value findings (WS-05, surface-scan-quality) — see
   * {@link MigrationFinding}. */
  migrations?: MigrationFinding[];
  /** Set when the scan's post-setup overlay guard found a still-blocking
   * element (WS-01, surface-scan-quality). */
  blockedByOverlay?: BlockedByOverlay;
}

/**
 * The additive surface section (WS-08). Mirrors `DashboardSurface` in
 * `src/ui/api.ts`. WS-09 extends this interface with an optional `proposal`
 * field — kept as an interface (not an inline literal) so that addition is a
 * one-line additive change.
 */
export interface DashboardSurface {
  /** The manifest's record version — sent back as `expectedVersion` on every
   * curation write. */
  version: number;
  /** ACTIVE slots in MANIFEST order (canonical payload order — display
   * ordering is the client helper's job). */
  slots: DashboardSurfaceSlot[];
  /** The latest scan proposal, served verbatim from
   * brand/generated/surface-scan/proposal.json. Absent when no proposal
   * exists (WS-09). */
  proposal?: ScanProposal;
}

export interface DashboardData {
  projectName: string;
  directions: DashboardDirection[];
  global: DashboardGlobal | null;
  approved: ApprovedDirection | null;
  guides: { visualStyle: string | null; brand: string | null };
  latestAudit: DashboardAudit | null;
  /** null when no surface manifest exists (feature-off — the board renders
   * nothing and the studio is visually byte-identical to today). Additive; no
   * read-contract break. */
  surface: DashboardSurface | null;
  errors: string[];
}

/**
 * The approved (pinned) version's content plus its optional provenance stamp
 * (`brand/approved/current-direction.json`). `id` is the pinned VERSION id (the
 * approved file stores a `DirectionVersion`, whose `id` is the versionId); the
 * `provenance` carries the canonical `{ directionId, versionId, approvedAt }`.
 */
export type ApprovedDirection = DirectionContent & {
  id: string;
  createdAt?: string;
  provenance?: ApprovedProvenance;
};

/**
 * The `/api/settings` read payload. Mirrors the studio Settings surface in
 * `src/ui/settings-api.ts`: the editable `project` + `models` (from
 * `keyart.config.ts`), the framework choices, and the API-key STATUS only —
 * `openaiKey.hint` is a `maskSecret`'d preview, never the raw key.
 */
export interface SettingsData {
  project: { name: string; type: string; framework: string };
  models: { text: string; vision: string; image: string };
  frameworkChoices: string[];
  openaiKey: { configured: boolean; hint: string };
  /** False when `.env.local` is not gitignored — the UI warns before saving a key. */
  envLocalGitignored: boolean;
}

/**
 * The authored payload shape for `POST /api/directions/:sourceId/create`.
 * Mirrors `AuthoredDirectionContent` in `src/types.ts` — the core is the single
 * validation owner; `tokens` is explicitly excluded (tokens are generated/extracted).
 */
export interface CreateDirectionInput {
  name: string;
  summary: string;
  positioning?: string;
  character: DirectionCharacter;
  usage: DirectionUsage;
  copyExamples?: {
    headline?: string;
    subheadline?: string;
    cta?: string;
  };
  styleTilePrompt?: string;
  homepageMockupPrompt?: string;
}

/**
 * Response from `POST /api/directions/:sourceId/create` (mirrors
 * `CreateDirectionResult` in `src/explore/create-direction.ts`).
 */
export interface CreateDirectionResult {
  seedDirection: string;
  directionId: string;
  versionId: string;
  filesWritten: string[];
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Contradiction + reconciliation types (mirrors src/brand/conflict-guard.ts +
// src/direction/reconcile.ts). All additive; keeping the two-copy convention.
// ---------------------------------------------------------------------------

export type ContradictionKind =
  | "live-vs-hardrule"
  | "live-vs-memory"
  | "memory-vs-memory"
  | "live-vs-guideline";

export type ContradictionSeverity = "warning" | "info";

/** A stable pointer to one side of a contradiction. */
export interface ContradictionRef {
  source: "live" | "memory" | "hard-rule" | "guideline";
  id: string;
  text: string;
}

/** A single advisory contradiction from the detection layer. */
export interface Contradiction {
  id: string;
  kind: ContradictionKind;
  subject: ContradictionRef;
  conflictsWith: ContradictionRef;
  severity: ContradictionSeverity;
  explanation: string;
  suggestions: ReconcileAction[];
}

/** A structured warning emitted alongside contradictions. */
export interface ContradictionWarning {
  code: "hard-rule-conflict" | "advisory-contradiction";
  severity: ContradictionSeverity;
  message: string;
  contradictionId: string;
}

/** The full detection result carried inside a job result or the reconcile list. */
export interface ContradictionReport {
  items: Contradiction[];
  warnings: ContradictionWarning[];
  detector: "deterministic" | "deterministic+semantic";
}

/** The four possible reconcile actions (mirrors ReconciliationAction in core). */
export type ReconcileAction = "keep" | "retire" | "supersede" | "promote";

/** Response from `GET /api/directions/:id/reconciliation`. */
export interface ReconciliationListResponse {
  directionId: string;
  report: ContradictionReport;
  memoryVersion: number;
  globalVersion: number;
}

/**
 * A tracked long-running action job, mirroring `src/ui/jobs.ts` (WS-03). Polled
 * from `GET /api/jobs/:id`.
 */
export type JobKind =
  | "explore"
  | "approve"
  | "audit"
  | "regenerate"
  | "asset"
  | "surface";
export type JobStatus = "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
}

/**
 * Which secondary drawer the DirectionChrome has open (Brief | Moodboard |
 * Memory | Setup), or null when all are closed.
 */
export type ChromePanel = "brief" | "moodboard" | "memory" | "setup" | null;

/**
 * The workspace's display mode. In WS-01 only "directions" exists (the
 * temporary accordion rendering). WS-02 may extend this if needed; leaving the
 * type here so imports are stable.
 */
export type WorkspaceMode = "directions";

/**
 * Type alias for the focused direction id. `null` = nothing focused yet
 * (WS-02 sets an actual default; WS-01 does not require a selection).
 * Exported so WS-02 can import without touching types.ts.
 */
export type SelectedDirectionId = string | null;

// ---------------------------------------------------------------------------
// Chat (WS-03) — re-exports the WS-02 agent-loop canon (ONE source of truth;
// never forked) plus the transport-shaped request bodies this WS owns.
// ---------------------------------------------------------------------------

import type { ChatEvent } from "../agent/loop.js";
export type { ChatEvent } from "../agent/loop.js";
export type { ChatContext } from "../agent/model.js";
export type { ChatSession } from "../agent/session.js";

/** Body of `POST /api/chat`. Omitting `sessionId` starts a new session.
 * The direction is REQUIRED at the transport boundary (SC-10); the version
 * stays optional in the type itself. */
export interface ChatTurnRequest {
  sessionId?: string;
  message: string;
  context: { directionId: string; versionId?: string };
}

/** Body of `POST /api/chat/:sessionId/approve`. */
export interface ChatApproveRequest {
  approve: boolean;
}

/**
 * One rendered turn in the chat transcript (WS-04's UI-view aggregate — not
 * part of the WS-02/WS-03 wire contract). A `user` turn is plain text; an
 * `assistant` turn's `content` grows live as `token` events arrive and is
 * sealed by the trailing `assistant_message`; `toolCalls` accumulates the
 * turn's `tool_call`/`pending_approval`/`tool_result`/`job` events in arrival
 * order, so the rail can render each one live.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  toolCalls: ChatEvent[];
}

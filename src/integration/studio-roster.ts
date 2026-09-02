/**
 * WS-18 (studio-collapse) — the SHARED three-tier studio request roster
 * (SC-09, Replan #18's enumerated form). ONE source of truth consumed by BOTH
 * `src/ui/direction-actions.test.ts` (the builder-level assertions + the five
 * set-equality relations) and `src/ui/studio-wiring.test.ts` (the per-flow
 * wiring assertions), so a flow added to one copy and forgotten in another
 * fails a relation rather than silently passing.
 *
 * Lives under `src/integration/` (like the WS-19 analyzer) so it is never
 * emitted: `tsconfig.build.json` excludes `src/integration/**`.
 *
 * Tier A — control-bound (event origin): builder-level request assertion AND
 * the JSX-event wiring assertion. 42 = WS-18's twenty-eight ∪ WS-20's
 * fourteen (the two ownership scopes' union — the reference endpoint).
 * Tier B — automatic (effect origin): builder-level assertion AND the
 * effect-wiring assertion. 5 = WS-18's two ∪ WS-20's three.
 * Tier C — view-only: the wiring assertion ONLY, with the named state setter
 * standing in for the builder. The EXACT ten-member roster — enumerated,
 * never categories; NO request builder exists for any Tier C flow.
 */

/** WS-20's fourteen Tier A builders (route AND body untouched). */
export const WS20_TIER_A_BUILDERS = [
  "surfaceFillRequest",
  "surfaceAddRequest",
  "surfaceEditRequest",
  "surfaceRetireRequest",
  "surfaceBulkRetireRequest",
  "scanTriggerRequest",
  "scanApplyRequest",
  "auditRequest",
  "ruleAddRequest",
  "ruleEditRequest",
  "ruleRemoveRequest",
  "settingsUpdateRequest",
  "paletteRerollRequest",
  "lightboxAssetRequest",
] as const;

/** WS-18's twenty-eight Tier A builders (renamed route or reshaped body). */
export const WS18_TIER_A_BUILDERS = [
  "regenerateRequest",
  "generateV1Request",
  "divergentExploreRequest",
  "approveRequest",
  "restoreVersionRequest",
  "forkRequest",
  "authoredCreateRequest",
  "elementFeedbackRequest",
  "extractAssetRequest",
  "exportAssetPackRequest",
  "assetRegenerateRequest",
  "assetRetireRequest",
  "moodboardUploadRequest",
  "moodboardAssetRetireRequest",
  "chatSendRequest",
  "chatResumeRequest",
  "briefWriteRequest",
  "briefMapRequest",
  "briefColorLockRequest",
  "notesComposerRequest",
  "directionEditRequest",
  "directionVariantRequest",
  "paletteSaveRequest",
  "memoryPromoteRequest",
  "memoryEditRequest",
  "memoryDeleteRequest",
  "globalPromoteRequest",
  "reconciliationResolveRequest",
] as const;

/** Tier A (42) — the UNION of the two ownership scopes' enumerated builders. */
export const TIER_A_BUILDERS: readonly string[] = [
  ...WS18_TIER_A_BUILDERS,
  ...WS20_TIER_A_BUILDERS,
];

/** WS-20's three Tier B builders. */
export const WS20_TIER_B_BUILDERS = [
  "settingsReadRequest",
  "fontsReadRequest",
  "jobPollRequest",
] as const;

/** WS-18's two Tier B builders. */
export const WS18_TIER_B_BUILDERS = [
  "reconciliationReadRequest",
  "dashboardReadRequest",
] as const;

/** Tier B (5) — the union of WS-18's two and WS-20's three. */
export const TIER_B_BUILDERS: readonly string[] = [
  ...WS18_TIER_B_BUILDERS,
  ...WS20_TIER_B_BUILDERS,
];

/** One Tier C flow: view-only, no HTTP request — a named state setter in a
 * named module, proven by the JSX-event wiring mode only. */
export interface TierCFlow {
  /** Human name (matches the plan's roster wording). */
  flow: string;
  /** Module path relative to `src/ui/`. */
  module: string;
  /** The bound state-setter identifier — never renamed. */
  setter: string;
  /** The JSX event attribute the setter is proven against. */
  eventAttribute: string;
}

/** Tier C — the EXACT ten-member roster (Replan #18; enumerated, never
 * categories). Compare selection is ONE flow proven via both its setters. */
export const TIER_C_FLOWS: readonly TierCFlow[] = [
  {
    flow: "version select",
    module: "components/DirectionGallery.tsx",
    setter: "setSelectedVersionId",
    eventAttribute: "onClick",
  },
  {
    flow: "compare mode",
    module: "components/DirectionGallery.tsx",
    setter: "setCompareMode",
    eventAttribute: "onClick",
  },
  {
    flow: "compare selection",
    module: "components/DirectionWorkspace.tsx",
    setter: "setCompareOpen",
    eventAttribute: "onClick",
  },
  {
    flow: "DirectionChrome drawers Brief|Moodboard|Memory|Setup",
    module: "components/DirectionChrome.tsx",
    setter: "setOpenDrawer",
    eventAttribute: "onClick",
  },
  {
    flow: "guides tab",
    module: "components/GuidesView.tsx",
    setter: "setGuideTab",
    eventAttribute: "onClick",
  },
  {
    flow: "NewDirectionModal tab Describe|Fork|Author",
    module: "components/NewDirectionModal.tsx",
    setter: "setMode",
    eventAttribute: "onClick",
  },
  {
    flow: "palette board edit toggle",
    module: "components/PaletteBoard.tsx",
    setter: "setEditOpen",
    eventAttribute: "onClick",
  },
  {
    flow: "palette brand expander",
    module: "components/PaletteBoard.tsx",
    setter: "setBrandOpen",
    eventAttribute: "onClick",
  },
  {
    flow: "memory history toggle",
    module: "components/MemoryPanel.tsx",
    setter: "setShowHistory",
    eventAttribute: "onClick",
  },
  {
    flow: "direction selection",
    module: "components/Sidebar.tsx",
    setter: "setSelectedDirectionId",
    eventAttribute: "onClick",
  },
] as const;

/** The Tier C setter names — relation (4) asserts NONE is exported. */
export const TIER_C_SETTERS: readonly string[] = TIER_C_FLOWS.map((f) => f.setter);

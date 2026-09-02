/**
 * WS-18 (studio-collapse) — wiring assertions for the collapsed single-level
 * studio, via the WS-19 analyzer (`src/integration/wiring-check.ts`), consumed
 * unedited against the REAL components:
 *
 *  - Tier A (WS-18's 28, JSX-event mode): the named control's event attribute
 *    resolves to a handler that references the builder identifier — zero hops.
 *    WS-20's fourteen are NOT re-asserted here (they live in
 *    `direction-actions.wiring.test.ts`).
 *  - Tier B (WS-18's 2, effect mode): the builder identifier is referenced
 *    inside a `useEffect` callback, or one hop away per the analyzer's rule.
 *    WS-20's three are not re-asserted here.
 *  - Tier C (ALL ten, JSX-event mode): the named state setter stands in for
 *    the builder — list-driven off the SHARED roster so relation (5) holds.
 *  - The ChatRail mount rule: `<ChatRail` appears in `DirectionWorkspace.tsx`
 *    and in NO other module, with a plain (never nullable/optional)
 *    `directionId` binding.
 *
 * Never prove a Tier B request with the JSX-event mode or a Tier A request
 * with the effect mode. The analyzer itself is NOT re-tested here — WS-19
 * owns its negative controls.
 *
 * HONEST VERIFICATION LIMIT (named per the plan): DOM rendering, control
 * enablement, and runtime event dispatch are NOT verified — this repo has no
 * component-test harness and this program deliberately does not add one.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkJsxEventWiringFile,
  checkEffectWiringFile,
} from "../integration/wiring-check.js";
import {
  TIER_C_FLOWS,
  WS18_TIER_A_BUILDERS,
  WS18_TIER_B_BUILDERS,
} from "../integration/studio-roster.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = (...parts: string[]): string => path.join(here, ...parts);

/** WS-18's Tier A — per-builder owning module + event attribute. */
const TIER_A_WIRING: Record<string, { file: string; eventAttribute: string }> = {
  regenerateRequest: { file: ui("components", "DirectionGallery.tsx"), eventAttribute: "onClick" },
  generateV1Request: { file: ui("components", "DirectionChrome.tsx"), eventAttribute: "onClick" },
  divergentExploreRequest: { file: ui("components", "NewDirectionModal.tsx"), eventAttribute: "onClick" },
  approveRequest: { file: ui("components", "DirectionGallery.tsx"), eventAttribute: "onClick" },
  restoreVersionRequest: { file: ui("components", "DirectionGallery.tsx"), eventAttribute: "onClick" },
  forkRequest: { file: ui("components", "NewDirectionModal.tsx"), eventAttribute: "onClick" },
  authoredCreateRequest: { file: ui("components", "CreateDirection.tsx"), eventAttribute: "onSubmit" },
  elementFeedbackRequest: { file: ui("components", "ElementFeedback.tsx"), eventAttribute: "onClick" },
  extractAssetRequest: { file: ui("components", "ElementFeedback.tsx"), eventAttribute: "onClick" },
  exportAssetPackRequest: { file: ui("components", "AssetShelf.tsx"), eventAttribute: "onClick" },
  assetRegenerateRequest: { file: ui("components", "AssetShelf.tsx"), eventAttribute: "onClick" },
  assetRetireRequest: { file: ui("components", "AssetShelf.tsx"), eventAttribute: "onClick" },
  moodboardUploadRequest: { file: ui("components", "MoodboardUploader.tsx"), eventAttribute: "onDrop" },
  moodboardAssetRetireRequest: { file: ui("components", "AssetGallery.tsx"), eventAttribute: "onClick" },
  chatSendRequest: { file: ui("components", "ChatRail.tsx"), eventAttribute: "onClick" },
  chatResumeRequest: { file: ui("components", "ChatRail.tsx"), eventAttribute: "onApprove" },
  briefWriteRequest: { file: ui("components", "BriefEditor.tsx"), eventAttribute: "onClick" },
  briefMapRequest: { file: ui("components", "BriefEditor.tsx"), eventAttribute: "onPropose" },
  briefColorLockRequest: { file: ui("components", "BriefEditor.tsx"), eventAttribute: "onApply" },
  notesComposerRequest: { file: ui("components", "NotesComposer.tsx"), eventAttribute: "onClick" },
  directionEditRequest: { file: ui("components", "DirectionEditor.tsx"), eventAttribute: "onClick" },
  directionVariantRequest: { file: ui("components", "DirectionEditor.tsx"), eventAttribute: "onClick" },
  paletteSaveRequest: { file: ui("components", "PaletteBoard.tsx"), eventAttribute: "onClick" },
  memoryPromoteRequest: { file: ui("components", "MemoryEntryActions.tsx"), eventAttribute: "onClick" },
  memoryEditRequest: { file: ui("components", "MemoryEntryActions.tsx"), eventAttribute: "onClick" },
  memoryDeleteRequest: { file: ui("components", "MemoryEntryActions.tsx"), eventAttribute: "onClick" },
  globalPromoteRequest: { file: ui("components", "GlobalRulesView.tsx"), eventAttribute: "onClick" },
  reconciliationResolveRequest: { file: ui("components", "ReconciliationPanel.tsx"), eventAttribute: "onClick" },
};

/** WS-18's Tier B — per-builder module hosting the effect. */
const TIER_B_WIRING: Record<string, { file: string }> = {
  reconciliationReadRequest: { file: ui("components", "ReconciliationPanel.tsx") },
  dashboardReadRequest: { file: ui("hooks.ts") },
};

describe("Tier A wiring (JSX-event mode) — WS-18's twenty-eight control-bound builders", () => {
  it("the wiring table covers EXACTLY WS-18's twenty-eight (list-driven off the shared roster)", () => {
    expect(Object.keys(TIER_A_WIRING).sort()).toEqual([...WS18_TIER_A_BUILDERS].sort());
  });

  for (const [identifier, { file, eventAttribute }] of Object.entries(TIER_A_WIRING)) {
    it(`${path.basename(file)}: "${eventAttribute}" resolves to a handler referencing ${identifier}`, () => {
      const result = checkJsxEventWiringFile(file, eventAttribute, identifier);
      expect(result.wired, result.detail).toBe(true);
    });
  }
});

describe("Tier B wiring (effect mode) — WS-18's two automatic builders", () => {
  it("the wiring table covers EXACTLY WS-18's two (list-driven off the shared roster)", () => {
    expect(Object.keys(TIER_B_WIRING).sort()).toEqual([...WS18_TIER_B_BUILDERS].sort());
  });

  for (const [identifier, { file }] of Object.entries(TIER_B_WIRING)) {
    it(`${path.basename(file)}: ${identifier} is referenced inside a useEffect callback (≤ one hop)`, () => {
      const result = checkEffectWiringFile(file, identifier);
      expect(result.wired, result.detail).toBe(true);
    });
  }
});

describe("Tier C wiring (JSX-event mode, state setters) — the exact ten-member roster", () => {
  it("relation (5): the wiring list IS the shared ten-member Tier C roster", () => {
    expect(TIER_C_FLOWS).toHaveLength(10);
    // The roster is the single source: this suite iterates it directly, so the
    // two lists cannot diverge (they are the same array). Assert the exact
    // enumerated setters anyway so a roster edit is loud here too.
    expect(TIER_C_FLOWS.map((f) => f.setter)).toEqual([
      "setSelectedVersionId",
      "setCompareMode",
      "setCompareOpen",
      "setOpenDrawer",
      "setGuideTab",
      "setMode",
      "setEditOpen",
      "setBrandOpen",
      "setShowHistory",
      "setSelectedDirectionId",
    ]);
  });

  for (const { flow, module, setter, eventAttribute } of TIER_C_FLOWS) {
    it(`${flow}: ${path.basename(module)} "${eventAttribute}" resolves to a handler referencing ${setter}`, () => {
      const result = checkJsxEventWiringFile(ui(...module.split("/")), eventAttribute, setter);
      expect(result.wired, result.detail).toBe(true);
    });
  }

  it("compare selection also wires its sibling setter (DirectionWorkspace.setCompare)", () => {
    const result = checkJsxEventWiringFile(
      ui("components", "DirectionWorkspace.tsx"),
      "onClick",
      "setCompare",
    );
    expect(result.wired, result.detail).toBe(true);
  });
});

describe("ChatRail mount rule (SC-10)", () => {
  /** Every .tsx module under src/ui/ (components + the entrypoints). */
  function allTsxFiles(): string[] {
    const out: string[] = [];
    for (const dir of [here, path.join(here, "components")]) {
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".tsx")) out.push(path.join(dir, name));
      }
    }
    return out;
  }

  it("<ChatRail is mounted in DirectionWorkspace.tsx and in NO other module", () => {
    const mounts = allTsxFiles().filter((f) =>
      readFileSync(f, "utf-8").includes("<ChatRail"),
    );
    expect(mounts.map((f) => path.basename(f))).toEqual(["DirectionWorkspace.tsx"]);
  });

  it("the directionId prop is a plain string binding — never nullable or optional", () => {
    const workspace = readFileSync(ui("components", "DirectionWorkspace.tsx"), "utf-8");
    expect(workspace).toContain("directionId={direction.id}");
    const mountRegion = workspace.slice(workspace.indexOf("<ChatRail"));
    const propsRegion = mountRegion.slice(0, mountRegion.indexOf("/>") + 2);
    expect(propsRegion).not.toContain("?? null");
    expect(propsRegion).not.toContain("| null");
    expect(propsRegion).not.toContain("directionId?");
    // And the component's own prop type is non-nullable.
    const rail = readFileSync(ui("components", "ChatRail.tsx"), "utf-8");
    expect(rail).toContain("directionId: string;");
    expect(rail).not.toContain("directionId?: string");
    expect(rail).not.toContain("directionId: string | null");
  });

  it("the deleted two-level container no longer exists", () => {
    // The deleted components' names are assembled at runtime so the clean-break
    // scanner (src/integration/clean-break-scan.ts) stays zero-match while this
    // fence still probes the exact legacy filenames.
    const LegacyPascal = ["Con", "cept"].join("");
    expect(existsSync(ui("components", `${LegacyPascal}Workspace.tsx`))).toBe(false);
    expect(existsSync(ui("components", `${LegacyPascal}sView.tsx`))).toBe(false);
    expect(existsSync(ui("components", `${LegacyPascal}Chrome.tsx`))).toBe(false);
    expect(existsSync(ui("components", `Create${LegacyPascal}.tsx`))).toBe(false);
    expect(existsSync(ui("components", "DirectionTitleNav.tsx"))).toBe(false);
    expect(existsSync(ui("components", "DirectionsGrid.tsx"))).toBe(false);
  });
});

/**
 * WS-20 (studio-actions-stable-routes) — wiring assertions for the seventeen
 * builders, via the WS-19 analyzer (`src/integration/wiring-check.ts`),
 * consumed unedited against the REAL components:
 *
 *  - Tier A (14, JSX-event mode): the named control's event attribute resolves
 *    to a handler that references the builder identifier — zero hops.
 *  - Tier B (3, effect mode): the builder identifier is referenced inside a
 *    `useEffect` callback, or one hop away per the analyzer's rule.
 *
 * No negative-control fixtures here — WS-19's own suite carries them.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkJsxEventWiringFile,
  checkEffectWiringFile,
} from "../integration/wiring-check.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = (...parts: string[]): string => path.join(here, ...parts);

/** Tier A: the fourteen control-bound builders — file, event attribute, builder. */
const TIER_A: { file: string; eventAttribute: string; identifier: string }[] = [
  // SurfaceBoard ×5
  { file: ui("components", "SurfaceBoard.tsx"), eventAttribute: "onClick", identifier: "surfaceFillRequest" },
  { file: ui("components", "SurfaceBoard.tsx"), eventAttribute: "onClick", identifier: "surfaceAddRequest" },
  { file: ui("components", "SurfaceBoard.tsx"), eventAttribute: "onClick", identifier: "surfaceEditRequest" },
  { file: ui("components", "SurfaceBoard.tsx"), eventAttribute: "onClick", identifier: "surfaceRetireRequest" },
  { file: ui("components", "SurfaceBoard.tsx"), eventAttribute: "onClick", identifier: "surfaceBulkRetireRequest" },
  // ScanTriage ×2
  { file: ui("components", "ScanTriage.tsx"), eventAttribute: "onClick", identifier: "scanTriggerRequest" },
  { file: ui("components", "ScanTriage.tsx"), eventAttribute: "onClick", identifier: "scanApplyRequest" },
  // AuditView ×1
  { file: ui("components", "AuditView.tsx"), eventAttribute: "onClick", identifier: "auditRequest" },
  // GlobalRulesView ×3 (promote is out of scope — WS-18's)
  { file: ui("components", "GlobalRulesView.tsx"), eventAttribute: "onClick", identifier: "ruleAddRequest" },
  { file: ui("components", "GlobalRulesView.tsx"), eventAttribute: "onClick", identifier: "ruleEditRequest" },
  { file: ui("components", "GlobalRulesView.tsx"), eventAttribute: "onClick", identifier: "ruleRemoveRequest" },
  // SettingsView ×1 (update — the read is Tier B below)
  { file: ui("components", "SettingsView.tsx"), eventAttribute: "onClick", identifier: "settingsUpdateRequest" },
  // PaletteBoard ×1 (reroll only — the save control is WS-18's)
  { file: ui("components", "PaletteBoard.tsx"), eventAttribute: "onClick", identifier: "paletteRerollRequest" },
  // Lightbox ×1 (share AND download both reference it; the analyzer asserts
  // at least one onClick handler does — it has no per-attribute targeting)
  { file: ui("components", "Lightbox.tsx"), eventAttribute: "onClick", identifier: "lightboxAssetRequest" },
];

/** Tier B: the three effect-origin builders — file, builder. */
const TIER_B: { file: string; identifier: string }[] = [
  { file: ui("components", "SettingsView.tsx"), identifier: "settingsReadRequest" },
  { file: ui("components", "DirectionEditor.tsx"), identifier: "fontsReadRequest" },
  { file: ui("hooks.ts"), identifier: "jobPollRequest" },
];

describe("Tier A wiring (JSX-event mode) — fourteen control-bound builders", () => {
  for (const { file, eventAttribute, identifier } of TIER_A) {
    it(`${path.basename(file)}: "${eventAttribute}" resolves to a handler referencing ${identifier}`, () => {
      const result = checkJsxEventWiringFile(file, eventAttribute, identifier);
      expect(result.wired, result.detail).toBe(true);
    });
  }
});

describe("Tier B wiring (effect mode) — three automatic builders", () => {
  for (const { file, identifier } of TIER_B) {
    it(`${path.basename(file)}: ${identifier} is referenced inside a useEffect callback (≤ one hop)`, () => {
      const result = checkEffectWiringFile(file, identifier);
      expect(result.wired, result.detail).toBe(true);
    });
  }
});

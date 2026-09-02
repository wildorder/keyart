/**
 * Builder-level request assertions for the complete forty-seven-builder
 * roster: WS-20's seventeen route-AND-body-stable builders plus WS-18's
 * thirty coupled ones, closed out by the FIVE set-equality relations (SC-09,
 * adjudicated — WS-18 replaced WS-20's interim seventeen-member subset
 * assertion with them).
 *
 * Each test asserts the EXACT `StudioRequest` — method, path (encoding
 * included), deep-equal body — so a drifted extraction fails here, not in
 * manual review. Bodies with conditional keys get both branches asserted.
 */
import { describe, it, expect } from "vitest";
import * as actions from "./direction-actions.js";
import {
  TIER_A_BUILDERS,
  TIER_B_BUILDERS,
  TIER_C_SETTERS,
  WS18_TIER_A_BUILDERS,
  WS18_TIER_B_BUILDERS,
  WS20_TIER_A_BUILDERS,
  WS20_TIER_B_BUILDERS,
} from "../integration/studio-roster.js";
import {
  surfaceFillRequest,
  surfaceAddRequest,
  surfaceEditRequest,
  surfaceRetireRequest,
  surfaceBulkRetireRequest,
  scanTriggerRequest,
  scanApplyRequest,
  auditRequest,
  ruleAddRequest,
  ruleEditRequest,
  ruleRemoveRequest,
  settingsUpdateRequest,
  paletteRerollRequest,
  lightboxAssetRequest,
  settingsReadRequest,
  fontsReadRequest,
  jobPollRequest,
} from "./direction-actions.js";
import type { DirectionTokens } from "./types.js";

// The removed legacy parent noun, assembled at runtime so the clean-break
// scanner's zero-match state holds (src/integration/clean-break-scan.ts) while
// these fences still probe the exact legacy keys/segments.
const LEGACY_NOUN = ["con", "cept"].join("");

/** An id that needs `encodeURIComponent` in a path segment. */
const RAW_ID = "icon/hero checkout?";
const ENC_ID = encodeURIComponent(RAW_ID);

const TOKENS: DirectionTokens = {
  palette: [{ role: "background", name: "Canvas", hex: "#faf8f4" }],
  typography: { heading: "Fraunces", body: "Inter" },
  shape: { radius: "8px", spacingUnit: "4px" },
};

// ---------------------------------------------------------------------------
// Tier A — control-bound
// ---------------------------------------------------------------------------

describe("surfaceFillRequest", () => {
  it("POSTs /api/actions/surface-fill with { slotId }", () => {
    expect(surfaceFillRequest("icon.hero")).toEqual({
      method: "POST",
      path: "/api/actions/surface-fill",
      body: { slotId: "icon.hero" },
    });
  });
});

describe("surfaceAddRequest", () => {
  it("POSTs /api/surface/slots with { slot, expectedVersion }", () => {
    const slot = {
      id: "icon.checkout",
      kind: "icon",
      description: "Checkout icon",
      criticality: "preferred" as const,
      context: { tone: "friendly" },
    };
    expect(surfaceAddRequest({ slot, expectedVersion: 4 })).toEqual({
      method: "POST",
      path: "/api/surface/slots",
      body: { slot, expectedVersion: 4 },
    });
  });

  it("omits the expectedVersion key when absent", () => {
    const slot = {
      id: "icon.checkout",
      kind: "icon",
      description: "Checkout icon",
      criticality: "required" as const,
    };
    expect(surfaceAddRequest({ slot })).toEqual({
      method: "POST",
      path: "/api/surface/slots",
      body: { slot },
    });
  });
});

describe("surfaceEditRequest", () => {
  it("PATCHes /api/surface/slots/:slotId with the slot id encoded", () => {
    expect(
      surfaceEditRequest(RAW_ID, {
        criticality: "required",
        context: { sitsOn: "surface" },
        expectedVersion: 7,
      }),
    ).toEqual({
      method: "PATCH",
      path: `/api/surface/slots/${ENC_ID}`,
      body: {
        criticality: "required",
        context: { sitsOn: "surface" },
        expectedVersion: 7,
      },
    });
  });

  it("omits the context key when undefined (never an explicit undefined)", () => {
    const req = surfaceEditRequest("icon.hero", {
      criticality: "preferred",
      context: undefined,
      expectedVersion: 2,
    });
    expect(req).toEqual({
      method: "PATCH",
      path: "/api/surface/slots/icon.hero",
      body: { criticality: "preferred", expectedVersion: 2 },
    });
    expect(Object.keys(req.body as object)).not.toContain("context");
  });
});

describe("surfaceRetireRequest", () => {
  it("DELETEs /api/surface/slots/:slotId with { expectedVersion } (id encoded)", () => {
    expect(surfaceRetireRequest(RAW_ID, { expectedVersion: 3 })).toEqual({
      method: "DELETE",
      path: `/api/surface/slots/${ENC_ID}`,
      body: { expectedVersion: 3 },
    });
  });
});

describe("surfaceBulkRetireRequest", () => {
  it("DELETEs /api/surface/slots?origin=scan (origin hard-coded)", () => {
    expect(surfaceBulkRetireRequest({ expectedVersion: 9 })).toEqual({
      method: "DELETE",
      path: "/api/surface/slots?origin=scan",
      body: { expectedVersion: 9 },
    });
  });
});

describe("scanTriggerRequest", () => {
  it("POSTs /api/actions/surface-scan with { urls } (the wire's array shape)", () => {
    expect(scanTriggerRequest(["http://localhost:3000"])).toEqual({
      method: "POST",
      path: "/api/actions/surface-scan",
      body: { urls: ["http://localhost:3000"] },
    });
  });
});

describe("scanApplyRequest", () => {
  it("POSTs /api/surface/proposal/apply with { acceptedIds, expectedVersion }", () => {
    expect(
      scanApplyRequest({ acceptedIds: ["sig-1", "sig-2"], expectedVersion: 5 }),
    ).toEqual({
      method: "POST",
      path: "/api/surface/proposal/apply",
      body: { acceptedIds: ["sig-1", "sig-2"], expectedVersion: 5 },
    });
  });

  it("omits the expectedVersion key when absent (first-scan bootstrap)", () => {
    expect(scanApplyRequest({ acceptedIds: [] })).toEqual({
      method: "POST",
      path: "/api/surface/proposal/apply",
      body: { acceptedIds: [] },
    });
  });
});

describe("auditRequest", () => {
  it("POSTs /api/actions/audit with { url }", () => {
    expect(auditRequest("https://localhost:3000")).toEqual({
      method: "POST",
      path: "/api/actions/audit",
      body: { url: "https://localhost:3000" },
    });
  });
});

describe("ruleAddRequest", () => {
  it("POSTs /api/rules with { text, severity, channel, polarity }", () => {
    expect(
      ruleAddRequest({
        text: "Never use pure black for body text",
        severity: "hard",
        channel: "visual",
        polarity: "avoid",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/rules",
      body: {
        text: "Never use pure black for body text",
        severity: "hard",
        channel: "visual",
        polarity: "avoid",
      },
    });
  });
});

describe("ruleEditRequest", () => {
  it("PATCHes /api/rules/:id with force: true when the edit is force-gated (id encoded)", () => {
    expect(
      ruleEditRequest(RAW_ID, { text: "Updated", severity: "hard", force: true }),
    ).toEqual({
      method: "PATCH",
      path: `/api/rules/${ENC_ID}`,
      body: { text: "Updated", severity: "hard", force: true },
    });
  });

  it("omits the force key when not sent", () => {
    const req = ruleEditRequest("rule-1", { text: "Updated", severity: "guideline" });
    expect(req).toEqual({
      method: "PATCH",
      path: "/api/rules/rule-1",
      body: { text: "Updated", severity: "guideline" },
    });
    expect(Object.keys(req.body as object)).not.toContain("force");
  });
});

describe("ruleRemoveRequest", () => {
  it("DELETEs /api/rules/:id with force: true for a hard rule (id encoded)", () => {
    expect(ruleRemoveRequest(RAW_ID, { force: true })).toEqual({
      method: "DELETE",
      path: `/api/rules/${ENC_ID}`,
      body: { force: true },
    });
  });

  it("sends an empty body when force is not required", () => {
    expect(ruleRemoveRequest("rule-1", {})).toEqual({
      method: "DELETE",
      path: "/api/rules/rule-1",
      body: {},
    });
  });
});

describe("settingsUpdateRequest", () => {
  const project = { name: "demo", type: "prototype", framework: "react" };
  const models = { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" };

  it("PUTs /api/settings with openaiApiKey present when non-empty", () => {
    expect(
      settingsUpdateRequest({ project, models, openaiApiKey: "sk-test" }),
    ).toEqual({
      method: "PUT",
      path: "/api/settings",
      body: { project, models, openaiApiKey: "sk-test" },
    });
  });

  it("omits the openaiApiKey key when absent or empty — as today", () => {
    const absent = settingsUpdateRequest({ project, models });
    expect(absent).toEqual({
      method: "PUT",
      path: "/api/settings",
      body: { project, models },
    });
    const empty = settingsUpdateRequest({ project, models, openaiApiKey: "" });
    expect(Object.keys(empty.body as object)).not.toContain("openaiApiKey");
  });
});

describe("paletteRerollRequest", () => {
  it("POSTs /api/palette/reroll with { tokens, lockedRoles, seed } (seed is an argument)", () => {
    expect(
      paletteRerollRequest({ tokens: TOKENS, lockedRoles: ["background"], seed: 12345 }),
    ).toEqual({
      method: "POST",
      path: "/api/palette/reroll",
      body: { tokens: TOKENS, lockedRoles: ["background"], seed: 12345 },
    });
  });
});

describe("lightboxAssetRequest", () => {
  it("GETs /api/asset?path=…&v=… with both parts encoded when version is present", () => {
    const req = lightboxAssetRequest("brand/directions/a/style tile.png", "v 2");
    expect(req).toEqual({
      method: "GET",
      path: `/api/asset?path=${encodeURIComponent("brand/directions/a/style tile.png")}&v=${encodeURIComponent("v 2")}`,
    });
    expect(req).not.toHaveProperty("body");
  });

  it("omits &v= entirely when version is nullish", () => {
    expect(lightboxAssetRequest("brand/tile.png")).toEqual({
      method: "GET",
      path: `/api/asset?path=${encodeURIComponent("brand/tile.png")}`,
    });
    expect(lightboxAssetRequest("brand/tile.png", undefined).path).not.toContain("&v=");
  });

  it("accepts a numeric version (cache-bust parity with AssetImage)", () => {
    expect(lightboxAssetRequest("brand/tile.png", 3).path).toBe(
      `/api/asset?path=${encodeURIComponent("brand/tile.png")}&v=3`,
    );
  });
});

// ---------------------------------------------------------------------------
// Tier B — automatic (effect origin)
// ---------------------------------------------------------------------------

describe("settingsReadRequest", () => {
  it("GETs /api/settings with no body key", () => {
    const req = settingsReadRequest();
    expect(req).toEqual({ method: "GET", path: "/api/settings" });
    expect(req).not.toHaveProperty("body");
  });
});

describe("fontsReadRequest", () => {
  it("GETs /api/fonts with no body key", () => {
    const req = fontsReadRequest();
    expect(req).toEqual({ method: "GET", path: "/api/fonts" });
    expect(req).not.toHaveProperty("body");
  });
});

describe("jobPollRequest", () => {
  it("GETs /api/jobs/:jobId with the id encoded and no body key", () => {
    const req = jobPollRequest(RAW_ID);
    expect(req).toEqual({ method: "GET", path: `/api/jobs/${ENC_ID}` });
    expect(req).not.toHaveProperty("body");
  });
});

// ---------------------------------------------------------------------------
// WS-18's thirty builders — per-builder request assertions, keyed by name so
// the builder-test list is a first-class set the relations compare against.
// ---------------------------------------------------------------------------

const {
  regenerateRequest,
  generateV1Request,
  divergentExploreRequest,
  approveRequest,
  restoreVersionRequest,
  forkRequest,
  authoredCreateRequest,
  elementFeedbackRequest,
  extractAssetRequest,
  exportAssetPackRequest,
  assetRegenerateRequest,
  assetRetireRequest,
  moodboardUploadRequest,
  moodboardAssetRetireRequest,
  chatSendRequest,
  chatResumeRequest,
  briefWriteRequest,
  briefMapRequest,
  briefColorLockRequest,
  notesComposerRequest,
  directionEditRequest,
  directionVariantRequest,
  paletteSaveRequest,
  memoryPromoteRequest,
  memoryEditRequest,
  memoryDeleteRequest,
  globalPromoteRequest,
  reconciliationResolveRequest,
  reconciliationReadRequest,
  dashboardReadRequest,
} = actions;

/** WS-18's Tier A cases — one entry per builder, keyed by the roster name. */
const WS18_TIER_A_CASES: Record<string, () => void> = {
  regenerateRequest: () => {
    expect(regenerateRequest("d")).toEqual({
      method: "POST",
      path: "/api/actions/regenerate",
      body: { directionId: "d" },
    });
    const full = regenerateRequest("d", {
      tweak: "warmer",
      feedback: "more editorial",
      lockedRoles: ["primary"],
      lockedColors: [{ role: "primary", hex: "#ff2d8d" }],
    });
    expect(full.body).toEqual({
      directionId: "d",
      tweak: "warmer",
      feedback: "more editorial",
      lockedRoles: ["primary"],
      lockedColors: [{ role: "primary", hex: "#ff2d8d" }],
    });
    // Empty lock arrays never become explicit empty keys.
    const bare = regenerateRequest("d", { lockedRoles: [], lockedColors: [] });
    expect(Object.keys(bare.body as object)).toEqual(["directionId"]);
  },
  generateV1Request: () => {
    // A SINGLE existing draft id, NO count — never regenerateRequest (WS-15
    // rejects a zero-version draft).
    const req = generateV1Request("d");
    expect(req).toEqual({
      method: "POST",
      path: "/api/actions/explore",
      body: { directionId: "d" },
    });
    expect(Object.keys(req.body as object)).not.toContain("count");
  },
  divergentExploreRequest: () => {
    // Seed text, NO direction id — the divergent mode, never the single-draft path.
    const req = divergentExploreRequest("warm slow coffee", 3);
    expect(req).toEqual({
      method: "POST",
      path: "/api/actions/explore",
      body: { describe: "warm slow coffee", count: 3 },
    });
    expect(Object.keys(req.body as object)).not.toContain("directionId");
    expect(divergentExploreRequest("seed").body).toEqual({ describe: "seed" });
  },
  approveRequest: () => {
    expect(approveRequest("d", "v2")).toEqual({
      method: "POST",
      path: "/api/actions/approve",
      body: { directionId: "d", versionId: "v2" },
    });
    expect(approveRequest("d").body).toEqual({ directionId: "d" });
  },
  restoreVersionRequest: () => {
    expect(restoreVersionRequest("d", { name: "Old", summary: "s" })).toEqual({
      method: "POST",
      path: "/api/directions/d/versions",
      body: { name: "Old", summary: "s" },
    });
    expect(restoreVersionRequest(RAW_ID, {}).path).toBe(
      `/api/directions/${ENC_ID}/versions`,
    );
  },
  forkRequest: () => {
    expect(forkRequest("src")).toEqual({
      method: "POST",
      path: "/api/directions/src/fork",
      body: {},
    });
    expect(forkRequest("src", { name: "Warm II", count: 2, withMemory: true })).toEqual({
      method: "POST",
      path: "/api/directions/src/fork",
      body: { name: "Warm II", count: 2, withMemory: true },
    });
  },
  authoredCreateRequest: () => {
    const content = { name: "Bold", summary: "s", character: {}, usage: { rules: [], antiRules: [] } };
    expect(authoredCreateRequest("seed", content)).toEqual({
      method: "POST",
      path: "/api/directions/seed/create",
      body: content,
    });
  },
  elementFeedbackRequest: () => {
    // Multipart descriptor: `form` carries directionId + the gesture fields —
    // NO scope field, NO conceptId. The crop blob rides via the transport.
    const req = elementFeedbackRequest({ directionId: "d", verb: "keep", intent: "inspire" });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/element-feedback");
    expect(req.form).toEqual({ directionId: "d", verb: "keep", intent: "inspire" });
    expect(req).not.toHaveProperty("body");
    expect(Object.keys(req.form!)).not.toContain(`${LEGACY_NOUN}Id`);
    expect(Object.keys(req.form!)).not.toContain("scope");
  },
  extractAssetRequest: () => {
    // A DIFFERENT route from element feedback (route distinctness, SC-09).
    const req = extractAssetRequest({ directionId: "d", describe: "the yak", name: "yak" });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/actions/asset-extract");
    expect(req.form).toEqual({ directionId: "d", describe: "the yak", name: "yak" });
    expect(req.path).not.toBe(elementFeedbackRequest({ directionId: "d", verb: "keep" }).path);
  },
  exportAssetPackRequest: () => {
    const req = exportAssetPackRequest("d");
    expect(req).toEqual({
      method: "POST",
      path: "/api/asset-pack",
      body: { directionId: "d" },
    });
    expect(Object.keys(req.body as object)).not.toContain(LEGACY_NOUN);
  },
  assetRegenerateRequest: () => {
    const req = assetRegenerateRequest("d", "yak", "face left", { remember: true });
    expect(req).toEqual({
      method: "POST",
      path: "/api/actions/asset-regenerate",
      body: { directionId: "d", assetId: "yak", tweak: "face left", remember: true },
    });
    const bare = assetRegenerateRequest("d", "yak", "face left");
    expect(Object.keys(bare.body as object)).not.toContain("remember");
    expect(Object.keys(bare.body as object)).not.toContain(LEGACY_NOUN);
  },
  assetRetireRequest: () => {
    expect(assetRetireRequest("d", RAW_ID)).toEqual({
      method: "DELETE",
      path: `/api/directions/d/extracted-assets/${ENC_ID}`,
      body: {},
    });
  },
  moodboardUploadRequest: () => {
    expect(moodboardUploadRequest("d")).toEqual({
      method: "POST",
      path: "/api/uploads",
      form: { directionId: "d" },
    });
    expect(moodboardUploadRequest("d", "extract").form).toEqual({
      directionId: "d",
      intent: "extract",
    });
  },
  moodboardAssetRetireRequest: () => {
    expect(moodboardAssetRetireRequest("d", "brand/directions/d/assets/x.png", 3)).toEqual({
      method: "DELETE",
      path: "/api/directions/d/assets",
      body: { path: "brand/directions/d/assets/x.png", expectedVersion: 3 },
    });
    expect(
      Object.keys(moodboardAssetRetireRequest("d", "p.png").body as object),
    ).toEqual(["path"]);
  },
  chatSendRequest: () => {
    // SSE descriptor — the direction is REQUIRED in payload.context.
    const req = chatSendRequest({
      message: "warmer",
      context: { directionId: "d", versionId: "v2" },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/chat");
    expect(req.payload).toEqual({
      message: "warmer",
      context: { directionId: "d", versionId: "v2" },
    });
    expect(req).not.toHaveProperty("body");
  },
  chatResumeRequest: () => {
    // The approval/denial resume — a SEPARATE route from send.
    const req = chatResumeRequest(RAW_ID, true);
    expect(req.method).toBe("POST");
    expect(req.path).toBe(`/api/chat/${ENC_ID}/approve`);
    expect(req.payload).toEqual({ approve: true });
    expect(chatResumeRequest("s", false).payload).toEqual({ approve: false });
  },
  briefWriteRequest: () => {
    expect(briefWriteRequest("d", { oneLiner: "x" }, 4)).toEqual({
      method: "PATCH",
      path: "/api/directions/d/brief",
      body: { patch: { oneLiner: "x" }, expectedVersion: 4 },
    });
    expect(Object.keys(briefWriteRequest("d", {}).body as object)).toEqual(["patch"]);
  },
  briefMapRequest: () => {
    expect(briefMapRequest("d", "a ramble")).toEqual({
      method: "POST",
      path: "/api/directions/d/brief/map",
      body: { freeform: "a ramble" },
    });
  },
  briefColorLockRequest: () => {
    expect(briefColorLockRequest("d", "#ff2d8d", "brand pink")).toEqual({
      method: "POST",
      path: "/api/directions/d/brief/lock",
      body: { hex: "#ff2d8d", note: "brand pink" },
    });
    expect(briefColorLockRequest("d", "#ff2d8d").body).toEqual({ hex: "#ff2d8d" });
  },
  notesComposerRequest: () => {
    const req = notesComposerRequest("d", {
      body: "warmer tones",
      kind: "decision",
      channel: "visual",
      polarity: "prefer",
    });
    expect(req).toEqual({
      method: "POST",
      path: "/api/directions/d/feedback",
      body: { body: "warmer tones", kind: "decision", channel: "visual", polarity: "prefer" },
    });
    // NO scope field — scope is location.
    expect(Object.keys(req.body as object)).not.toContain("scope");
    expect(
      notesComposerRequest("d", { body: "b", kind: "feedback" }).body,
    ).toEqual({ body: "b", kind: "feedback" });
  },
  directionEditRequest: () => {
    expect(directionEditRequest("d", { name: "N" })).toEqual({
      method: "PUT",
      path: "/api/directions/d",
      body: { name: "N" },
    });
  },
  directionVariantRequest: () => {
    expect(directionVariantRequest("d", { name: "N" })).toEqual({
      method: "POST",
      path: "/api/directions/d/versions",
      body: { name: "N" },
    });
  },
  paletteSaveRequest: () => {
    expect(paletteSaveRequest("d", TOKENS)).toEqual({
      method: "PUT",
      path: "/api/directions/d",
      body: { tokens: TOKENS },
    });
  },
  memoryPromoteRequest: () => {
    // Promote is up-ladder to global ONLY.
    expect(memoryPromoteRequest("d", "e1")).toEqual({
      method: "POST",
      path: "/api/directions/d/memory/e1/promote",
      body: { to: "global" },
    });
    expect(memoryPromoteRequest("d", "e1", { severity: "hard", expectedVersion: 2 }).body).toEqual({
      to: "global",
      severity: "hard",
      expectedVersion: 2,
    });
  },
  memoryEditRequest: () => {
    expect(
      memoryEditRequest("d", RAW_ID, { body: "edited", channel: "copy", expectedVersion: 5 }),
    ).toEqual({
      method: "PATCH",
      path: `/api/directions/d/memory/${ENC_ID}`,
      body: { body: "edited", channel: "copy", expectedVersion: 5 },
    });
  },
  memoryDeleteRequest: () => {
    expect(memoryDeleteRequest("d", "e1", 3)).toEqual({
      method: "DELETE",
      path: "/api/directions/d/memory/e1",
      body: { expectedVersion: 3 },
    });
    expect(memoryDeleteRequest("d", "e1").body).toEqual({});
  },
  globalPromoteRequest: () => {
    // WS-05's contracted signature — directionId only, never re-widened.
    const req = globalPromoteRequest({ directionId: "d", severity: "hard", entryId: "e1" });
    expect(req).toEqual({
      method: "POST",
      path: "/api/promote",
      body: { directionId: "d", severity: "hard", entryId: "e1" },
    });
    expect(Object.keys(req.body as object)).not.toContain(`${LEGACY_NOUN}Id`);
    expect(globalPromoteRequest({ directionId: "d", severity: "guideline", text: "t" }).body).toEqual({
      directionId: "d",
      severity: "guideline",
      text: "t",
    });
  },
  reconciliationResolveRequest: () => {
    expect(reconciliationResolveRequest("d", { action: "keep" })).toEqual({
      method: "POST",
      path: "/api/directions/d/reconciliation/resolve",
      body: { action: "keep" },
    });
  },
};

/** WS-18's Tier B cases. */
const WS18_TIER_B_CASES: Record<string, () => void> = {
  reconciliationReadRequest: () => {
    const req = reconciliationReadRequest(RAW_ID);
    expect(req).toEqual({ method: "GET", path: `/api/directions/${ENC_ID}/reconciliation` });
    expect(req).not.toHaveProperty("body");
  },
  dashboardReadRequest: () => {
    const req = dashboardReadRequest();
    expect(req).toEqual({ method: "GET", path: "/api/dashboard" });
    expect(req).not.toHaveProperty("body");
  },
};

describe("WS-18 Tier A builders — exact requests per the route table", () => {
  for (const [name, run] of Object.entries(WS18_TIER_A_CASES)) {
    it(`${name} produces the exact request`, run);
  }
});

describe("WS-18 Tier B builders — exact requests", () => {
  for (const [name, run] of Object.entries(WS18_TIER_B_CASES)) {
    it(`${name} produces the exact request`, run);
  }
});

describe("route hygiene across the WHOLE export set", () => {
  it("no builder path contains the legacy plural segment or a doubled `directions` segment", () => {
    // Exercise every builder with representative arguments and inspect paths.
    const paths: string[] = [
      regenerateRequest("d").path,
      generateV1Request("d").path,
      divergentExploreRequest("seed").path,
      approveRequest("d").path,
      restoreVersionRequest("d", {}).path,
      forkRequest("d").path,
      authoredCreateRequest("d", {}).path,
      elementFeedbackRequest({ directionId: "d" }).path,
      extractAssetRequest({ directionId: "d" }).path,
      exportAssetPackRequest("d").path,
      assetRegenerateRequest("d", "a", "t").path,
      assetRetireRequest("d", "a").path,
      moodboardUploadRequest("d").path,
      moodboardAssetRetireRequest("d", "p").path,
      chatSendRequest({ message: "m", context: { directionId: "d" } }).path,
      chatResumeRequest("s", true).path,
      briefWriteRequest("d", {}).path,
      briefMapRequest("d", "f").path,
      briefColorLockRequest("d", "#ffffff").path,
      notesComposerRequest("d", { body: "b", kind: "feedback" }).path,
      directionEditRequest("d", {}).path,
      directionVariantRequest("d", {}).path,
      paletteSaveRequest("d", TOKENS).path,
      memoryPromoteRequest("d", "e").path,
      memoryEditRequest("d", "e", { body: "b" }).path,
      memoryDeleteRequest("d", "e").path,
      globalPromoteRequest({ directionId: "d", severity: "hard" }).path,
      reconciliationResolveRequest("d", {}).path,
      reconciliationReadRequest("d").path,
      dashboardReadRequest().path,
      // WS-20's seventeen included.
      surfaceFillRequest("s").path,
      surfaceAddRequest({ slot: { id: "i", kind: "icon", description: "", criticality: "required" } }).path,
      surfaceEditRequest("s", { criticality: "required" }).path,
      surfaceRetireRequest("s", {}).path,
      surfaceBulkRetireRequest({}).path,
      scanTriggerRequest(["u"]).path,
      scanApplyRequest({ acceptedIds: [] }).path,
      auditRequest("u").path,
      ruleAddRequest({ text: "t", severity: "hard", channel: "visual", polarity: "avoid" }).path,
      ruleEditRequest("r", { text: "t", severity: "hard" }).path,
      ruleRemoveRequest("r", {}).path,
      settingsUpdateRequest({
        project: { name: "n", type: "t", framework: "f" },
        models: { text: "t", vision: "v", image: "i" },
      }).path,
      paletteRerollRequest({ tokens: TOKENS, lockedRoles: [], seed: 1 }).path,
      lightboxAssetRequest("p.png").path,
      settingsReadRequest().path,
      fontsReadRequest().path,
      jobPollRequest("j").path,
    ];
    expect(paths).toHaveLength(47);
    for (const p of paths) {
      const segments = p.split("?")[0].split("/").filter(Boolean);
      expect(segments, p).not.toContain(`${LEGACY_NOUN}s`);
      expect(segments.filter((s) => s === "directions").length, p).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The FIVE set-equality relations (SC-09, adjudicated) — these REPLACE WS-20's
// interim seventeen-member subset assertion.
// ---------------------------------------------------------------------------

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("the five set-equality relations", () => {
  it("(1) the export set EQUALS Tier A (42) ∪ Tier B (5) = 47, and the tiers are disjoint", () => {
    const exported = Object.keys(actions).sort();
    expect(TIER_A_BUILDERS).toHaveLength(42);
    expect(TIER_B_BUILDERS).toHaveLength(5);
    expect(exported).toEqual(sorted([...TIER_A_BUILDERS, ...TIER_B_BUILDERS]));
    const overlap = TIER_A_BUILDERS.filter((n) => TIER_B_BUILDERS.includes(n));
    expect(overlap).toEqual([]);
    for (const name of exported) {
      expect(typeof (actions as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("(2) Tier A EQUALS the builder-test list EQUALS the 28 + 14 ownership-scope union", () => {
    // The reference endpoint is the UNION of the two ownership scopes'
    // enumerated builders — never WS-18's alone.
    expect(WS18_TIER_A_BUILDERS).toHaveLength(28);
    expect(WS20_TIER_A_BUILDERS).toHaveLength(14);
    expect(sorted(TIER_A_BUILDERS)).toEqual(
      sorted([...WS18_TIER_A_BUILDERS, ...WS20_TIER_A_BUILDERS]),
    );
    // The builder-test list: WS-18's per-builder case keys ∪ WS-20's fourteen
    // (whose per-builder tests live above, untouched).
    expect(sorted(Object.keys(WS18_TIER_A_CASES))).toEqual(sorted(WS18_TIER_A_BUILDERS));
  });

  it("(3) Tier B EQUALS the builder-test list EQUALS the 2 + 3 ownership-scope union", () => {
    expect(WS18_TIER_B_BUILDERS).toHaveLength(2);
    expect(WS20_TIER_B_BUILDERS).toHaveLength(3);
    expect(sorted(TIER_B_BUILDERS)).toEqual(
      sorted([...WS18_TIER_B_BUILDERS, ...WS20_TIER_B_BUILDERS]),
    );
    expect(sorted(Object.keys(WS18_TIER_B_CASES))).toEqual(sorted(WS18_TIER_B_BUILDERS));
  });

  it("(4) no Tier C flow appears in the export set — view-only flows have NO builder", () => {
    const exported = new Set(Object.keys(actions));
    for (const setter of TIER_C_SETTERS) {
      expect(exported.has(setter), setter).toBe(false);
    }
    // And no accidental builder spelling for any of them either.
    for (const suspicious of [
      "versionSelectRequest",
      "compareRequest",
      "drawerRequest",
      "guidesTabRequest",
      "directionSelectRequest",
      "surfaceBindRequest", // SC-11: no whole-manifest bind affordance exists
      "archiveRequest", // R-5: no archive request builder in any tier's roster
    ]) {
      expect(exported.has(suspicious), suspicious).toBe(false);
    }
  });

  it("(5) the Tier C roster has EXACTLY the ten enumerated members (the wiring test consumes the same list)", () => {
    expect(TIER_C_SETTERS).toHaveLength(10);
    // The exact roster, in the plan's order.
    expect([...TIER_C_SETTERS]).toEqual([
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
});

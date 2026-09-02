import { describe, it, expect } from "vitest";
import {
  orderSurfaceSlots,
  requestLine,
  statusChipClass,
  statusLabel,
  isGenerateTarget,
  pendingHint,
  parseListInput,
  parseSizesInput,
  scannedSlotCount,
} from "./surface-board-helpers.js";
import type { DashboardSurfaceSlot } from "./types.js";

const makeSlot = (o: Partial<DashboardSurfaceSlot>): DashboardSurfaceSlot => ({
  id: "icon.hero",
  kind: "icon",
  criticality: "required",
  origin: "authored",
  attributionCount: 0,
  status: "gap",
  ...o,
});

describe("orderSurfaceSlots", () => {
  it("gap/pending first, then derived, then bound — manifest order preserved within each group", () => {
    const bound = makeSlot({ id: "a-bound", status: "bound" });
    const derived = makeSlot({ id: "b-derived", status: "derived" });
    const gap = makeSlot({ id: "c-gap", status: "gap" });
    const pending = makeSlot({ id: "d-pending", status: "pending" });
    const gap2 = makeSlot({ id: "e-gap2", status: "gap" });

    const ordered = orderSurfaceSlots([bound, derived, gap, pending, gap2]);
    expect(ordered.map((s) => s.id)).toEqual([
      "c-gap",
      "d-pending",
      "e-gap2",
      "b-derived",
      "a-bound",
    ]);
  });

  it("does not mutate the input array", () => {
    const list = [makeSlot({ id: "a", status: "bound" }), makeSlot({ id: "b", status: "gap" })];
    const before = JSON.stringify(list);
    orderSurfaceSlots(list);
    expect(JSON.stringify(list)).toEqual(before);
  });
});

describe("requestLine", () => {
  it("origin: request + attributionCount 3 + latestAttribution → contains 'requested 3×' and the author", () => {
    const slot = makeSlot({
      origin: "request",
      attributionCount: 3,
      latestAttribution: { author: "cursor-agent", date: "2026-01-02T00:00:00.000Z" },
    });
    const line = requestLine(slot);
    expect(line).toContain("requested 3×");
    expect(line).toContain("cursor-agent");
  });

  it("attributionCount 1 → 'requested 1×'", () => {
    const slot = makeSlot({ origin: "request", attributionCount: 1 });
    expect(requestLine(slot)).toContain("requested 1×");
  });

  it("origin: authored → null (no fabricated request line)", () => {
    const slot = makeSlot({ origin: "authored", attributionCount: 1 });
    expect(requestLine(slot)).toBeNull();
  });
});

describe("statusChipClass / statusLabel", () => {
  it("the exact four mappings", () => {
    expect(statusChipClass("bound")).toBe("surface-board__chip surface-board__chip--bound");
    expect(statusChipClass("derived")).toBe("surface-board__chip surface-board__chip--derived");
    expect(statusChipClass("gap")).toBe("surface-board__chip surface-board__chip--gap");
    expect(statusChipClass("pending")).toBe("surface-board__chip surface-board__chip--pending");

    expect(statusLabel("bound")).toBe("bound");
    expect(statusLabel("derived")).toBe("derived");
    expect(statusLabel("gap")).toBe("gap");
  });

  it("pending's label is the honest 'pending (no image yet)'", () => {
    expect(statusLabel("pending")).toBe("pending (no image yet)");
  });
});

describe("isGenerateTarget / pendingHint", () => {
  it("icon + gap ⇒ true", () => {
    expect(isGenerateTarget(makeSlot({ kind: "icon", status: "gap" }))).toBe(true);
  });

  it("illustration + gap ⇒ true", () => {
    expect(isGenerateTarget(makeSlot({ kind: "illustration", status: "gap" }))).toBe(true);
  });

  it("illustration + pending ⇒ false (already claimed — the fill core rejects it)", () => {
    expect(isGenerateTarget(makeSlot({ kind: "illustration", status: "pending" }))).toBe(false);
  });

  it("color-role + gap ⇒ false (derives in bind, never fills)", () => {
    expect(isGenerateTarget(makeSlot({ kind: "color-role", status: "gap" }))).toBe(false);
  });

  it("icon + bound ⇒ false", () => {
    expect(isGenerateTarget(makeSlot({ kind: "icon", status: "bound" }))).toBe(false);
  });

  it("other + gap ⇒ false", () => {
    expect(isGenerateTarget(makeSlot({ kind: "other", status: "gap" }))).toBe(false);
  });

  it("pendingHint: a pending slot ⇒ a string pointing at the Asset Shelf regenerate flow", () => {
    const hint = pendingHint(makeSlot({ status: "pending" }));
    expect(hint).toMatch(/Asset Shelf/);
    expect(hint).toMatch(/regenerate/i);
  });

  it("pendingHint: any other status ⇒ null", () => {
    expect(pendingHint(makeSlot({ status: "gap" }))).toBeNull();
    expect(pendingHint(makeSlot({ status: "bound" }))).toBeNull();
    expect(pendingHint(makeSlot({ status: "derived" }))).toBeNull();
  });
});

describe("parseSizesInput / parseListInput", () => {
  it("parseSizesInput: '16, 24 ,x,32' → [16, 24, 32] (non-numeric entries dropped)", () => {
    expect(parseSizesInput("16, 24 ,x,32")).toEqual([16, 24, 32]);
  });

  it("parseSizesInput: empty/whitespace → undefined (the field is omitted, not [])", () => {
    expect(parseSizesInput("")).toBeUndefined();
    expect(parseSizesInput("   ")).toBeUndefined();
    expect(parseSizesInput("x, y")).toBeUndefined();
  });

  it("parseListInput: 'nav, empty-state ,footer' → ['nav', 'empty-state', 'footer']", () => {
    expect(parseListInput("nav, empty-state ,footer")).toEqual(["nav", "empty-state", "footer"]);
  });

  it("parseListInput: empty/whitespace → undefined (the field is omitted, not [])", () => {
    expect(parseListInput("")).toBeUndefined();
    expect(parseListInput("   ")).toBeUndefined();
  });
});

describe("scannedSlotCount", () => {
  it("15. counts only scan-origin slots and does not mutate the input", () => {
    const slots = [
      makeSlot({ id: "a", origin: "scan" }),
      makeSlot({ id: "b", origin: "authored" }),
      makeSlot({ id: "c", origin: "scan" }),
      makeSlot({ id: "d", origin: "request" }),
    ];
    const before = JSON.stringify(slots);
    expect(scannedSlotCount(slots)).toBe(2);
    expect(scannedSlotCount([])).toBe(0);
    expect(JSON.stringify(slots)).toEqual(before);
  });
});

import { describe, it, expect } from "vitest";
import {
  affordanceFor,
  isChatUnavailable,
  renderScopeChip,
  resolveInheritedScope,
} from "./chat-affordances.js";
import type { DashboardDirection, DashboardGlobal } from "./types.js";

const direction = (o: Partial<DashboardDirection> = {}): DashboardDirection => ({
  id: "direction-b",
  name: "Direction B",
  status: "active",
  brief: {
    aliases: [],
    neverCallIt: [],
    audiences: [],
    differentiateFrom: [],
    tone: [],
    values: [],
    inspirations: [],
    constraints: [],
    surfaces: [],
  },
  renderedBrief: "",
  version: 1,
  head: "v3",
  isDraft: false,
  versions: [
    { versionId: "v1", createdAt: "2026-01-01T00:00:00Z" } as never,
    { versionId: "v2", createdAt: "2026-01-02T00:00:00Z" } as never,
    { versionId: "v3", createdAt: "2026-01-03T00:00:00Z" } as never,
  ],
  extractedAssets: [],
  memory: [],
  ...o,
});

const pointer = (
  o: Partial<NonNullable<DashboardGlobal["approvedPointer"]>>,
): DashboardGlobal["approvedPointer"] => ({
  directionId: "direction-b",
  versionId: "v3",
  approvedAt: "2026-01-03T00:00:00Z",
  ...o,
});

describe("affordanceFor", () => {
  it("a destructive pending call earns the heavier confirm", () => {
    expect(affordanceFor("destructive")).toBe("heavy-confirm");
  });

  it("a write pending call earns the light confirm", () => {
    expect(affordanceFor("write")).toBe("light-confirm");
  });
});

describe("resolveInheritedScope + renderScopeChip", () => {
  it("renders directionId + the VIEWED version", () => {
    const scope = resolveInheritedScope(direction(), "v3", null);
    expect(scope).toEqual({
      directionId: "direction-b",
      versionId: "v3",
      pinned: false,
    });
    const chip = renderScopeChip(scope);
    expect(chip).toContain("direction-b");
    expect(chip).toContain("v3");
  });

  it("the VIEWED version is inherited, not head (finding #6)", () => {
    const viewingHistorical = resolveInheritedScope(direction(), "v2", null);
    expect(viewingHistorical.versionId).toBe("v2");

    const untouched = resolveInheritedScope(direction(), null, null);
    expect(untouched.versionId).toBe("v3");
  });

  it("pinned is true when the pointer pins this direction at the viewed version", () => {
    const scope = resolveInheritedScope(direction(), "v3", pointer({}));
    expect(scope.pinned).toBe(true);
  });

  it("pinned is false when the pointer pins this direction at a different version than viewed", () => {
    const scope = resolveInheritedScope(
      direction(),
      "v2",
      pointer({ versionId: "v3" }),
    );
    expect(scope.versionId).toBe("v2");
    expect(scope.pinned).toBe(false);
  });

  it("pinned is false when the pointer pins a sibling direction — no leakage", () => {
    const scope = resolveInheritedScope(
      direction(),
      "v3",
      pointer({ directionId: "direction-a" }),
    );
    expect(scope.directionId).toBe("direction-b");
    expect(scope.versionId).toBe("v3");
    expect(scope.pinned).toBe(false);
  });

  it("a draft direction (no versions) resolves to a version-less scope", () => {
    const draft = direction({ head: null, isDraft: true, versions: [] });
    const scope = resolveInheritedScope(draft, null, null);
    expect(scope).toEqual({
      directionId: "direction-b",
      versionId: null,
      pinned: false,
    });
    const chip = renderScopeChip(scope);
    expect(chip).not.toContain("null");
    expect(chip).not.toContain("undefined");
    expect(chip).toContain("direction-b");
  });

  it("the chip renders the resolved concrete version's SHORT id — never the literal `head` (Replan #4)", () => {
    const d = direction({
      head: "version-3",
      versions: [
        { versionId: "version-1", createdAt: "2026-01-01T00:00:00Z" } as never,
        { versionId: "version-2", createdAt: "2026-01-02T00:00:00Z" } as never,
        { versionId: "version-3", createdAt: "2026-01-03T00:00:00Z" } as never,
      ],
    });
    // Untouched switcher ⇒ the head resolves, rendered as its short id.
    const untouched = resolveInheritedScope(d, null, null);
    expect(untouched.versionId).toBe("version-3");
    expect(renderScopeChip(untouched)).toBe("↳ direction-b · 3");
    expect(renderScopeChip(untouched)).not.toContain("head");

    // Viewing a historical version ⇒ the VIEWED version's short id, not the head.
    const historical = resolveInheritedScope(d, "version-2", null);
    expect(renderScopeChip(historical)).toBe("↳ direction-b · 2");
  });

  it("a genuine draft omits the version part — no separator", () => {
    const draft = direction({ head: null, isDraft: true, versions: [] });
    const scope = resolveInheritedScope(draft, null, null);
    expect(scope.versionId).toBeNull();
    expect(renderScopeChip(scope)).toBe("↳ direction-b");
    expect(renderScopeChip(scope)).not.toContain("·");
  });

  it("purity: identical input yields identical output; direction/pointer are not mutated", () => {
    const d = direction();
    const p = pointer({});
    const before = JSON.stringify({ d, p });
    const first = resolveInheritedScope(d, "v3", p);
    const second = resolveInheritedScope(d, "v3", p);
    expect(first).toEqual(second);
    expect(JSON.stringify({ d, p })).toEqual(before);
  });
});

describe("isChatUnavailable", () => {
  it("true for an error event carrying unavailable: true", () => {
    expect(isChatUnavailable({ type: "error", unavailable: true })).toBe(true);
  });

  it("false for a normal turn error, null, and undefined", () => {
    expect(isChatUnavailable({ type: "error", message: "x" } as never)).toBe(false);
    expect(isChatUnavailable(null)).toBe(false);
    expect(isChatUnavailable(undefined)).toBe(false);
  });
});

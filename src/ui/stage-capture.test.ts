import { describe, it, expect } from "vitest";
import {
  MIN_DRAG_PX,
  dataUrlToBlob,
  STAGE_MODES,
  formatCropSize,
  isCaptureMode,
  isRealDrag,
  normalizeDrag,
  stageHint,
  stageModeLabel,
  type StageMode,
} from "./stage-capture.js";

describe("STAGE_MODES", () => {
  it("renders select first so the stage defaults to the non-destructive mode", () => {
    expect(STAGE_MODES[0]).toBe("select");
  });

  it("is exactly the three stage modes", () => {
    expect([...STAGE_MODES]).toEqual(["select", "crop", "eyedropper"]);
  });
});

describe("stageModeLabel", () => {
  it("labels every mode with a short, distinct button label", () => {
    const labels = STAGE_MODES.map(stageModeLabel);
    expect(labels).toEqual(["Select", "Crop", "Eyedrop"]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("stageHint", () => {
  it("gives each mode its own instruction", () => {
    const hints = STAGE_MODES.map(stageHint);
    expect(new Set(hints).size).toBe(hints.length);
  });

  it("tells the user where a crop goes, since that is the non-obvious part", () => {
    expect(stageHint("crop")).toContain("chat composer");
  });

  it("never returns an empty hint", () => {
    for (const mode of STAGE_MODES) expect(stageHint(mode).length).toBeGreaterThan(0);
  });
});

describe("isCaptureMode", () => {
  it("is true for crop and eyedropper (the lightbox must be suppressed)", () => {
    expect(isCaptureMode("crop")).toBe(true);
    expect(isCaptureMode("eyedropper")).toBe(true);
  });

  it("is false for select, so the staged image stays a lightbox target", () => {
    expect(isCaptureMode("select")).toBe(false);
  });
});

describe("normalizeDrag", () => {
  it("returns the dragged box when dragging down and right", () => {
    expect(normalizeDrag({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });

  it("normalizes a drag up and to the LEFT to the same rect", () => {
    const downRight = normalizeDrag({ x: 10, y: 20 }, { x: 40, y: 60 });
    const upLeft = normalizeDrag({ x: 40, y: 60 }, { x: 10, y: 20 });
    expect(upLeft).toEqual(downRight);
  });

  it("normalizes the two mixed diagonals identically", () => {
    expect(normalizeDrag({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });

  it("never emits a negative width or height", () => {
    const r = normalizeDrag({ x: 100, y: 100 }, { x: 0, y: 0 });
    expect(r.width).toBeGreaterThanOrEqual(0);
    expect(r.height).toBeGreaterThanOrEqual(0);
  });

  it("yields a zero-area rect for a click (no movement)", () => {
    expect(normalizeDrag({ x: 7, y: 9 }, { x: 7, y: 9 })).toEqual({
      x: 7,
      y: 9,
      width: 0,
      height: 0,
    });
  });
});

describe("isRealDrag", () => {
  it("rejects null (nothing dragged)", () => {
    expect(isRealDrag(null)).toBe(false);
  });

  it("rejects a stray click, so crop mode never captures a degenerate region", () => {
    expect(isRealDrag({ x: 5, y: 5, width: 0, height: 0 })).toBe(false);
  });

  it("rejects a drag that clears the threshold on only one axis", () => {
    expect(isRealDrag({ x: 0, y: 0, width: 40, height: 1 })).toBe(false);
    expect(isRealDrag({ x: 0, y: 0, width: 1, height: 40 })).toBe(false);
  });

  it("accepts a drag exactly at the threshold on both axes", () => {
    expect(isRealDrag({ x: 0, y: 0, width: MIN_DRAG_PX, height: MIN_DRAG_PX })).toBe(true);
  });

  it("honors a caller-supplied threshold", () => {
    const sel = { x: 0, y: 0, width: 10, height: 10 };
    expect(isRealDrag(sel, 20)).toBe(false);
    expect(isRealDrag(sel, 10)).toBe(true);
  });
});

describe("formatCropSize", () => {
  it("formats whole pixels as W×H", () => {
    expect(formatCropSize({ x: 0, y: 0, width: 212, height: 168 })).toBe("212×168");
  });

  it("rounds fractional CSS-px extents", () => {
    expect(formatCropSize({ x: 0, y: 0, width: 211.6, height: 167.4 })).toBe("212×167");
  });

  it("uses the multiplication sign, not the letter x", () => {
    expect(formatCropSize({ x: 0, y: 0, width: 2, height: 2 })).toBe("2×2");
  });
});

describe("mode exhaustiveness", () => {
  it("every StageMode has a label, a hint, and a capture verdict", () => {
    const modes: StageMode[] = ["select", "crop", "eyedropper"];
    for (const mode of modes) {
      expect(typeof stageModeLabel(mode)).toBe("string");
      expect(typeof stageHint(mode)).toBe("string");
      expect(typeof isCaptureMode(mode)).toBe("boolean");
    }
  });
});

describe("dataUrlToBlob", () => {
  it("decodes a base64 data URL into a Blob with its bytes and type", async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
    const b64 = Buffer.from(bytes).toString("base64");
    const blob = dataUrlToBlob(`data:image/png;base64,${b64}`);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe("image/png");
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual(bytes);
  });

  it("returns null for anything that is not a base64 data URL", () => {
    expect(dataUrlToBlob("data:image/png,plain")).toBeNull();
    expect(dataUrlToBlob("https://example.com/a.png")).toBeNull();
  });
});

/**
 * Pure-math coverage for the studio crop / eyedropper overlay. No DOM, no
 * `<canvas>` — just the rect→natural-pixel mapping across CSS-scaled / retina
 * cases and the ImageData pixel→hex conversion.
 */
import { describe, it, expect } from "vitest";
import { toNaturalCrop, pixelToHex } from "./crop-math.js";

describe("toNaturalCrop", () => {
  it("is identity at a 1:1 display scale", () => {
    expect(
      toNaturalCrop(
        { x: 10, y: 20, width: 30, height: 40 },
        { clientWidth: 100, clientHeight: 100, naturalWidth: 100, naturalHeight: 100 },
      ),
    ).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("scales up a 2× intrinsic image shown at half size (retina)", () => {
    expect(
      toNaturalCrop(
        { x: 10, y: 10, width: 20, height: 20 },
        { clientWidth: 100, clientHeight: 100, naturalWidth: 200, naturalHeight: 200 },
      ),
    ).toEqual({ x: 20, y: 20, width: 40, height: 40 });
  });

  it("rounds fractional scale factors to integers and stays in bounds", () => {
    const r = toNaturalCrop(
      { x: 33, y: 33, width: 33, height: 33 },
      { clientWidth: 100, clientHeight: 100, naturalWidth: 150, naturalHeight: 150 },
    );
    expect(Number.isInteger(r.x)).toBe(true);
    expect(Number.isInteger(r.y)).toBe(true);
    expect(Number.isInteger(r.width)).toBe(true);
    expect(Number.isInteger(r.height)).toBe(true);
    expect(r.x + r.width).toBeLessThanOrEqual(150);
    expect(r.y + r.height).toBeLessThanOrEqual(150);
  });

  it("clamps a selection that runs past the image edge", () => {
    const r = toNaturalCrop(
      { x: 80, y: 80, width: 50, height: 50 },
      { clientWidth: 100, clientHeight: 100, naturalWidth: 100, naturalHeight: 100 },
    );
    expect(r.x + r.width).toBeLessThanOrEqual(100);
    expect(r.y + r.height).toBeLessThanOrEqual(100);
  });

  it("yields a >=1×1 rect for a zero-area (click) selection", () => {
    const r = toNaturalCrop(
      { x: 40, y: 40, width: 0, height: 0 },
      { clientWidth: 100, clientHeight: 100, naturalWidth: 100, naturalHeight: 100 },
    );
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });

  it("clamps negative origins to 0", () => {
    const r = toNaturalCrop(
      { x: -20, y: -20, width: 10, height: 10 },
      { clientWidth: 100, clientHeight: 100, naturalWidth: 100, naturalHeight: 100 },
    );
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});

describe("pixelToHex", () => {
  const buf = new Uint8ClampedArray([255, 0, 0, 255, 0, 128, 255, 255]); // width 2

  it("reads the first pixel as #ff0000", () => {
    expect(pixelToHex(buf, 2, 0, 0)).toBe("#ff0000");
  });

  it("reads the second pixel as #0080ff", () => {
    expect(pixelToHex(buf, 2, 1, 0)).toBe("#0080ff");
  });

  it("always returns a lower-case, 7-char hex string", () => {
    const hex = pixelToHex(buf, 2, 1, 0);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hex).toHaveLength(7);
  });
});

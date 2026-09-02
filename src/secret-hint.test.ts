import { describe, it, expect } from "vitest";
import { maskSecret } from "./secret-hint.js";

describe("maskSecret", () => {
  it("masks a long secret to a prefix + last 4 chars", () => {
    expect(maskSecret("sk-proj-1234567890B3k9")).toBe("sk-…B3k9");
  });

  it("fully masks a short secret with bullets, revealing no original chars", () => {
    const masked = maskSecret("short");
    expect(masked).toBe("•••••");
    expect(masked.length).toBe("short".length);
    for (const ch of "short") {
      expect(masked).not.toContain(ch);
    }
  });

  it("returns (none) for an empty secret", () => {
    expect(maskSecret("")).toBe("(none)");
  });
});

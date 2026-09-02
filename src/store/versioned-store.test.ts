import { describe, it, expect } from "vitest";
import { VersionConflictError } from "./versioned-store.js";
import { CommandError } from "../errors.js";

describe("VersionConflictError", () => {
  it("carries version metadata, a 1 exit code, and a descriptive message", () => {
    const err = new VersionConflictError("brand/brand.yaml", 1, 2);

    expect(err).toBeInstanceOf(CommandError);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err.name).toBe("VersionConflictError");
    expect(err.expectedVersion).toBe(1);
    expect(err.actualVersion).toBe(2);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain("brand/brand.yaml");
    expect(err.message).toContain("1");
    expect(err.message).toContain("2");
  });
});

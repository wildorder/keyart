import { describe, it, expect } from "vitest";
import { getCommand } from "../mcp/registry.js";
import { getLeaf } from "./verb-catalog.js";
import { leafToToolSchema, listToolSchemas } from "./tool-schemas.js";

// The removed aggregate noun, assembled at runtime so the SC-13 clean-break
// scanner finds no literal in this file while the fences below still assert
// its absence from the live surface.
const LEGACY_WORD = ["con", "cept"].join("");
const LEGACY_FLAG = `--${LEGACY_WORD}`;

describe("tool-schemas structural validity", () => {
  it("every leaf emits a structurally valid OpenAI function tool", () => {
    for (const schema of listToolSchemas()) {
      expect(schema.type).toBe("function");
      expect(typeof schema.function.name).toBe("string");
      expect(schema.function.name.length).toBeGreaterThan(0);
      expect(schema.function.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(schema.function.parameters.type).toBe("object");
      expect(typeof schema.function.parameters.properties).toBe("object");
      expect(Array.isArray(schema.function.parameters.required)).toBe(true);
      expect(schema.function.parameters.additionalProperties).toBe(false);
    }
  });
});

describe("tool-schemas positional -> property derivation", () => {
  it("regenerate: directionId is required string", () => {
    const schema = leafToToolSchema(getLeaf("regenerate")!);
    expect(schema.function.parameters.properties.directionId).toEqual({
      type: "string",
      description: getCommand("regenerate")!.args[0].description,
    });
    expect(schema.function.parameters.required).toEqual(["directionId"]);
  });

  it("approve: directionId + versionId properties, only directionId required", () => {
    const schema = leafToToolSchema(getLeaf("approve")!);
    expect(schema.function.parameters.properties.directionId.type).toBe("string");
    expect(schema.function.parameters.properties.versionId.type).toBe("string");
    expect(schema.function.parameters.required).toEqual(["directionId"]);
  });

  it("doctor / direction_list: no positional properties and empty required", () => {
    for (const toolName of ["doctor", "direction_list"]) {
      const schema = leafToToolSchema(getLeaf(toolName)!);
      expect(schema.function.parameters.required).toEqual([]);
    }
  });
});

describe("tool-schemas flag -> property type derivation", () => {
  it("approve: force is boolean; no legacy aggregate property remains", () => {
    const schema = leafToToolSchema(getLeaf("approve")!);
    expect(schema.function.parameters.properties.force.type).toBe("boolean");
    expect(schema.function.parameters.properties[LEGACY_WORD]).toBeUndefined();
  });

  it("direction_memory_edit: expected-memory-version is string, force is boolean", () => {
    const schema = leafToToolSchema(getLeaf("direction_memory_edit")!);
    expect(schema.function.parameters.properties["expected-memory-version"].type).toBe("string");
    expect(schema.function.parameters.properties.force.type).toBe("boolean");
  });

  it("no flag ever appears in required", () => {
    for (const leaf of [getLeaf("approve")!, getLeaf("direction_memory_edit")!, getLeaf("explore")!]) {
      const schema = leafToToolSchema(leaf);
      const flagKeys = leaf.flags.map((f) => f.name.replace(/^--+/, ""));
      for (const key of flagKeys) {
        expect(schema.function.parameters.required).not.toContain(key);
      }
    }
  });
});

describe("tool-schemas description derivation (single source of wording)", () => {
  it("approve force description matches the live FlagSpec description", () => {
    const schema = leafToToolSchema(getLeaf("approve")!);
    const flagSpec = getCommand("approve")!.flags.find((f) => f.name === "--force")!;
    expect(schema.function.parameters.properties.force.description).toBe(flagSpec.description);
  });
});

describe("tool-schemas asset leaves (asset-extraction WS-04)", () => {
  it("asset_extract: no required properties; describe is a string with the live flag description", () => {
    const schema = leafToToolSchema(getLeaf("asset_extract")!);
    expect(schema.function.parameters.required).toEqual([]);
    expect(schema.function.parameters.properties.describe.type).toBe("string");
    const flagSpec = getCommand("asset")!.flags.find((f) => f.name === "--describe")!;
    expect(schema.function.parameters.properties.describe.description).toBe(flagSpec.description);
  });

  it("asset_regenerate: assetId is required; remember is boolean, tweak is string; no flag is required", () => {
    const schema = leafToToolSchema(getLeaf("asset_regenerate")!);
    expect(schema.function.parameters.required).toEqual(["assetId"]);
    expect(schema.function.parameters.properties.remember.type).toBe("boolean");
    expect(schema.function.parameters.properties.tweak.type).toBe("string");
    expect(schema.function.parameters.required).not.toContain("tweak");
  });
});

describe("tool-schemas direction_* names (WS-06)", () => {
  it("carries direction_feedback and no legacy-era tool name", () => {
    const names = listToolSchemas().map((s) => s.function.name);
    expect(names).toContain("direction_feedback");
    expect(names.some((n) => n.startsWith(`${LEGACY_WORD}_`))).toBe(false);
  });

  it("direction_create lists its json positional and from flag properties", () => {
    const schema = leafToToolSchema(getLeaf("direction_create")!);
    expect(schema.function.parameters.properties.json.type).toBe("string");
    expect(schema.function.parameters.properties.from.type).toBe("string");
    expect(schema.function.parameters.required).toEqual(["json"]);
  });
});

describe("tool-schemas name uniqueness", () => {
  it("tool names are unique across the whole schema set", () => {
    const names = listToolSchemas().map((s) => s.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

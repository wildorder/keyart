import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { defineKeyartConfig } from "./index.js";
import {
  loadConfig,
  directionsRoot,
  globalBrandPath,
  surfaceManifestPath,
  storeDriver,
  KeyartConfigSchema,
} from "./config.js";
import { DEFAULT_MODELS } from "./types.js";
import type { KeyartConfig } from "./types.js";

describe("defineKeyartConfig", () => {
  it("preserves literal types and returns the same object reference", () => {
    const config = defineKeyartConfig({
      project: { name: "Test", type: "prototype", framework: "next" },
      brand: {
        root: "./brand",
        references: "./brand/input/references",
        approved: "./brand/approved",
        rejected: "./brand/rejected",
      },
      models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
      outputs: {
        cursorRules: ".cursor/rules/keyart-brand.mdc",
        cssVars: "brand/generated/brand.css",
        implementationBrief: "brand/generated/implementation-brief.md",
      },
    });

    expect(config.project.name).toBe("Test");
    const input = {
      project: { name: "X", type: "y", framework: "z" },
      brand: {
        root: "a",
        references: "c",
        approved: "d",
        rejected: "e",
      },
      models: { text: "t", vision: "v", image: "i" },
      outputs: { cursorRules: "a", cssVars: "b", implementationBrief: "c" },
    };
    expect(defineKeyartConfig(input)).toBe(input);
  });
});

describe("loadConfig", () => {
  it("rejects with message containing 'keyart init' when config is missing", async () => {
    await expect(loadConfig("/nonexistent/path")).rejects.toThrow(
      "keyart init",
    );
  });

  it("does not report a missing config when the file exists but import fails", async () => {
    const tmpDir = path.join(
      import.meta.dirname,
      "../.tmp-config-load-test",
    );
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "keyart.config.ts"),
      "throw new Error('import failed');\n",
      "utf-8",
    );

    await expect(loadConfig(tmpDir)).rejects.toThrow("Failed to load");
    await expect(loadConfig(tmpDir)).rejects.not.toThrow("keyart init");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

async function withTmpConfig<R>(
  contents: string,
  fn: (tmpDir: string) => Promise<R>,
): Promise<R> {
  // Created INSIDE the project tree so Node can import the .ts config
  // (type-stripping resolves relative to this package, like the existing tests).
  const tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname, "..", ".tmp-config-"),
  );
  try {
    await fs.writeFile(
      path.join(tmpDir, "keyart.config.ts"),
      contents,
      "utf-8",
    );
    return await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const BASE_CONFIG = `export default {
  project: { name: "P", type: "prototype", framework: "next" },
  brand: {
    root: "./brand",
    references: "./brand/input/references",
    approved: "./brand/approved",
    rejected: "./brand/rejected",
  },
  models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
  outputs: {
    cursorRules: ".cursor/rules/keyart-brand.mdc",
    cssVars: "brand/generated/brand.css",
    implementationBrief: "brand/generated/implementation-brief.md",
  },
};
`;

describe("loadConfig — backward compatibility", () => {
  it("loads a config without directions/global/store and defaults them", async () => {
    await withTmpConfig(BASE_CONFIG, async (tmpDir) => {
      const config = await loadConfig(tmpDir);
      expect(config.models).toEqual(DEFAULT_MODELS);
      expect(storeDriver(config)).toBe("file");
      expect(directionsRoot(tmpDir, config).endsWith(path.join("brand", "directions"))).toBe(
        true,
      );
      expect(
        globalBrandPath(tmpDir, config).endsWith(path.join("brand", "brand.yaml")),
      ).toBe(true);
      expect(
        surfaceManifestPath(tmpDir, config).endsWith(
          path.join("brand", "surface.yaml"),
        ),
      ).toBe(true);
      expect(config.scan).toBeUndefined();
    });
  });

  it("rejects a config missing required fields", async () => {
    const bad = `export default { models: {} };\n`;
    await withTmpConfig(bad, async (tmpDir) => {
      await expect(loadConfig(tmpDir)).rejects.toThrow(
        "Invalid keyart.config.ts",
      );
    });
  });

  it("rejects a config with an unknown store driver", async () => {
    const bad = BASE_CONFIG.replace(
      "};\n",
      '  store: { driver: "mongo" },\n};\n',
    );
    await withTmpConfig(bad, async (tmpDir) => {
      await expect(loadConfig(tmpDir)).rejects.toThrow(
        "Invalid keyart.config.ts",
      );
    });
  });

  it("accepts models.baseURL and carries it through the defaults merge", async () => {
    const withBaseURL = BASE_CONFIG.replace(
      'models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },',
      'models: { baseURL: "https://openrouter.ai/api/v1" },',
    );
    await withTmpConfig(withBaseURL, async (tmpDir) => {
      const config = await loadConfig(tmpDir);
      expect(config.models.baseURL).toBe("https://openrouter.ai/api/v1");
      expect(config.models.text).toBe("gpt-5.5"); // defaults still merge
    });
  });

  it("rejects a non-URL models.baseURL with the standard teaching prefix", async () => {
    const bad = BASE_CONFIG.replace(
      'models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },',
      'models: { baseURL: "not-a-url" },',
    );
    await withTmpConfig(bad, async (tmpDir) => {
      await expect(loadConfig(tmpDir)).rejects.toThrow(
        "Invalid keyart.config.ts",
      );
    });
  });

  it("round-trips a full `scan` block verbatim", async () => {
    const withScan = BASE_CONFIG.replace(
      "};\n",
      `  scan: {
    waitFor: "main",
    dismiss: [".modal__close", ".cookie-accept"],
    storage: { "ls-visited": "1", "ls-consent": "yes" },
    cookies: [
      { name: "seen", value: "yes", domain: "example.com" },
      { name: "session", value: "abc" },
    ],
    ignore: [".ads"],
    contentOrigins: ["cdn.example.com"],
  },
};\n`,
    );
    await withTmpConfig(withScan, async (tmpDir) => {
      const config = await loadConfig(tmpDir);
      expect(config.scan).toEqual({
        waitFor: "main",
        dismiss: [".modal__close", ".cookie-accept"],
        storage: { "ls-visited": "1", "ls-consent": "yes" },
        cookies: [
          { name: "seen", value: "yes", domain: "example.com" },
          { name: "session", value: "abc" },
        ],
        ignore: [".ads"],
        contentOrigins: ["cdn.example.com"],
      });
    });
  });

  it("rejects a malformed `scan` block with the standard teaching prefix", async () => {
    const bad = BASE_CONFIG.replace(
      "};\n",
      '  scan: { dismiss: "not-an-array" },\n};\n',
    );
    await withTmpConfig(bad, async (tmpDir) => {
      await expect(loadConfig(tmpDir)).rejects.toThrow(
        "Invalid keyart.config.ts",
      );
      await expect(loadConfig(tmpDir)).rejects.toThrow(/scan\.dismiss/);
    });
  });

  it("honors configured directions/global/store paths", () => {
    const config: KeyartConfig = {
      project: { name: "P", type: "prototype", framework: "next" },
      brand: {
        root: "./brand",
        references: "r",
        approved: "a",
        rejected: "x",
        directions: "./b/c",
        global: "./b/g.yaml",
      },
      models: { text: "t", vision: "v", image: "i" },
      outputs: { cursorRules: "a", cssVars: "b", implementationBrief: "c" },
      store: { driver: "file" },
    };
    expect(storeDriver(config)).toBe("file");
    expect(directionsRoot("/root", config)).toBe(path.resolve("/root", "./b/c"));
    expect(globalBrandPath("/root", config)).toBe(
      path.resolve("/root", "./b/g.yaml"),
    );
  });
});

describe("Test 13: directionsRoot — default, override, and the legacy-key clean break", () => {
  const baseBrand = {
    root: "brand",
    references: "brand/references",
    approved: "brand/approved",
    rejected: "brand/rejected",
  };
  const rest = {
    project: { name: "P", type: "prototype", framework: "next" },
    models: { text: "t", vision: "v", image: "i" },
    outputs: { cursorRules: "a", cssVars: "b", implementationBrief: "c" },
    store: { driver: "file" as const },
  };

  it("defaults to <cwd>/<brand.root>/directions when brand.directions is absent", () => {
    const config: KeyartConfig = { ...rest, brand: { ...baseBrand } };
    expect(directionsRoot("/cwd", config)).toBe(path.resolve("/cwd", "brand", "directions"));
  });

  it("resolves an override: brand.directions: 'custom/dirs' -> <cwd>/custom/dirs", () => {
    const config: KeyartConfig = { ...rest, brand: { ...baseBrand, directions: "custom/dirs" } };
    expect(directionsRoot("/cwd", config)).toBe(path.resolve("/cwd", "custom/dirs"));
  });

  it("an unknown brand key parses successfully and the parsed value does not retain it", () => {
    const parsed = KeyartConfigSchema.parse({
      ...rest,
      brand: { ...baseBrand, obsoleteKey: "obsolete/root" },
    });
    expect("obsoleteKey" in parsed.brand).toBe(false);
  });
});

describe("surfaceManifestPath", () => {
  const baseBrand = {
    root: "./brand",
    references: "r",
    approved: "a",
    rejected: "x",
  };
  const rest = {
    project: { name: "P", type: "prototype", framework: "next" },
    models: { text: "t", vision: "v", image: "i" },
    outputs: { cursorRules: "a", cssVars: "b", implementationBrief: "c" },
    store: { driver: "file" as const },
  };

  it("defaults to <brand.root>/surface.yaml when brand.surface is absent", () => {
    const config: KeyartConfig = { ...rest, brand: { ...baseBrand } };
    expect(surfaceManifestPath("/root", config)).toBe(
      path.resolve("/root", "./brand/surface.yaml"),
    );
  });

  it("resolves a relative brand.surface override against cwd", () => {
    const config: KeyartConfig = {
      ...rest,
      brand: { ...baseBrand, surface: "custom/demand.yaml" },
    };
    expect(surfaceManifestPath("/root", config)).toBe(
      path.resolve("/root", "custom/demand.yaml"),
    );
  });

  it("resolves an absolute brand.surface override as-is", () => {
    const absolute = path.resolve("/abs/demand.yaml");
    const config: KeyartConfig = {
      ...rest,
      brand: { ...baseBrand, surface: absolute },
    };
    expect(surfaceManifestPath("/root", config)).toBe(absolute);
  });
});

describe("KeyartConfigSchema", () => {
  it("parses a minimal config and defaults the store block", () => {
    const parsed = KeyartConfigSchema.parse({
      project: { name: "P", type: "prototype", framework: "next" },
      brand: {
        root: "./brand",
        references: "r",
        approved: "a",
        rejected: "x",
      },
      outputs: { cursorRules: "a", cssVars: "b", implementationBrief: "c" },
    });
    expect(parsed.store).toEqual({ driver: "file" });
  });

  it("rejects an object missing project", () => {
    const result = KeyartConfigSchema.safeParse({
      brand: {
        root: "./brand",
        references: "r",
        approved: "a",
        rejected: "x",
      },
      outputs: { cursorRules: "a", cssVars: "b", implementationBrief: "c" },
    });
    expect(result.success).toBe(false);
  });
});

describe("DEFAULT_MODELS", () => {
  it("has text, vision, and image defaults", () => {
    expect(DEFAULT_MODELS.text).toBe("gpt-5.5");
    expect(DEFAULT_MODELS.vision).toBe("gpt-5.5");
    expect(DEFAULT_MODELS.image).toBe("gpt-image-2");
  });

  it("partial models config merges with defaults", () => {
    // Simulate what loadConfig does during merge
    const partialModels: Record<string, string> = { text: "gpt-4o" };
    const merged = { ...DEFAULT_MODELS, ...partialModels };
    expect(merged.text).toBe("gpt-4o");
    expect(merged.vision).toBe("gpt-5.5");
    expect(merged.image).toBe("gpt-image-2");
  });

  it("empty models config keeps all defaults", () => {
    const merged = { ...DEFAULT_MODELS };
    expect(merged.text).toBe("gpt-5.5");
    expect(merged.vision).toBe("gpt-5.5");
    expect(merged.image).toBe("gpt-image-2");
  });
});

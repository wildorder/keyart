import { describe, it, expect } from "vitest";
import { KeyartConfigSchema } from "../config.js";
import {
  buildConfigObject,
  renderConfig,
  renderConfigFromObject,
  defaultAnswers,
  type WizardAnswers,
} from "./config-template.js";
import type { KeyartConfig } from "../types.js";

describe("config-template", () => {
  it("buildConfigObject is schema-valid and carries the project fields", () => {
    const obj = buildConfigObject({
      projectName: "Acme",
      projectType: "prototype",
      framework: "vite",
    });
    const parsed = KeyartConfigSchema.parse(obj);
    expect(parsed.project.name).toBe("Acme");
    expect(parsed.project.framework).toBe("vite");
  });

  it("renderConfig produces populated config text without the API key", () => {
    const answers: WizardAnswers = {
      projectName: "Acme",
      projectType: "prototype",
      framework: "vite",
      openaiApiKey: "sk-test-secret-key",
    };
    const text = renderConfig(answers);
    expect(text).toContain(
      'import { defineKeyartConfig } from "@wildorder/keyart";',
    );
    expect(text).toContain('"Acme"');
    expect(text).toContain('framework: "vite"');
    expect(text).not.toContain("OPENAI_API_KEY");
    expect(text).not.toContain("sk-test-secret-key");
  });

  it("renderConfig(defaultAnswers) uses the shipped defaults", () => {
    const text = renderConfig(defaultAnswers);
    expect(text).toContain('name: "My Project"');
    expect(text).toContain('framework: "next"');
  });

  it("renderConfigFromObject round-trips a full config and preserves custom fields", () => {
    const config: KeyartConfig = {
      project: { name: "Acme", type: "app", framework: "vite" },
      brand: {
        root: "./design",
        references: "./design/refs",
        approved: "./design/approved",
        rejected: "./design/rejected",
        directions: "./design/dirs",
      },
      models: { text: "gpt-x", vision: "gpt-y", image: "img-z" },
      outputs: {
        cursorRules: ".cursor/rules/custom.mdc",
        cssVars: "design/brand.css",
        implementationBrief: "design/impl.md",
      },
      store: { driver: "file" },
    };
    const text = renderConfigFromObject(config);
    // Custom brand root + outputs survive (not the shipped constants).
    expect(text).toContain('root: "./design"');
    expect(text).toContain('cursorRules: ".cursor/rules/custom.mdc"');
    expect(text).toContain('text: "gpt-x"');
    // Optional brand fields present are emitted; absent ones (silos/global) are not.
    expect(text).toContain('directions: "./design/dirs"');
    expect(text).not.toContain("silos:");
    expect(text).not.toContain("global:");
    expect(text).toContain('store: { driver: "file" }');
    expect(text).toContain(
      'import { defineKeyartConfig } from "@wildorder/keyart";',
    );
    // Never leaks a key.
    expect(text).not.toContain("OPENAI_API_KEY");
  });
});

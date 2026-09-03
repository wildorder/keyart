import type { KeyartConfig } from "../types.js";

export interface WizardAnswers {
  projectName: string;
  projectType: string; // e.g. "prototype"
  framework: string; // e.g. "next"
  openaiApiKey?: string; // collected but NEVER rendered into the config text
}

export const FRAMEWORK_CHOICES = [
  "next",
  "vite",
  "remix",
  "astro",
  "other",
] as const;

export const defaultAnswers: WizardAnswers = {
  projectName: "My Project",
  projectType: "prototype",
  framework: "next",
};

/**
 * The fixed (non-project) blocks of `templates/keyart.config.ts`. Kept as
 * module constants so {@link buildConfigObject} and {@link renderConfig} share a
 * single source and the rendered text stays byte-aligned with the template.
 */
const BRAND = {
  root: "./brand",
  references: "./brand/input/references",
  approved: "./brand/approved",
  rejected: "./brand/rejected",
  directions: "./brand/directions",
  global: "./brand/brand.yaml",
} as const;

const MODELS = {
  text: "gpt-5.5",
  vision: "gpt-5.5",
  image: "gpt-image-2",
} as const;

const OUTPUTS = {
  cursorRules: ".cursor/rules/keyart-brand.mdc",
  cssVars: "brand/generated/brand.css",
  implementationBrief: "brand/generated/implementation-brief.md",
} as const;

const STORE = { driver: "file" } as const;

/**
 * Build the config OBJECT (schema-valid; mirrors templates/keyart.config.ts,
 * substituting the project fields). Used for schema validation and as the single
 * source the string renderer serializes. Never includes the API key.
 */
export function buildConfigObject(answers: WizardAnswers): KeyartConfig {
  return {
    project: {
      name: answers.projectName,
      type: answers.projectType,
      framework: answers.framework,
    },
    brand: { ...BRAND },
    models: { ...MODELS },
    outputs: { ...OUTPUTS },
    store: { ...STORE },
  };
}

/** Serialize a string value as a double-quoted, escaped TS string literal. */
function q(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the populated keyart.config.ts TEXT: imports defineKeyartConfig
 * from "@wildorder/keyart" and calls it with the object from buildConfigObject. The
 * byte-shape matches templates/keyart.config.ts aside from the project block.
 * MUST NOT contain the API key or the string `OPENAI_API_KEY`.
 */
export function renderConfig(answers: WizardAnswers): string {
  return renderConfigFromObject(buildConfigObject(answers));
}

/**
 * Serialize an ARBITRARY (already schema-valid) {@link KeyartConfig} back to
 * `keyart.config.ts` text, preserving every field it carries. Unlike
 * {@link renderConfig} (which always emits the shipped brand/output/store
 * constants), this round-trips a loaded config so callers that only change a
 * subset — e.g. the studio Settings page editing `project` + `models` — never
 * clobber a user's custom `brand`/`outputs`/`store` paths. Optional brand fields
 * (`directions`/`global`) and `store` are emitted only when present.
 * MUST NOT contain the API key or the string `OPENAI_API_KEY` (config never has).
 */
export function renderConfigFromObject(config: KeyartConfig): string {
  const { project, brand, models, outputs, store } = config;

  const brandLines = [
    `    root: ${q(brand.root)},`,
    `    references: ${q(brand.references)},`,
    `    approved: ${q(brand.approved)},`,
    `    rejected: ${q(brand.rejected)},`,
  ];
  if (brand.directions !== undefined)
    brandLines.push(`    directions: ${q(brand.directions)},`);
  if (brand.global !== undefined)
    brandLines.push(`    global: ${q(brand.global)},`);

  const storeLine =
    store !== undefined ? `\n  store: { driver: ${q(store.driver)} },` : "";

  return `import { defineKeyartConfig } from "@wildorder/keyart";

export default defineKeyartConfig({
  project: { name: ${q(project.name)}, type: ${q(project.type)}, framework: ${q(
    project.framework,
  )} },
  brand: {
${brandLines.join("\n")}
  },
  models: { text: ${q(models.text)}, vision: ${q(models.vision)}, image: ${q(
    models.image,
  )}${models.baseURL !== undefined ? `, baseURL: ${q(models.baseURL)}` : ""} },
  outputs: {
    cursorRules: ${q(outputs.cursorRules)},
    cssVars: ${q(outputs.cssVars)},
    implementationBrief: ${q(outputs.implementationBrief)},
  },${storeLine}
});
`;
}

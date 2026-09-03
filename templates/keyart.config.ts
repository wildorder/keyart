import { defineKeyartConfig } from "@wildorder/keyart";

export default defineKeyartConfig({
  project: { name: "My Project", type: "prototype", framework: "next" },
  brand: {
    root: "./brand",
    references: "./brand/input/references",
    approved: "./brand/approved",
    rejected: "./brand/rejected",
    concepts: "./brand/concepts",
    global: "./brand/brand.yaml",
  },
  models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
  outputs: {
    cursorRules: ".cursor/rules/keyart-brand.mdc",
    cssVars: "brand/generated/brand.css",
    implementationBrief: "brand/generated/implementation-brief.md",
  },
  store: { driver: "file" },
});

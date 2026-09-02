import type { VerbLeaf } from "./verb-catalog.js";
import { listLeaves } from "./verb-catalog.js";

export interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: "string" | "boolean"; description: string }>;
      required: string[];
      additionalProperties: false;
    };
  };
}

/**
 * Pure catalog → OpenAI function-tool schema. Positionals become named string
 * properties (`required` from `ArgSpec.required` ONLY — flags are never
 * required; per-verb flag obligations are enforced by the existing
 * `runDirection`/`dispatchCommand` layer, not the schema). Flags become a
 * string property when `takesValue`, boolean otherwise.
 */
export function leafToToolSchema(leaf: VerbLeaf): OpenAIFunctionTool {
  const properties: Record<string, { type: "string" | "boolean"; description: string }> = {};
  const required: string[] = [];

  for (const p of leaf.positionals) {
    properties[p.name] = { type: "string", description: p.description };
    if (p.required) required.push(p.name);
  }

  for (const f of leaf.flags) {
    const key = f.name.replace(/^--+/, "");
    properties[key] = { type: f.takesValue ? "string" : "boolean", description: f.description };
  }

  return {
    type: "function",
    function: {
      name: leaf.toolName,
      description: leaf.description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

export function listToolSchemas(): OpenAIFunctionTool[] {
  return listLeaves().map(leafToToolSchema);
}

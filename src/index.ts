export type {
  CopyExamples,
  Direction,
  DirectionVersion,
  DirectionContent,
  DirectionCharacter,
  DirectionUsage,
  AuthoredDirectionContent,
  KeyartConfig,
} from "./types.js";
export { DEFAULT_MODELS } from "./types.js";

import type { KeyartConfig } from "./types.js";

export function defineKeyartConfig<T extends KeyartConfig>(
  config: T,
): T {
  return config;
}

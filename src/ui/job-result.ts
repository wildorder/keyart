/** Dispatch jobs return the CLI facade envelope, unlike direct studio jobs. */
export function dispatchJobSummary(result: unknown): string | null {
  if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") return null;
  return result.text.split(/\r?\n\s*\r?\n/)[0].trim() || null;
}

export function jobResultIncomplete(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as Record<string, unknown>;
  if (value.isError === true || ["partial", "pending", "failed"].includes(String(value.status))) return true;
  const summary = dispatchJobSummary(result);
  return summary !== null && /(?::\s*(?:pending|failed|partial)\b|dry-run|no PNG|no images)/i.test(summary);
}

/** Only written image paths become links, never model prose or log output. */
export function jobImageOutputs(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const value = result as Record<string, unknown>;
  const files: unknown[] = Array.isArray(value.filesWritten) ? value.filesWritten : [];
  if (!Array.isArray(value.filesWritten) && typeof value.text === "string") {
    const section = value.text.match(/(?:^|\n)Files written \(\d+\):\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/)?.[1];
    for (const line of section?.split(/\r?\n/) ?? []) if (line.startsWith("- ")) files.push(line.slice(2));
  }
  return [...new Set(files.filter((file): file is string => typeof file === "string" &&
    !file.startsWith("/") && !file.includes("\\") && !file.split("/").includes("..") &&
    !/^[a-z]+:/i.test(file) && /\.(png|webp|jpe?g|svg)$/i.test(file)))];
}

import path from "node:path";
import { loadConfig } from "../config.js";
import { readTextFile, writeWithConfirm } from "../fs.js";
import { hasApiKey, chatJson } from "../openai.js";
import { renderPageBrief } from "../brief/render-page-brief.js";
import type { DirectionContent } from "../types.js";
import { CommandError } from "../errors.js";

function sanitizePageName(name: string): string {
  return name
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export interface BriefResult {
  written: boolean;
  outPath: string;
}

export async function runBrief(opts: {
  cwd: string;
  pageName: string;
  force?: boolean;
}): Promise<BriefResult> {
  const config = await loadConfig(opts.cwd);
  const brandRoot = path.resolve(opts.cwd, config.brand.root);

  // Read approved direction
  const directionPath = path.join(
    path.resolve(opts.cwd, config.brand.approved),
    "current-direction.json",
  );
  let directionRaw: string;
  try {
    directionRaw = await readTextFile(directionPath);
  } catch {
    throw new CommandError(
      "No approved direction found. Run `keyart approve` first.",
    );
  }
  const direction = JSON.parse(directionRaw) as DirectionContent;

  // Optionally read style guide (no crash if missing)
  let styleGuideExcerpt = "";
  try {
    const fullGuide = await readTextFile(
      path.join(brandRoot, "guides", "visual-style-guide.md"),
    );
    styleGuideExcerpt = fullGuide.slice(0, 4000);
  } catch {
    // Missing style guide is fine
  }

  // Render base brief
  let brief = renderPageBrief({
    pageName: opts.pageName,
    direction,
    styleGuideExcerpt,
  });

  // Optional AI expansion
  if (hasApiKey()) {
    const { data, dryRun } = await chatJson<{
      additionalChecklist?: string[];
      pageNotes?: string;
    }>({
      model: config.models.text,
      system:
        "You are a design-savvy frontend architect. Given a page brief, return JSON with optional additionalChecklist (string[]) and pageNotes (string) to enhance the brief.",
      user: `Page: ${opts.pageName}\n\nBrief:\n${brief}`,
    });

    if (!dryRun && data) {
      if (data.additionalChecklist?.length) {
        const extra = data.additionalChecklist
          .map((item, i) => `${i + 6}. ${item}`)
          .join("\n");
        brief = brief.replace(
          "## Cursor prompt (paste below)",
          `${extra}\n\n## Cursor prompt (paste below)`,
        );
      }
      if (data.pageNotes) {
        brief = brief.replace(
          "## Implementation checklist",
          `## Page-specific notes\n\n${data.pageNotes}\n\n## Implementation checklist`,
        );
      }
    }
  }

  // Write output
  const sanitized = sanitizePageName(opts.pageName);
  const outPathAbs = path.join(
    brandRoot,
    "generated",
    "page-briefs",
    `${sanitized}.md`,
  );
  const outPath = path
    .relative(path.resolve(opts.cwd), outPathAbs)
    .split(path.sep)
    .join("/");

  const wrote = await writeWithConfirm(outPathAbs, brief, {
    force: opts.force,
  });
  if (wrote) {
    console.log(`  ✓ brand/generated/page-briefs/${sanitized}.md`);
  }

  return { written: wrote, outPath };
}

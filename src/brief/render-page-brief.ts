import type { DirectionContent } from "../types.js";
import { characterSummary } from "../approve/render-guides.js";

export function renderPageBrief(opts: {
  pageName: string;
  direction: DirectionContent;
  styleGuideExcerpt: string;
}): string {
  const { pageName, direction, styleGuideExcerpt } = opts;

  const sections: string[] = [];

  // Title
  sections.push(`# Page Brief: ${pageName}\n`);

  // Approved direction summary
  sections.push(`## Approved direction summary\n`);
  sections.push(`${direction.summary}\n`);
  sections.push(`**Positioning:** ${direction.positioning}\n`);

  // Visual rules
  sections.push(`## Visual rules\n`);
  for (const rule of direction.usage.rules) {
    sections.push(`- ${rule}`);
  }
  sections.push("");

  // Anti-rules
  sections.push(`## Anti-rules\n`);
  for (const rule of direction.usage.antiRules) {
    sections.push(`- ${rule}`);
  }
  sections.push("");

  // Copy tone
  sections.push(`## Copy tone\n`);
  sections.push(
    `The brand voice is grounded in the approved positioning: ${direction.positioning}\n`,
  );
  sections.push(`**Example headline:** ${direction.copyExamples.headline}`);
  sections.push(
    `**Example subheadline:** ${direction.copyExamples.subheadline}`,
  );
  sections.push(`**Example CTA:** ${direction.copyExamples.cta}\n`);

  // Image requirements
  sections.push(`## Image requirements\n`);
  sections.push(`**Style tile prompt:** ${direction.styleTilePrompt}`);
  sections.push(
    `**Homepage mockup prompt:** ${direction.homepageMockupPrompt}\n`,
  );

  // Component & style expectations
  sections.push(`## Component & style expectations\n`);
  sections.push(
    `- Use consistent spacing based on the approved design tokens (\`var(--brand-spacing-unit)\` in brand.css).`,
  );
  const typography = direction.tokens?.typography;
  sections.push(
    typography
      ? `- Typography: headings in "${typography.heading}", body in "${typography.body}" — use \`var(--brand-font-heading)\`/\`var(--brand-font-body)\` from brand.css (canonical, do not hardcode).`
      : `- Typography: apply \`var(--brand-font-heading)\`/\`var(--brand-font-body)\` from brand.css (canonical, do not hardcode).`,
  );
  sections.push(
    `- CTA buttons must use the primary brand accent and match the copy tone ("${direction.copyExamples.cta}").`,
  );
  sections.push(
    `- All interactive elements must have visible focus and hover states.`,
  );
  sections.push(`- Follow responsive breakpoints consistently.\n`);

  // Implementation checklist
  sections.push(`## Implementation checklist\n`);
  sections.push(
    `1. Set up page layout matching the approved visual direction.`,
  );
  sections.push(`2. Apply design tokens (colors, typography, spacing).`);
  sections.push(`3. Implement all interactive states (hover, focus, active).`);
  sections.push(`4. Verify accessibility (contrast ratios, focus order, ARIA).`);
  sections.push(`5. Test responsive behavior at all breakpoints.\n`);

  // Cursor prompt
  sections.push(`## Cursor prompt (paste below)\n`);
  sections.push("```");
  sections.push(
    `Implement the "${pageName}" page for this project following the approved visual direction and brand guides.`,
  );
  sections.push("");
  sections.push(`Key requirements:`);
  sections.push(`- Direction: ${direction.name} — ${direction.summary}`);
  sections.push(`- Visual style: ${characterSummary(direction.character)}`);
  sections.push(
    `- Design rules: ${direction.usage.rules.map((r) => r.toLowerCase()).join("; ")}`,
  );
  sections.push(
    `- Anti-rules (never do): ${direction.usage.antiRules.map((r) => r.toLowerCase()).join("; ")}`,
  );
  sections.push(
    `- Copy tone: confident and clear, matching examples like "${direction.copyExamples.headline}"`,
  );
  if (styleGuideExcerpt) {
    sections.push("");
    sections.push(
      `Refer to the visual style guide for detailed implementation guidance.`,
    );
  }
  sections.push("");
  sections.push(
    `Ensure all components meet accessibility standards, are responsive, and follow the design tokens.`,
  );
  sections.push("```\n");

  return sections.join("\n");
}

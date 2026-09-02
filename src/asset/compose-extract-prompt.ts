/**
 * The asset-prompt composer: element description + the isolation directive +
 * an optional tweak block + the direction's `composeArtDirection` block
 * appended verbatim. Pure, deterministic — no I/O, no imports beyond types.
 *
 * This is how a global visual hard rule reaches the asset prompt as MUST and
 * a discard note as AVOID — via the existing `composeArtDirection` compiler,
 * never re-implemented or re-classified here.
 */
export function composeExtractPrompt(input: {
  description: string;
  artDirection: string;
  tweak?: string;
}): string {
  const parts: string[] = [
    [
      `Extract the following element from the reference image as a standalone asset:`,
      input.description,
      "",
      "Render ONLY this element, isolated and centered, on a fully transparent background.",
      "Stay faithful to the reference's styling and rendering of the element.",
      "Do not include any scene background, additional elements, text, or labels.",
    ].join("\n"),
  ];

  const tweak = input.tweak?.trim();
  if (tweak) {
    parts.push(
      `Adjustment (this pass only — apply to the asset above): ${tweak}`,
    );
  }

  const artDirection = input.artDirection;
  if (artDirection.trim().length > 0) {
    parts.push(artDirection);
  }

  return parts.join("\n\n");
}

import { describe, it, expect } from "vitest";
import {
  renderContactSheetSvg,
  renderContactSheetMarkdown,
  type ContactSheetInput,
  type ContactSheetAsset,
} from "./render-contact-sheet.js";

const IMAGE_ASSET: ContactSheetAsset = {
  id: "yak-mascot",
  name: "Yak mascot",
  description: "The yak, isolated",
  versionId: "2026-07-26T00-00-00-000Z",
  hasImage: true,
  source: {
    directionId: "direction-a",
    versionId: "2026-07-20T00-00-00-000Z",
    image: "styleTile",
    cropBox: { x: 1, y: 2, w: 3, h: 4 },
  },
};

const PENDING_ASSET: ContactSheetAsset = {
  id: "wave-pattern",
  name: "Wave pattern",
  description: "",
  versionId: "2026-07-26T01-00-00-000Z",
  hasImage: false,
  source: {
    directionId: "direction-a",
    versionId: "2026-07-21T00-00-00-000Z",
    image: "homepageMockup",
  },
};

const INPUT: ContactSheetInput = {
  directionId: "direction-a",
  directionName: "Bold & Modern",
  assets: [IMAGE_ASSET, PENDING_ASSET],
};

describe("renderContactSheetSvg / renderContactSheetMarkdown — the deterministic contact sheet", () => {
  it("is byte-identical across repeated renders", () => {
    expect(renderContactSheetSvg(INPUT)).toBe(renderContactSheetSvg(INPUT));
    expect(renderContactSheetMarkdown(INPUT)).toBe(
      renderContactSheetMarkdown(INPUT),
    );
  });

  it("renders an honest pending placeholder for an image-less asset, never a fabricated image", () => {
    const svg = renderContactSheetSvg(INPUT);
    expect(svg).toContain("pending (dry-run)");
    expect(svg).not.toContain(`<image href="${PENDING_ASSET.id}.png"`);
    expect(svg).toContain(`<image href="${IMAGE_ASSET.id}.png"`);

    const md = renderContactSheetMarkdown(INPUT);
    const pendingRow = md.split("\n").find((l) => l.includes(PENDING_ASSET.id));
    expect(pendingRow).toContain("pending (dry-run)");
    const imageRow = md.split("\n").find((l) => l.includes(IMAGE_ASSET.id));
    expect(imageRow).toContain(`![${IMAGE_ASSET.id}](${IMAGE_ASSET.id}.png)`);
  });

  it("carries a provenance line and the head version on every tile/row", () => {
    const svg = renderContactSheetSvg(INPUT);
    expect(svg).toContain(
      `from ${IMAGE_ASSET.source.image} @ ${IMAGE_ASSET.source.versionId} (crop)`,
    );
    expect(svg).toContain(
      `from ${PENDING_ASSET.source.image} @ ${PENDING_ASSET.source.versionId}`,
    );
    expect(svg).toContain(`head ${IMAGE_ASSET.versionId}`);
    expect(svg).toContain(`head ${PENDING_ASSET.versionId}`);

    const md = renderContactSheetMarkdown(INPUT);
    const imageRow = md.split("\n").find((l) => l.includes(IMAGE_ASSET.id));
    expect(imageRow).toContain(
      `${IMAGE_ASSET.source.image} @ ${IMAGE_ASSET.source.versionId} (crop)`,
    );
    expect(imageRow).toContain(IMAGE_ASSET.versionId);
    const pendingRow = md.split("\n").find((l) => l.includes(PENDING_ASSET.id));
    expect(pendingRow).toContain(
      `${PENDING_ASSET.source.image} @ ${PENDING_ASSET.source.versionId}`,
    );
    expect(pendingRow).not.toContain("(crop)");
  });

  it("escapes XML entities in the SVG and pipes in the markdown table", () => {
    const hostileAsset: ContactSheetAsset = {
      ...IMAGE_ASSET,
      id: "hostile",
      name: `Name & <script> "quote" 'apos' | pipe`,
    };
    const input: ContactSheetInput = { ...INPUT, assets: [hostileAsset] };

    const svg = renderContactSheetSvg(input);
    expect(svg).toContain("Name &amp; &lt;script&gt; &quot;quote&quot; &apos;apos&apos; | pipe");
    expect(svg).not.toContain("<script>");

    const md = renderContactSheetMarkdown(input);
    expect(md).toContain("Name & <script> \"quote\" 'apos' \\| pipe");
  });

  it("renders a valid, honest empty state for zero assets", () => {
    const empty: ContactSheetInput = { directionId: "direction-a", assets: [] };

    const svg = renderContactSheetSvg(empty);
    expect(svg).toContain("<svg");
    expect(svg).toContain("No active assets.");
    expect(svg).not.toContain("<image");

    const md = renderContactSheetMarkdown(empty);
    expect(md).toContain("# Asset Pack");
    expect(md).toContain("_No active assets._");
    expect(md).not.toContain("| Asset |");
  });

  it("falls back the title to directionId when directionName is absent", () => {
    const withoutName: ContactSheetInput = { directionId: "direction-a", assets: [] };
    expect(renderContactSheetSvg(withoutName)).toContain("direction-a — Asset Pack");
    expect(renderContactSheetMarkdown(withoutName)).toContain(
      "# Asset Pack — direction-a",
    );

    expect(renderContactSheetSvg(INPUT)).toContain("Bold &amp; Modern — Asset Pack");
    expect(renderContactSheetMarkdown(INPUT)).toContain(
      "# Asset Pack — Bold & Modern",
    );
  });
});

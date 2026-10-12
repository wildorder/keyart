import { describe, expect, it } from "vitest";
import { dispatchJobSummary, jobImageOutputs, jobResultIncomplete } from "./job-result.js";

describe("chat job results", () => {
  it("uses the extraction result rather than a generic update label and links the written image", () => {
    const summary = 'Extracted asset "good-food" (v1): completed.';
    const result = { isError: false, text: `${summary}\n\nFiles written (2):\n- brand/directions/bold/extracted-assets/good-food/versions/v1/asset.png\n- brand/directions/bold/extracted-assets/good-food/asset.json\n\nLog output:\nCreated.` };
    expect(dispatchJobSummary(result)).toBe(summary);
    expect(jobResultIncomplete(result)).toBe(false);
    expect(jobImageOutputs(result)).toEqual(["brand/directions/bold/extracted-assets/good-food/versions/v1/asset.png"]);
  });

  it("does not present pending/dry-run dispatch or errors as rendered success", () => {
    expect(jobResultIncomplete({ isError: false, text: 'Extracted asset "good-food" (v1): pending — dry-run, no PNG.\n\nFiles written (0):\n(none)' })).toBe(true);
    expect(jobResultIncomplete({ isError: true, text: "Model failed." })).toBe(true);
    expect(jobResultIncomplete({ status: "pending" })).toBe(true);
  });

  it("only links safe written image paths, never prose or logs", () => {
    expect(jobImageOutputs({ filesWritten: ["../../secret.png", "https://external/image.png", "C:\\image.png", "/absolute.png", "brand/a.png", "brand/a.png", "brand/a.json"] })).toEqual(["brand/a.png"]);
    expect(jobImageOutputs({ text: "Look at evil.png\n\nFiles written (0):\n(none)\n\nLog output:\n- evil.png" })).toEqual([]);
    expect(dispatchJobSummary(null)).toBeNull();
  });
});

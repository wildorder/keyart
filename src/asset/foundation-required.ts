import { CommandError } from "../errors.js";

/** A surviving asset needs a human-selected foundation before it can be revised. */
export class AssetFoundationRequiredError extends CommandError {
  readonly code = "asset_foundation_required";
  constructor(
    readonly directionId: string,
    readonly assetId: string,
    readonly revisionId: string,
    readonly missingVersionId: string,
    readonly availableVersions: string[],
  ) {
    super(`Asset ${assetId} uses missing foundation ${missingVersionId}. Choose a replacement foundation explicitly with --version; no latest-version fallback was applied. Available foundations: ${availableVersions.join(", ") || "none — create a foundation first"}.`);
    this.name = "AssetFoundationRequiredError";
  }
}

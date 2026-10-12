import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig, directionsRoot } from "../config.js";
import type { KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import { createBrandCore } from "../brand/core.js";
import { createDirectionCore } from "./core.js";
import { assertFoundationId, assertFoundationPath } from "./foundation.js";
import { versionOrdinals } from "./schema.js";
import { withFileLock } from "../store/file-lock.js";
import { VersionConflictError } from "../store/versioned-store.js";

/** Approval and permanent deletion must not race to publish a removed foundation. */
export function withFoundationMutationLock<T>(cwd: string, config: KeyartConfig, action: () => Promise<T>): Promise<T> {
  return withFileLock(path.resolve(cwd, config.brand.root, ".foundation-mutation"), action);
}

export interface DeleteDirectionVersionResult {
  directionId: string;
  versionId: string;
  head: string | null;
  versions: string[];
  filesDeleted: string[];
  deleted: true;
}

/** Permanently removes only a foundation. Derived output/provenance is never rewritten. */
export async function runDeleteDirectionVersion(opts: {
  cwd: string;
  directionId: string;
  versionId: string;
  expectedVersion?: number;
}): Promise<DeleteDirectionVersionResult> {
  assertFoundationId(opts.directionId, "direction");
  assertFoundationId(opts.versionId, "version");
  const cwd = path.resolve(opts.cwd);
  const config = await loadConfig(cwd);
  return withFoundationMutationLock(cwd, config, async () => {
    const core = createDirectionCore(cwd, config);
    const record = await core.get(opts.directionId);
    if (record.id !== opts.directionId) throw new CommandError("Foundation direction identity does not match its requested owner.");
    const root = directionsRoot(cwd, config);
    const dir = path.join(root, opts.directionId);
    const versionsDir = path.join(dir, "versions");
    const target = path.join(versionsDir, opts.versionId);
    await assertFoundationPath(root, dir);
    const ordinals = versionOrdinals(record);
    if (!Object.hasOwn(ordinals, opts.versionId)) throw new CommandError(`Foundation ${opts.directionId}@${opts.versionId} is not in this direction's history.`);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== record.version) {
      throw new VersionConflictError(path.join(dir, "direction.yaml"), opts.expectedVersion, record.version);
    }
    const approved = (await createBrandCore(cwd, config).read()).approvedPointer;
    if (approved?.directionId === opts.directionId && approved.versionId === opts.versionId) {
      throw new CommandError("Cannot delete the approved foundation. Approve another foundation first.");
    }
    let present = false;
    try {
      const [parentStat, targetStat] = await Promise.all([fs.lstat(versionsDir), fs.lstat(target)]);
      if (parentStat.isSymbolicLink() || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        throw new CommandError("Refusing to delete a foundation through a symlink, junction, or non-directory path.");
      }
      await assertFoundationPath(dir, versionsDir);
      await assertFoundationPath(versionsDir, target);
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Commit history first: a CAS conflict never removes any historical files.
    // On interruption, the retained ordinal makes exact-path cleanup retryable.
    const versions = record.versions.filter((id) => id !== opts.versionId);
    const head = versions.at(-1) ?? null;
    if (record.versions.includes(opts.versionId)) {
      await core.update(opts.directionId, (current) => ({ ...current, versions, head, versionOrdinals: ordinals }),
        { expectedVersion: record.version });
    }
    if (present) {
      try {
        await fs.rm(target, { recursive: true });
      } catch (error) {
        throw new CommandError(`Foundation removed from history but its files could not be deleted at ${target}. Retry the same deletion to finish cleanup. ${String(error)}`);
      }
    }
    return { directionId: opts.directionId, versionId: opts.versionId, head, versions,
      filesDeleted: present ? [path.relative(cwd, target).split(path.sep).join("/")] : [], deleted: true };
  });
}

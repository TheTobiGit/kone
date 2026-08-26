// ── turn checkpoints ──────────────────────────────────────────────────────────
// Lightweight, non-destructive repository snapshots stored under
// `refs/kone/checkpoints/<uuid>`. Captures working tree, staging, and untracked
// files into a git commit object using a throwaway GIT_INDEX_FILE, so the
// repository's real index and branch HEAD are never disturbed.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, GitError, repoRoot, safeRepoPath } from "./core.js";
import type {
  CreateCheckpointOptions,
  GitCheckpoint,
  RestoreCheckpointOptions,
} from "./types.js";

const CHECKPOINT_REF_PREFIX = "refs/kone/checkpoints/";

export async function createCheckpoint(
  cwd: string,
  options?: CreateCheckpointOptions,
): Promise<GitCheckpoint> {
  const root = await repoRoot(cwd);
  if (!root) {
    throw new GitError(`"${cwd}" is not inside a git repository.`, null);
  }

  const id = randomUUID();
  const createdAt = Date.now();
  const metaObj = {
    id,
    name: options?.name,
    message: options?.message,
    threadId: options?.threadId,
    turnId: options?.turnId,
    createdAt,
  };
  const metadataString = JSON.stringify(metaObj);

  let scratch: string | null = null;
  let commitHash: string;

  try {
    scratch = await mkdtemp(path.join(os.tmpdir(), "kone-checkpoint-idx-"));
    const scratchIndex = path.join(scratch, "index");
    const env = { GIT_INDEX_FILE: scratchIndex };

    // Get current HEAD commit if available
    let headHash: string | null = null;
    try {
      headHash = (await git(root, ["rev-parse", "HEAD"])).trim();
    } catch {
      // Clean/empty repo with no commits yet
    }

    if (headHash) {
      try {
        await git(root, ["read-tree", headHash], env);
      } catch {
        // Fall through
      }
    }

    // Stage changes into the throwaway index
    const addArgs = options?.includeUntracked !== false ? ["add", "-A"] : ["add", "-u"];
    await git(root, addArgs, env);

    const treeHash = (await git(root, ["write-tree"], env)).trim();
    if (!treeHash) {
      throw new GitError("Failed to write tree for checkpoint.", null);
    }

    const commitArgs = ["commit-tree", treeHash, "-m", metadataString];
    if (headHash) {
      commitArgs.push("-p", headHash);
    }
    commitHash = (await git(root, commitArgs)).trim();

    const refPath = `${CHECKPOINT_REF_PREFIX}${id}`;
    await git(root, ["update-ref", refPath, commitHash]);
  } catch (err) {
    if (err instanceof GitError) {
      throw err;
    }
    throw new GitError(
      `Failed to create checkpoint: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  } finally {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    id,
    name: options?.name,
    message: options?.message,
    threadId: options?.threadId,
    turnId: options?.turnId,
    commitHash,
    createdAt,
  };
}

export async function restoreCheckpoint(
  cwd: string,
  checkpointId: string,
  options?: RestoreCheckpointOptions,
): Promise<boolean> {
  const root = await repoRoot(cwd);
  if (!root) {
    throw new GitError(`"${cwd}" is not inside a git repository.`, null);
  }

  const refPath = `${CHECKPOINT_REF_PREFIX}${checkpointId}`;
  let commitHash: string;
  try {
    commitHash = (await git(root, ["rev-parse", "--verify", refPath])).trim();
  } catch {
    throw new GitError(`Checkpoint "${checkpointId}" not found.`, null);
  }

  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(path.join(os.tmpdir(), "kone-checkpoint-idx-"));
    const scratchIndex = path.join(scratch, "index");
    const env = { GIT_INDEX_FILE: scratchIndex };

    // Load checkpoint tree into throwaway index
    await git(root, ["read-tree", commitHash], env);

    if (options?.hard) {
      // Collect files captured in checkpoint
      const cpFilesOutput = await git(root, ["ls-files", "-z"], env);
      const cpFiles = new Set(cpFilesOutput.split("\0").filter(Boolean));

      // Collect current non-ignored working tree files via a temporary scratch index
      let currentScratch: string | null = null;
      try {
        currentScratch = await mkdtemp(path.join(os.tmpdir(), "kone-checkpoint-curr-"));
        const currEnv = { GIT_INDEX_FILE: path.join(currentScratch, "index") };
        await git(root, ["add", "-A"], currEnv);
        const currFilesOutput = await git(root, ["ls-files", "-z"], currEnv);
        const currFiles = currFilesOutput.split("\0").filter(Boolean);

        for (const file of currFiles) {
          if (!cpFiles.has(file)) {
            const absPath = safeRepoPath(root, file);
            if (absPath) {
              await rm(absPath, { force: true, recursive: true }).catch(() => {});
            }
          }
        }
      } finally {
        if (currentScratch) {
          await rm(currentScratch, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    // Restore files from the checkpoint scratch index without touching user's real index or HEAD
    await git(root, ["checkout-index", "-a", "-f"], env);
    return true;
  } catch (err) {
    if (err instanceof GitError) {
      throw err;
    }
    throw new GitError(
      `Failed to restore checkpoint "${checkpointId}": ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  } finally {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function listCheckpoints(
  cwd: string,
  filter?: { threadId?: string },
): Promise<GitCheckpoint[]> {
  const root = await repoRoot(cwd);
  if (!root) {
    return [];
  }

  let output: string;
  try {
    output = await git(root, [
      "for-each-ref",
      `--format=%(refname:strip=3)\t%(objectname)\t%(contents:subject)%00`,
      CHECKPOINT_REF_PREFIX,
    ]);
  } catch {
    return [];
  }

  const checkpoints: GitCheckpoint[] = [];
  const entries = output.split("\0");
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const id: string = parts[0];
    const commitHash: string = parts[1];
    const metaRaw = parts.slice(2).join("\t").trim();
    let meta: Partial<GitCheckpoint> = {};
    if (metaRaw.startsWith("{") && metaRaw.endsWith("}")) {
      try {
        meta = JSON.parse(metaRaw);
      } catch {
        meta = { message: metaRaw };
      }
    } else {
      meta = { message: metaRaw };
    }

    if (filter?.threadId && meta.threadId !== filter.threadId) {
      continue;
    }

    checkpoints.push({
      id: meta.id ?? id,
      name: meta.name,
      message: meta.message,
      threadId: meta.threadId,
      turnId: meta.turnId,
      commitHash,
      createdAt: meta.createdAt ?? Date.now(),
    });
  }

  checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  return checkpoints;
}

export async function dropCheckpoint(
  cwd: string,
  checkpointId: string,
): Promise<boolean> {
  const root = await repoRoot(cwd);
  if (!root) {
    return false;
  }

  const refPath = `${CHECKPOINT_REF_PREFIX}${checkpointId}`;
  try {
    await git(root, ["rev-parse", "--verify", refPath]);
    await git(root, ["update-ref", "-d", refPath]);
    return true;
  } catch {
    return false;
  }
}

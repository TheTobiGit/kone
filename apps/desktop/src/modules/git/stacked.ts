import { GitError, assertWithinRepo, git, repoRoot } from "@kone/git-core/core.js";
import * as github from "./github.js";
import { withRepoMutation } from "./mutationLock.js";
import { sanitizeBranchFragment } from "./textGen.js";
import type {
  GitActionProgressEvent,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
} from "@kone/git-core/types.js";

function notify(
  onProgress: ((event: GitActionProgressEvent) => void) | undefined,
  phase: GitActionProgressEvent["phase"],
  message: string,
  exitCode?: number,
  error?: string,
): void {
  if (onProgress) {
    onProgress({ phase, message, exitCode, error });
  }
}

/**
 * Execute a multi-stage stacked action (e.g. Branch -> Stage -> Commit -> Push -> PR).
 * Serialized per-repo via withRepoMutation to protect the index.
 */
export async function runStackedAction(
  dir: string,
  input: GitRunStackedActionInput,
  onProgress?: (event: GitActionProgressEvent) => void,
): Promise<GitRunStackedActionResult> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root) {
      throw new GitError("Directory is not inside a git repository.", null);
    }

    let currentBranch = "";
    try {
      currentBranch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch {
      currentBranch = "main";
    }

    // ── Phase 1: Feature branch (if requested) ──────────────────────────────
    const needsNewBranch =
      input.action === "commit_new_branch" ||
      input.featureBranch === true ||
      (input.branchName && input.branchName.trim().length > 0 && input.branchName.trim() !== currentBranch);

    if (needsNewBranch) {
      const candidateName =
        input.branchName?.trim() ||
        `feature/${sanitizeBranchFragment(input.message) || "update"}`;

      notify(onProgress, "branch", `Creating feature branch ${candidateName}...`);

      try {
        await git(root, ["branch", candidateName]);
        try {
          await git(root, ["checkout", candidateName]);
          currentBranch = candidateName;
        } catch (checkoutErr) {
          await git(root, ["branch", "-D", candidateName]).catch(() => {});
          throw checkoutErr;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(onProgress, "branch", "Failed to create feature branch", 1, msg);
        throw err;
      }
    }

    // ── Phase 2: Staging ────────────────────────────────────────────────────
    if (input.filePaths && input.filePaths.length > 0) {
      notify(onProgress, "stage", `Staging ${input.filePaths.length} selected files...`);
      assertWithinRepo(root, input.filePaths);
      await git(root, ["add", "--", ...input.filePaths]);
    } else {
      // Check if anything is staged; if not, stage all modified & untracked files
      let hasStaged = false;
      try {
        await git(root, ["diff", "--cached", "--quiet"]);
      } catch (err) {
        if (err instanceof GitError && err.code === 1) hasStaged = true;
        else throw err;
      }

      if (!hasStaged) {
        notify(onProgress, "stage", "Staging all changed files...");
        await git(root, ["add", "-A"]);
      }
    }

    // ── Phase 3: Commit ─────────────────────────────────────────────────────
    notify(onProgress, "commit", "Committing changes...");
    const message = input.message.trim();
    if (!message) {
      throw new GitError("Commit message is empty.", null);
    }
    const firstLine = message.split("\n")[0]?.trim() ?? "";
    const rest = message.split("\n").slice(1).join("\n").trim();
    const body = input.body?.trim() || rest;

    const commitArgs = ["commit", "-m", firstLine];
    if (body) {
      commitArgs.push("-m", body);
    }

    try {
      await git(root, commitArgs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(onProgress, "commit", "Commit failed", 1, msg);
      throw err;
    }

    let commitSha = "";
    try {
      commitSha = (await git(root, ["rev-parse", "HEAD"])).trim();
    } catch {
      commitSha = "";
    }

    const result: GitRunStackedActionResult = {
      action: input.action,
      commitSha,
      subject: firstLine,
      branch: currentBranch,
      pushed: false,
    };

    // ── Phase 4: Push (if requested) ────────────────────────────────────────
    const wantsPush =
      input.action === "commit_push" ||
      input.action === "commit_push_pr";

    if (wantsPush) {
      const remote = input.pushTarget?.trim() || "origin";
      notify(onProgress, "push", `Pushing to ${remote}/${currentBranch}...`);

      try {
        await git(root, ["push", "--set-upstream", remote, currentBranch]);
        result.pushed = true;
        result.upstreamBranch = `${remote}/${currentBranch}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(onProgress, "push", `Push failed: ${msg}`, 1, msg);
        throw err;
      }
    }

    // ── Phase 5: Create PR (if requested) ───────────────────────────────────
    if (input.action === "commit_push_pr") {
      notify(onProgress, "pr", "Creating pull request...");

      try {
        const pr = await github.createPr(root, {
          title: input.prTitle ?? firstLine,
          body: input.prBody ?? body,
          draft: input.prDraft,
        });
        result.prNumber = pr.number ?? undefined;
        result.prUrl = pr.url;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(onProgress, "pr", `Failed to create pull request: ${msg}`, 1, msg);
        throw err;
      }
    }

    return result;
  });
}

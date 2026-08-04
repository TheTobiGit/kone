import { GitError, git, repoRoot } from "./core.js";
import type { GitPullOptions, GitPushOptions } from "./types.js";

// Network operations behind the Git Space masthead. Two behaviours matter
// here that the local mutations don't need: upstream resolution happens before
// pushing (so a branch with no upstream gets `-u` — the "Publish" gesture —
// instead of a silent tracking-less push), and failures are reworded when they
// look like credential problems, because git's raw auth stderr is a wall of
// noise and the renderer prints the error line verbatim.

const AUTH_FAILURE =
  /authentication failed|failed to authenticate|could not read username|bad credentials|not logged in|\b401\b/i;

/** Reword a network git failure when it looks like a credential problem;
 *  otherwise pass the original GitError through untouched. */
function networkError(error: unknown, remote: string): GitError {
  if (error instanceof GitError) {
    if (AUTH_FAILURE.test(error.message)) {
      return new GitError(
        `Authentication failed while talking to ${remote} — check your git credentials.`,
        error.code,
      );
    }
    return error;
  }
  return error instanceof Error
    ? new GitError(error.message, null)
    : new GitError("git failed.", null);
}

/** Fetch from a remote, pruning refs deleted upstream so dead remote branches
 *  disappear from the Branches section instead of lingering. */
export async function fetch(dir: string, remote = "origin"): Promise<void> {
  const root = await repoRoot(dir);
  if (!root) return;
  try {
    await git(root, ["fetch", "--prune", remote]);
  } catch (error) {
    throw networkError(error, remote);
  }
}

/** Pull the current branch from its upstream (or the given remote/branch).
 *  Plain pull is the default; `rebase` opts into --rebase. */
export async function pull(dir: string, opts?: GitPullOptions): Promise<void> {
  const root = await repoRoot(dir);
  if (!root) return;
  const args = ["pull"];
  if (opts?.rebase) args.push("--rebase");
  if (opts?.remote?.trim()) args.push(opts.remote.trim());
  if (opts?.branch?.trim()) args.push(opts.branch.trim());
  const remote = opts?.remote?.trim() || "origin";
  try {
    await git(root, args);
  } catch (error) {
    throw networkError(error, remote);
  }
}

/** The current branch name, or null when detached / unborn. */
async function currentBranch(root: string): Promise<string | null> {
  try {
    const out = (await git(root, ["branch", "--show-current"])).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** The current branch's upstream ref ("origin/main"), or null when it has none.
 *  rev-parse echoes the literal "@{upstream}" back in some configurations when
 *  there is no upstream — that is "none" too. */
async function currentUpstream(root: string): Promise<string | null> {
  try {
    const out = (
      await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    ).trim();
    return out.length > 0 && out !== "@{upstream}" ? out : null;
  } catch {
    return null;
  }
}

/** Push the current branch. Without an upstream (or with `setUpstream`) this
 *  is a `-u` push — the Publish gesture. `force` maps to --force-with-lease,
 *  which refuses to clobber a remote that moved since our last fetch — never
 *  plain --force. */
export async function push(dir: string, opts?: GitPushOptions): Promise<void> {
  const root = await repoRoot(dir);
  if (!root) return;
  const branch = opts?.branch?.trim() || (await currentBranch(root));
  if (!branch) {
    throw new GitError("Cannot push from detached HEAD — check out a branch first.", null);
  }
  const upstream = await currentUpstream(root);
  const upstreamRemote = upstream ? upstream.split("/")[0] ?? null : null;
  const remote = opts?.remote?.trim() || upstreamRemote || "origin";
  const setUpstream = opts?.setUpstream === true || upstream === null;

  const args = ["push"];
  if (setUpstream) args.push("-u");
  if (opts?.force) args.push("--force-with-lease");
  args.push(remote);
  if (opts?.branch) {
    // An explicit branch is pushed as-is; upstream tracking is then the
    // caller's option via `setUpstream`.
    args.push(branch);
  } else if (upstream) {
    // Push HEAD onto the tracked remote branch — not a same-named local branch
    // that may not exist on the remote.
    args.push(`HEAD:${upstream.slice(remote.length + 1)}`);
  } else {
    args.push(branch);
  }
  try {
    await git(root, args);
  } catch (error) {
    throw networkError(error, remote);
  }
}

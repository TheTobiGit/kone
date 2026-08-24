import { GitError, git, repoRoot } from "./core.js";
import { withRepoMutation } from "./mutationLock.js";
import { remoteExists } from "./state.js";
import type { IpcErrorKind } from "@kone/protocol/ipc-error";
import type { GitPullOptions, GitPushOptions } from "./types.js";

// Network operations behind the Git Space masthead. Two behaviours matter
// here that the local mutations don't need: upstream resolution happens before
// pushing (so a branch with no upstream gets `-u` — the "Publish" gesture —
// instead of a silent tracking-less push), and failures are reworded when they
// look like credential or transport problems, because git's raw stderr is a
// wall of noise and the renderer prints the error line verbatim.
//
// fetch/pull/push update refs and can take locks, so each runs inside
// withRepoMutation to serialize with other kone git writes for the same repo.

const AUTH_FAILURE =
  /authentication failed|failed to authenticate|could not read username|could not read password|bad credentials|not logged in|permission denied|\b401\b|\b403\b/i;

// Non-interactive auth env for every network git call. Without a TTY, git
// would otherwise try to prompt for credentials via an askpass helper or block
// the Electron main process for the full command timeout when a credential
// helper misbehaves; pinning these makes a missing credential fail fast so the
// UI can surface the auth error instead of hanging.
const NON_INTERACTIVE_NETWORK_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "never",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies Record<string, string>;

/** Whether a git network failure message is a credential problem — the
 *  discriminator `rewordNetworkError` uses to reword git's raw auth stderr into
 *  the one-line "check your git credentials" hint the renderer prints verbatim. */
export function isAuthFailure(message: string): boolean {
  return AUTH_FAILURE.test(message);
}

// Transport/offline failure signatures. These come before authentication even
// starts — the host or its name service is unreachable — so they read as a
// connectivity fix ("check your connection") rather than a credential one.
const NETWORK_FAILURE =
  /could not resolve host|could not read from remote|connection (refused|reset|timed out)|network is unreachable|temporary failure in name resolution|operation timed out|early eof|failed to connect/i;

/** Classify a git failure message into a semantic kind that survives IPC:
 *  "AUTH_FAILURE" for credential problems, "NETWORK" for transport/offline
 *  problems, or null when it is neither (e.g. a merge conflict). Auth wins when
 *  a message could read both ways. */
export function classifyNetworkError(message: string): IpcErrorKind | null {
  if (isAuthFailure(message)) return "AUTH_FAILURE";
  if (NETWORK_FAILURE.test(message)) return "NETWORK";
  return null;
}

/** Reword a network git failure into a one-line hint carrying its semantic
 *  kind; pass anything else through untouched. */
export function rewordNetworkError(cause: unknown, remote: string): GitError {
  if (cause instanceof GitError) {
    const kind = classifyNetworkError(cause.message);
    if (kind === "AUTH_FAILURE") {
      return GitError.classified(
        "AUTH_FAILURE",
        `Authentication failed while talking to ${remote} — check your git credentials.`,
        cause.code,
      );
    }
    if (kind === "NETWORK") {
      return GitError.classified(
        "NETWORK",
        `Can't reach ${remote} — check your connection.`,
        cause.code,
      );
    }
    return cause;
  }
  return cause instanceof Error
    ? new GitError(cause.message, null)
    : new GitError("git failed.", null);
}

/** Fetch from a remote, pruning refs deleted upstream so dead remote branches
 *  disappear from the Branches section instead of lingering. A repo with no
 *  such remote has nothing to fetch: the fetch is skipped rather than run, so
 *  a repo without an origin doesn't surface git's "does not appear to be a
 *  git repository" error for an operation that could never have succeeded. */
export async function fetch(dir: string, remote = "origin"): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root) return;
    if (!(await remoteExists(dir, remote))) return;
    try {
      await git(root, ["fetch", "--prune", remote], NON_INTERACTIVE_NETWORK_ENV);
    } catch (error) {
      throw rewordNetworkError(error, remote);
    }
  });
}

/** Pull the current branch from its upstream (or the given remote/branch).
 *  Plain pull is the default; `rebase` opts into --rebase. */
export async function pull(dir: string, opts?: GitPullOptions): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root) return;
    const args = ["pull"];
    if (opts?.rebase) args.push("--rebase");
    if (opts?.remote?.trim()) args.push(opts.remote.trim());
    if (opts?.branch?.trim()) args.push(opts.branch.trim());
    const remote = opts?.remote?.trim() || "origin";
    try {
      await git(root, args, NON_INTERACTIVE_NETWORK_ENV);
    } catch (error) {
      throw rewordNetworkError(error, remote);
    }
  });
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
  return withRepoMutation(dir, async () => {
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
      await git(root, args, NON_INTERACTIVE_NETWORK_ENV);
    } catch (error) {
      throw rewordNetworkError(error, remote);
    }
  });
}

import { git, repoRoot } from "@kone/git-core/core.js";
import { withRepoMutation } from "./mutationLock.js";
import { NON_INTERACTIVE_NETWORK_ENV, classifyNetworkError } from "./sync.js";

// Where a new worktree's branch starts: the freshest copy of the picked branch
// that is safe to use.
//
// A branch picked as a starting point is usually meant as "that branch as it
// stands", not "my copy of it from whenever I last pulled". So the branch is
// fetched first, and when the user's copy is only behind the remote's, the
// remote's is used — the agent then starts on code that is current rather than
// fixing something already fixed upstream.
//
// The user's copy wins whenever using the remote's would lose something. A copy
// with commits the remote lacks keeps them: those are work, and a worktree that
// quietly started without them would be building on the wrong thing. A fetch
// that cannot run — offline, no remote, a credential prompt that must not
// block — falls back to the user's copy too. Freshening is an improvement to
// the starting point, never a reason for the worktree not to exist.
//
// Deliberately no setting. Every case has an answer that loses nothing, so there
// is nothing for a user to decide.

/** How long a fetch may take before the build gives up on it and uses the local
 *  copy. Short on purpose: one branch is a small fetch, and a slow network
 *  should cost the user a moment, not the worktree. */
const FETCH_TIMEOUT_MS = 20_000;

export type FreshBase = {
  /** The ref the new branch starts from. Undefined keeps the default (HEAD). */
  base?: string;
  /** A sentence for the setup card when the answer is worth saying — the start
   *  moved forward, or it could not and why. Absent when nothing changed. */
  note?: string;
};

async function read(root: string, args: string[]): Promise<string | null> {
  try {
    const out = (await git(root, args)).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** What the branch's own ref says about it and its upstream, in one read. */
type Tracking = {
  remote: string;
  mergeRef: string;
  /** The remote-tracking ref, e.g. `refs/remotes/origin/main`. */
  upstreamRef: string;
  /** The same, as a person reads it: `origin/main`. */
  upstreamName: string;
  local: string;
};

async function tracking(root: string, branch: string): Promise<Tracking | null> {
  const out = await read(root, [
    "for-each-ref",
    "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)%00%(upstream:short)%00%(objectname)",
    `refs/heads/${branch}`,
  ]);
  if (!out) return null;
  const [remote, mergeRef, upstreamRef, upstreamName, local] = out.split("\0");
  if (!remote || !mergeRef || !upstreamRef || !upstreamName || !local) return null;
  return { remote, mergeRef, upstreamRef, upstreamName, local };
}

function commits(n: number): string {
  return n === 1 ? "1 commit" : `${n} commits`;
}

/**
 * The freshest safe starting point for a new worktree off `base` (the project's
 * current branch when absent). Never throws: every failure keeps the local copy.
 */
export async function freshestBase(projectPath: string, base?: string | null): Promise<FreshBase> {
  const picked = base?.trim() || undefined;
  const keep: FreshBase = picked ? { base: picked } : {};
  const root = await repoRoot(projectPath);
  if (!root) return keep;

  // A detached HEAD has no branch to freshen; it starts where it stands.
  const branch = picked ?? (await read(root, ["branch", "--show-current"]));
  if (!branch) return keep;

  // No upstream, or one that is another local branch ("."): there is no remote
  // copy to be fresher than.
  const ref = await tracking(root, branch);
  if (!ref || ref.remote === ".") return keep;
  const { remote, mergeRef, upstreamRef, upstreamName, local } = ref;

  try {
    await withRepoMutation(root, () =>
      git(root, ["fetch", "--no-tags", "--end-of-options", remote, mergeRef], {
        env: NON_INTERACTIVE_NETWORK_ENV,
        timeoutMs: FETCH_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const why =
      classifyNetworkError(message) === "AUTH_FAILURE"
        ? `${remote} asked for credentials`
        : `Couldn't reach ${remote}`;
    return { ...keep, note: `${why} — started from your copy of ${branch}.` };
  }

  // The fetch moved only the remote-tracking ref, so the local sha read above
  // still stands.
  const upstream = await read(root, ["rev-parse", "--verify", "--end-of-options", `${upstreamRef}^{commit}`]);
  if (!upstream || upstream === local) return keep;

  // `ahead` is what the user's copy has that the remote's lacks; none means it
  // is only behind, and the remote's copy loses nothing.
  const counts = await read(root, ["rev-list", "--left-right", "--count", `${local}...${upstream}`]);
  if (!counts) return keep;
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  if (ahead === 0 && behind) {
    return {
      base: upstream,
      note: `Started from the latest ${upstreamName}, ${commits(behind)} newer than your copy.`,
    };
  }
  return { ...keep, note: `Your ${branch} has commits ${upstreamName} doesn't — started from yours.` };
}

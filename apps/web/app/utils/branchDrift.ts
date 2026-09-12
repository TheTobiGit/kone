import { isWorkspacePending, type WorkspaceFacts } from "./threadWorkspace";

// Whether a thread's history was written somewhere other than where its next
// turn would land.
//
// A thread does not choose a branch. The branch recorded on it is a photograph
// taken when its last turn settled — "this is where the project happened to be"
// — and the project's checkout has moved freely since. So a thread whose work
// was done on one branch can send its next turn onto another without anything
// having gone wrong, and without anything having said so.
//
// That silence is the problem this answers, and it is a problem only for a
// thread sharing the project's checkout. One checkout has one branch, every
// thread in it shares that branch, and recording the branch more carefully
// cannot change either fact — so the honest thing is to say plainly when the
// two have come apart.
//
// A thread with a working tree of its own is exempt, and not as an optimization.
// Nothing can check out a different branch inside a dedicated worktree, so its
// recorded branch and its live branch are the same fact read twice; a banner
// there would be reporting a hazard that cannot occur. The exemption is decided
// here, at the top, rather than left to evaluate to false further down — a
// worktree thread must never reach the comparison at all.

export type BranchDrift = {
  /** Where the thread's turns were done. */
  ranOn: string;
  /** Where the checkout is now, and so where the next turn would go. */
  nowOn: string;
};

/** The drift on a thread, or null when there is none to report.
 *
 *  Null covers four different quiets, all of which should show nothing: a
 *  thread that works in a directory of its own and so cannot drift, a thread
 *  that has never run (nothing was recorded), a project git cannot speak for
 *  (detached, unborn, or not a repository), and the ordinary case of the two
 *  agreeing.
 *
 *  The workspace facts ride along so the exemption reads them raw — a pending
 *  worktree has run nowhere yet, and when it runs it will not be in the
 *  project's checkout either. */
export function resolveBranchDrift(input: {
  /** The branch stamped on the thread by its last settled turn. */
  recorded?: string | null;
  /** The branch the project's checkout reports right now. */
  live?: string | null;
} & WorkspaceFacts): BranchDrift | null {
  if (input.worktreePath?.trim() || isWorkspacePending(input)) return null;
  const ranOn = input.recorded?.trim();
  const nowOn = input.live?.trim();
  if (!ranOn || !nowOn) return null;
  if (ranOn === nowOn) return null;
  return { ranOn, nowOn };
}

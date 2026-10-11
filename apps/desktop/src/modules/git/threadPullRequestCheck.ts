import type { GitHubPullRequestState } from "@kone/git-core/types.js";
import type { ThreadPullRequestLink } from "@kone/agent-core/threadPullRequest.js";

// Resolving a thread's pull request for the settle-on-merge sweep. The rules
// here are the ones a wrong answer would violate:
//
//   - an explicit link is identified by its FULL identity (repository + number,
//     or its URL). A bare number in the thread's own repo is never used, because
//     a thread may link a PR in another repository and the local repo's number 7
//     is a different PR entirely;
//   - an explicit link that cannot be resolved is UNKNOWN, not "no PR": the
//     branch fallback is only for a thread with no link at all. Falling back
//     would let the thread settle on the branch's PR while the user's linked PR
//     is still open;
//   - a lookup that throws is unknown too, so the caller fails closed.
//
// gh access is injected so this is testable without the CLI.

export interface PullRequestStateRef {
  number: number;
  url: string;
  repository: string;
}

export interface ThreadPullRequestCheckDeps {
  fetchState: (ref: PullRequestStateRef) => Promise<GitHubPullRequestState | null>;
  /** Branch discovery returns whether the lookup was available, so a missing or
   *  unauthenticated gh is unknown rather than "no PR". */
  fetchBranchPr: (
    branch: string,
  ) => Promise<{ available: boolean; pullRequest: GitHubPullRequestState | null }>;
}

export interface ThreadPullRequestCheckInput {
  link: ThreadPullRequestLink | null;
  branch: string | null;
}

export interface ThreadPullRequestCheckOutcome {
  /** The resolved PR, or null when there is none (or it could not be seen). */
  link: ThreadPullRequestLink | null;
  /** True when a lookup failed or an explicit link could not be resolved — the
   *  caller must not read `link: null` as "no PR". */
  unavailable: boolean;
}

function linkFromState(
  base: { repository: string; number: number; url: string },
  state: GitHubPullRequestState,
  checkedAt: number,
): ThreadPullRequestLink {
  const mergedAt = state.mergedAt ? Date.parse(state.mergedAt) : Number.NaN;
  return {
    repository: base.repository,
    number: state.number > 0 ? state.number : base.number,
    url: state.url || base.url,
    state: state.state,
    checkedAt,
    mergedAt: Number.isFinite(mergedAt) ? mergedAt : null,
  };
}

/** Resolve the pull request a thread should settle on, if any. */
export async function checkThreadPullRequest(
  input: ThreadPullRequestCheckInput,
  deps: ThreadPullRequestCheckDeps,
): Promise<ThreadPullRequestCheckOutcome> {
  const checkedAt = Date.now();
  if (input.link) {
    try {
      const state = await deps.fetchState({
        number: input.link.number,
        url: input.link.url,
        repository: input.link.repository,
      });
      // An explicit link that resolves to nothing is unknown, never a reason to
      // fall back to the branch's PR.
      if (!state) return { link: null, unavailable: true };
      return { link: linkFromState(input.link, state, checkedAt), unavailable: false };
    } catch {
      return { link: null, unavailable: true };
    }
  }
  if (!input.branch) return { link: null, unavailable: false };
  try {
    const outcome = await deps.fetchBranchPr(input.branch);
    if (!outcome.available) return { link: null, unavailable: true };
    if (!outcome.pullRequest) return { link: null, unavailable: false };
    return {
      link: linkFromState({ repository: "", number: 0, url: "" }, outcome.pullRequest, checkedAt),
      unavailable: false,
    };
  } catch {
    return { link: null, unavailable: true };
  }
}

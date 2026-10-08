// Pull requests linked to a thread. A thread may have an explicit link the user
// set (any PR, from any repo) or a branch PR that git can discover from the
// thread's branch. The settled rules the rest of the app relies on live here,
// pure and testable:
//
//   - "the same pull request" is repository (case-insensitive) plus number;
//     when a number is unknown, the URL is the fallback identity.
//   - a merge is terminal: once merged, a thread is a settle candidate unless
//     the user wrote to it afterwards.
//
// Disk/gh access stays out of this module; callers hand it what they read.

export type ThreadPullRequestState = "open" | "merged" | "closed" | "unknown";

/** A pull request as kone remembers it on a thread. `checkedAt`/`mergedAt` are
 *  epoch ms from the last check; both null until a PR has been looked up. */
export interface ThreadPullRequestLink {
  /** "owner/repo" when known; "" when the source could not name one. */
  repository: string;
  number: number;
  url: string;
  state: ThreadPullRequestState;
  checkedAt: number | null;
  mergedAt: number | null;
}

/** The subset a link input must carry; the rest defaults. */
export interface ThreadPullRequestLinkInput {
  repository?: string | null;
  number?: number | null;
  url: string;
  state?: ThreadPullRequestState | null;
  checkedAt?: number | null;
  mergedAt?: number | null;
}

/** Normalize a repository slug for comparison: trim and lower-case, since
 *  GitHub treats owner/repo case-insensitively. Empty reads as unknown. */
export function normalizeRepository(repository: string | null | undefined): string | null {
  const trimmed = repository?.trim() ?? "";
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

/** Coerce a raw stored state string to the known set; anything else is
 *  `unknown` rather than a guess. */
export function threadPullRequestState(value: string | null | undefined): ThreadPullRequestState {
  return value === "open" || value === "merged" || value === "closed" ? value : "unknown";
}

/** Complete a partial link into a stored one, dropping a non-positive number
 *  and an empty URL (a link with neither is not a link). */
export function toThreadPullRequestLink(
  input: ThreadPullRequestLinkInput,
): ThreadPullRequestLink | null {
  const url = input.url?.trim() ?? "";
  const number = Number.isFinite(input.number) && (input.number ?? 0) > 0 ? Number(input.number) : 0;
  if (!url && number === 0) return null;
  return {
    repository: input.repository?.trim() ?? "",
    number,
    url,
    state: threadPullRequestState(input.state),
    checkedAt: input.checkedAt ?? null,
    mergedAt: input.mergedAt ?? null,
  };
}

/** Whether two links name the same pull request: repository and number when
 *  both are known, else URL. A link with neither field matches nothing. */
export function samePullRequest(
  a: Pick<ThreadPullRequestLink, "repository" | "number" | "url">,
  b: Pick<ThreadPullRequestLink, "repository" | "number" | "url">,
): boolean {
  const repoA = normalizeRepository(a.repository);
  const repoB = normalizeRepository(b.repository);
  if (a.number > 0 && b.number > 0) {
    if (repoA !== null && repoB !== null) return repoA === repoB && a.number === b.number;
    return a.number === b.number;
  }
  const urlA = a.url.trim();
  const urlB = b.url.trim();
  return urlA.length > 0 && urlA === urlB;
}

/** A merged PR is what settles a thread. A closed-but-unmerged PR does not:
 *  the work may still be wanted, just delivered another way. */
export function pullRequestMerged(
  link: Pick<ThreadPullRequestLink, "state" | "mergedAt">,
): boolean {
  return link.state === "merged" || (link.mergedAt !== null && link.mergedAt > 0);
}

/** The PR a thread should settle on: its explicit link wins; otherwise the
 *  branch-discovered PR. Null when neither exists. */
export function resolveThreadPullRequest(
  linked: ThreadPullRequestLink | null,
  branch: ThreadPullRequestLink | null,
): ThreadPullRequestLink | null {
  return linked ?? branch;
}

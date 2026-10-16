import type { GitHubMergeability, GitHubReviewer } from "~/types/desktop";

// Where a pull request stands: the one thing in its way, in the order it would
// have to be dealt with. A draft isn't asking for anything yet, a conflict
// blocks everything after it, red checks come before reviews, a review someone
// still owes comes before the repository's own merge rules, and only a PR that
// clears all of that, on a branch GitHub has said merges cleanly, is ready.
//
// The list's rows, counts, sort and filter and the open pull request's verdict
// all read this one rule, so a row can never say "ready" while its card says
// "needs review".

export type PrStand =
  | "ready"
  | "review"
  | "running"
  | "changes"
  | "failing"
  | "conflict"
  | "blocked"
  | "behind"
  | "checking"
  | "draft"
  | "merged"
  | "closed";

export interface PrStandInfo {
  id: PrStand;
  label: string;
  /** The token its dot and bar segment wear. */
  tone: string;
}

/** Every stand, in the order a list of them sorts: ready first. */
export const PR_STANDS: PrStandInfo[] = [
  { id: "ready", label: "Ready to merge", tone: "var(--ok)" },
  { id: "review", label: "Needs review", tone: "var(--ink-soft)" },
  { id: "running", label: "Checks running", tone: "var(--warn)" },
  { id: "checking", label: "Checking", tone: "color-mix(in srgb, var(--warn) 45%, transparent)" },
  { id: "behind", label: "Behind base", tone: "color-mix(in srgb, var(--warn) 70%, var(--ink))" },
  { id: "blocked", label: "Blocked", tone: "color-mix(in srgb, var(--accent) 60%, var(--ink))" },
  { id: "changes", label: "Changes requested", tone: "var(--accent)" },
  { id: "failing", label: "Checks failing", tone: "var(--danger)" },
  { id: "conflict", label: "Has conflicts", tone: "color-mix(in srgb, var(--danger) 55%, var(--ink))" },
  { id: "draft", label: "Draft", tone: "color-mix(in srgb, var(--ink) 22%, transparent)" },
  { id: "merged", label: "Merged", tone: "color-mix(in srgb, var(--ink) 45%, transparent)" },
  { id: "closed", label: "Closed", tone: "color-mix(in srgb, var(--ink) 15%, transparent)" },
];
export const PR_STAND = new Map(PR_STANDS.map((s) => [s.id, s]));
export const PR_STAND_RANK = new Map(PR_STANDS.map((s, i) => [s.id, i]));

/** What the rule needs to know; a list row and a full detail both carry it. */
export interface PrStandInput {
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  mergeability: GitHubMergeability;
  reviewDecision: "approved" | "changes-requested" | "review-required" | null;
  reviewers: Pick<GitHubReviewer, "state">[];
  failingChecks: number;
  pendingChecks: number;
}

export function prStandOf(pr: PrStandInput): PrStand {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.isDraft || pr.mergeability === "draft") return "draft";
  if (pr.mergeability === "conflicting") return "conflict";
  if (pr.failingChecks > 0) return "failing";
  if (pr.reviewDecision === "changes-requested") return "changes";
  if (pr.pendingChecks > 0) return "running";
  // An open request outranks an approval: someone asked to look again is who
  // this waits on, whatever the decision said before they were asked.
  if (pr.reviewDecision === "review-required" || pr.reviewers.some((r) => r.state === "pending")) return "review";
  if (pr.mergeability === "blocked") return "blocked";
  if (pr.mergeability === "behind") return "behind";
  if (pr.mergeability === "unknown") return "checking";
  return "ready";
}

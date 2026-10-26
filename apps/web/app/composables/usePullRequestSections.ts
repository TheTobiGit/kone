import { onScopeDispose, reactive, shallowRef } from "vue";
import type { GitHubPullRequestDetail, GitHubPullRequestSection } from "~/types/desktop";

export const pullRequestSections: readonly GitHubPullRequestSection[] = [
  "summary", "conversation", "checks", "files", "merge",
];

export type PullRequestSectionState = {
  pending: boolean;
  ready: boolean;
  error: string | null;
};

type ReadDetail = (
  number: number,
  fresh?: boolean,
  section?: GitHubPullRequestSection,
) => Promise<GitHubPullRequestDetail | null>;

function initialSection(): PullRequestSectionState {
  return { pending: false, ready: false, error: null };
}

function projectSection(section: GitHubPullRequestSection, detail: GitHubPullRequestDetail): Partial<GitHubPullRequestDetail> {
  switch (section) {
    case "summary":
      return {
        number: detail.number, title: detail.title, state: detail.state,
        isDraft: detail.isDraft, url: detail.url, body: detail.body,
        author: detail.author, branch: detail.branch, headOid: detail.headOid,
        base: detail.base, forkOwner: detail.forkOwner, createdAt: detail.createdAt,
        relative: detail.relative, updatedAt: detail.updatedAt, mergedAt: detail.mergedAt,
        closedAt: detail.closedAt, mergedBy: detail.mergedBy, labels: detail.labels,
        assignees: detail.assignees, milestone: detail.milestone,
      };
    case "conversation":
      return { reviews: detail.reviews, comments: detail.comments, commits: detail.commits };
    case "checks":
      return { checks: detail.checks, checkRuns: detail.checkRuns };
    case "files":
      return { files: detail.files, additions: detail.additions, deletions: detail.deletions, changedFiles: detail.changedFiles };
    case "merge":
      return { mergeability: detail.mergeability, reviewDecision: detail.reviewDecision, mergeMethods: detail.mergeMethods, canWrite: detail.canWrite, canTriage: detail.canTriage };
  }
}

/** Each read owns only its section, so a slower response cannot erase sections already shown. */
export function usePullRequestSections(read: ReadDetail) {
  const pr = shallowRef<GitHubPullRequestDetail | null>(null);
  const sections = reactive({
    summary: initialSection(), conversation: initialSection(), checks: initialSection(),
    files: initialSection(), merge: initialSection(),
  });
  let currentNumber: number | null = null;
  let generation = 0;
  let disposed = false;
  const requests = { summary: 0, conversation: 0, checks: 0, files: 0, merge: 0 };

  async function request(section: GitHubPullRequestSection, fresh: boolean) {
    if (currentNumber === null || disposed) return;
    const number = currentNumber;
    const run = generation;
    const id = ++requests[section];
    const state = sections[section];
    state.pending = true;
    state.error = null;
    const active = () => !disposed && generation === run && requests[section] === id;
    try {
      const detail = await read(number, fresh, section);
      if (!active()) return;
      if (!detail) throw new Error("Could not load this section.");
      // Older full-detail defaults grant permissions when omitted; section reads must wait for them.
      const initial = { ...detail, canWrite: false, canTriage: false, mergeMethods: [] };
      pr.value = { ...(pr.value ?? initial), ...projectSection(section, detail) };
      state.ready = true;
    } catch (error) {
      if (active()) state.error = error instanceof Error ? error.message : "Could not load this section.";
    } finally {
      if (active()) state.pending = false;
    }
  }

  async function load(number: number, fresh = false) {
    if (disposed) return;
    generation++;
    if (currentNumber !== number) {
      pr.value = null;
      for (const section of pullRequestSections) Object.assign(sections[section], initialSection());
    }
    currentNumber = number;
    await Promise.all(pullRequestSections.map((section) => request(section, fresh)));
  }

  function retry(section: GitHubPullRequestSection) {
    return request(section, true);
  }

  function adopt(detail: GitHubPullRequestDetail) {
    if (disposed) return;
    generation++;
    currentNumber = detail.number;
    pr.value = detail;
    for (const section of pullRequestSections) Object.assign(sections[section], { pending: false, ready: true, error: null });
  }

  onScopeDispose(() => { disposed = true; generation++; });
  return { pr, sections, load, retry, adopt };
}

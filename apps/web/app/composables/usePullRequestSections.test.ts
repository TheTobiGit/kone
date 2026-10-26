import { afterEach, describe, expect, test } from "bun:test";
import { effectScope, type EffectScope } from "vue";
import type { GitHubPullRequestDetail, GitHubPullRequestSection } from "~/types/desktop";
import { pullRequestSections, usePullRequestSections } from "./usePullRequestSections";

function detail(number = 42): GitHubPullRequestDetail {
  return {
    number, title: "Improve PR details", state: "open", isDraft: false, url: "https://github.com/owner/repo/pull/42",
    body: "Description", author: null, branch: "feature", headOid: "head", base: "main", forkOwner: null,
    createdAt: "2026-01-01", relative: "today", updatedAt: null, mergedAt: null, closedAt: null, mergedBy: null,
    additions: 12, deletions: 3, changedFiles: 1, mergeability: "clean", reviewDecision: "approved",
    checks: "passing", checkRuns: [], labels: [], assignees: [], reviews: [], comments: [], commits: [],
    files: [{ path: "app.vue", additions: 12, deletions: 3, change: "modified" }], milestone: null,
    mergeMethods: ["squash"], canWrite: true, canTriage: true,
  };
}
const scopes: EffectScope[] = [];
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()));
function harness() {
  const reads: Array<{ number: number; fresh: boolean | undefined; section: GitHubPullRequestSection | undefined; resolve: (value: GitHubPullRequestDetail | null) => void; reject: (error: Error) => void }> = [];
  const scope = effectScope();
  scopes.push(scope);
  const state = scope.run(() => usePullRequestSections((number, fresh, section) => new Promise((resolve, reject) => {
    reads.push({ number, fresh, section, resolve, reject });
  })))!;
  return { state, reads, scope };
}

const flush = () => Promise.resolve();

describe("progressive pull request sections", () => {
  test("starts every section together and displays files before summary", async () => {
    const { state, reads } = harness();
    const done = state.load(42);
    expect(reads.map((read) => read.section)).toEqual([...pullRequestSections]);
    expect(Object.values(state.sections).every((section) => section.pending)).toBe(true);
    reads[3]!.resolve(detail());
    await flush();
    expect(state.pr.value?.files[0]?.path).toBe("app.vue");
    expect(state.sections.files.ready).toBe(true);
    expect(state.sections.summary.ready).toBe(false);
    expect(state.sections.summary.pending).toBe(true);
    expect(state.pr.value?.canWrite).toBe(false);
    expect(state.pr.value?.canTriage).toBe(false);
    expect(state.pr.value?.mergeMethods).toEqual([]);
    for (const read of reads.filter((read) => read.section !== "files")) read.resolve(detail());
    await done;
    expect(Object.values(state.sections).every((section) => section.ready && !section.pending)).toBe(true);
  });

  test("slower section defaults never erase previously loaded fields", async () => {
    const { state, reads } = harness();
    const done = state.load(42);
    reads[3]!.resolve(detail());
    await flush();
    reads[0]!.resolve({ ...detail(), files: [], additions: 0, canWrite: false, checks: "none" });
    await flush();
    expect(state.pr.value?.files).toHaveLength(1);
    expect(state.pr.value?.additions).toBe(12);
    reads[4]!.resolve(detail());
    await flush();
    reads[2]!.resolve({ ...detail(), title: "", canWrite: false, files: [] });
    reads[1]!.resolve({ ...detail(), title: "", canWrite: false, checks: "none", files: [] });
    await done;
    expect(state.pr.value?.title).toBe("Improve PR details");
    expect(state.pr.value?.checks).toBe("passing");
    expect(state.pr.value?.canWrite).toBe(true);
  });

  test("null sections fail independently and can retry without replacing other sections", async () => {
    const { state, reads } = harness();
    const done = state.load(42);
    for (const read of reads) read.resolve(read.section === "summary" ? null : detail());
    await done;
    expect(state.sections.summary).toMatchObject({ ready: false, pending: false, error: "Could not load this section." });
    expect(state.sections.files.ready).toBe(true);
    const retry = state.retry("summary");
    expect(reads[5]).toMatchObject({ number: 42, fresh: true, section: "summary" });
    reads[5]!.resolve(detail());
    await retry;
    expect(state.sections.summary).toEqual({ ready: true, pending: false, error: null });
  });

  test("failed refresh keeps successful data visible with an error", async () => {
    const { state, reads } = harness();
    state.adopt(detail());
    const done = state.load(42, true);
    expect(state.sections.files.ready).toBe(true);
    expect(state.sections.files.pending).toBe(true);
    for (const read of reads) read.reject(new Error("Offline"));
    await done;
    expect(state.pr.value?.files).toHaveLength(1);
    expect(state.sections.files).toEqual({ ready: true, pending: false, error: "Offline" });
  });

  test("switching PRs discards every old completion and resets readiness", async () => {
    const { state, reads } = harness();
    const old = state.load(42);
    reads[0]!.resolve(detail());
    await flush();
    const next = state.load(43);
    expect(state.pr.value).toBeNull();
    expect(state.sections.summary.ready).toBe(false);
    for (const read of reads.slice(0, 5)) read.resolve(detail(42));
    await old;
    expect(state.pr.value).toBeNull();
    for (const read of reads.slice(5)) read.resolve(detail(43));
    await next;
    expect(state.pr.value?.number).toBe(43);
  });

  test("new refresh, retry, adoption and disposal each invalidate stale reads", async () => {
    const { state, reads, scope } = harness();
    const old = state.load(42);
    const latest = state.load(42, true);
    for (const read of reads.slice(0, 5)) read.resolve(detail());
    await old;
    expect(state.pr.value).toBeNull();
    const retry = state.retry("files");
    reads[8]!.resolve(detail());
    await flush();
    expect(state.sections.files.ready).toBe(false);
    reads[10]!.resolve(detail());
    await retry;
    state.adopt({ ...detail(), title: "Adopted" });
    for (const read of reads.slice(5, 10)) read.resolve(detail());
    await latest;
    expect(state.pr.value?.title).toBe("Adopted");
    const pending = state.retry("summary");
    scope.stop();
    reads[11]!.resolve({ ...detail(), title: "Stale" });
    await pending;
    expect(state.pr.value?.title).toBe("Adopted");
  });
});

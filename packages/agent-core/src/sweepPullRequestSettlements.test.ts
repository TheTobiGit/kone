import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import type { ThreadPullRequestLink } from "./threadPullRequest.js";
import type { ThreadPullRequestCandidate } from "./store/threadPullRequest.js";
import type { ProviderAdapter } from "./types.js";

const userDataDir = mkdtempSync(path.join(tmpdir(), "kone-pr-settle-test-"));
setUserDataDir(userDataDir);

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

let AgentServiceCtor: typeof import("./AgentService.js").AgentService;

class FakeSettleHistory {
  candidates: ThreadPullRequestCandidate[] = [];
  busy = new Set<string>();
  userAt = new Map<string, number | null>();
  recorded: Array<{ threadId: string; state: string; mergedAt: number | null }> = [];
  attempts: string[] = [];
  links = new Map<string, ThreadPullRequestLink | null>();
  candidateById = new Map<string, ThreadPullRequestCandidate>();
  done = new Set<string>();
  metas = new Map<string, { provider: string }>();

  settleThreadPullRequestCandidates(limit: number, _notCheckedAfter?: number) {
    return this.candidates.slice(0, limit);
  }
  threadPullRequestCandidate(threadId: string): ThreadPullRequestCandidate | null {
    const base = this.candidateById.get(threadId);
    if (!base) return null;
    return { ...base, link: this.links.get(threadId) ?? null };
  }
  threadIsBusy(threadId: string) {
    return this.busy.has(threadId);
  }
  threadIsSettleEligible(threadId: string) {
    return this.metas.has(threadId) && !this.done.has(threadId);
  }
  latestUserAuthoredAt(threadId: string) {
    return this.userAt.get(threadId) ?? null;
  }
  recordThreadPullRequestChecked(
    threadId: string,
    input: { state: string; mergedAt: number | null },
  ) {
    this.recorded.push({ threadId, state: input.state, mergedAt: input.mergedAt });
  }
  recordThreadPullRequestAttempt(threadId: string) {
    this.attempts.push(threadId);
  }
  threadMeta(threadId: string) {
    const meta = this.metas.get(threadId);
    return meta ? { threadId, provider: meta.provider } : null;
  }
  setDone(threadId: string, done: boolean) {
    if (done) this.done.add(threadId);
    else this.done.delete(threadId);
  }
  // Unused by the sweep but part of the injected slice's shape.
  setArchived() {
    return { ok: false as const, reason: "missing" as const };
  }
  staleThreadIds() {
    return [];
  }
  setTitleIfAuto() {
    return false;
  }
  titleOrigin() {
    return "auto" as const;
  }
  titleMessages() {
    return [];
  }
  threadWorkspace() {
    return null;
  }
  threadPullRequestLink(threadId: string) {
    return this.links.get(threadId) ?? null;
  }
  setThreadPullRequestLink() {
    return false;
  }
  clearThreadPullRequestLink() {
    return false;
  }
}

const history = new FakeSettleHistory();
let service: import("./AgentService.js").AgentService;
const closed: string[] = [];
const scripts: string[] = [];
let checkerResult: ThreadPullRequestLink | null = null;
let checkerCalls = 0;
/** When set, the checker waits on this before answering. */
let checkerGate: Promise<void> | null = null;
/** When set, closeIdleShells waits on this, and `closeStarted` fires first. */
let closeGate: Promise<void> | null = null;
let closeStarted: (() => void) | null = null;

/** A minimal provider so the service can hold a live session in a test. */
class LiveAdapter {
  provider = "codex" as const;
  capabilities = {
    sessionModelSwitch: "unsupported" as const,
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
  };
  async startSession(input: { threadId: string }) {
    return { threadId: input.threadId, provider: "codex" as const };
  }
  async stopSession() {}
  async stopAll() {}
  async listSessions(): Promise<unknown[]> {
    return [];
  }
}

beforeAll(async () => {
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  service = new AgentServiceCtor({
    retentionSweepMs: 0,
    pullRequestSweepMs: 0,
    // SAFETY: the fake implements exactly the history methods the sweep reads.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    historyStore: history as unknown as import("./AgentService.js").AgentServiceOptions["historyStore"],
    pullRequestChecker: async () => {
      checkerCalls++;
      if (checkerGate) await checkerGate;
      return checkerResult;
    },
    // SAFETY: the minimal adapter is enough for a service that only starts a
    // session to occupy a thread.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    adapters: () => [new LiveAdapter() as unknown as ProviderAdapter],
    closeIdleShells: async ({ threadId }) => {
      closeStarted?.();
      if (closeGate) await closeGate;
      closed.push(threadId);
    },
    runSettleScript: async ({ cwd }) => {
      scripts.push(cwd);
    },
  });
  service.onEvent(() => {});
});

beforeEach(() => {
  history.candidates = [];
  history.busy.clear();
  history.userAt.clear();
  history.recorded = [];
  history.attempts = [];
  history.links.clear();
  history.candidateById.clear();
  history.done.clear();
  history.metas.clear();
  closed.length = 0;
  scripts.length = 0;
  checkerCalls = 0;
  checkerResult = null;
  checkerGate = null;
  closeGate = null;
  closeStarted = null;
});

afterAll(() => {});

function candidate(threadId: string, link: ThreadPullRequestLink | null): ThreadPullRequestCandidate {
  history.metas.set(threadId, { provider: "claudeAgent" });
  history.links.set(threadId, link);
  const entry: ThreadPullRequestCandidate = {
    threadId,
    projectPath: "/repo",
    branch: "feature",
    worktreePath: "/repo/.worktrees/feature",
    link,
  };
  history.candidateById.set(threadId, entry);
  return entry;
}

const merged: ThreadPullRequestLink = {
  repository: "acme/site",
  number: 7,
  url: "https://github.com/acme/site/pull/7",
  state: "merged",
  checkedAt: 500,
  mergedAt: 1_000,
};

describe("AgentService.sweepPullRequestSettlements", () => {
  test("settles a thread whose PR merged, closing shells and running the script", async () => {
    history.candidates = [candidate("t1", merged)];
    checkerResult = merged;
    const settled = await service.sweepPullRequestSettlements();
    expect(settled).toBe(1);
    expect(history.done.has("t1")).toBe(true);
    expect(closed).toEqual(["t1"]);
    expect(scripts).toEqual(["/repo/.worktrees/feature"]);
    expect(history.recorded).toEqual([{ threadId: "t1", state: "merged", mergedAt: 1_000 }]);
  });

  test("leaves a thread the user wrote to after the merge", async () => {
    history.candidates = [candidate("t2", merged)];
    history.userAt.set("t2", 2_000);
    checkerResult = merged;
    expect(await service.sweepPullRequestSettlements()).toBe(0);
    expect(history.done.has("t2")).toBe(false);
    expect(closed).toHaveLength(0);
  });

  test("skips a thread with work in flight without checking its PR", async () => {
    history.candidates = [candidate("t3", merged)];
    history.busy.add("t3");
    checkerResult = merged;
    expect(await service.sweepPullRequestSettlements()).toBe(0);
    expect(checkerCalls).toBe(0);
  });

  test("records an open PR but does not settle", async () => {
    history.candidates = [candidate("t4", merged)];
    checkerResult = { ...merged, state: "open", mergedAt: null };
    expect(await service.sweepPullRequestSettlements()).toBe(0);
    expect(history.done.has("t4")).toBe(false);
    expect(history.recorded).toEqual([{ threadId: "t4", state: "open", mergedAt: null }]);
  });

  test("a merge with no timestamp settles when the user has not written", async () => {
    history.candidates = [candidate("t5", merged)];
    checkerResult = { ...merged, mergedAt: null };
    expect(await service.sweepPullRequestSettlements()).toBe(1);
    expect(history.done.has("t5")).toBe(true);
  });

  test("a merge with no timestamp does not settle a thread the user wrote to", async () => {
    history.candidates = [candidate("t6", merged)];
    history.userAt.set("t6", Date.now());
    checkerResult = { ...merged, mergedAt: null };
    expect(await service.sweepPullRequestSettlements()).toBe(0);
    expect(history.done.has("t6")).toBe(false);
  });

  test("a second tick while a sweep is in flight does nothing", async () => {
    history.candidates = [candidate("t1", merged)];
    checkerResult = merged;
    let release: () => void = () => {};
    checkerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = service.sweepPullRequestSettlements();
    // The tick fires again while the first pass awaits its check.
    expect(await service.sweepPullRequestSettlements()).toBe(0);
    release();
    expect(await first).toBe(1);
    expect(scripts).toHaveLength(1);
    expect(closed).toEqual(["t1"]);
  });

  test("drops a result when the link changed while the check ran", async () => {
    history.candidates = [candidate("t1", merged)];
    checkerResult = merged;
    let release: () => void = () => {};
    checkerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = service.sweepPullRequestSettlements();
    // The user links a different PR while gh is in flight.
    history.links.set("t1", { ...merged, number: 99, url: "https://x/pull/99" });
    release();

    expect(await pending).toBe(0);
    expect(history.done.has("t1")).toBe(false);
    // No stale result written into the new link's columns.
    expect(history.recorded).toHaveLength(0);
  });

  test("a busy thread is skipped and its check time advances", async () => {
    history.candidates = [candidate("t1", merged)];
    history.busy.add("t1");
    checkerResult = merged;
    expect(await service.sweepPullRequestSettlements()).toBe(0);
    expect(checkerCalls).toBe(0);
    expect(history.attempts).toContain("t1");
  });

  test("a null or failed check advances the backoff without writing state", async () => {
    history.candidates = [candidate("t1", merged)];
    checkerResult = null;
    expect(await service.sweepPullRequestSettlements()).toBe(0);
    expect(history.recorded).toHaveLength(0);
    expect(history.attempts).toContain("t1");
  });

  test("a live session blocks settlement even when the store is not busy", async () => {
    history.candidates = [candidate("t-live", merged)];
    checkerResult = merged;
    await service.startSession({ threadId: "t-live", provider: "codex", cwd: "/repo" });
    try {
      expect(await service.sweepPullRequestSettlements()).toBe(0);
      // Blocked before the lookup: no gh call for a thread with a live session.
      expect(checkerCalls).toBe(0);
      expect(history.done.has("t-live")).toBe(false);
    } finally {
      await service.stopSession("t-live");
    }
  });

  test("drops a result when the branch or workspace changed while the check ran", async () => {
    history.candidates = [candidate("t1", null)];
    checkerResult = merged;
    let release: () => void = () => {};
    checkerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = service.sweepPullRequestSettlements();
    // The thread moves to a different worktree/branch while gh is in flight.
    history.candidateById.set("t1", {
      threadId: "t1",
      projectPath: "/repo",
      branch: "other",
      worktreePath: "/repo/.worktrees/other",
      link: null,
    });
    release();

    expect(await pending).toBe(0);
    expect(history.done.has("t1")).toBe(false);
    // Cleanup is not run against the stale directory.
    expect(closed).toHaveLength(0);
    expect(scripts).toHaveLength(0);
  });

  test("does not start the settle script after stopAll during cleanup", async () => {
    history.candidates = [candidate("t1", merged)];
    checkerResult = merged;
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    closeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = service.sweepPullRequestSettlements();
    await started;
    await service.stopAll();
    release();

    expect(await pending).toBe(1);
    // Shutdown was requested while cleanup ran: the script must not start.
    expect(scripts).toHaveLength(0);
  });
});

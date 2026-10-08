import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import type { ThreadPullRequestLink } from "./threadPullRequest.js";
import type { ThreadPullRequestCandidate } from "./store/threadPullRequest.js";
import type { ProviderAdapter, RuntimeEvent } from "./types.js";

const userDataDir = mkdtempSync(path.join(tmpdir(), "kone-pr-settle-test-"));
setUserDataDir(userDataDir);

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

let AgentServiceCtor: typeof import("./AgentService.js").AgentService;

class FakeSettleHistory {
  candidates: ThreadPullRequestCandidate[] = [];
  busy = new Set<string>();
  /** Threads with a queued-but-not-promoted follow-up — the store's own busy
   *  read that threadIsBusy folds in. */
  queued = new Set<string>();
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
    return this.busy.has(threadId) || this.queued.has(threadId);
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

/** A minimal provider so the service can hold a live session and receive real
 *  turn events in a test. */
class LiveAdapter {
  provider = "codex" as const;
  /** The service's emit closure, as a real adapter holds it — used to deliver
   *  the turn.started/turn.completed events that mark a thread busy. */
  static emit: ((event: import("./types.js").RuntimeEvent) => void) | null = null;
  capabilities = {
    sessionModelSwitch: "unsupported" as const,
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
    compaction: { kind: "native" as const },
  };
  /** When set, the service's session start waits on it — lets a test hold the
   *  startingSessions window open. */
  static startGate: Promise<void> | null = null;
  /** When set, the adapter's native compaction waits on it, holding the
   *  compactingThreads claim open for a test. */
  static compactGate: Promise<void> | null = null;
  static compactStarted: (() => void) | null = null;
  constructor(emit: (event: import("./types.js").RuntimeEvent) => void) {
    LiveAdapter.emit = emit;
  }
  async startSession(input: { threadId: string }) {
    if (LiveAdapter.startGate) await LiveAdapter.startGate;
    return { threadId: input.threadId, provider: "codex" as const };
  }
  async compactThread(threadId: string) {
    LiveAdapter.compactStarted?.();
    if (LiveAdapter.compactGate) await LiveAdapter.compactGate;
    // Announce the boundary runCompaction waits for, so the claim can clear.
    const compacted: RuntimeEvent = {
      type: "thread.state.changed",
      threadId,
      provider: "codex",
      at: Date.now(),
      source: "codex.acp",
      state: "compacted",
    };
    LiveAdapter.emit?.(compacted);
  }
  async stopSession() {}
  async stopAll() {}
  async sendTurn(input: { threadId: string }) {
    return { threadId: input.threadId, turnId: "turn-live" };
  }
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
    // session and receives turn events.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    adapters: (emit) => [new LiveAdapter(emit) as unknown as ProviderAdapter],
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
  history.queued.clear();
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
  LiveAdapter.startGate = null;
  LiveAdapter.compactGate = null;
  LiveAdapter.compactStarted = null;
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

  test("an idle live session settles", async () => {
    history.candidates = [candidate("t-live", merged)];
    checkerResult = merged;
    await service.startSession({ threadId: "t-live", provider: "codex", cwd: "/repo" });
    try {
      // A quiescent connected session is not work in flight: it settles.
      expect(await service.sweepPullRequestSettlements()).toBe(1);
      expect(history.done.has("t-live")).toBe(true);
    } finally {
      await service.stopSession("t-live");
    }
  });

  test("a session still starting blocks settlement", async () => {
    history.candidates = [candidate("t-startup", merged)];
    checkerResult = merged;
    let release: () => void = () => {};
    LiveAdapter.startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = service.startSession({ threadId: "t-startup", provider: "codex", cwd: "/repo" });
    try {
      // startingSessions holds the id until the adapter answers; the sweep must
      // not even look up.
      expect(await service.sweepPullRequestSettlements()).toBe(0);
      expect(checkerCalls).toBe(0);
      expect(history.done.has("t-startup")).toBe(false);
    } finally {
      release();
      await starting;
      await service.stopSession("t-startup");
    }
  });

  test("parked work (a pending question) blocks settlement", async () => {
    history.candidates = [candidate("t-parked", merged)];
    checkerResult = merged;
    LiveAdapter.emit?.({
      type: "user-input.requested",
      threadId: "t-parked",
      provider: "codex",
      at: Date.now(),
      source: "codex.acp",
      requestId: "q-1",
      questions: [],
    });
    expect(await service.sweepPullRequestSettlements()).toBe(0);
    expect(history.done.has("t-parked")).toBe(false);
    // Clear the parked ask so it does not leak into the next test.
    LiveAdapter.emit?.({
      type: "user-input.resolved",
      threadId: "t-parked",
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      requestId: "q-1",
      answers: {},
    });
  });

  test("a turn dispatched while the lookup is deferred blocks settlement", async () => {
    history.candidates = [candidate("t1", merged)];
    checkerResult = merged;
    let release: () => void = () => {};
    checkerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = service.sweepPullRequestSettlements();

    // While gh is in flight, the adapter starts a turn on the thread — the real
    // event the service marks it busy on. The store's own busy read stays false.
    LiveAdapter.emit?.({
      type: "turn.started",
      threadId: "t1",
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      turnId: "turn-during-lookup",
    });
    release();

    expect(await pending).toBe(0);
    expect(history.done.has("t1")).toBe(false);
    expect(closed).toHaveLength(0);
    expect(scripts).toHaveLength(0);

    // End the turn so it does not leak into the next test.
    LiveAdapter.emit?.({
      type: "turn.completed",
      threadId: "t1",
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      turnId: "turn-during-lookup",
    });
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

describe("AgentService.sweepPullRequestSettlements — work that blocks settle", () => {
  async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("a queued-but-not-promoted follow-up blocks settlement before the lookup", async () => {
    history.candidates = [candidate("t-q", merged)];
    checkerResult = merged;
    history.queued.add("t-q");
    expect(await service.sweepPullRequestSettlements()).toBe(0);
    // Blocked before gh: no lookup for a thread with a queued follow-up.
    expect(checkerCalls).toBe(0);
    expect(history.done.has("t-q")).toBe(false);
  });

  test("a queued follow-up added during the lookup blocks settlement", async () => {
    history.candidates = [candidate("t-q", merged)];
    checkerResult = merged;
    let release: () => void = () => {};
    checkerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = service.sweepPullRequestSettlements();
    history.queued.add("t-q");
    release();
    expect(await pending).toBe(0);
    expect(history.done.has("t-q")).toBe(false);
    expect(closed).toHaveLength(0);
    expect(scripts).toHaveLength(0);
  });

  test("an in-flight compaction blocks settlement before the lookup", async () => {
    history.candidates = [candidate("t-c", merged)];
    checkerResult = merged;
    await service.startSession({ threadId: "t-c", provider: "codex", cwd: "/repo" });
    let release: () => void = () => {};
    LiveAdapter.compactGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const compactStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    LiveAdapter.compactStarted = started;
    const compacting = service.compactThread("t-c");
    await compactStarted;
    try {
      expect(await service.sweepPullRequestSettlements()).toBe(0);
      expect(checkerCalls).toBe(0);
      expect(history.done.has("t-c")).toBe(false);
    } finally {
      release();
      await compacting;
      await service.stopSession("t-c");
    }
  });

  test("a compaction started during the lookup blocks settlement", async () => {
    history.candidates = [candidate("t-c", merged)];
    checkerResult = merged;
    await service.startSession({ threadId: "t-c", provider: "codex", cwd: "/repo" });
    let releaseChecker: () => void = () => {};
    checkerGate = new Promise<void>((resolve) => {
      releaseChecker = resolve;
    });
    const pending = service.sweepPullRequestSettlements();

    let releaseCompact: () => void = () => {};
    LiveAdapter.compactGate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    const compacting = service.compactThread("t-c");
    await waitFor(() => service.isCompacting("t-c"));
    releaseChecker();
    try {
      expect(await pending).toBe(0);
      expect(history.done.has("t-c")).toBe(false);
      expect(closed).toHaveLength(0);
    } finally {
      releaseCompact();
      await compacting;
      await service.stopSession("t-c");
    }
  });
});

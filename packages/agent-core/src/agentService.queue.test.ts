import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { getUserDataDir, setUserDataDir } from "./userDataDir.js";
import type { ProviderAdapter, RuntimeEvent, RuntimeItem, SendTurnInput, TurnStartResult } from "./types.js";
import type { CheckpointStore } from "./conversationStoreTypes.js";

// The queue's orchestration against the REAL ConversationStore. The suite in
// agentService.test.ts drives a fake store; this one exists because the real
// store answers synchronously and enforces its own claim, index and hold
// rules, and the interleavings below only fail against those.

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly ? new Database(filePath, { readonly: true }) : new Database(filePath);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}

mock.module("./sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

type EmitEvent = (event: RuntimeEvent) => void;
type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
type AgentServiceType = import("./AgentService.js").AgentService;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;
let AgentServiceCtor: typeof import("./AgentService.js").AgentService;
let STEER_CARRY_ON: string;

/** A provider whose sends can be held open, refused, or let through, and
 *  which announces its turns the way the real adapters do. */
class FakeAdapter {
  capabilities = {
    sessionModelSwitch: "unsupported" as const,
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
    /** On for a provider kone steer may interrupt between steps. */
    cancelKeepsCompletedTools: false,
  };
  readonly provider = "codex";
  sent: SendTurnInput[] = [];
  interrupted: string[] = [];
  /** The turn each interrupt landed on — what tells a right interrupt from
   *  one that hit somebody else's turn. */
  interruptedTurns: string[] = [];
  /** Every sendTurn call, accepted or not, with when it came. */
  attempts: number[] = [];
  /** When set, sendTurn throws this. */
  refuse: Error | null = null;
  /** Refuse the way OpenCode does: the turn is announced, then aborted, and
   *  only then does the send reject. */
  abortBeforeRefusing = false;
  /** When set, sendTurn waits on it before accepting. */
  gate: Promise<void> | null = null;
  /** When set, the next send is accepted (its turn announced) and then held
   *  on this before returning — work a delivery does after acceptance, such
   *  as the pre-turn checkpoint. One send only. */
  holdAfterAccept: Promise<void> | null = null;
  /** The live-steer channel, attached per test (most providers have one). */
  steerTurn?: (input: SendTurnInput) => Promise<TurnStartResult>;
  /** The turn this provider is running right now, as it announced it. */
  liveTurn: string | null = null;
  private turns = 0;
  readonly emit: EmitEvent;
  constructor(emit: EmitEvent) {
    this.emit = (event) => {
      if (event.type === "turn.started") this.liveTurn = event.turnId;
      if ((event.type === "turn.completed" || event.type === "turn.aborted") && this.liveTurn === event.turnId) {
        this.liveTurn = null;
      }
      emit(event);
    };
  }
  async startSession(): Promise<object> {
    return {};
  }
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    this.attempts.push(Date.now());
    if (this.gate) await this.gate;
    const turnId = `turn-${++this.turns}`;
    if (this.abortBeforeRefusing) {
      this.emit({ ...base(input.threadId), type: "turn.started", turnId });
      this.emit({ ...base(input.threadId), type: "turn.aborted", turnId, reason: "failed" });
    }
    if (this.refuse) throw this.refuse;
    this.sent.push(input);
    this.emit({ ...base(input.threadId), type: "turn.started", turnId });
    const held = this.holdAfterAccept;
    this.holdAfterAccept = null;
    if (held) await held;
    return { threadId: input.threadId, turnId };
  }
  async interruptTurn(threadId: string): Promise<void> {
    this.interrupted.push(threadId);
    if (this.liveTurn) this.interruptedTurns.push(this.liveTurn);
  }
  async stopSession(): Promise<void> {
    this.liveTurn = null;
  }
  async stopAll(): Promise<void> {}
  async listSessions(): Promise<unknown[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return false;
  }
  async discover(): Promise<unknown[]> {
    return [];
  }
  async listModels(): Promise<unknown[]> {
    return [];
  }
}

function base(threadId: string) {
  return { threadId, provider: "codex" as const, at: Date.now(), source: "codex.app-server" as const };
}

let store: ConversationStoreType;
let service: AgentServiceType;
let adapter: FakeAdapter;
let events: RuntimeEvent[] = [];
let seq = 0;

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  STEER_CARRY_ON = (await import("./AgentService.js")).STEER_CARRY_ON;
});

beforeEach(() => {
  setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-queue-service-test-")));
  store = new ConversationStoreCtor();
  events = [];
  service = new AgentServiceCtor({
    store,
    // One store on the database: the default checkpoint store is the app-wide
    // one, and a second store opening the same file releases live claims.
    checkpointStore: null,
    queueRetryDelaysMs: [20, 20],
    retentionSweepMs: 0,
    wedgeSweepMs: 60_000,
    idleSweepMs: 60_000,
    adapters: (emit) => {
      adapter = new FakeAdapter(emit);
      // SAFETY: the fake covers every adapter method these queue paths reach.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      return [adapter] as unknown as ProviderAdapter[];
    },
  });
  service.onEvent((e) => events.push(e));
});

afterAll(async () => {
  await service.stopAll();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function waitFor(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2_000) throw new Error("timed out");
    await tick();
  }
}

/** A thread with a live session, as the renderer leaves it. */
async function openThread(): Promise<string> {
  const threadId = `t-${++seq}`;
  store.ensureThread({ threadId, projectPath: "/repo", provider: "codex" });
  await service.startSession({ threadId, provider: "codex", cwd: "/tmp", mode: "ask" });
  return threadId;
}

/** Journal a prompt and queue it straight in the store, as a send that
 *  landed while busy leaves it. */
function queueRow(threadId: string, text: string): string {
  const queueId = `q-${++seq}`;
  store.recordUserBlock({ blockId: `ub-${queueId}`, threadId, text });
  expect(store.enqueueQueuedTurn({ queueId, threadId, userBlockId: `ub-${queueId}`, input: text })).toBe(true);
  return queueId;
}

/** Turn a waiting row into a held one, the way exhausted retries leave it. */
function hold(threadId: string, queueId: string): void {
  expect(store.claimNextQueuedTurn(threadId)?.queueId).toBe(queueId);
  expect(store.releaseQueuedTurn(queueId, "failed")).toBe(true);
}

const stateOf = (threadId: string, queueId: string) =>
  store.listQueuedTurns(threadId).find((r) => r.queueId === queueId)?.state ?? "gone";

const ofType = <T extends RuntimeEvent["type"]>(threadId: string, type: T) =>
  events.filter((e): e is Extract<RuntimeEvent, { type: T }> => e.threadId === threadId && e.type === type);

describe("retry and hold, against the real store", () => {
  test("a refused promotion retries on its backoff, then is held and announced", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const first = queueRow(thread, "one");
    const second = queueRow(thread, "two");
    adapter.refuse = new Error("provider is down");

    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await waitFor(() => stateOf(thread, first) === "failed");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(ofType(thread, "turn.queued-updated").map((u) => u.state)).toEqual([
      "promoting",
      "queued",
      "promoting",
      "queued",
      "promoting",
      "failed",
    ]);
    expect(ofType(thread, "turn.queued-updated").at(-1)).toMatchObject({ attemptCount: 3, error: "provider is down" });
    expect(ofType(thread, "session.warning").at(-1)?.message).toBe(
      "A queued message didn't start after 3 tries (provider is down). It's held in the queue: send it now or remove it.",
    );
    // The held row keeps what was sent after it from running ahead.
    expect(stateOf(thread, second)).toBe("queued");

    // Removing the held row lets the rest run.
    adapter.refuse = null;
    expect(await service.cancelQueuedTurn(thread, first)).toBe(true);
    await waitFor(() => stateOf(thread, second) === "gone");
    expect(adapter.sent.map((s) => s.input)).toEqual(["two"]);
  });

  test("a provider that reports the failed turn before rejecting still gets the backoff", async () => {
    const thread = await openThread();
    const row = queueRow(thread, "flaky");
    adapter.refuse = new Error("provider is down");
    adapter.abortBeforeRefusing = true;

    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "earlier" });
    await waitFor(() => stateOf(thread, row) === "failed");
    await new Promise((resolve) => setTimeout(resolve, 80));

    // The first try plus one per delay, each after its delay — the turn
    // events the failed sends emitted didn't kick early retries.
    expect(adapter.attempts).toHaveLength(3);
    const gaps = adapter.attempts.slice(1).map((at, i) => at - adapter.attempts[i]!);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(18);
    expect(ofType(thread, "turn.queued-updated").at(-1)?.state).toBe("failed");
  });

  for (const how of ["stop", "delete"] as const) {
    test(`a pending retry never fires after the thread's ${how}`, async () => {
      const thread = await openThread();
      queueRow(thread, "doomed");
      adapter.refuse = new Error("not yet");
      adapter.emit({ ...base(thread), type: "turn.completed", turnId: "none" });
      await waitFor(() => ofType(thread, "turn.queued-updated").some((u) => u.retryAt !== undefined));

      if (how === "stop") await service.cancelQueuedTurns(thread);
      else service.cancelQueuedTurnsForDelete(thread);
      const promotingBefore = ofType(thread, "turn.queued-updated").length;
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(ofType(thread, "turn.queued-updated")).toHaveLength(promotingBefore);
      expect(ofType(thread, "turn.queued-cancelled").map((c) => c.reason)).toEqual([
        how === "stop" ? "stop" : "thread-deleted",
      ]);
    });
  }
});

/** Make every release of a claimed queue row fail, as a full or locked disk
 *  does, until the returned call ends the outage. */
function failReleases(): () => void {
  const outage = new Database(path.join(getUserDataDir(), "kone.sqlite"));
  outage.exec(`CREATE TRIGGER release_fails BEFORE UPDATE OF state ON queued_turns
                WHEN OLD.state = 'promoting' AND NEW.state IN ('queued', 'failed')
                BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  return () => {
    outage.exec("DROP TRIGGER release_fails");
    outage.close();
  };
}

/** Make every cancellation of a queue row fail until the returned call ends
 *  the outage. */
function failCancels(): () => void {
  const outage = new Database(path.join(getUserDataDir(), "kone.sqlite"));
  outage.exec(`CREATE TRIGGER cancel_fails BEFORE UPDATE OF state ON queued_turns
                WHEN NEW.state = 'cancelled'
                BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  return () => {
    outage.exec("DROP TRIGGER cancel_fails");
    outage.close();
  };
}

/** Make the queue unreadable and unwritable — its table gone from under the
 *  service — until the returned call ends the outage. */
function loseQueueTable(): () => void {
  const outage = new Database(path.join(getUserDataDir(), "kone.sqlite"));
  outage.exec("ALTER TABLE queued_turns RENAME TO queued_turns_away");
  return () => {
    outage.exec("ALTER TABLE queued_turns_away RENAME TO queued_turns");
    outage.close();
  };
}

// A Stop is the user taking their words back. When the store cannot write
// the cancellation, it is kept and retried: the rows never go out meanwhile,
// and once writes come back they are cancelled, not back in line.
describe("Stop whose cancellation could not be written", () => {
  test("a Stop retry cannot cancel a replacement after its highest row is deleted and the store reopens", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const q1 = queueRow(thread, "take it back");
    const removed = queueRow(thread, "removed during outage");
    const unreadableIds = spyOn(store, "pendingQueueIds").mockReturnValue(null);
    const recover = failCancels();
    try {
      await service.cancelQueuedTurns(thread);
    } finally {
      unreadableIds.mockRestore();
    }
    const raw = new Database(path.join(getUserDataDir(), "kone.sqlite"));
    raw.prepare("DELETE FROM queued_turns WHERE queue_id = ?").run(removed);
    raw.close();
    store.close();
    const reopened = new ConversationStoreCtor();
    const replacement = `q-${++seq}`;
    reopened.recordUserBlock({ blockId: `ub-${replacement}`, threadId: thread, text: "keep this" });
    expect(reopened.enqueueQueuedTurn({ queueId: replacement, threadId: thread, userBlockId: `ub-${replacement}`, input: "keep this" })).toBe(true);
    reopened.close();
    recover();

    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(ofType(thread, "turn.queued-cancelled").map((c) => c.queueId)).toEqual([q1]);
    expect(stateOf(thread, replacement)).toBe("queued");
  });

  test("a Stop reads the durable boundary after another store writes, and spares a later direct insert", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const q1 = queueRow(thread, "first stopped prompt");
    expect(store.queueBoundary()).not.toBeNull();
    const writer = new ConversationStoreCtor();
    const q2 = `q-${++seq}`;
    writer.recordUserBlock({ blockId: `ub-${q2}`, threadId: thread, text: "also stop this" });
    expect(writer.enqueueQueuedTurn({ queueId: q2, threadId: thread, userBlockId: `ub-${q2}`, input: "also stop this" })).toBe(true);
    const unreadableIds = spyOn(store, "pendingQueueIds").mockReturnValue(null);
    const recover = failCancels();
    try {
      await service.cancelQueuedTurns(thread);
    } finally {
      unreadableIds.mockRestore();
    }
    const q3 = `q-${++seq}`;
    writer.recordUserBlock({ blockId: `ub-${q3}`, threadId: thread, text: "keep this" });
    expect(writer.enqueueQueuedTurn({ queueId: q3, threadId: thread, userBlockId: `ub-${q3}`, input: "keep this" })).toBe(true);
    writer.close();
    recover();

    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(ofType(thread, "turn.queued-cancelled").map((c) => c.queueId)).toEqual([q1, q2]);
    expect(stateOf(thread, q3)).toBe("queued");
  });

  test("a stopped row never runs while its cancellation waits, and is cancelled once writes come back", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const q1 = queueRow(thread, "take it back");
    const recover = failCancels();

    await service.cancelQueuedTurns(thread);
    expect(stateOf(thread, q1)).toBe("queued");
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(adapter.attempts).toHaveLength(0);

    recover();
    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(ofType(thread, "turn.queued-cancelled").map((c) => [c.queueId, c.reason])).toEqual([[q1, "stop"]]);
    expect(adapter.attempts).toHaveLength(0);
  });

  test("a row sent now whose release was owed is cancelled, not put back, when Stop lands late", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const q1 = queueRow(thread, "take it back");
    const recoverReleases = failReleases();
    expect(await service.sendQueuedTurnNow(thread, q1)).toBe(false);
    const recoverCancels = failCancels();

    await service.cancelQueuedTurns(thread);
    expect(stateOf(thread, q1)).toBe("promoting");

    recoverReleases();
    recoverCancels();
    await waitFor(() => ofType(thread, "turn.queued-cancelled").length === 1);
    expect(stateOf(thread, q1)).toBe("gone");
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(adapter.attempts).toHaveLength(0);
  });

  test("a Stop that could not read the queue cancels only what was queued before it", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const q1 = queueRow(thread, "take it back");
    const recover = loseQueueTable();

    await service.cancelQueuedTurns(thread);
    await tick();
    recover();
    expect(stateOf(thread, q1)).toBe("queued");
    // The user writes again before the retry lands.
    const q2 = queueRow(thread, "my next message");

    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(ofType(thread, "turn.queued-cancelled").map((c) => c.queueId)).toEqual([q1]);
    expect(stateOf(thread, q2)).toBe("queued");
  });

  test("a Stop that could not read the queue still takes a row queued before the clock moved back", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const now = Date.now();
    const ahead = spyOn(Date, "now").mockReturnValue(now + 60_000);
    let q1: string;
    try {
      q1 = queueRow(thread, "take it back");
    } finally {
      ahead.mockRestore();
    }
    // The clock steps back a minute: the Stop comes "before" the row it stops.
    const behind = spyOn(Date, "now").mockReturnValue(now);
    try {
      const recover = loseQueueTable();
      await service.cancelQueuedTurns(thread);
      recover();
    } finally {
      behind.mockRestore();
    }

    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(ofType(thread, "turn.queued-cancelled").map((c) => c.queueId)).toEqual([q1]);
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(adapter.attempts).toHaveLength(0);
  });

  test("a row written straight to the store after such a Stop, in the same millisecond, is kept", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const q1 = queueRow(thread, "take it back");
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    let q2: string;
    try {
      const recover = loseQueueTable();
      await service.cancelQueuedTurns(thread);
      recover();
      q2 = queueRow(thread, "my next message");
    } finally {
      clock.mockRestore();
    }

    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(ofType(thread, "turn.queued-cancelled").map((c) => c.queueId)).toEqual([q1]);
    expect(stateOf(thread, q2)).toBe("queued");
  });

  test("a prompt queued in the same millisecond as such a Stop, but after it, is kept", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const q1 = queueRow(thread, "take it back");
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    let next: { turnId: string; queued?: boolean };
    try {
      const recover = loseQueueTable();
      await service.cancelQueuedTurns(thread);
      recover();
      store.recordUserBlock({ blockId: "ub-next", threadId: thread, text: "my next message" });
      next = await service.sendTurn({ threadId: thread, input: "my next message", userBlockId: "ub-next" });
    } finally {
      clock.mockRestore();
    }
    expect(next.queued).toBe(true);

    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(ofType(thread, "turn.queued-cancelled").map((c) => c.queueId)).toEqual([q1]);
    expect(stateOf(thread, next.turnId)).toBe("queued");
  });
});

// Send now on a busy thread with no steer channel releases the row to the
// front of the line. When the store cannot write that release, the row is
// still claimed: each must be released once writes come back, and then run.
// A release that lands at once must still leave the row to a drain that runs.
describe("Send now's release, against the real store", () => {
  test("two rows sent now in one outage are both released once writes come back", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const q1 = queueRow(thread, "one");
    const q2 = queueRow(thread, "two");
    const recover = failReleases();

    expect(await service.sendQueuedTurnNow(thread, q1)).toBe(false);
    expect(await service.sendQueuedTurnNow(thread, q2)).toBe(false);
    expect([stateOf(thread, q1), stateOf(thread, q2)]).toEqual(["promoting", "promoting"]);

    recover();
    await waitFor(() => stateOf(thread, q1) === "queued" && stateOf(thread, q2) === "queued");
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await waitFor(() => adapter.sent.length === 1);
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "turn-1" });
    await waitFor(() => adapter.sent.length === 2);
    expect(adapter.sent.map((s) => s.input).sort()).toEqual(["one", "two"]);
  });

  test("a row whose release lands after the running turn ended runs then", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const q1 = queueRow(thread, "one");
    const recover = failReleases();

    expect(await service.sendQueuedTurnNow(thread, q1)).toBe(false);
    // The turn ends while the release still waits: the drain is held back
    // for it, so nothing else starts the row.
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapter.sent).toHaveLength(0);

    recover();
    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(adapter.sent.map((s) => s.input)).toEqual(["one"]);
    // The turn it would have stopped was already over.
    expect(adapter.interrupted).toHaveLength(0);
  });

  test("a refused send now on an idle thread goes back in line and the queue runs it", async () => {
    const thread = await openThread();
    const q1 = queueRow(thread, "one");
    adapter.refuse = new Error("provider is down");

    await expect(service.sendQueuedTurnNow(thread, q1)).rejects.toThrow("provider is down");
    adapter.refuse = null;

    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(adapter.sent.map((s) => s.input)).toEqual(["one"]);
  });

  test("a refused send now whose release lands late is retried by the queue", async () => {
    const thread = await openThread();
    const q1 = queueRow(thread, "one");
    adapter.refuse = new Error("provider is down");
    const recover = failReleases();

    await expect(service.sendQueuedTurnNow(thread, q1)).rejects.toThrow("provider is down");
    expect(stateOf(thread, q1)).toBe("promoting");

    adapter.refuse = null;
    recover();
    await waitFor(() => stateOf(thread, q1) === "gone");
    expect(adapter.sent.map((s) => s.input)).toEqual(["one"]);
  });
});

describe("Send now, against the real store", () => {
  test("refuses without a session and leaves the row where Send now and remove can reach it", async () => {
    const thread = `t-${++seq}`;
    store.ensureThread({ threadId: thread, projectPath: "/repo", provider: "codex" });
    const row = queueRow(thread, "from before the reload");

    await expect(service.sendQueuedTurnNow(thread, row)).rejects.toThrow("No agent session");

    expect(stateOf(thread, row)).toBe("queued");
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    // The session's own recovery drain may take it first; either way it ran.
    await service.sendQueuedTurnNow(thread, row);
    await waitFor(() => stateOf(thread, row) === "gone");
    expect(adapter.sent.map((s) => s.input)).toEqual(["from before the reload"]);
  });

  test("a held row's replayed send dedupes onto it, and sending it then works", async () => {
    const thread = await openThread();
    const held = queueRow(thread, "held");
    hold(thread, held);

    // The same prompt arriving again (a retrying caller) is the same row.
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const replay = await service.sendTurn({ threadId: thread, input: "held", userBlockId: `ub-${held}` });
    expect(replay.turnId).toBe(held);
    expect(store.listQueuedTurns(thread).map((r) => r.queueId)).toEqual([held]);
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await tick();

    expect(await service.sendQueuedTurnNow(thread, held)).toBe(true);
    expect(stateOf(thread, held)).toBe("gone");
    expect(adapter.sent.map((s) => s.input)).toEqual(["held"]);
  });

  test("can't be overtaken by a drain into a second concurrent turn", async () => {
    const thread = await openThread();
    const b = queueRow(thread, "B");
    const a = queueRow(thread, "A");
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    // A steer the provider takes its time over. If the turn it was aimed at
    // has ended by then, the provider runs it as a turn of its own — which is
    // what the real adapters do.
    let turnLive = true;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    adapter.steerTurn = async (input) => {
      await gate;
      if (!turnLive) return adapter.sendTurn(input);
      return { threadId: input.threadId, turnId: "live" };
    };

    const sending = service.sendQueuedTurnNow(thread, a);
    await tick();
    // The live turn ends while the steer is still being taken: that kicks the
    // drain, which must wait for the Send now instead of starting B beside it.
    turnLive = false;
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await tick();
    open();
    expect(await sending).toBe(true);
    await tick();

    expect(adapter.sent.map((s) => s.input)).toEqual(["A"]);
    expect(stateOf(thread, b)).toBe("queued");
  });

  test("a Stop before the provider takes it cancels the delivery", async () => {
    const thread = await openThread();
    const row = queueRow(thread, "changed my mind");
    hold(thread, row);

    const sending = service.sendQueuedTurnNow(thread, row);
    await service.cancelQueuedTurns(thread);

    expect(await sending).toBe(false);
    expect(adapter.sent).toEqual([]);
    expect(ofType(thread, "turn.queued-cancelled").map((c) => c.queueId)).toEqual([row]);
  });

  test("a Stop while the provider is taking it stops the turn it started", async () => {
    const thread = await openThread();
    const row = queueRow(thread, "too late");
    hold(thread, row);
    let open = () => {};
    adapter.gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const sending = service.sendQueuedTurnNow(thread, row);
    await tick();
    await service.cancelQueuedTurns(thread);
    open();
    await sending;

    expect(adapter.interruptedTurns).toEqual(["turn-1"]);
    expect(ofType(thread, "turn.promoted")).toEqual([]);
  });

  test("a delivery that outlives its session never interrupts the next session's turn", async () => {
    const thread = await openThread();
    const row = queueRow(thread, "A");
    hold(thread, row);
    let finish = () => {};
    adapter.holdAfterAccept = new Promise<void>((resolve) => {
      finish = resolve;
    });

    // A is accepted, but its delivery is still finishing up when the session
    // is stopped (cancelling A's claim) and started again, and an ordinary
    // turn B begins.
    const sending = service.sendQueuedTurnNow(thread, row);
    await tick();
    await service.stopSession(thread);
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    await service.sendTurn({ threadId: thread, input: "B" });
    expect(adapter.liveTurn).toBe("turn-2");
    finish();
    await sending;

    expect(adapter.interruptedTurns).toEqual([]);
    expect(adapter.liveTurn).toBe("turn-2");
  });

  test("a Stop during a steer that fell back to a fresh turn stops that turn", async () => {
    const thread = await openThread();
    const row = queueRow(thread, "A");
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    let turnLive = true;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    adapter.steerTurn = async (input) => {
      await gate;
      if (!turnLive) return adapter.sendTurn(input);
      return { threadId: input.threadId, turnId: "live" };
    };

    const sending = service.sendQueuedTurnNow(thread, row);
    await tick();
    // Stop: the row is cancelled (its words go back to the composer) and the
    // live turn is interrupted, while the provider is still taking the steer.
    await service.cancelQueuedTurns(thread);
    turnLive = false;
    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });
    open();
    expect(await sending).toBe(true);

    // The steer became turn C; with its row gone, C is stopped, not left to run.
    expect(adapter.sent.map((s) => s.input)).toEqual(["A"]);
    expect(adapter.interruptedTurns).toEqual(["turn-1"]);
    expect(ofType(thread, "turn.promoted")).toEqual([]);
  });

  test("moves a row ahead of a held one and it runs, on a provider that can't steer", async () => {
    const thread = await openThread();
    const held = queueRow(thread, "held");
    const urgent = queueRow(thread, "urgent");
    hold(thread, held);
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });

    expect(await service.sendQueuedTurnNow(thread, urgent)).toBe(true);
    expect(adapter.interrupted).toContain(thread);
    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });
    await waitFor(() => stateOf(thread, urgent) === "gone");

    expect(adapter.sent.map((s) => s.input)).toEqual(["urgent"]);
    expect(stateOf(thread, held)).toBe("failed");
  });
});

describe("a steer on a provider that can't steer, against the real store", () => {
  const steerRows = (threadId: string) =>
    store.listQueuedTurns(threadId).filter((r) => r.dispatchMode === "steer" && r.state === "queued");

  function park(threadId: string, requestId: string): void {
    adapter.emit({
      ...base(threadId),
      type: "approval.requested",
      requestId,
      turnId: "live",
      approval: { kind: "command", title: "rm -rf build" },
    });
  }

  test("a turn parked on the user's approval is not interrupted; the steer waits", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    park(thread, "req-1");

    await service.steerTurn({ threadId: thread, input: "a note from Ada" });

    expect(steerRows(thread)).toHaveLength(1);
    expect(adapter.interrupted).toEqual([]);
  });

  test("once the approval is answered, the next steer interrupts", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    park(thread, "req-1");
    await service.steerTurn({ threadId: thread, input: "first" });
    adapter.emit({ ...base(thread), type: "approval.resolved", requestId: "req-1", decision: "allow-once" });

    await service.steerTurn({ threadId: thread, input: "second" });

    expect(steerRows(thread)).toHaveLength(2);
    expect(adapter.interrupted).toEqual([thread]);
  });

  test("a turn not parked is interrupted as before", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });

    await service.steerTurn({ threadId: thread, input: "now" });

    expect(steerRows(thread)).toHaveLength(1);
    expect(adapter.interrupted).toEqual([thread]);
  });
});

// kone steer (docs/agent-delivery-design.md §7): a provider that cannot steer
// but keeps a finished tool call across a cancel has its turn ended between
// two actions, never mid tool call and never while parked on the user.
describe("kone steer, against the real store", () => {
  beforeEach(() => {
    adapter.capabilities.cancelKeepsCompletedTools = true;
  });

  const item = (
    threadId: string,
    type: "item.started" | "item.completed",
    itemId: string,
    kind: "tool_call" | "assistant_text" = "tool_call",
    over: { name?: string; text?: string; subagentToolUseId?: string } = {},
  ): RuntimeEvent => {
    const status = type === "item.started" ? "in-progress" : "completed";
    const runtimeItem: RuntimeItem = { itemId, kind, status, text: over.text ?? "" };
    if (kind === "tool_call") runtimeItem.name = over.name ?? "bash";
    const event: Extract<RuntimeEvent, { type: "item.started" | "item.completed" }> = {
      ...base(threadId),
      type,
      turnId: "live",
      item: runtimeItem,
    };
    if (over.subagentToolUseId) event.subagentToolUseId = over.subagentToolUseId;
    return event;
  };

  async function working(): Promise<string> {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    return thread;
  }

  function park(threadId: string, requestId: string): void {
    adapter.emit({
      ...base(threadId),
      type: "approval.requested",
      requestId,
      turnId: "live",
      approval: { kind: "command", title: "rm -rf build" },
    });
  }

  test("reads as after-step in the thread's runtime", async () => {
    const thread = await working();
    expect(service.threadRuntime(thread).urgent).toBe("after-step");
    adapter.capabilities.cancelKeepsCompletedTools = false;
    expect(service.threadRuntime(thread).urgent).toBe("turn-end");
  });

  test("with no tool call open the turn ends now; streaming text does not hold it", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "text-1", "assistant_text"));

    const result = await service.steerTurn({ threadId: thread, input: "change of plan" });

    expect(result.queued).toBe(true);
    expect(result.afterStep).toBeUndefined();
    expect(adapter.interrupted).toEqual([thread]);
  });

  test("mid tool call it waits, and ends the turn only on that call's completion, not on streaming text", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1", "tool_call", { name: "bash", text: "bun test" }));

    const result = await service.steerTurn({ threadId: thread, input: "change of plan" });
    expect(result.afterStep).toMatchObject({ from: "user", tool: { name: "bash", text: "bun test" } });
    expect(service.stepWait(thread)).toMatchObject({ from: "user" });
    expect(adapter.interrupted).toEqual([]);

    // Text streaming beside the call, and finishing, is not the gap.
    adapter.emit(item(thread, "item.started", "text-1", "assistant_text"));
    adapter.emit(item(thread, "item.completed", "text-1", "assistant_text"));
    expect(adapter.interrupted).toEqual([]);

    adapter.emit(item(thread, "item.completed", "call-1"));
    expect(adapter.interruptedTurns).toEqual(["live"]);
    expect(service.stepWait(thread)).toBeNull();
  });

  test("the tool call's completion is recorded before the interrupt", async () => {
    const thread = await working();
    const timeline: string[] = [];
    // Registered after the service's own bookkeeping, like the journal.
    service.onEvent((e) => {
      if (e.type === "item.completed") timeline.push(`recorded ${e.item.itemId}`);
    });
    const interrupt = adapter.interruptTurn.bind(adapter);
    adapter.interruptTurn = async (threadId) => {
      timeline.push("interrupt");
      return interrupt(threadId);
    };
    adapter.emit(item(thread, "item.started", "call-1"));
    await service.steerTurn({ threadId: thread, input: "change of plan" });

    adapter.emit(item(thread, "item.completed", "call-1"));
    expect(timeline).toEqual(["recorded call-1", "interrupt"]);
  });

  test("waits for every open tool call, a subagent's included", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    adapter.emit(item(thread, "item.started", "sub-call", "tool_call", { subagentToolUseId: "task-1" }));
    await service.steerTurn({ threadId: thread, input: "change of plan" });

    adapter.emit(item(thread, "item.completed", "call-1"));
    expect(adapter.interrupted).toEqual([]);
    adapter.emit(item(thread, "item.completed", "sub-call", "tool_call", { subagentToolUseId: "task-1" }));
    expect(adapter.interrupted).toEqual([thread]);
  });

  test("never while parked on the user: held through the call's completion, then ended when the user answers", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    park(thread, "req-1");
    const { afterStep } = await service.steerTurn({ threadId: thread, input: "change of plan" });

    adapter.emit(item(thread, "item.completed", "call-1"));
    expect(adapter.interrupted).toEqual([]);
    expect(service.interruptStepWaitNow(thread, afterStep!.id)).toBe(false);
    expect(adapter.interrupted).toEqual([]);

    adapter.emit({ ...base(thread), type: "approval.resolved", requestId: "req-1", decision: "allow-once" });
    expect(adapter.interrupted).toEqual([thread]);
  });

  test("parked with no tool call open, it holds until the user answers", async () => {
    const thread = await working();
    park(thread, "req-1");
    const result = await service.steerTurn({ threadId: thread, input: "change of plan" });
    expect(result.queued).toBe(true);
    expect(adapter.interrupted).toEqual([]);

    adapter.emit({ ...base(thread), type: "approval.resolved", requestId: "req-1", decision: "allow-once" });
    expect(adapter.interrupted).toEqual([thread]);
  });

  test("Interrupt now ends the turn without waiting for the tool call, once, for the wait it was offered for", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    const { afterStep } = await service.steerTurn({ threadId: thread, input: "change of plan" });
    expect(afterStep?.turnId).toBe("live");
    expect(afterStep?.id).toBe(service.stepWait(thread)!.id);

    expect(service.interruptStepWaitNow(thread, "some-other-wait")).toBe(false);
    expect(adapter.interrupted).toEqual([]);
    expect(service.interruptStepWaitNow(thread, afterStep!.id)).toBe(true);
    expect(adapter.interruptedTurns).toEqual(["live"]);
    expect(service.interruptStepWaitNow(thread, afterStep!.id)).toBe(false);
    adapter.emit(item(thread, "item.completed", "call-1"));
    expect(adapter.interrupted).toEqual([thread]);
  });

  test("the turn it ended is followed by the steer, told the task goes on", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    await service.steerTurn({ threadId: thread, input: "change of plan" });
    adapter.emit(item(thread, "item.completed", "call-1"));
    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });

    await waitFor(() => adapter.sent.length === 1);
    expect(adapter.sent[0]!.input).toBe(`${STEER_CARRY_ON}\n\nchange of plan`);

    // Said once: the turn after that is plain.
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "turn-1" });
    await service.sendTurn({ threadId: thread, input: "next" });
    expect(adapter.sent[1]!.input).toBe("next");
  });

  test("a turn that finished on its own before the cancel was not cut short", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    await service.steerTurn({ threadId: thread, input: "change of plan" });
    adapter.emit(item(thread, "item.completed", "call-1"));
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });

    await waitFor(() => adapter.sent.length === 1);
    expect(adapter.sent[0]!.input).toBe("change of plan");
  });

  test("a wait goes with its turn", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    await service.steerTurn({ threadId: thread, input: "change of plan" });
    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await waitFor(() => adapter.sent.length === 1);
    expect(service.stepWait(thread)).toBeNull();

    // The next turn's tool calls end nothing.
    adapter.emit({ ...base(thread), type: "item.started", turnId: "turn-1", item: { itemId: "c-2", kind: "tool_call", status: "in-progress", text: "", name: "bash" } });
    adapter.emit({ ...base(thread), type: "item.completed", turnId: "turn-1", item: { itemId: "c-2", kind: "tool_call", status: "completed", text: "", name: "bash" } });
    expect(adapter.interrupted).toEqual([]);
  });

  // Review finding 2: a turn kone steer is ending is not cancelled again.
  test("a turn already being ended is not cancelled twice, whoever asks", async () => {
    const thread = await working();
    expect(service.interruptAfterStep(thread, "agent").outcome).toBe("interrupted");
    expect(service.interruptAfterStep(thread, "agent").outcome).toBe("interrupted");
    await service.steerTurn({ threadId: thread, input: "change of plan" });
    expect(adapter.interrupted).toEqual([thread]);

    // Settled, the next turn can be ended again.
    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });
    await waitFor(() => adapter.sent.length === 1);
    expect(service.interruptAfterStep(thread, "agent").outcome).toBe("interrupted");
    expect(adapter.interrupted).toEqual([thread, thread]);
  });

  // Review finding 3: what a cut was for goes with its session, and with the
  // steer it was for.
  test("a cancelled steer takes its carry-on line with it, across a session exit", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    const steered = await service.steerTurn({ threadId: thread, input: "change of plan" });
    adapter.emit(item(thread, "item.completed", "call-1"));
    expect(await service.cancelQueuedTurn(thread, steered.turnId)).toBe(true);
    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });
    adapter.emit({ ...base(thread), type: "session.exited", code: 0 });

    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    await service.sendTurn({ threadId: thread, input: "unrelated work" });
    expect(adapter.sent.map((t) => t.input)).toEqual(["unrelated work"]);
  });

  test("a cancelled steer takes its carry-on line with it", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    const steered = await service.steerTurn({ threadId: thread, input: "change of plan" });
    adapter.emit(item(thread, "item.completed", "call-1"));
    expect(await service.cancelQueuedTurn(thread, steered.turnId)).toBe(true);
    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });

    await service.sendTurn({ threadId: thread, input: "unrelated work" });
    expect(adapter.sent.map((t) => t.input)).toEqual(["unrelated work"]);
  });

  // Re-review finding 1: the cut outlives its cancelled steer, so a
  // replacement that comes before the abort asks for no second cancel.
  test("a steer that replaces a cancelled one before the abort cancels nothing again, and is told to carry on", async () => {
    const thread = await working();
    const first = await service.steerTurn({ threadId: thread, input: "change of plan" });
    expect(await service.cancelQueuedTurn(thread, first.turnId)).toBe(true);
    await service.steerTurn({ threadId: thread, input: "a better plan" });
    expect(adapter.interruptedTurns).toEqual(["live"]);

    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });
    await waitFor(() => adapter.sent.length === 1);
    expect(adapter.sent[0]!.input).toBe(`${STEER_CARRY_ON}\n\na better plan`);
  });

  test("a cut with nothing left owed adds no line, and still cancels once", async () => {
    const thread = await working();
    const first = await service.steerTurn({ threadId: thread, input: "change of plan" });
    expect(await service.cancelQueuedTurn(thread, first.turnId)).toBe(true);
    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });

    await service.sendTurn({ threadId: thread, input: "unrelated work" });
    expect(adapter.sent.map((t) => t.input)).toEqual(["unrelated work"]);
    expect(adapter.interruptedTurns).toEqual(["live"]);
  });

  test("a cancelled steer's wait ends no turn", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    const steered = await service.steerTurn({ threadId: thread, input: "change of plan" });
    expect(await service.cancelQueuedTurn(thread, steered.turnId)).toBe(true);
    adapter.emit(item(thread, "item.completed", "call-1"));
    expect(adapter.interrupted).toEqual([]);
  });

  test("the carry-on line does not outlive the session", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    expect(service.interruptAfterStep(thread, "agent").outcome).toBe("after-step");
    adapter.emit(item(thread, "item.completed", "call-1"));
    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });
    adapter.emit({ ...base(thread), type: "session.state.changed", state: "error", message: "gone" });

    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    await service.sendTurn({ threadId: thread, input: "unrelated work" });
    expect(adapter.sent.map((t) => t.input)).toEqual(["unrelated work"]);
  });

  // Review finding 5: a refused turn did not carry the line, so its retry does.
  test("the carry-on line goes with the turn the provider accepts, not one it refused", async () => {
    const thread = await working();
    await service.steerTurn({ threadId: thread, input: "change of plan" });
    expect(adapter.interrupted).toEqual([thread]);
    adapter.refuse = new Error("busy, try again");
    adapter.abortBeforeRefusing = true;
    adapter.emit({ ...base(thread), type: "turn.aborted", turnId: "live", reason: "interrupted" });
    await waitFor(() => adapter.attempts.length === 1);
    adapter.refuse = null;
    adapter.abortBeforeRefusing = false;

    await waitFor(() => adapter.sent.length === 1);
    expect(adapter.sent[0]!.input).toBe(`${STEER_CARRY_ON}\n\nchange of plan`);
  });

  test("an agent's urgent mail joins the wait; the user's steer makes it theirs", async () => {
    const thread = await working();
    adapter.emit(item(thread, "item.started", "call-1"));
    expect(service.interruptAfterStep(thread, "agent")).toMatchObject({ outcome: "after-step", wait: { from: "agent" } });
    expect(service.interruptAfterStep(thread, "agent").outcome).toBe("after-step");
    const result = await service.steerTurn({ threadId: thread, input: "change of plan" });
    expect(result.afterStep?.from).toBe("user");

    adapter.emit(item(thread, "item.completed", "call-1"));
    expect(adapter.interrupted).toEqual([thread]);
  });
});

// Urgent mail is settled with the turn that took it. A steer that arrives
// after the announced turn ended, while the next send is still on its way to
// the provider, would otherwise be queued and acked with the queue row's id.
describe("a live-only steer, against the real store", () => {
  test("is refused, not queued, while a send is on its way and no turn is announced", async () => {
    const thread = await openThread();
    let open = (): void => {};
    adapter.gate = new Promise((resolve) => {
      open = resolve;
    });
    const sending = service.sendTurn({ threadId: thread, input: "the user's next message" });
    expect(service.isThreadBusy(thread)).toBe(true);

    const accepted: string[] = [];
    await expect(
      service.steerTurn(
        { threadId: thread, input: "urgent: stop" },
        { liveOnly: true, onAccepted: (turnId) => accepted.push(turnId) },
      ),
    ).rejects.toThrow("No running turn");
    expect(store.listQueuedTurns(thread)).toHaveLength(0);
    expect(accepted).toEqual([]);

    // Without liveOnly the same steer is queued, and says so.
    const queued = await service.steerTurn({ threadId: thread, input: "a plain steer" });
    expect(queued.queued).toBe(true);
    open();
    await sending;
  });

  test("into a turn the provider announced, reports the turn that took it", async () => {
    const thread = await openThread();
    adapter.steerTurn = async (input) => ({ threadId: input.threadId, turnId: "live" });
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });

    const accepted: string[] = [];
    const result = await service.steerTurn(
      { threadId: thread, input: "urgent: stop" },
      { liveOnly: true, onAccepted: (turnId) => accepted.push(turnId) },
    );
    expect(result.queued).toBeUndefined();
    expect(accepted).toEqual(["live"]);
  });
});

describe("threadRuntime: what a thread is doing, for a sender", () => {
  test("a tool call first reported under way is the one in progress, under the target an update names", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    adapter.emit({
      ...base(thread),
      type: "item.updated",
      turnId: "live",
      item: { itemId: "c-1", kind: "tool_call", status: "in-progress", text: "", name: "bash" },
    });
    expect(service.threadRuntime(thread).activeTool).toMatchObject({ name: "bash", text: "" });
    adapter.emit({
      ...base(thread),
      type: "item.updated",
      turnId: "live",
      item: { itemId: "c-1", kind: "tool_call", status: "in-progress", text: "Run the test suite", name: "bash" },
    });
    expect(service.threadRuntime(thread).activeTool).toMatchObject({ name: "bash", text: "Run the test suite" });

    adapter.emit({
      ...base(thread),
      type: "item.updated",
      turnId: "live",
      item: { itemId: "c-1", kind: "tool_call", status: "completed", text: "Run the test suite", name: "bash" },
    });
    expect(service.threadRuntime(thread).activeTool).toBeNull();
  });

  for (const [how, end] of [
    ["fails", { type: "session.state.changed", state: "error", message: "query exited" }],
    ["exits", { type: "session.exited", code: 1 }],
  ] as const) {
    test(`a session that ${how} under an open tool call leaves nothing of it for the next turn`, async () => {
      const thread = await openThread();
      adapter.emit({ ...base(thread), type: "turn.started", turnId: "t-1" });
      adapter.emit({
        ...base(thread),
        type: "item.started",
        turnId: "t-1",
        item: { itemId: "c-1", kind: "tool_call", status: "in-progress", text: "old.ts", name: "read" },
      });
      adapter.emit({ ...base(thread), ...end });
      expect(service.threadRuntime(thread).activeTool).toBeNull();

      // Even with the end unheard, a new turn starts clean.
      adapter.emit({
        ...base(thread),
        type: "item.started",
        turnId: "t-1",
        item: { itemId: "c-2", kind: "tool_call", status: "in-progress", text: "older.ts", name: "read" },
      });
      await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
      adapter.emit({ ...base(thread), type: "turn.started", turnId: "t-2" });
      expect(service.threadRuntime(thread)).toMatchObject({ busy: true, activeTool: null, step: null });
    });
  }

  test("of two tool calls open at once, the one still open stays when the other ends", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    for (const [itemId, text] of [["a", "src/one.ts"], ["b", "src/two.ts"]]) {
      adapter.emit({
        ...base(thread),
        type: "item.started",
        turnId: "live",
        item: { itemId: itemId!, kind: "tool_call", status: "in-progress", text: text!, name: "read" },
      });
    }
    adapter.emit({
      ...base(thread),
      type: "item.completed",
      turnId: "live",
      item: { itemId: "b", kind: "tool_call", status: "completed", text: "src/two.ts", name: "read" },
    });
    expect(service.threadRuntime(thread).activeTool).toMatchObject({ name: "read", text: "src/one.ts" });
  });

  test("between tool calls, the step its turn is on; nothing open says nothing", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    expect(service.threadRuntime(thread)).toMatchObject({ activeTool: null, step: null });
    adapter.emit({
      ...base(thread),
      type: "item.started",
      turnId: "live",
      item: { itemId: "r-1", kind: "reasoning_text", status: "in-progress", text: "Let me look" },
    });
    expect(service.threadRuntime(thread).step).toBe("reasoning_text");
    adapter.emit({
      ...base(thread),
      type: "item.completed",
      turnId: "live",
      item: { itemId: "r-1", kind: "reasoning_text", status: "completed", text: "Let me look" },
    });
    expect(service.threadRuntime(thread).step).toBeNull();

    // A reply never reported closed is over once a tool call starts after it.
    adapter.emit({
      ...base(thread),
      type: "item.started",
      turnId: "live",
      item: { itemId: "t-1", kind: "assistant_text", status: "in-progress", text: "Checking." },
    });
    adapter.emit({
      ...base(thread),
      type: "item.started",
      turnId: "live",
      item: { itemId: "c-1", kind: "tool_call", status: "in-progress", text: "a.ts", name: "read" },
    });
    adapter.emit({
      ...base(thread),
      type: "item.completed",
      turnId: "live",
      item: { itemId: "c-1", kind: "tool_call", status: "completed", text: "a.ts", name: "read" },
    });
    expect(service.threadRuntime(thread)).toMatchObject({ activeTool: null, step: null });
  });

  test("reads the live turn, the tool in progress, the parked ask and the steer channel", async () => {
    const thread = await openThread();
    expect(service.threadRuntime(thread)).toMatchObject({ live: true, busy: false, parked: null, steers: false });

    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    adapter.emit({
      ...base(thread),
      type: "item.started",
      turnId: "live",
      item: { itemId: "i-1", kind: "tool_call", status: "in-progress", text: "bun test", name: "Bash" },
    });
    const working = service.threadRuntime(thread);
    expect(working.busy).toBe(true);
    expect(working.turnStartedAt).not.toBeNull();
    expect(working.activeTool).toMatchObject({ name: "Bash", text: "bun test" });

    adapter.emit({
      ...base(thread),
      type: "item.completed",
      turnId: "live",
      item: { itemId: "i-1", kind: "tool_call", status: "completed", text: "bun test", name: "Bash" },
    });
    expect(service.threadRuntime(thread).activeTool).toBeNull();

    adapter.emit({
      ...base(thread),
      type: "user-input.requested",
      requestId: "q-1",
      turnId: "live",
      questions: [],
    });
    expect(service.threadRuntime(thread).parked).toBe("user-input");

    adapter.steerTurn = async (input) => ({ threadId: input.threadId, turnId: "live" });
    expect(service.threadRuntime(thread).steers).toBe(true);
    expect(service.providerSteers("codex")).toBe(true);

    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    expect(service.threadRuntime(thread)).toMatchObject({ busy: false, turnStartedAt: null });
    expect(service.threadRuntime("nobody")).toMatchObject({ live: false, steers: null });
  });
});

describe("the turn slot carries the inbox, against the real store", () => {
  /** An inbox that folds one line in front of every turn and records how what
   *  it carried was settled. `rings` is whether anything waits that is worth a
   *  turn of its own. */
  function fakeInbox(rings = false, options: { markerFails?: boolean } = {}) {
    type Carried = {
      turn: string | null;
      own: string | undefined;
      settled: string | null;
      released: boolean;
      /** How many sends the provider had seen when it was marked sending. */
      sentBefore?: number;
    };
    const log: Carried[] = [];
    const inbox = {
      carry(threadId: string, turn: SendTurnInput | null, own?: string) {
        if (turn === null && !rings) return null;
        rings = false;
        const entry: Carried = { turn: turn?.input ?? null, own, settled: null, released: false };
        log.push(entry);
        return {
          input: { threadId, input: turn ? `INBOX\n\n${turn.input}` : "INBOX" },
          sending: () => {
            if (options.markerFails) throw new Error("database is locked");
            entry.sentBefore = adapter.sent.length;
          },
          settle: (turnId: string) => {
            entry.settled = turnId;
          },
          release: () => {
            entry.released = true;
          },
        };
      },
    };
    return { inbox, log };
  }

  test("a queued message carries the inbox, settled with the turn the provider started", async () => {
    const thread = await openThread();
    const { inbox, log } = fakeInbox();
    service.setTurnInbox(inbox);
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const row = queueRow(thread, "ship it");

    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await waitFor(() => stateOf(thread, row) === "gone");

    expect(adapter.sent.map((s) => s.input)).toEqual(["INBOX\n\nship it"]);
    expect(log).toEqual([{ turn: "ship it", own: `ub-${row}`, settled: "turn-1", released: false, sentBefore: 0 }]);
  });

  test("with nothing queued, what rings starts a turn of its own", async () => {
    const thread = await openThread();
    const { inbox, log } = fakeInbox(true);
    service.setTurnInbox(inbox);

    service.kickTurnSlot(thread);
    await waitFor(() => adapter.sent.length === 1);

    expect(adapter.sent[0]!.input).toBe("INBOX");
    await waitFor(() => log[0]?.settled !== null);
    expect(log[0]!.settled).toBe("turn-1");
  });

  test("an urgent job waiting runs as its own turn ahead of the user's queued message", async () => {
    const thread = await openThread();
    const { inbox } = fakeInbox(true);
    let urgent = true;
    service.setTurnInbox({
      carry: inbox.carry,
      cutsIn: () => {
        const was = urgent;
        urgent = false;
        return was;
      },
    });
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const row = queueRow(thread, "ship it");

    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await waitFor(() => adapter.sent.length === 1);
    expect(adapter.sent[0]!.input).toBe("INBOX");
    expect(stateOf(thread, row)).toBe("queued");
  });

  test("nothing ringing, nothing queued: the slot stays empty", async () => {
    const thread = await openThread();
    service.setTurnInbox(fakeInbox().inbox);

    service.kickTurnSlot(thread);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapter.sent).toHaveLength(0);
  });

  test("a refused turn puts what it carried back", async () => {
    const thread = await openThread();
    const { inbox, log } = fakeInbox(true);
    service.setTurnInbox(inbox);
    adapter.refuse = new Error("provider is down");

    service.kickTurnSlot(thread);
    await waitFor(() => log.length === 1 && log[0]!.released);
    expect(log[0]!.settled).toBeNull();
  });

  // A crash while the checkpoint is being taken must not leave the turn's
  // delivery open: the restart would hand the same work over a second time.
  test("what a turn delivers is settled before its checkpoint is taken", async () => {
    const atCheckpoint: Array<{ inbox: string | null; row: string }> = [];
    let probe: () => { inbox: string | null; row: string } = () => ({ inbox: null, row: "" });
    const checkpoints: CheckpointStore = {
      threadProjectPath: () => null,
      threadWorkspace: () => null,
      recordTurnCheckpoint: () => false,
      getTurnCheckpoint: () => {
        atCheckpoint.push(probe());
        return null;
      },
      listTurnCheckpoints: () => [],
      pruneTurnCheckpoints: () => [],
    };
    service = new AgentServiceCtor({
      store,
      checkpointStore: checkpoints,
      queueRetryDelaysMs: [20, 20],
      retentionSweepMs: 0,
      wedgeSweepMs: 60_000,
      idleSweepMs: 60_000,
      adapters: (emit) => {
        adapter = new FakeAdapter(emit);
        // SAFETY: the fake covers every adapter method these queue paths reach.
        // eslint-disable-next-line anti-slop/no-chained-type-assertions
        return [adapter] as unknown as ProviderAdapter[];
      },
    });
    const thread = await openThread();
    const { inbox, log } = fakeInbox();
    service.setTurnInbox(inbox);
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const row = queueRow(thread, "ship it");
    probe = () => ({ inbox: log[0]?.settled ?? null, row: stateOf(thread, row) });

    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await waitFor(() => atCheckpoint.length === 1);

    expect(atCheckpoint[0]).toEqual({ inbox: "turn-1", row: "gone" });
  });

  // A crash after this mark leaves the hand-over uncertain, not unsent: it is
  // written before the provider can have the turn, never after.
  test("what a turn carries is marked sending before the provider has it", async () => {
    const thread = await openThread();
    const { inbox, log } = fakeInbox(true);
    service.setTurnInbox(inbox);
    service.kickTurnSlot(thread);
    await waitFor(() => log[0]?.settled !== null && log[0]?.settled !== undefined);
    expect(log[0]?.sentBefore).toBe(0);
    expect(adapter.sent).toHaveLength(1);
  });

  // A marker the store could not write: a crash after the send would read as
  // never sent and hand the mail over twice, so the provider is not contacted.
  test("a turn whose carried mail could not be marked sent never reaches the provider", async () => {
    const thread = await openThread();
    const { inbox, log } = fakeInbox(true, { markerFails: true });
    service.setTurnInbox(inbox);
    service.kickTurnSlot(thread);
    await waitFor(() => log[0]?.released === true);
    expect(adapter.attempts).toHaveLength(0);
    expect(log[0]?.settled).toBeNull();
  });

  // The outage that refused the marker can refuse the queue's release too.
  // The row is then still claimed with nothing to run it: the release is
  // tried again until it lands, and the row then runs.
  test("a queued message whose release could not be written runs once writes come back", async () => {
    const thread = await openThread();
    const faults = { markerFails: true };
    const { inbox } = fakeInbox(false, faults);
    service.setTurnInbox(inbox);
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const row = queueRow(thread, "ship it");
    const outage = new Database(path.join(getUserDataDir(), "kone.sqlite"));
    outage.exec(`CREATE TRIGGER release_fails BEFORE UPDATE OF state ON queued_turns
                  WHEN OLD.state = 'promoting' AND NEW.state IN ('queued', 'failed')
                  BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);

    adapter.emit({ ...base(thread), type: "turn.completed", turnId: "live" });
    await waitFor(() => ofType(thread, "turn.queued-updated").some((u) => u.state === "promoting"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stateOf(thread, row)).toBe("promoting");
    expect(adapter.attempts).toHaveLength(0);

    outage.exec("DROP TRIGGER release_fails");
    outage.close();
    faults.markerFails = false;
    await waitFor(() => stateOf(thread, row) === "gone");
    expect(adapter.sent.map((s) => s.input)).toEqual(["INBOX\n\nship it"]);
  });

  test("a message sent straight to an idle thread carries the inbox too", async () => {
    const thread = await openThread();
    const { inbox, log } = fakeInbox();
    service.setTurnInbox(inbox);
    store.recordUserBlock({ blockId: "ub-direct", threadId: thread, text: "go" });

    const result = await service.sendTurn({ threadId: thread, input: "go", userBlockId: "ub-direct" });

    expect(adapter.sent[0]!.input).toBe("INBOX\n\ngo");
    expect(log[0]).toMatchObject({ own: "ub-direct", settled: result.turnId });
  });
});

// The transcript hides a row's block while the row waits, so the renderer
// cannot tell the user's queued words from an agent's by looking for it.
describe("a queued row says who wrote it", () => {
  test("the queue read and turn.queued carry the row's sender: the user's, or the agent's", async () => {
    const thread = await openThread();
    adapter.emit({ ...base(thread), type: "turn.started", turnId: "live" });
    const agent = { kind: "agent" as const, threadId: "lead", name: "Vera", relationship: "delegator" as const, messageKind: "note" as const };
    store.recordUserBlock({ blockId: "ub-agent", threadId: thread, text: "a note", sender: agent });
    await service.sendTurn({ threadId: thread, input: "a note", userBlockId: "ub-agent", sender: agent });
    store.recordUserBlock({ blockId: "ub-user", threadId: thread, text: "mine" });
    await service.sendTurn({ threadId: thread, input: "mine", userBlockId: "ub-user" });

    const rows = store.listQueuedTurns(thread);
    expect(rows.map((r) => r.sender)).toEqual([agent, { kind: "user" }]);
    expect(ofType(thread, "turn.queued").map((e) => e.sender)).toEqual([agent, { kind: "user" }]);
  });

  test("a row with no block on record has no sender, so it never reads as the user's", () => {
    const queueId = `q-${++seq}`;
    store.ensureThread({ threadId: "t-bare", projectPath: "/repo", provider: "codex" });
    store.enqueueQueuedTurn({ queueId, threadId: "t-bare", userBlockId: "ub-none", input: "silent" });
    expect(store.listQueuedTurns("t-bare")[0]?.sender).toBeUndefined();
  });
});


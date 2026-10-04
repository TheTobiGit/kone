import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import type { ProviderAdapter, RuntimeEvent, SendTurnInput, TurnStartResult } from "./types.js";

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

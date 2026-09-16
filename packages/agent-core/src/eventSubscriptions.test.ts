import { describe, expect, test } from "bun:test";

import {
  EventSubscriptions,
  EVENT_BATCH_INTERVAL_MS,
  REPLAY_DELAY_MS,
  type AgentEventFrame,
  type PendingInteraction,
  type SubscriptionSink,
} from "./eventSubscriptions.js";
import type { RuntimeEvent } from "./types.js";

function approvalEvent(threadId: string, requestId: string): RuntimeEvent {
  return {
    type: "approval.requested",
    threadId,
    provider: "codex",
    at: 1_000,
    source: "kone.store",
    requestId,
    approval: { kind: "command", title: "rm -rf /tmp/scratch" },
  };
}

function pendingAsk(threadId: string, requestId: string): PendingInteraction {
  return { threadId, requestId, event: approvalEvent(threadId, requestId) };
}

interface FakeSink {
  sink: SubscriptionSink;
  sent: AgentEventFrame[];
  readonly onceCount: number;
  destroy(): void;
}

function fakeSink(): FakeSink {
  let destroyed = false;
  let onceCount = 0;
  const destroyListeners: (() => void)[] = [];
  const sent: AgentEventFrame[] = [];
  const sink: SubscriptionSink = {
    isDestroyed: () => destroyed,
    send: (_channel, payload) => {
      sent.push(payload);
    },
    once: (_event, listener) => {
      onceCount += 1;
      destroyListeners.push(listener);
    },
  };
  return {
    sink,
    sent,
    get onceCount() {
      return onceCount;
    },
    destroy() {
      destroyed = true;
      for (const listener of destroyListeners) listener();
    },
  };
}

type SubsHarness = {
  subs: EventSubscriptions;
  delayed: (() => void)[];
  flushes: (() => void)[];
};

function makeSubs(
  pending: () => PendingInteraction[],
  delayed: (() => void)[] = [],
  flushes: (() => void)[] = [],
): SubsHarness {
  const subs = new EventSubscriptions({
    pendingInteractions: pending,
    parentTurnIdFor: () => undefined,
    scheduleDelay: (fn, ms) => {
      expect(ms).toBe(REPLAY_DELAY_MS);
      delayed.push(fn);
    },
    scheduleFlush: (fn, ms) => {
      expect(ms).toBe(EVENT_BATCH_INTERVAL_MS);
      flushes.push(fn);
    },
  });
  return { subs, delayed, flushes };
}

/** Narrow one frame without a type assertion: arrays are batches. */
function isBatchFrame(frame: AgentEventFrame): frame is RuntimeEvent[] {
  return Array.isArray(frame);
}

/** Every event across every frame, in wire order. */
function flatten(frames: AgentEventFrame[]): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  for (const frame of frames) {
    if (isBatchFrame(frame)) out.push(...frame);
    else out.push(frame);
  }
  return out;
}

function itemUpdated(threadId: string, turnId: string, itemId: string, text: string): RuntimeEvent {
  return {
    type: "item.updated",
    threadId,
    provider: "codex",
    at: 1_000,
    source: "kone.store",
    turnId,
    item: { itemId, kind: "assistant_text", status: "in-progress", text },
  };
}

function itemStarted(threadId: string, turnId: string, itemId: string): RuntimeEvent {
  return {
    type: "item.started",
    threadId,
    provider: "codex",
    at: 1_000,
    source: "kone.store",
    turnId,
    item: { itemId, kind: "assistant_text", status: "in-progress", text: "" },
  };
}

function itemCompleted(threadId: string, turnId: string, itemId: string, text: string): RuntimeEvent {
  return {
    type: "item.completed",
    threadId,
    provider: "codex",
    at: 1_001,
    source: "kone.store",
    turnId,
    item: { itemId, kind: "assistant_text", status: "completed", text },
  };
}

function turnCompleted(threadId: string, turnId: string): RuntimeEvent {
  return {
    type: "turn.completed",
    threadId,
    provider: "codex",
    at: 1_002,
    source: "kone.store",
    turnId,
  };
}

function subagentUpdated(
  threadId: string,
  turnId: string,
  toolUseId: string,
  status: "running" | "completed" = "running",
): RuntimeEvent {
  return {
    type: "subagent.updated",
    threadId,
    provider: "codex",
    at: 1_000,
    source: "kone.store",
    turnId,
    subagent: { toolUseId, status, startedAt: 999, description: "worker" },
  };
}

describe("EventSubscriptions", () => {
  test("first subscribe replays parked asks immediately with a fresh eventId", () => {
    const delayed: (() => void)[] = [];
    const { subs } = makeSubs(() => [pendingAsk("t1", "r1")], delayed);

    const f = fakeSink();
    subs.subscribe(f.sink);

    expect(f.sent.length).toBe(1);
    const events = flatten(f.sent);
    expect(events[0]!.threadId).toBe("t1");
    // SAFETY: events[0] exists (checked above) and is the exact event
    // pendingAsk() constructed with requestId set; RuntimeEvent just doesn't
    // surface that field in its type.
    expect((events[0] as { requestId?: string }).requestId).toBe("r1");
    expect(events[0]!.eventId).toBeDefined();
    expect(delayed.length).toBe(1);
  });

  test("re-subscribe after a reload re-replays the parked ask", () => {
    // A renderer that reloads keeps its WebContents but loses every in-memory
    // modal — the re-subscribe must re-present the ask it was parked on.
    const delayed: (() => void)[] = [];
    const { subs } = makeSubs(() => [pendingAsk("t1", "r1")], delayed);

    const f = fakeSink();
    subs.subscribe(f.sink);
    expect(f.sent.length).toBe(1);

    // Simulate the reload: same sink, fresh in-memory state.
    subs.subscribe(f.sink);
    expect(f.sent.length).toBe(2);
  });

  test("the delayed second pass sends newly-parked asks and skips already-sent ones", () => {
    const pending: PendingInteraction[] = [pendingAsk("t1", "r1")];
    const delayed: (() => void)[] = [];
    const { subs } = makeSubs(() => pending, delayed);

    const f = fakeSink();
    subs.subscribe(f.sink);
    expect(f.sent.length).toBe(1);

    // A new ask arrives between the first pass and the delayed pass.
    pending.push(pendingAsk("t2", "r2"));
    delayed[0]!();

    expect(f.sent.length).toBe(2);
    expect(flatten(f.sent)[1]!.threadId).toBe("t2");
  });

  test("unsubscribe stops broadcast forwarding", () => {
    const { subs } = makeSubs(() => []);
    const f = fakeSink();
    subs.subscribe(f.sink);
    subs.unsubscribe(f.sink);
    subs.broadcast(approvalEvent("t1", "r1"));
    expect(f.sent.length).toBe(0);
    expect(subs.size()).toBe(0);
  });

  test("one renderer-side unsubscribe does not kill the sink for the other listeners", () => {
    // Several renderer composables (the thread registry, the recent-sessions
    // block, the scratchpad) each subscribe the SAME WebContents sink and each
    // return their own unsubscribe. One of them tearing down must not remove the
    // sink while the others still need the live stream.
    const { subs } = makeSubs(() => []);
    const f = fakeSink();

    subs.subscribe(f.sink);
    subs.subscribe(f.sink);

    subs.unsubscribe(f.sink);

    subs.broadcast(approvalEvent("t1", "r1"));
    expect(f.sent.length).toBe(1);
    expect(subs.size()).toBe(1);

    subs.unsubscribe(f.sink);
    subs.broadcast(approvalEvent("t2", "r2"));
    expect(f.sent.length).toBe(1);
    expect(subs.size()).toBe(0);
  });

  test("a destroyed sink is removed and skipped by replay and broadcast", () => {
    const { subs } = makeSubs(() => [pendingAsk("t1", "r1")]);
    const f = fakeSink();
    subs.subscribe(f.sink);
    f.destroy();
    subs.broadcast(approvalEvent("t9", "r9"));
    expect(f.sent.length).toBe(1);
    expect(subs.size()).toBe(0);
  });

  test("the destroyed hook is registered once across re-subscribes", () => {
    const { subs } = makeSubs(() => []);
    const f = fakeSink();
    subs.subscribe(f.sink);
    subs.subscribe(f.sink);
    subs.subscribe(f.sink);
    expect(f.onceCount).toBe(1);
  });

  test("parentTurnId is stamped from the injectable resolver", () => {
    const subs = new EventSubscriptions({
      pendingInteractions: () => [pendingAsk("t1", "r1")],
      parentTurnIdFor: (threadId) => (threadId === "t1" ? "parentTurn" : undefined),
      scheduleDelay: () => {},
    });
    const f = fakeSink();
    subs.subscribe(f.sink);
    // SAFETY: the sink received exactly one replayed approval event — built by
    // pendingAsk() and re-stamped by the resolver this test injects.
    expect((flatten(f.sent)[0] as { parentTurnId?: string }).parentTurnId).toBe("parentTurn");
  });

  test("a synthetic delta burst collapses to one frame carrying the last snapshot", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [], [], flushes);
    const f = fakeSink();
    subs.subscribe(f.sink);

    // A busy turn: 500 per-delta updates to the same item.
    const DELTAS = 500;
    for (let i = 0; i < DELTAS; i++) {
      subs.broadcast(itemUpdated("t1", "turn-1", "item-1", `text-${i}`));
    }
    // Nothing crossed IPC yet — the burst is still accumulating.
    expect(f.sent.length).toBe(0);
    expect(flushes.length).toBe(1);

    flushes[0]!();
    expect(f.sent.length).toBe(1);
    expect(isBatchFrame(f.sent[0]!)).toBe(false);
    const events = flatten(f.sent);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("item.updated");
    // SAFETY: events[0] is the item.updated this test broadcast; the union
    // narrows it but the test needs the payload text.
    expect((events[0] as { item: { text: string } }).item.text).toBe(`text-${DELTAS - 1}`);
  });

  test("updates to different items share one frame without collapsing each other", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [], [], flushes);
    const f = fakeSink();
    subs.subscribe(f.sink);

    for (let i = 0; i < 10; i++) {
      subs.broadcast(itemUpdated("t1", "turn-1", "item-a", `a-${i}`));
      subs.broadcast(itemUpdated("t1", "turn-1", "item-b", `b-${i}`));
    }
    flushes[0]!();

    // 20 broadcasts, one frame, two surviving snapshots (last of each).
    expect(f.sent.length).toBe(1);
    expect(isBatchFrame(f.sent[0]!)).toBe(true);
    const events = flatten(f.sent);
    expect(events.length).toBe(2);
    // SAFETY: both events are item.updated literals built by this test's helper.
    const texts = events.map((e) => (e as { item: { text: string } }).item.text);
    expect(texts).toEqual(["a-9", "b-9"]);
  });

  test("subagent.updated collapses per run", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [], [], flushes);
    const f = fakeSink();
    subs.subscribe(f.sink);

    subs.broadcast(subagentUpdated("t1", "turn-1", "run-1"));
    subs.broadcast(subagentUpdated("t1", "turn-1", "run-2"));
    subs.broadcast(subagentUpdated("t1", "turn-1", "run-1"));
    flushes[0]!();

    const events = flatten(f.sent);
    expect(events.length).toBe(2);
    // SAFETY: both events are subagent.updated literals built by this test's helper.
    const runs = events.map((e) => (e as { subagent: { toolUseId: string } }).subagent.toolUseId);
    // First-seen slot order is kept (replacement happens in place); both
    // snapshots are the latest for their run.
    expect(runs).toEqual(["run-1", "run-2"]);
  });

  test("a turn completion flushes the pending batch immediately, in order", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [], [], flushes);
    const f = fakeSink();
    subs.subscribe(f.sink);

    subs.broadcast(itemUpdated("t1", "turn-1", "item-1", "a"));
    subs.broadcast(itemUpdated("t1", "turn-1", "item-1", "ab"));
    subs.broadcast(turnCompleted("t1", "turn-1"));

    // No timer ran: the terminal event flushed at once.
    expect(f.sent.length).toBe(1);
    const events = flatten(f.sent);
    expect(events.map((e) => e.type)).toEqual(["item.updated", "turn.completed"]);
    // SAFETY: events[0] is the item.updated this test broadcast last for item-1.
    expect((events[0] as { item: { text: string } }).item.text).toBe("ab");
  });

  test("item.completed flushes immediately and never merges across the boundary", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [], [], flushes);
    const f = fakeSink();
    subs.subscribe(f.sink);

    subs.broadcast(itemUpdated("t1", "turn-1", "item-1", "before"));
    subs.broadcast(itemCompleted("t1", "turn-1", "item-1", "before"));
    // A post-completion update for the same item id is a new snapshot, not a
    // continuation — the completion already flushed, so it cannot collapse
    // with the pre-completion copy.
    subs.broadcast(itemUpdated("t1", "turn-1", "item-1", "after"));

    expect(f.sent.length).toBe(1);
    expect(flatten(f.sent).map((e) => e.type)).toEqual([
      "item.updated",
      "item.completed",
    ]);

    flushes[0]!();
    const events = flatten(f.sent);
    expect(events.map((e) => e.type)).toEqual([
      "item.updated",
      "item.completed",
      "item.updated",
    ]);
    // SAFETY: positions 0 and 2 are the two item.updated literals this test broadcast.
    expect((events[0] as { item: { text: string } }).item.text).toBe("before");
    // SAFETY: position 2 is the post-completion item.updated this test broadcast.
    expect((events[2] as { item: { text: string } }).item.text).toBe("after");
  });

  test("item.started passes through in order and splits the batch", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [], [], flushes);
    const f = fakeSink();
    subs.subscribe(f.sink);

    subs.broadcast(itemUpdated("t1", "turn-1", "item-1", "streaming"));
    subs.broadcast(itemStarted("t1", "turn-1", "item-2"));

    expect(f.sent.length).toBe(1);
    expect(flatten(f.sent).map((e) => e.type)).toEqual(["item.updated", "item.started"]);
  });

  test("approval asks skip the batch and flush what was pending first", () => {
    const { subs } = makeSubs(() => []);
    const f = fakeSink();
    subs.subscribe(f.sink);

    subs.broadcast(itemUpdated("t1", "turn-1", "item-1", "streaming"));
    const ask = approvalEvent("t1", "r1");
    subs.broadcast(ask);

    // Two synchronous sends: the pending update first, then the ask alone —
    // never folded into a batch frame.
    expect(f.sent.length).toBe(2);
    expect(isBatchFrame(f.sent[0]!)).toBe(false);
    expect(isBatchFrame(f.sent[1]!)).toBe(false);
    expect(flatten(f.sent).map((e) => e.type)).toEqual(["item.updated", "approval.requested"]);
  });

  test("the replayed parked asks stay immediate and un-batched", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [pendingAsk("t1", "r1")], [], flushes);
    const f = fakeSink();
    subs.subscribe(f.sink);

    expect(f.sent.length).toBe(1);
    expect(isBatchFrame(f.sent[0]!)).toBe(false);
    expect(flatten(f.sent)[0]!.type).toBe("approval.requested");
  });

  test("batching is per sink: one sink's burst never delays another's", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [], [], flushes);
    const a = fakeSink();
    const b = fakeSink();
    subs.subscribe(a.sink);
    subs.subscribe(b.sink);
    // Each subscribe replays nothing (no parked asks) — clear the decks is
    // unnecessary: with no pending interactions nothing was sent.
    expect(a.sent.length).toBe(0);

    subs.broadcast(itemUpdated("t1", "turn-1", "item-1", "x"));
    subs.unsubscribe(a.sink);
    subs.flush();

    expect(a.sent.length).toBe(0);
    expect(flatten(b.sent).length).toBe(1);
  });

  test("a sink destroyed mid-batch drops the batch without throwing", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [], [], flushes);
    const f = fakeSink();
    subs.subscribe(f.sink);

    subs.broadcast(itemUpdated("t1", "turn-1", "item-1", "x"));
    expect(flushes.length).toBe(1);
    f.destroy();

    expect(() => flushes[0]!()).not.toThrow();
    expect(f.sent.length).toBe(0);
  });

  test("a sink unsubscribed mid-batch drops the batch without throwing", () => {
    const flushes: (() => void)[] = [];
    const { subs } = makeSubs(() => [], [], flushes);
    const f = fakeSink();
    subs.subscribe(f.sink);

    subs.broadcast(itemUpdated("t1", "turn-1", "item-1", "x"));
    subs.unsubscribe(f.sink);

    expect(() => flushes[0]!()).not.toThrow();
    expect(f.sent.length).toBe(0);
    expect(subs.size()).toBe(0);
  });
});

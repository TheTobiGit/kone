import { describe, expect, test } from "bun:test";

import {
  EventSubscriptions,
  REPLAY_DELAY_MS,
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
  sent: RuntimeEvent[];
  readonly onceCount: number;
  destroy(): void;
}

function fakeSink(): FakeSink {
  let destroyed = false;
  let onceCount = 0;
  const destroyListeners: (() => void)[] = [];
  const sent: RuntimeEvent[] = [];
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

function makeSubs(
  pending: () => PendingInteraction[],
  delayed: (() => void)[] = [],
): { subs: EventSubscriptions; delayed: (() => void)[] } {
  const subs = new EventSubscriptions({
    pendingInteractions: pending,
    parentTurnIdFor: () => undefined,
    scheduleDelay: (fn, ms) => {
      expect(ms).toBe(REPLAY_DELAY_MS);
      delayed.push(fn);
    },
  });
  return { subs, delayed };
}

describe("EventSubscriptions", () => {
  test("first subscribe replays parked asks immediately with a fresh eventId", () => {
    const delayed: (() => void)[] = [];
    const { subs } = makeSubs(() => [pendingAsk("t1", "r1")], delayed);

    const f = fakeSink();
    subs.subscribe(f.sink);

    expect(f.sent.length).toBe(1);
    expect(f.sent[0]!.threadId).toBe("t1");
    expect((f.sent[0] as { requestId?: string }).requestId).toBe("r1");
    expect(f.sent[0]!.eventId).toBeDefined();
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
    expect(f.sent[1]!.threadId).toBe("t2");
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
    expect((f.sent[0] as { parentTurnId?: string }).parentTurnId).toBe("parentTurn");
  });
});

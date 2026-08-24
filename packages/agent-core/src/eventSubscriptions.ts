import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "./types.js";

/** A parked ask the reload-recovery replay re-presents to a (re)subscribing
 *  renderer. Approvals and user-input questions are live round-trips and are
 *  deliberately never journaled, so this snapshot is the only record a fresh
 *  renderer can be replayed from (see AgentService.pendingInteractions). */
export interface PendingInteraction {
  threadId: string;
  requestId: string;
  event: RuntimeEvent;
}

/** The slice of an Electron WebContents the subscription layer touches. Kept
 *  structural so the replay is testable without Electron. */
export interface SubscriptionSink {
  isDestroyed(): boolean;
  send(channel: string, payload: RuntimeEvent): void;
  once(event: "destroyed", listener: () => void): void;
}

export interface EventSubscriptionsOptions {
  /** The live parked-ask snapshot. */
  pendingInteractions: () => PendingInteraction[];
  /** The spawning turn's id to stamp on a replayed event, or undefined. */
  parentTurnIdFor: (threadId: string) => string | undefined;
  /** Defer the second replay pass — injectable so tests control it. */
  scheduleDelay: (fn: () => void, ms: number) => void;
}

/** Delay between the immediate replay and the second pass. */
export const REPLAY_DELAY_MS = 800;

/** The one side channel replayed events and the live stream ride on. */
const EVENT_CHANNEL = "agent:event";

/** Owns the renderer event-stream subscriptions: which renderers receive the
 *  live stream, and — separately — the reload-recovery replay of parked asks.
 *
 *  The two concerns are deliberately decoupled. The subscriber set only
 *  deduplicates broadcast forwarding (a closed window leaks nothing); it never
 *  gates the replay, because every subscribe is a (re)entry point where the
 *  renderer's in-memory state may have been lost. A reload (⌘R) or a crash
 *  reload keeps the same WebContents, so a `has(sink)` check cannot tell
 *  "already subscribed and still showing the modal" from "re-subscribing after
 *  its modal was wiped" — replaying on every subscribe is the only safe read,
 *  and a live renderer that already holds the ask simply re-renders the same
 *  parked modal rather than stranding the turn. */
export class EventSubscriptions {
  private readonly subscribers = new Set<SubscriptionSink>();
  // Several renderer composables (the thread registry, the recent-sessions
  // block, the scratchpad) each subscribe the same WebContents sink and each
  // return their own unsubscribe. Membership in `subscribers` is therefore
  // refcounted: a sink is a broadcast target while at least one of those
  // listeners is still attached, and it leaves only when the last one unsubscribes.
  private readonly refs = new Map<SubscriptionSink, number>();
  private readonly destroyedHooked = new Set<SubscriptionSink>();
  private readonly options: EventSubscriptionsOptions;

  constructor(options: EventSubscriptionsOptions) {
    this.options = options;
  }

  /** Forward one event to every live subscriber. */
  broadcast(payload: RuntimeEvent): void {
    for (const sink of this.subscribers) {
      if (!sink.isDestroyed()) sink.send(EVENT_CHANNEL, payload);
    }
  }

  /** Handle one subscribe: take a reference on the sink, hook teardown once,
   *  and replay the currently parked asks — now, and again a beat later so an
   *  ask whose session the (re)loading renderer hasn't hydrated yet still lands
   *  once it has. The replay runs on every subscribe, even a repeat one, because
   *  each subscribe is a (re)entry point whose caller may have lost its in-memory
   *  state; only broadcast membership is gated by the refcount. */
  subscribe(sink: SubscriptionSink): void {
    const next = (this.refs.get(sink) ?? 0) + 1;
    this.refs.set(sink, next);
    if (next === 1) {
      this.subscribers.add(sink);
    }
    if (!this.destroyedHooked.has(sink)) {
      this.destroyedHooked.add(sink);
      sink.once("destroyed", () => {
        this.destroyedHooked.delete(sink);
        this.subscribers.delete(sink);
        this.refs.delete(sink);
      });
    }
    // `sent` is scoped to this subscribe: the second pass never re-sends an ask
    // the first already delivered, but a later re-subscribe (a reload) must
    // re-present every still-parked ask, because the reloaded renderer lost it.
    const sent = new Set<string>();
    const replay = () => this.replayPendingTo(sink, sent);
    replay();
    this.options.scheduleDelay(replay, REPLAY_DELAY_MS);
  }

  unsubscribe(sink: SubscriptionSink): void {
    const next = (this.refs.get(sink) ?? 0) - 1;
    if (next > 0) {
      this.refs.set(sink, next);
      return;
    }
    this.refs.delete(sink);
    this.subscribers.delete(sink);
  }

  /** Number of live subscribers (teardown/test assertion). */
  size(): number {
    return this.subscribers.size;
  }

  /** Drop every subscriber — app teardown / tests. */
  dispose(): void {
    this.subscribers.clear();
    this.destroyedHooked.clear();
    this.refs.clear();
  }

  private replayPendingTo(sink: SubscriptionSink, sent: Set<string>): void {
    if (sink.isDestroyed()) return;
    for (const pending of this.options.pendingInteractions()) {
      const key = `${pending.threadId}::${pending.requestId}`;
      if (sent.has(key)) continue;
      sent.add(key);
      sink.send(EVENT_CHANNEL, {
        ...pending.event,
        eventId: randomUUID(),
        parentTurnId: this.options.parentTurnIdFor(pending.threadId),
      });
    }
  }
}

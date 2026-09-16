import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "./types.js";

/** One frame on the `agent:event` channel: either a single event (quiet
 *  traffic keeps the old shape, so single-event consumers never change) or a
 *  batch of events folded in arrival order (a burst of per-delta updates). */
export type AgentEventFrame = RuntimeEvent | RuntimeEvent[];

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
  send(channel: string, payload: AgentEventFrame): void;
  once(event: "destroyed", listener: () => void): void;
}

export interface EventSubscriptionsOptions {
  /** The live parked-ask snapshot. */
  pendingInteractions: () => PendingInteraction[];
  /** The spawning turn's id to stamp on a replayed event, or undefined. */
  parentTurnIdFor: (threadId: string) => string | undefined;
  /** Defer the second replay pass — injectable so tests control it. */
  scheduleDelay: (fn: () => void, ms: number) => void;
  /** Defer a pending batch flush — injectable so tests control it. Defaults
   *  to a real timer at EVENT_BATCH_INTERVAL_MS. */
  scheduleFlush?: (fn: () => void, ms: number) => void;
}

/** Delay between the immediate replay and the second pass. */
export const REPLAY_DELAY_MS = 800;

/** How long a burst of coalescible events may accumulate before it is flushed
 *  as one frame.
 *
 *  16ms is one display refresh at 60Hz: the renderer's streamed text still
 *  advances every frame — indistinguishable from per-delta delivery to a
 *  reader — while a burst of hundreds of deltas crosses IPC as one frame
 *  instead of hundreds. Shorter buys nothing visible (the screen cannot show
 *  it); longer makes streaming look stepped. */
export const EVENT_BATCH_INTERVAL_MS = 16;

/** The one side channel replayed events and the live stream ride on. */
const EVENT_CHANNEL = "agent:event";

/** An `item.updated` collapses with an earlier one when both describe the same
 *  item in the same turn: every update carries the item's whole snapshot, not
 *  a patch, so only the last one in a batch can change what the renderer
 *  shows. The nested-run scope is part of the key — an update to a run's
 *  transcript must never swallow the parent turn's own update. */
function itemCollapseKey(event: RuntimeEvent): string | null {
  if (event.type !== "item.updated") return null;
  const scope = event.subagentToolUseId ?? "";
  return `item.updated::${event.threadId}::${event.turnId}::${scope}::${event.item.itemId}`;
}

/** Same whole-snapshot rule as items: each `subagent.updated` carries the
 *  run's full snapshot, so only the last one per run in a batch matters. */
function subagentCollapseKey(event: RuntimeEvent): string | null {
  if (event.type !== "subagent.updated") return null;
  return `subagent.updated::${event.threadId}::${event.turnId}::${event.subagent.toolUseId}`;
}

/** The collapse key for a batchable event, or null when the event must pass
 *  through untouched. Only the two per-delta snapshot types collapse;
 *  everything else is a semantic boundary the batch never crosses. */
function collapseKey(event: RuntimeEvent): string | null {
  return itemCollapseKey(event) ?? subagentCollapseKey(event);
}

/** True for the live round-trips that are never journaled and never wait:
 *  a parked approval or question a renderer is blocked on must reach it in
 *  this tick, not at the next batch flush. */
function isImmediateEvent(event: RuntimeEvent): boolean {
  return (
    event.type === "approval.requested" ||
    event.type === "approval.resolved" ||
    event.type === "user-input.requested" ||
    event.type === "user-input.resolved"
  );
}

/** One sink's pending batch: the queued events in arrival order, plus the
 *  slot index per collapse key so a repeat snapshot replaces its earlier copy
 *  in place instead of appending. Replacing in place (rather than moving to
 *  the tail) keeps every other event's relative order exactly as broadcast. */
interface SinkBatch {
  events: RuntimeEvent[];
  slotsByKey: Map<string, number>;
  flushScheduled: boolean;
}

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
  private readonly batches = new Map<SubscriptionSink, SinkBatch>();
  private readonly options: EventSubscriptionsOptions;

  constructor(options: EventSubscriptionsOptions) {
    this.options = options;
  }

  /** Forward one event toward every live subscriber. Per-delta snapshots
   *  (`item.updated`, `subagent.updated`) accumulate per sink and flush as one
   *  frame; every other event flushes that sink's pending batch first and then
   *  crosses immediately, so lifecycle boundaries keep their relative order and
   *  a turn/item completion never sits in a timer. */
  broadcast(payload: RuntimeEvent): void {
    for (const sink of this.subscribers) {
      if (sink.isDestroyed()) continue;
      if (isImmediateEvent(payload)) {
        this.flushSink(sink);
        this.sendToSink(sink, payload);
        continue;
      }
      const key = collapseKey(payload);
      if (key === null) {
        this.enqueueBoundary(sink, payload);
        continue;
      }
      this.enqueueCollapsible(sink, key, payload);
    }
  }

  /** Flush every sink's pending batch. Tests drive this directly; production
   *  only flushes via the per-sink timer or a boundary event. */
  flush(): void {
    for (const sink of this.subscribers) {
      this.flushSink(sink);
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
        this.batches.delete(sink);
      });
    }
    // A resubscribe flushes first: the replay below sends immediately, and an
    // older batch still waiting on its timer must not overtake it.
    this.flushSink(sink);
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
    // The sink is going away: drop its batch unsent. Its renderer asked out,
    // so delivering stragglers would wake it for nothing — and the timer it
    // may still hold must find nothing to do rather than throw.
    this.batches.delete(sink);
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
    this.batches.clear();
  }

  /** Append a boundary event and flush at once: the event rides its own frame
   *  in arrival order, and nothing pending waits behind it. A one-event batch
   *  keeps the single-event shape, so quiet traffic looks exactly as before. */
  private enqueueBoundary(sink: SubscriptionSink, event: RuntimeEvent): void {
    this.batchFor(sink).events.push(event);
    this.flushSink(sink);
  }

  /** Fold a per-delta snapshot into the sink's batch, replacing its earlier
   *  copy when one is still pending. The timer is armed once per batch. */
  private enqueueCollapsible(sink: SubscriptionSink, key: string, event: RuntimeEvent): void {
    const batch = this.batchFor(sink);
    const slot = batch.slotsByKey.get(key);
    if (slot === undefined) {
      batch.slotsByKey.set(key, batch.events.length);
      batch.events.push(event);
    } else {
      batch.events[slot] = event;
    }
    if (!batch.flushScheduled) {
      batch.flushScheduled = true;
      this.scheduleFlushFor(sink);
    }
  }

  private batchFor(sink: SubscriptionSink): SinkBatch {
    let batch = this.batches.get(sink);
    if (!batch) {
      batch = { events: [], slotsByKey: new Map(), flushScheduled: false };
      this.batches.set(sink, batch);
    }
    return batch;
  }

  private scheduleFlushFor(sink: SubscriptionSink): void {
    const schedule = this.options.scheduleFlush ?? ((fn, ms) => setTimeout(fn, ms));
    schedule(() => this.flushSink(sink), EVENT_BATCH_INTERVAL_MS);
  }

  /** Deliver one sink's pending batch as a single frame. A destroyed or
   *  unsubscribed sink's batch is dropped silently — the timer outlives the
   *  subscription by design, so this must never throw. */
  private flushSink(sink: SubscriptionSink): void {
    const batch = this.batches.get(sink);
    if (!batch) return;
    this.batches.delete(sink);
    batch.flushScheduled = false;
    if (batch.events.length === 0) return;
    if (sink.isDestroyed() || !this.subscribers.has(sink)) return;
    const frame: AgentEventFrame =
      batch.events.length === 1 ? batch.events[0]! : [...batch.events];
    this.sendToSink(sink, frame);
  }

  private sendToSink(sink: SubscriptionSink, frame: AgentEventFrame): void {
    if (sink.isDestroyed()) return;
    try {
      sink.send(EVENT_CHANNEL, frame);
    } catch {
      // A renderer going away mid-flush must not break the pump for the
      // sinks still listening: drop this frame and forget the sink.
      this.subscribers.delete(sink);
      this.refs.delete(sink);
      this.batches.delete(sink);
      this.destroyedHooked.delete(sink);
    }
  }

  private replayPendingTo(sink: SubscriptionSink, sent: Set<string>): void {
    if (sink.isDestroyed()) return;
    for (const pending of this.options.pendingInteractions()) {
      const key = `${pending.threadId}::${pending.requestId}`;
      if (sent.has(key)) continue;
      sent.add(key);
      // Immediate and un-batched, like every live approval ask: the renderer
      // is blocked on this round-trip, so it must not wait for a flush.
      this.sendToSink(sink, {
        ...pending.event,
        eventId: randomUUID(),
        parentTurnId: this.options.parentTurnIdFor(pending.threadId),
      });
    }
  }
}

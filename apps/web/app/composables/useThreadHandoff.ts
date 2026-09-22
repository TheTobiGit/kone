import type { CreateHandoffInput, CreateHandoffResult, ProviderKind } from "~/types/desktop";

// Thread handoff, renderer side. The desktop IPC channel
// (`agent:create-handoff`) is one-shot and idempotent on the minted thread
// id; this module adds the *user-path* semantics on top of it:
//
// - client-minted ids: the renderer mints threadId + requestId (kone owns
//   thread ids), so a replayed dispatch resolves "exists" instead of handing
//   off twice;
// - in-flight join: rapid repeat clicks for the same source + target join
//   the same flight instead of dispatching a second handoff (unlike side
//   chats, many handoffs MAY leave one source — the join key includes the
//   target, so handing one thread to two providers in quick succession still
//   mints two threads).
//
// The UI owns panes and sessions; this module only guarantees the handoff
// happens exactly once per intent.

/** A flight in progress for one source + target pair. */
type HandoffFlight = {
  creation: Promise<{ threadId: string; status: "created" | "exists" }>;
};

const flights = new Map<string, HandoffFlight>();

function uid(): string {
  return "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

export type HandoffTarget = {
  provider: ProviderKind;
  model?: string;
  /** Reasoning-effort tier in the target provider's vocabulary. */
  effort?: string;
};

export type HandoffOptions = {
  /** The thread being handed off. */
  sourceThreadId: string;
  /** The provider/model the handoff continues on. */
  target: HandoffTarget;
  /** Title override (default: the source thread's title). */
  title?: string;
  /** Cut the copied transcript off after this block instead of carrying the
   *  whole thread. Set when branching from one reply, so the new thread ends
   *  on it and the next turn continues from there. */
  throughBlockId?: string;
};

export type HandoffResult = {
  /** The handoff thread's id (stable across joins and replays). */
  threadId: string;
  /** `"created"` on the flight that wrote the handoff, `"exists"` on a join
   *  or a replay of an already-created id. */
  status: "created" | "exists";
  /** True when this call joined an in-flight handoff instead of starting one. */
  joined: boolean;
};

/** Hand a thread to another provider/model — the user path. Calling this
 *  twice rapidly for the same source + target yields one handoff; the second
 *  call resolves with the same thread id once the first settles. */
export async function createHandoff(options: HandoffOptions): Promise<HandoffResult> {
  const { sourceThreadId, target, title, throughBlockId } = options;
  const api = window.koneDesktop?.agent;
  // The anchor is part of the key: two branches off the same thread to the
  // same target are different threads, and must not join each other's flight.
  const flightKey = `${sourceThreadId}:${target.provider}:${target.model ?? ""}:${throughBlockId ?? ""}`;

  const existing = flights.get(flightKey);
  if (existing) {
    const result = await existing.creation;
    return { ...result, joined: true };
  }

  const threadId = uid();
  const requestId = uid();
  const creation = (async (): Promise<{ threadId: string; status: "created" | "exists" }> => {
    if (!api?.createHandoff) {
      // Browser dev has no bridge — the flight still resolves so the join
      // semantics hold, but no handoff exists on any disk.
      return { threadId, status: "created" };
    }
    const input: CreateHandoffInput = {
      requestId,
      threadId,
      sourceThreadId,
      target: { provider: target.provider },
    };
    if (target.model) input.target.model = target.model;
    if (target.effort) input.target.effort = target.effort;
    if (title?.trim()) input.title = title.trim();
    if (throughBlockId) input.throughBlockId = throughBlockId;
    const result: CreateHandoffResult = await api.createHandoff(input);
    return { threadId: result.threadId, status: result.status };
  })();

  const flight: HandoffFlight = { creation };
  flights.set(flightKey, flight);
  try {
    const result = await creation;
    return { ...result, joined: false };
  } finally {
    if (flights.get(flightKey) === flight) flights.delete(flightKey);
  }
}

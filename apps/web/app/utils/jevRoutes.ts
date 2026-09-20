import { useStorage } from "@vueuse/core";
import type { ThreadAgentRoute } from "~/types/desktop";

/**
 * Which threads Jev staffed, and how firmly — the record behind a thread's
 * "Jev (…) → …" marker.
 *
 * The durable copy lives on the thread's binding row in the store, written in
 * the same insert that settles who works the thread: one fact, one writer, one
 * lifetime. This map is the warm cache in front of it, and `~/utils/agentStore`
 * is the only module that writes it — the same one that owns the bindings these
 * rows ride on. That is deliberate: the two halves of one settlement are then
 * impossible for a caller to move apart by remembering one and forgetting the
 * other, and the write-once rule is stated once, on the binding, rather than
 * once here in a copy that can disagree with it.
 *
 * Only a real decision is recorded. A router that could not be reached, or that
 * declined to choose, left the thread on the default partner and settled
 * nothing — the composer says so in its receipt for that send, and the thread
 * keeps no mark afterwards, because there is no staffing to explain. A thread
 * that was never routed has no row here and shows no marker.
 */
export type JevThreadRoute = {
  /** Who Jev chose. Never null: a route that named nobody is not a decision. */
  agentId: string;
  /** How firmly, 0–1, as the router reported it. */
  confidence: number;
};

const routes = useStorage<Record<string, JevThreadRoute>>("kone.jev.routes", {}, undefined, {
  listenToStorageChanges: true,
});

/** The one outcome that means a decision was made. The store keeps the tag
 *  verbatim and has no opinion on the vocabulary, so the word is read back
 *  here, at the edge where it starts meaning something — and a tag a newer
 *  build invented reads as no decision rather than as one this build would have
 *  to describe without knowing what it says. */
const ROUTED = "routed";

/**
 * What a settled binding says about Jev staffing the thread, or undefined when
 * it says nothing.
 *
 * Three ways to say nothing, and all three are the same answer: no route at all
 * (a thread settled by hand), a route this build cannot read, or a decision
 * that named nobody. The confidence is held to the scale it is documented on —
 * the value crosses the store as a plain number, and every reader downstream
 * turns it into a percentage.
 */
function decode(
  agentId: string | null,
  route: ThreadAgentRoute | null | undefined,
): JevThreadRoute | undefined {
  if (!route || route.outcome !== ROUTED || agentId === null) return undefined;
  if (!Number.isFinite(route.confidence)) return undefined;
  return { agentId, confidence: Math.min(1, Math.max(0, route.confidence)) };
}

/**
 * Take the settled binding's word for a thread's route.
 *
 * A plain write, not a write-once one: it is only ever called with an answer
 * the binding beside it just settled on, and the binding is where that rule is
 * enforced. A binding with nothing to say clears the row rather than leaving
 * the previous answer standing — which is what makes a bind the store refused
 * take its marker down with it, instead of leaving a receipt for a decision
 * that never took effect.
 */
export function applyJevRoute(
  threadId: string,
  agentId: string | null,
  route: ThreadAgentRoute | null | undefined,
): void {
  const next = decode(agentId, route);
  if (next === undefined) {
    if (routes.value[threadId] === undefined) return;
    const { [threadId]: _dropped, ...rest } = routes.value;
    routes.value = rest;
    return;
  }
  routes.value = { ...routes.value, [threadId]: next };
}

/** The router's decision for a thread, or undefined when Jev never staffed it. */
export function jevRouteFor(threadId: string | null | undefined): JevThreadRoute | undefined {
  if (!threadId) return undefined;
  return routes.value[threadId];
}

/** Hand a reborn thread the route its previous id had — a provider or model
 *  switch tears the session down under a new id, but the work is the same and
 *  so is the decision that staffed it. The store carries it on the binding at
 *  the same moment; this keeps the cache in step without waiting for the next
 *  snapshot. Guarded at the far end by the binding's own carry, which refuses a
 *  thread that has already settled. */
export function carryJevRoute(fromThreadId: string, toThreadId: string): void {
  const source = routes.value[fromThreadId];
  if (!source) return;
  routes.value = { ...routes.value, [toThreadId]: source };
}

/**
 * Take the store's word for every route there is.
 *
 * Replaced, not merged, for the reason the bindings beside them are: a merge
 * could only ever grow, so every thread the app had ever routed would stay in
 * browser storage for good. A binding with no route, or with a tag this build
 * doesn't know, reads as unrouted — which is exactly what a thread settled by
 * hand is.
 *
 * The one exception is a route whose bind has not come back yet, which the
 * caller names: the store cannot have it, and it is not lost, only in flight.
 */
export function applyJevRouteSnapshot(
  bindings: readonly { threadId: string; agentId: string | null; route: ThreadAgentRoute | null }[],
  pendingThreadIds: Iterable<string>,
): void {
  const next: Record<string, JevThreadRoute> = {};
  // A route whose bind is still in the air has no row in the snapshot yet, and
  // dropping it would blank the marker on a thread that is looking at it. The
  // bindings beside it are kept for the same reason and by the same set.
  for (const threadId of pendingThreadIds) {
    const held = routes.value[threadId];
    if (held) next[threadId] = held;
  }
  for (const binding of bindings) {
    const route = decode(binding.agentId, binding.route);
    if (route) next[binding.threadId] = route;
    else delete next[binding.threadId];
  }
  routes.value = next;
}

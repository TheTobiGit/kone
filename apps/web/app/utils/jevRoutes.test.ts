import { describe, expect, test } from "bun:test";

import { applyJevRoute, applyJevRouteSnapshot, carryJevRoute, jevRouteFor } from "./jevRoutes";
import { routeForBinding } from "./agentRouting";
import type { JevRouteResult } from "~/types/desktop";

// The cache lives in a module-scope store with no reset, the same arrangement
// as the bindings it shadows — so every test mints its own thread ids, which is
// also closer to the real thing, where a thread id is never reused.
let minted = 0;
function threadId(): string {
  minted += 1;
  return `jev-thread-${minted}`;
}

function routed(agentId: string, confidence = 0.9): JevRouteResult {
  return { agentId, confidence, outcome: "routed", probabilities: { [agentId]: confidence } };
}
// The store's bindings are the durable copy; this map is the cache in front of
// them, and `~/utils/agentStore` is the only thing that writes it — always with
// an answer the binding beside it just settled on.
describe("applyJevRoute", () => {
  test("remembers the decision behind a thread's marker", () => {
    const id = threadId();
    applyJevRoute(id, "kone", routeForBinding(routed("kone", 0.82)));
    expect(jevRouteFor(id)).toEqual({ agentId: "kone", confidence: 0.82 });
  });

  test("a thread that was never routed has no row and shows no marker", () => {
    expect(jevRouteFor(threadId())).toBeUndefined();
    expect(jevRouteFor(null)).toBeUndefined();
    expect(jevRouteFor(undefined)).toBeUndefined();
  });

  // Who and why settle together, so the marker answers to the binding that
  // actually landed. A bind the store refused comes back as the row that won —
  // hand-picked, with no route on it — and the marker has to come down with it
  // rather than stand over a decision that never took effect.
  test("a settle with no route takes down whatever the thread was showing", () => {
    const id = threadId();
    applyJevRoute(id, "kone", routeForBinding(routed("kone")));
    applyJevRoute(id, "orchestrator", null);
    expect(jevRouteFor(id)).toBeUndefined();
  });

  test("a settle with a route of its own replaces the one before it", () => {
    const id = threadId();
    applyJevRoute(id, "kone", { outcome: "routed", confidence: 0.9 });
    applyJevRoute(id, "orchestrator", { outcome: "routed", confidence: 0.4 });
    expect(jevRouteFor(id)).toEqual({ agentId: "orchestrator", confidence: 0.4 });
  });

  // The store keeps the tag verbatim and has no opinion on it, so a row written
  // by a newer build can carry a word this one has never heard of. Showing a
  // marker for it would mean rendering a decision we cannot describe.
  test("an outcome this build does not know reads as unrouted", () => {
    const id = threadId();
    applyJevRoute(id, "kone", { outcome: "delegated", confidence: 0.5 });
    expect(jevRouteFor(id)).toBeUndefined();
  });

  test("a route on a guest binding names nobody, so it shows nothing", () => {
    const id = threadId();
    applyJevRoute(id, null, { outcome: "routed", confidence: 0.5 });
    expect(jevRouteFor(id)).toBeUndefined();
  });

  // The confidence crosses the store as a plain number and is rendered as a
  // percentage at the other end, so it is held to its documented scale here
  // rather than trusted to arrive on it.
  test("a confidence off the 0–1 scale is clamped back onto it", () => {
    const high = threadId();
    const low = threadId();
    applyJevRoute(high, "kone", { outcome: "routed", confidence: 7.5 });
    applyJevRoute(low, "kone", { outcome: "routed", confidence: -2 });
    expect(jevRouteFor(high)?.confidence).toBe(1);
    expect(jevRouteFor(low)?.confidence).toBe(0);
  });

  test("a confidence that is no number at all reads as unrouted", () => {
    const id = threadId();
    applyJevRoute(id, "kone", { outcome: "routed", confidence: Number.NaN });
    expect(jevRouteFor(id)).toBeUndefined();
  });
});

describe("carryJevRoute", () => {
  test("a reborn thread keeps the decision that staffed it", () => {
    const from = threadId();
    const to = threadId();
    applyJevRoute(from, "kone", { outcome: "routed", confidence: 0.7 });
    carryJevRoute(from, to);
    expect(jevRouteFor(to)).toEqual({ agentId: "kone", confidence: 0.7 });
  });

  test("an unrouted thread carries nothing, rather than carrying an absence", () => {
    const from = threadId();
    const to = threadId();
    applyJevRoute(to, "kone", { outcome: "routed", confidence: 0.3 });
    carryJevRoute(from, to);
    expect(jevRouteFor(to)).toEqual({ agentId: "kone", confidence: 0.3 });
  });
});

// Replaced and not merged, so the cache shrinks with the history rather than
// keeping every thread the app ever routed.
describe("applyJevRouteSnapshot", () => {
  test("takes the store's word, and drops threads it no longer names", () => {
    const gone = threadId();
    const kept = threadId();
    applyJevRoute(gone, "orchestrator", { outcome: "routed", confidence: 0.9 });
    applyJevRouteSnapshot(
      [{ threadId: kept, agentId: "kone", route: { outcome: "routed", confidence: 0.6 } }],
      [],
    );
    expect(jevRouteFor(kept)).toEqual({ agentId: "kone", confidence: 0.6 });
    expect(jevRouteFor(gone)).toBeUndefined();
  });

  test("a binding with no route reads as a thread settled by hand", () => {
    const id = threadId();
    applyJevRouteSnapshot([{ threadId: id, agentId: "kone", route: null }], []);
    expect(jevRouteFor(id)).toBeUndefined();
  });

  test("a route whose bind is still in the air survives the snapshot", () => {
    const pending = threadId();
    applyJevRoute(pending, "kone", { outcome: "routed", confidence: 0.5 });
    applyJevRouteSnapshot([], [pending]);
    expect(jevRouteFor(pending)).toEqual({ agentId: "kone", confidence: 0.5 });
  });

  // A thread the store names is a thread the store has settled, whoever won the
  // write — so its answer stands over the guess this window is holding, for the
  // route as much as for the agent.
  test("the store wins over the cache for a thread it does name", () => {
    const id = threadId();
    applyJevRoute(id, "kone", { outcome: "routed", confidence: 0.9 });
    applyJevRouteSnapshot([{ threadId: id, agentId: "orchestrator", route: null }], [id]);
    expect(jevRouteFor(id)).toBeUndefined();
  });
});

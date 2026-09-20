import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { route } from "./route.js";
import type { JevCandidate } from "./types.js";

const CANDIDATES: JevCandidate[] = [
  { agentId: "kone", name: "kone", role: "Agent assistant", brief: "General engineering work." },
  {
    agentId: "orchestrator",
    name: "Orchestrator",
    role: "Splits a goal into work and delegates it",
    brief: "Breaks a goal into pieces and hands each to a worker.",
  },
];

/**
 * A reply shaped like the service's, built from the distribution each test is
 * actually about. The winner is whichever option scores highest, exactly as
 * the service reports it.
 */
function reply(probabilities: Record<string, number>, confidence = 0.9): string {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "default";
  return JSON.stringify({
    model: "jev-latest",
    answers: { agent: { type: "choice", choice, confidence, probabilities } },
  });
}

/** The calls the router made, and what it sent. Typed as `fetch` itself rather
 *  than asserted into place, so a change to the call site shows up here as a
 *  type error rather than as a test that quietly stops describing it. */
type Recorder = { calls: string[]; fetch: typeof fetch };

function recorder(body: string, status = 200): Recorder {
  const calls: string[] = [];
  const stub: typeof fetch = async (_input, init) => {
    calls.push(String(init?.body ?? ""));
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch: stub };
}

const realFetch = globalThis.fetch;
const realKey = process.env.TYPESAFE_API_KEY;

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = realKey;
});

describe("route", () => {
  test("hands the request to the agent whose area it is in", async () => {
    globalThis.fetch = recorder(reply({ orchestrator: 0.92, kone: 0.05, default: 0.03 })).fetch;
    const result = await route({ request: "Ship the whole auth rewrite", candidates: CANDIDATES });
    expect(result.agentId).toBe("orchestrator");
    expect(result.outcome).toBe("routed");
  });

  // The failure that motivated the current rule. A general-purpose assistant
  // could answer almost anything a user types, so gating on whether a request
  // "needs" a specialist declined every correct route the model made. Whose
  // job it is, and whether it is hard, are different questions — only the
  // first one is asked now.
  test("routes ordinary work a generalist could also do", async () => {
    globalThis.fetch = recorder(reply({ kone: 0.81, orchestrator: 0.1, default: 0.09 })).fetch;
    const result = await route({
      request: "what will you recommend as a header for the job portal?",
      candidates: CANDIDATES,
    });
    expect(result.agentId).toBe("kone");
    expect(result.outcome).toBe("routed");
  });

  // Two specialists splitting a request evenly is an unconfident distribution
  // about which one — and a certain one about it not being general work.
  test("routes a near-tie between two agents rather than declining it", async () => {
    globalThis.fetch = recorder(
      reply({ kone: 0.46, orchestrator: 0.45, default: 0.09 }, 0.35),
    ).fetch;
    const result = await route({ request: "design the page header", candidates: CANDIDATES });
    expect(result.agentId).toBe("kone");
    expect(result.outcome).toBe("routed");
    expect(result.confidence).toBeCloseTo(0.35);
  });

  test("keeps the default partner when it wins outright", async () => {
    globalThis.fetch = recorder(reply({ default: 0.83, kone: 0.17, orchestrator: 0 })).fetch;
    const result = await route({ request: "thanks, that worked", candidates: CANDIDATES });
    expect(result.agentId).toBeNull();
    expect(result.outcome).toBe("no-match");
  });

  test("declines a winner barely ahead of nobody at all", async () => {
    globalThis.fetch = recorder(reply({ kone: 0.4, default: 0.35, orchestrator: 0.25 })).fetch;
    const result = await route({ request: "fix the thing", candidates: CANDIDATES });
    expect(result.agentId).toBeNull();
    expect(result.outcome).toBe("unsure");
  });

  test("declines a choice naming somebody who is not a candidate", async () => {
    globalThis.fetch = recorder(reply({ ghost: 0.99, default: 0.01 })).fetch;
    const result = await route({ request: "do the work", candidates: CANDIDATES });
    expect(result.agentId).toBeNull();
    expect(result.outcome).toBe("unsure");
  });

  test("falls back rather than throwing when the call fails", async () => {
    globalThis.fetch = recorder(`{"error":"nope"}`, 500).fetch;
    const result = await route({ request: "do the work", candidates: CANDIDATES });
    expect(result.agentId).toBeNull();
    expect(result.outcome).toBe("failed");
  });

  test("never calls out with no key configured", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const seen = recorder(reply({ kone: 0.99 }));
    globalThis.fetch = seen.fetch;
    const result = await route({ request: "do the work", candidates: CANDIDATES });
    expect(result.outcome).toBe("unavailable");
    expect(seen.calls).toEqual([]);
  });

  test("never calls out with nobody to route to", async () => {
    const seen = recorder(reply({ kone: 0.99 }));
    globalThis.fetch = seen.fetch;
    const result = await route({ request: "do the work", candidates: [] });
    expect(result.outcome).toBe("no-match");
    expect(seen.calls).toEqual([]);
  });

  test("asks one question, over the request as typed", async () => {
    const seen = recorder(reply({ kone: 0.95, default: 0.05 }));
    globalThis.fetch = seen.fetch;

    await route({ request: "add a test", candidates: CANDIDATES, project: "kone" });

    expect(seen.calls).toHaveLength(1);
    const payload = JSON.parse(seen.calls[0] ?? "{}");
    expect(payload.state).toEqual({ request: "add a test", project: "kone" });
    expect(Object.keys(payload.questions)).toEqual(["agent"]);
    expect(Object.keys(payload.questions.agent.criteria).sort()).toEqual([
      "default",
      "kone",
      "orchestrator",
    ]);
  });
});

// The per-attempt timeout was never the budget: three attempts plus their
// backoff reached 19.2s, and the user holds a send for all of it. One deadline
// covers the whole loop, so a service that keeps saying "not now" costs a
// bounded wait rather than an unbounded one.
describe("the routing deadline", () => {
  test("stops retrying once the budget is spent, and falls back", async () => {
    let attempts = 0;
    // SAFETY: the stub takes and returns exactly what the router calls fetch
    // with — a Request/URL it ignores, and a Response it reads.
    globalThis.fetch = (async () => {
      attempts += 1;
      // Retryable, so the loop would keep going if only ATTEMPTS bounded it.
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;

    const started = Date.now();
    const result = await route({
      request: "add a migration",
      candidates: [{ agentId: "a1", name: "Ada", role: "Backend", brief: "Databases." }],
    });
    const waited = Date.now() - started;

    // The default partner answers rather than an error reaching the send.
    expect(result.agentId).toBeNull();
    expect(result.outcome).toBe("failed");
    // Bounded by the deadline, not by attempts × per-attempt timeout.
    expect(waited).toBeLessThan(9000);
    expect(attempts).toBeGreaterThanOrEqual(1);
  });

  test("a prompt answer still wins, with no extra attempts", async () => {
    let attempts = 0;
    const answer = reply({ a1: 0.9, default: 0.1 });
    // SAFETY: as above — the stub matches the one call shape the router makes.
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(answer, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await route({
      request: "add a migration",
      candidates: [{ agentId: "a1", name: "Ada", role: "Backend", brief: "Databases." }],
    });

    expect(result.agentId).toBe("a1");
    expect(attempts).toBe(1);
  });
});

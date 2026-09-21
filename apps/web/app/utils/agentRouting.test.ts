import { describe, expect, test } from "bun:test";

import {
  isPrefetchableDraft,
  isRouterId,
  JEV_ROUTER_ID,
  normalizeRouteText,
  routeForBinding,
  routerCandidates,
  routingReceipt,
} from "~/utils/agentRouting";
import type { Agent } from "~/utils/agents";
import type { JevRouteResult } from "~/types/desktop";

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    name: over.id,
    role: "",
    svg: "",
    hue: "#000",
    ink: "#fff",
    capabilities: { skills: [], model: null, modelFallbacks: [] },
    avatar: null,
    bot: null,
    ...over,
  };
}

function result(over: Partial<JevRouteResult>): JevRouteResult {
  return {
    agentId: null,
    outcome: "no-match",
    confidence: 0,
    probabilities: {},
    ...over,
  };
}

describe("isRouterId", () => {
  test("is true only for the sentinel", () => {
    expect(isRouterId(JEV_ROUTER_ID)).toBe(true);
    expect(isRouterId("kone")).toBe(false);
    expect(isRouterId(null)).toBe(false);
    expect(isRouterId(undefined)).toBe(false);
  });
});

describe("routerCandidates", () => {
  test("describes each agent by its own standing orders", () => {
    const candidates = routerCandidates([
      agent({ id: "maya", name: "Maya", role: "Reviewer", instructions: "Review diffs." }),
    ]);
    expect(candidates).toEqual([
      { agentId: "maya", name: "Maya", role: "Reviewer", brief: "Review diffs." },
    ]);
  });

  test("invents nothing for an agent nobody described", () => {
    expect(routerCandidates([agent({ id: "ada", name: "Ada" })])[0]?.brief).toBe("");
  });

  test("never offers the router to itself", () => {
    expect(routerCandidates([agent({ id: JEV_ROUTER_ID, name: "Jev" })])).toEqual([]);
  });
});

describe("routingReceipt", () => {
  test("names the agent and how firmly it was chosen", () => {
    expect(routingReceipt(result({ agentId: "x", outcome: "routed", confidence: 0.94 }), "Maya")).toBe(
      "Jev → Maya · 94%",
    );
  });

  test("says something on every outcome, so silence never reads as working", () => {
    const outcomes: JevRouteResult["outcome"][] = [
      "no-match",
      "unsure",
      "unavailable",
      "failed",
    ];
    for (const outcome of outcomes) {
      expect(routingReceipt(result({ outcome }))).not.toBe("");
    }
  });

  test("distinguishes a missing key from nothing having matched", () => {
    expect(routingReceipt(result({ outcome: "unavailable" }))).toContain("not configured");
    expect(routingReceipt(result({ outcome: "no-match" }))).toContain("nobody on the team");
  });
});

describe("isPrefetchableDraft", () => {
  test("ignores fragments too short to classify", () => {
    expect(isPrefetchableDraft("fix")).toBe(false);
    expect(isPrefetchableDraft("   ")).toBe(false);
  });

  test("ignores slash rows, which never route at send time either", () => {
    expect(isPrefetchableDraft("/compact focus on auth")).toBe(false);
  });

  test("warms a paused draft worth classifying", () => {
    expect(isPrefetchableDraft("review this diff for race conditions")).toBe(true);
  });
});

describe("normalizeRouteText", () => {
  test("trims so a trailing space does not orphan a warmed decision", () => {
    expect(normalizeRouteText("review this diff ")).toBe("review this diff");
  });
});

describe("JEV_ROUTER_ID", () => {
  test("is a reserved word, so a uuid-minted agent can never collide with it", () => {
    expect(JEV_ROUTER_ID).toBe("jev");
    expect(JEV_ROUTER_ID).not.toContain("-");
  });
});

describe("routeForBinding", () => {
  // What the store keeps is the decision, not the whole reply: the alternatives
  // it weighed are working-out, and a marker that never shows them would only
  // be storing them to be believed later.
  test("narrows a router reply to what settles on the binding", () => {
    expect(
      routeForBinding(result({ agentId: "kone", outcome: "routed", confidence: 0.82 })),
    ).toEqual({ outcome: "routed", confidence: 0.82 });
  });

  // A router that could not be reached, or that declined to choose, settled
  // nothing — the send's receipt says so and the thread keeps no record, so one
  // network blip cannot become a permanent line in a conversation's history.
  test.each(["no-match", "unsure", "unavailable", "failed"] as const)(
    "a %s reply settles nothing on the binding",
    (outcome) => {
      expect(routeForBinding(result({ outcome }))).toBeNull();
    },
  );

  test("a decision that named nobody is not a decision", () => {
    expect(routeForBinding(result({ outcome: "routed", confidence: 0.9 }))).toBeNull();
  });
});

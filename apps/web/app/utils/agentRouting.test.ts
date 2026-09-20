import { describe, expect, test } from "bun:test";

import {
  isRouterId,
  JEV_ROUTER_ID,
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

describe("JEV_ROUTER_ID", () => {
  test("is a reserved word, so a uuid-minted agent can never collide with it", () => {
    expect(JEV_ROUTER_ID).toBe("jev");
    expect(JEV_ROUTER_ID).not.toContain("-");
  });
});

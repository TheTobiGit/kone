import { describe, expect, test } from "bun:test";
import type { StepWait } from "~/types/desktop";
import { STEER_WAIT_OFFER_MS, steerWaitLabel, steerWaitOffered } from "./steerWait";

const wait = (over: Partial<StepWait> = {}): StepWait => ({
  from: "user",
  tool: { name: "Bash", text: "bun test" },
  since: 1_000,
  ...over,
});

describe("steerWaitOffered", () => {
  test("offers Interrupt now 30 s into the user's wait, not before", () => {
    expect(steerWaitOffered(wait(), 1_000 + STEER_WAIT_OFFER_MS - 1)).toBe(false);
    expect(steerWaitOffered(wait(), 1_000 + STEER_WAIT_OFFER_MS)).toBe(true);
  });

  test("never for an agent's wait, nor with none", () => {
    expect(steerWaitOffered(wait({ from: "agent" }), 1_000 + 10 * STEER_WAIT_OFFER_MS)).toBe(false);
    expect(steerWaitOffered(null, 10 * STEER_WAIT_OFFER_MS)).toBe(false);
  });
});

describe("steerWaitLabel", () => {
  test("names the agent and the tool call", () => {
    expect(steerWaitLabel(wait(), "Ada")).toBe("Waiting for Ada to finish Bash (bun test)");
  });

  test("without a name or a tool", () => {
    expect(steerWaitLabel(wait({ tool: null }), null)).toBe("Waiting for the agent to finish the current step");
  });
});

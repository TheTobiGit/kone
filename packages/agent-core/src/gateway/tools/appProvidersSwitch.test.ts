import { describe, expect, it } from "bun:test";

import type { ProviderAvailability } from "../../agentModel.js";
import type { AgentModelRef } from "../../rosterRecord.js";
import type { TurnSelection } from "../../selection.js";
import { createRegistry, type GatewayToolContext } from "../registry.js";
import type { GatewayRecord } from "../schemas.js";
import {
  createAppProviderSwitchTools,
  type AppProviderSwitchControls,
  type AppSwitchSelection,
  type AppSwitchStore,
} from "./appProvidersSwitch.js";

function makeCtx(overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    provider: "codex",
    cwd: process.cwd(),
    requestId: "req-1",
    ...overrides,
  };
}

function makeStore(overrides: Partial<AppSwitchStore> = {}): AppSwitchStore {
  return {
    threadMeta: () => ({ provider: "codex", model: "gpt-5" }),
    getThreadAgent: () => null,
    getAgent: () => null,
    ...overrides,
  };
}

function recordingControls(
  outcome: { applied: "direct" | "pending"; selection: TurnSelection } | { refused: string },
): AppProviderSwitchControls & { calls: AppSwitchSelection[] } {
  const calls: AppSwitchSelection[] = [];
  return {
    calls,
    async switchOwnSelection(_threadId, selection) {
      calls.push(selection);
      return outcome;
    },
  };
}

const AVAILABILITY: ProviderAvailability[] = [
  { provider: "codex", available: true, models: ["gpt-5"] },
  { provider: "claudeAgent", available: true, models: ["claude-x"] },
  { provider: "cursor", available: false, models: [] },
];

async function call(
  options: Parameters<typeof createAppProviderSwitchTools>[0],
  input: GatewayRecord,
  ctx: GatewayToolContext = makeCtx(),
) {
  const registry = createRegistry(createAppProviderSwitchTools(options));
  return registry.call(ctx, "app_switch_provider", input, "assistant");
}

describe("app_switch_provider", () => {
  it("switches and carries the new selection in the text with structuredContent stripped", async () => {
    const controls = recordingControls({
      applied: "direct",
      selection: { provider: "claudeAgent", model: "claude-x", effort: "high" },
    });
    const result = await call({ store: makeStore(), controls, availability: async () => AVAILABILITY }, {
      provider: "claudeAgent",
      model: "claude-x",
      effort: "high",
    });
    const text = result.content[0]?.text ?? "";
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeUndefined();
    expect(text).toContain("claudeAgent");
    expect(text).toContain("claude-x");
    expect(text).toContain("high");
    expect(controls.calls).toEqual([{ provider: "claudeAgent", model: "claude-x", effort: "high" }]);
  });

  it("says a mid-turn pick applies when the running turn ends", async () => {
    const controls = recordingControls({ applied: "pending", selection: { provider: "claudeAgent", model: "claude-x" } });
    const result = await call({ store: makeStore(), controls, availability: async () => AVAILABILITY }, {
      provider: "claudeAgent",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text ?? "").toContain("when the turn now running ends");
  });

  it("refuses a switch outside a pinned agent's model and fallbacks", async () => {
    const pinned: AgentModelRef[] = [
      { provider: "claudeAgent", model: "claude-x" },
      { provider: "codex", model: "gpt-5" },
    ];
    const controls = recordingControls({ applied: "direct", selection: { provider: "cursor" } });
    const result = await call(
      {
        store: makeStore({
          getThreadAgent: () => ({ agentId: "a1" }),
          getAgent: () => ({ model: pinned[0]!, modelFallbacks: [pinned[1]!] }),
        }),
        controls,
        availability: async () => AVAILABILITY,
      },
      { provider: "cursor" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("pinned");
    expect(controls.calls).toHaveLength(0);
  });

  it("allows a switch within the pin", async () => {
    const controls = recordingControls({ applied: "direct", selection: { provider: "claudeAgent", model: "claude-x" } });
    const result = await call(
      {
        store: makeStore({
          getThreadAgent: () => ({ agentId: "a1" }),
          getAgent: () => ({
            model: { provider: "claudeAgent", model: "claude-x" },
            modelFallbacks: [{ provider: "codex", model: "gpt-5" }],
          }),
        }),
        controls,
        availability: async () => AVAILABILITY,
      },
      { provider: "claudeAgent", model: "claude-x" },
    );
    expect(result.isError).toBeFalsy();
    expect(controls.calls).toEqual([{ provider: "claudeAgent", model: "claude-x" }]);
  });

  it("refuses an unavailable provider", async () => {
    const controls = recordingControls({ applied: "direct", selection: { provider: "cursor" } });
    const result = await call({ store: makeStore(), controls, availability: async () => AVAILABILITY }, {
      provider: "cursor",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("not available");
    expect(controls.calls).toHaveLength(0);
  });

  it("refuses a no-op selection", async () => {
    const controls = recordingControls({ applied: "direct", selection: { provider: "codex", model: "gpt-5" } });
    const result = await call({ store: makeStore(), controls, availability: async () => AVAILABILITY }, {
      provider: "codex",
      model: "gpt-5",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("already runs on that provider and model");
    expect(controls.calls).toHaveLength(0);
  });

  it("refuses when the switch hook is not wired", async () => {
    const result = await call({ store: makeStore() }, { provider: "claudeAgent" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("Cannot switch providers");
  });

  it("resolves a provider-only fallback request to the allowed model", async () => {
    const controls = recordingControls({ applied: "pending", selection: { provider: "claudeAgent", model: "claude-x" } });
    const result = await call(
      {
        store: makeStore({
          getThreadAgent: () => ({ agentId: "a" }),
          getAgent: () => ({
            model: { provider: "codex", model: "gpt-5" },
            modelFallbacks: [{ provider: "claudeAgent", model: "claude-x" }],
          }),
        }),
        controls,
        availability: async () => AVAILABILITY,
      },
      { provider: "claudeAgent" },
    );
    expect(result.isError).toBeFalsy();
    // The provider-only request takes the one model the chain allows there.
    expect(controls.calls[0]?.model).toBe("claude-x");
  });

  it("refuses a provider-only request with several rungs on that provider", async () => {
    const controls = recordingControls({ applied: "pending", selection: { provider: "claudeAgent" } });
    const result = await call(
      {
        store: makeStore({
          getThreadAgent: () => ({ agentId: "a" }),
          getAgent: () => ({
            model: { provider: "codex", model: "gpt-5" },
            modelFallbacks: [
              { provider: "claudeAgent", model: "claude-x" },
              { provider: "claudeAgent", model: "claude-y" },
            ],
          }),
        }),
        controls,
        availability: async () => AVAILABILITY,
      },
      { provider: "claudeAgent" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toMatch(/several models|Name the model/);
    expect(controls.calls).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";

import { AntigravityAcpAdapter } from "./adapters/AntigravityAcpAdapter.js";
import {
  antigravityToolDetail,
  antigravityToolStatus,
  antigravityToolTarget,
  isAntigravityQuestion,
  parseAntigravityConfigOptions,
  parseAntigravityPlan,
  selectQuestionOption,
  toAntigravityModelDescriptor,
  toAntigravityQuestion,
  type AntigravityAcpRecord,
} from "./adapters/AntigravityAcpAdapter.js";
import {
  FakeAntigravityRpc,
  type FakeAntigravityScenario,
} from "./antigravityAcpTestServer.js";
import type { RuntimeEvent } from "./types.js";

// Pure-protocol unit tests: every shape asserted here follows the ACP
// standard plus the server's documented quirks (mode values, interaction_
// questions, agy.security.warning meta).

function record(cause: unknown): AntigravityAcpRecord {
  // SAFETY: fixtures below are object literals of the documented ACP shape.
  return cause as AntigravityAcpRecord;
}

describe("parseAntigravityConfigOptions", () => {
  test("reads the model and mode selects", () => {
    const options = parseAntigravityConfigOptions(
      record([
        {
          id: "model",
          name: "Model",
          currentValue: "gemini-mock",
          options: [{ value: "gemini-mock", name: "Gemini Mock" }],
        },
        { id: "mode", currentValue: "default", options: [{ value: "yolo" }] },
      ]),
    );
    expect(options.map((option) => option.id)).toEqual(["model", "mode"]);
    expect(options[0]?.options).toEqual([{ value: "gemini-mock", name: "Gemini Mock" }]);
  });

  test("skips entries without ids or option values", () => {
    expect(parseAntigravityConfigOptions(record([{ options: [] }]))).toEqual([]);
  });
});

describe("toAntigravityModelDescriptor", () => {
  test("projects value + name", () => {
    const descriptor = toAntigravityModelDescriptor({ value: "gemini-mock", name: "Gemini Mock" });
    expect(descriptor.id).toBe("gemini-mock");
    expect(descriptor.label).toBe("Gemini Mock");
    expect(descriptor.contextWindowTokens).toBeGreaterThan(0);
  });
});

describe("isAntigravityQuestion", () => {
  test("detects the interaction_ prefix", () => {
    expect(isAntigravityQuestion(record({ toolCall: { toolCallId: "interaction_1" } }))).toBe(true);
    expect(isAntigravityQuestion(record({ toolCall: { toolCallId: "call_1" } }))).toBe(false);
    expect(isAntigravityQuestion(undefined)).toBe(false);
  });
});

describe("toAntigravityQuestion + selectQuestionOption", () => {
  const params = record({
    toolCall: { toolCallId: "interaction_1", title: "Pick one." },
    options: [
      { optionId: "a", name: "Alpha" },
      { optionId: "b", name: "Beta" },
    ],
  });

  test("normalizes the fixed choices", () => {
    const parsed = toAntigravityQuestion(params);
    expect(parsed?.question.options.map((option) => option.label)).toEqual(["Alpha", "Beta"]);
    expect(parsed?.question.multiSelect).toBe(false);
  });

  test("matches exact optionIds and unique labels", () => {
    const parsed = toAntigravityQuestion(params);
    if (!parsed) throw new Error("expected a question");
    expect(selectQuestionOption(parsed, { interaction_1: "b" }, params)).toBe("b");
    expect(selectQuestionOption(parsed, { interaction_1: "Beta" }, params)).toBe("b");
    expect(selectQuestionOption(parsed, { interaction_1: "Gamma" }, params)).toBeUndefined();
    expect(selectQuestionOption(parsed, { interaction_1: null }, params)).toBeUndefined();
  });

  test("rejects duplicate or empty option ids", () => {
    expect(
      toAntigravityQuestion(
        record({
          toolCall: { toolCallId: "interaction_1" },
          options: [{ optionId: "a" }, { optionId: "a" }],
        }),
      ),
    ).toBeUndefined();
    expect(toAntigravityQuestion(record({ toolCall: { toolCallId: "interaction_1" }, options: [] }))).toBeUndefined();
  });
});

describe("antigravityToolTarget", () => {
  test("prefers native command spellings, then paths, then the title", () => {
    expect(antigravityToolTarget(record({ rawInput: { CommandLine: "ls -la" } }))).toBe("ls -la");
    expect(antigravityToolTarget(record({ rawInput: { command: "pwd" } }))).toBe("pwd");
    expect(antigravityToolTarget(record({ rawInput: { TargetFile: "/a/b.ts" } }))).toBe("/a/b.ts");
    expect(antigravityToolTarget(record({ title: "Running build" }))).toBe("Running build");
  });
});

describe("antigravityToolDetail", () => {
  test("collects text blocks and structured output", () => {
    expect(
      antigravityToolDetail(
        record({
          content: [{ type: "content", content: { type: "text", text: "hello" } }],
          rawOutput: { output: "done" },
        }),
      ),
    ).toBe("hello\ndone");
  });

  test("bounds runaway output", () => {
    const detail = antigravityToolDetail(record({ rawOutput: "x".repeat(100_000) }));
    expect(detail.length).toBeLessThanOrEqual(8000);
  });
});

describe("antigravityToolStatus", () => {
  test("maps the three states", () => {
    expect(antigravityToolStatus("completed")).toBe("completed");
    expect(antigravityToolStatus("failed")).toBe("failed");
    expect(antigravityToolStatus("in_progress")).toBe("in-progress");
    expect(antigravityToolStatus(undefined)).toBe("in-progress");
  });
});

describe("parseAntigravityPlan", () => {
  test("re-spells in_progress", () => {
    expect(
      parseAntigravityPlan(record({ entries: [{ content: "Step one", status: "in_progress" }] })),
    ).toEqual([{ content: "Step one", status: "in-progress" }]);
  });

  test("ignores empty entry lists", () => {
    expect(parseAntigravityPlan(record({ entries: [] }))).toBeUndefined();
  });
});

// ── mock-server integration ──────────────────────────────────────────────────

async function waitFor(events: RuntimeEvent[], predicate: (event: RuntimeEvent) => boolean, timeoutMs = 15_000): Promise<RuntimeEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for event.");
}

type MockHarness = {
  adapter: AntigravityAcpAdapter;
  events: RuntimeEvent[];
  rpcs: FakeAntigravityRpc[];
};

async function startHarness(scenario: FakeAntigravityScenario): Promise<MockHarness> {
  const rpcs: FakeAntigravityRpc[] = [];
  const events: RuntimeEvent[] = [];
  const adapter = new AntigravityAcpAdapter((event) => events.push(event), {
    resolveBinary: () => ({
      executablePath: "/mock/agy_acp_server",
      harnessPath: "/mock/harness",
      source: "override",
    }),
    createRpc: () => {
      const rpc = new FakeAntigravityRpc(scenario);
      rpcs.push(rpc);
      return rpc;
    },
  });
  await adapter.startSession({
    threadId: "thread-1",
    provider: "antigravity",
    cwd: "/mock/work",
    mode: "accept-edits",
  });
  return { adapter, events, rpcs };
}

async function stopHarness(harness: MockHarness): Promise<void> {
  await harness.adapter.stopSession("thread-1").catch(() => {});
}

describe("AntigravityAcpAdapter fake protocol", () => {
  test("runs a basic turn: chunks stream, tool completes, turn completes", async () => {
    const harness = await startHarness("basic");
    try {
      const { turnId } = await harness.adapter.sendTurn({ threadId: "thread-1", input: "Hello" });
      const completed = await waitFor(
        harness.events,
        (event) => event.type === "turn.completed" && event.turnId === turnId,
      );
      expect(completed.type).toBe("turn.completed");
      const texts = harness.events.filter(
        (event) => event.type === "item.completed" && event.item.kind === "assistant_text",
      );
      expect(texts.length).toBe(1);
      const tools = harness.events.filter(
        (event) => event.type === "item.completed" && event.item.kind === "tool_call",
      );
      expect(tools.length).toBe(1);
    } finally {
      await stopHarness(harness);
    }
  });

  test("parks an approval and answers it with the selected option", async () => {
    const harness = await startHarness("approval");
    try {
      const { turnId } = await harness.adapter.sendTurn({ threadId: "thread-1", input: "Run it" });
      const asked = await waitFor(harness.events, (event) => event.type === "approval.requested");
      if (asked.type !== "approval.requested") throw new Error("expected approval.requested");
      expect(asked.approval.title).toBe("npm test");
      await harness.adapter.respondToRequest("thread-1", asked.requestId, "allow-once");
      await waitFor(
        harness.events,
        (event) => event.type === "turn.completed" && event.turnId === turnId,
      );
      expect(JSON.stringify(harness.rpcs[0]?.permissionOutcomes ?? [])).toContain(
        '"outcome":"selected","optionId":"proceed_once"',
      );
    } finally {
      await stopHarness(harness);
    }
  });

  test("parks a native question and answers it by label", async () => {
    const harness = await startHarness("question");
    try {
      const { turnId } = await harness.adapter.sendTurn({ threadId: "thread-1", input: "Ask me" });
      const asked = await waitFor(harness.events, (event) => event.type === "user-input.requested");
      if (asked.type !== "user-input.requested") throw new Error("expected user-input.requested");
      expect(asked.questions[0]?.options.map((option) => option.label)).toEqual(["Alpha", "Beta"]);
      await harness.adapter.respondToUserInput("thread-1", asked.requestId, {
        interaction_9: "Beta",
      });
      await waitFor(
        harness.events,
        (event) => event.type === "turn.completed" && event.turnId === turnId,
      );
      expect(JSON.stringify(harness.rpcs[0]?.permissionOutcomes ?? [])).toContain(
        '"outcome":"selected","optionId":"b"',
      );
    } finally {
      await stopHarness(harness);
    }
  });

  test("refuses a same-thread replacement while a turn is live", async () => {
    const rpcs: FakeAntigravityRpc[] = [];
    const events: RuntimeEvent[] = [];
    const adapter = new AntigravityAcpAdapter((event) => events.push(event), {
      resolveBinary: () => ({
        executablePath: "/mock/agy_acp_server",
        harnessPath: "/mock/harness",
        source: "override",
      }),
      createRpc: () => {
        const rpc = new FakeAntigravityRpc("basic");
        rpc.holdPrompt = true;
        rpcs.push(rpc);
        return rpc;
      },
    });
    await adapter.startSession({
      threadId: "thread-1",
      provider: "antigravity",
      cwd: "/mock/work",
      mode: "accept-edits",
    });
    // The turn is live (held inside the fake) once the ack lands.
    await adapter.sendTurn({ threadId: "thread-1", input: "Hello" });
    await expect(
      adapter.startSession({
        threadId: "thread-1",
        provider: "antigravity",
        cwd: "/mock/work",
        mode: "accept-edits",
      }),
    ).rejects.toThrow("while turn");
    // The live turn survives the refused replacement and settles normally.
    rpcs[0]?.releasePrompt();
    const completed = await waitFor(
      events,
      (event) => event.type === "turn.completed",
    );
    expect(completed.type).toBe("turn.completed");
    await stopHarness({ adapter, events, rpcs });
  });
});

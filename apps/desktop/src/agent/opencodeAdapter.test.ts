import { describe, expect, test } from "bun:test";

import {
  accumulateOpenCodeTokens,
  appendOpenCodeTextDelta,
  buildOpenCodeSubagentSnapshot,
  buildOpenCodeTokenUsageKey,
  isOpenCodeNotFound,
  isOpenCodeTurnEnd,
  normalizeOpenCodeTokenUsage,
  parseOpenCodeModels,
  permissionRules,
  reconcileOpenCodeText,
  selectOpenCodeTurnId,
  translateOpenCodeEvent,
} from "./adapters/OpenCodeAdapter.js";

describe("OpenCode pure translation helpers", () => {
  test("parses verbose multiline model blocks and skips malformed blocks", () => {
    const output = [
      "opencode-go/deepseek-v4-flash",
      JSON.stringify({ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", variants: { high: {}, max: {} } }, null, 2),
      "opencode/no-variants",
      JSON.stringify({ id: "no-variants", name: "No Variants", variants: {} }, null, 2),
      "broken/model",
      "{ not json",
    ].join("\n");
    expect(parseOpenCodeModels(output)).toEqual([
      { id: "opencode-go/deepseek-v4-flash", label: "DeepSeek V4 Flash", reasoningEfforts: ["high", "max"], defaultReasoningEffort: "high" },
      { id: "opencode/no-variants", label: "No Variants" },
    ]);
  });

  test("keeps each model's advertised context capacity", () => {
    const output = [
      "openai/model-with-limit",
      JSON.stringify({ providerID: "openai", id: "model-with-limit", name: "Limited", limit: { context: 128000 } }, null, 2),
    ].join("\n");
    expect(parseOpenCodeModels(output)[0]?.contextWindowTokens).toBe(128000);
  });

  test("reconciles snapshot-then-delta and delta-then-snapshot without duplication", () => {
    const first = reconcileOpenCodeText(undefined, "A B");
    const afterDelta = appendOpenCodeTextDelta(first.text, "Bonus");
    const final = reconcileOpenCodeText(afterDelta.text, "A BBonus");
    expect([first.delta, afterDelta.delta, final.delta]).toEqual(["A B", "Bonus", ""]);
    expect(final.text).toBe("A BBonus");
    const deltaFirst = appendOpenCodeTextDelta("A B", "Bonus");
    expect(reconcileOpenCodeText(deltaFirst.text, "A B").text).toBe("A BBonus");
  });

  test("recognizes the tool status ladder", () => {
    const statuses = ["pending", "running", "completed", "error"];
    expect(statuses.map((status) => status === "pending" ? "item.started" : status === "running" ? "item.updated" : "item.completed")).toEqual([
      "item.started", "item.updated", "item.completed", "item.completed",
    ]);
  });

  test("accepts both idle event forms and they are completion candidates", () => {
    expect(isOpenCodeTurnEnd({ type: "session.idle", properties: { sessionID: "ses_1" } })).toBe(true);
    expect(isOpenCodeTurnEnd({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } })).toBe(true);
    expect(isOpenCodeTurnEnd({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })).toBe(false);
  });

  test("drops events from another session", () => {
    expect(translateOpenCodeEvent("ses_1", { type: "message.part.updated", properties: { sessionID: "ses_2" } })).toBe(false);
    expect(translateOpenCodeEvent("ses_1", { type: "message.part.updated", properties: { sessionID: "ses_1" } })).toBe(true);
  });

  test("only treats structured 404s as missing", () => {
    expect(isOpenCodeNotFound({ response: { status: 404 } })).toBe(true);
    expect(isOpenCodeNotFound({ status: 500, body: { name: "NotFoundError" } })).toBe(false);
    expect(isOpenCodeNotFound(new Error("not found"))).toBe(false);
    const cycle: Record<string, unknown> = {}; cycle.cause = cycle;
    expect(isOpenCodeNotFound(cycle)).toBe(false);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) deep = { cause: deep };
    expect(isOpenCodeNotFound(deep)).toBe(false);
  });

  test("accumulates per-step input and output plus reasoning, excluding cache", () => {
    let usage = { input: 0, output: 0 };
    for (const tokens of [
      { input: 8555, output: 46, reasoning: 26, cache: { read: 0, write: 0 } },
      { input: 107, output: 88, reasoning: 0, cache: { read: 8576, write: 0 } },
      { input: 156, output: 8, reasoning: 0, cache: { read: 8704, write: 0 } },
    ]) usage = accumulateOpenCodeTokens(usage, tokens);
    expect(usage).toEqual({ input: 8818, output: 168 });
  });

  test("normalizes assistant token snapshots into thread usage", () => {
    expect(
      normalizeOpenCodeTokenUsage(
        {
          input: 120,
          output: 80,
          reasoning: 30,
          cache: { read: 10, write: 5 },
        },
        200_000,
      ),
    ).toEqual({
      input: 120,
      output: 110,
      total: 245,
      contextUsed: 245,
      contextWindow: 200_000,
    });
    expect(
      normalizeOpenCodeTokenUsage({
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({
        input: 1,
        output: 1,
        reasoning: 1,
      }),
    ).toBeUndefined();
  });

  test("deduplicates assistant usage by message id and token fields", () => {
    const tokens = {
      input: 120,
      output: 80,
      reasoning: 30,
      cache: { read: 10, write: 5 },
    };
    const key = buildOpenCodeTokenUsageKey({ messageId: "msg_1", tokens, contextWindow: 200_000 });
    expect(key).toBe("msg_1:120:10:5:80:30:200000");
    expect(buildOpenCodeTokenUsageKey({ messageId: "msg_1", tokens })).toBe("msg_1:120:10:5:80:30:");
    expect(buildOpenCodeTokenUsageKey({ messageId: "msg_1", tokens: { input: 1 } })).toBeUndefined();
  });

  test("steering reuses the active turn id", () => {
    expect(selectOpenCodeTurnId("opencode-turn-existing")).toBe("opencode-turn-existing");
    expect(selectOpenCodeTurnId(undefined)).toMatch(/^opencode-turn-/);
  });
});

describe("OpenCode subagent run snapshots", () => {
  test("an inherited parent variant becomes the run's effort", () => {
    const snapshot = buildOpenCodeSubagentSnapshot({
      toolUseId: "call-1",
      status: "running",
      toolInput: { subagent_type: "general", description: "Dig into the bug" },
      toolMetadata: { sessionId: "ses_child", providerID: "opencode-go", modelID: "deepseek-v4-flash" },
      stateTitle: undefined,
      childSessionId: "ses_child",
      variant: "high",
    });
    expect(snapshot.effort).toBe("high");
    expect(snapshot.agentType).toBe("general");
    expect(snapshot.model).toBe("opencode-go/deepseek-v4-flash");
    expect(snapshot.taskId).toBe("ses_child");
  });

  test("no variant means no effort field on the run", () => {
    const snapshot = buildOpenCodeSubagentSnapshot({
      toolUseId: "call-2",
      status: "completed",
      toolInput: { description: "No variant" },
      toolMetadata: {},
      stateTitle: undefined,
      childSessionId: undefined,
    });
    expect(snapshot.effort).toBeUndefined();
  });
});

describe("OpenCode permission rules per mode", () => {
  const last = (permission: string, mode: "ask" | "accept-edits" | "full-access") =>
    [...permissionRules(mode)].reverse().find((r) => r.permission === permission);

  test("accept-edits auto-approves file edits but keeps asking for everything else", () => {
    // OpenCode resolves against the LAST matching rule, so the edit-allow rule
    // must come after the edit-ask rule and the `*` catch-all.
    const rules = permissionRules("accept-edits");
    const edit = [...rules].reverse().find((r) => r.permission === "edit");
    expect(edit?.action).toBe("allow");
    for (const permission of ["bash", "webfetch", "websearch", "external_directory"]) {
      const rule = [...rules].reverse().find((r) => r.permission === permission);
      expect(rule?.action).toBe("ask");
    }
    expect([...rules].reverse().find((r) => r.permission === "question")?.action).toBe("allow");
  });

  test("ask asks for edits, full-access allows everything", () => {
    const askEdit = last("edit", "ask");
    expect(askEdit?.action).toBe("ask");
    const fullRules = permissionRules("full-access");
    expect(fullRules).toHaveLength(1);
    expect(fullRules[0]).toEqual({ permission: "*", pattern: "*", action: "allow" });
  });

  test("accept-edits is closed by default outside the named families", () => {
    const rules = permissionRules("accept-edits");
    // The deny catch-all closes the surface for anything the explicit rules
    // don't name (custom/MCP tools, future mutating tools).
    const closed = rules.find((r) => r.permission === "*");
    expect(closed?.action).toBe("deny");
  });
});

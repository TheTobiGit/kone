import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import { fileURLToPath, pathToFileURL } from "node:url";

// The steer harness's temp-copied adapter reaches promptAttachments →
// AttachmentStore → ConversationStore, which loads node:sqlite — an
// Electron-runtime builtin this bun can't load. Stand it in with bun:sqlite
// and point the agent layer's state dir at a throwaway dir, the same pattern
// the Claude adapter test uses. (The pure helpers below never touch that chain, so the existing
// tests are unaffected.)
const testUserDataDir = mkdtempSync(path.join(tmpdir(), "kone-opencode-adapter-"));
mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));
setUserDataDir(testUserDataDir);

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
import type { RuntimeEvent } from "./types.js";

function ofType<T extends RuntimeEvent["type"]>(events: RuntimeEvent[], type: T) {
  return events.filter((e): e is Extract<RuntimeEvent, { type: T }> => e.type === type);
}

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
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      reasoningTokens: 30,
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

// ── OpenCode steerTurn (integration harness) ────────────────────────────────
// The adapter spawns a real opencode server and speaks HTTP to it, so the
// server module is stubbed out (a temp copy of the adapter source with its
// `../opencodeServer.js` import rewritten to a stub file — the
// CodexAdapter.test.ts pattern, which also dodges mock.module registry
// collisions) and global fetch answers the HTTP surface: session create,
// prompt_async, and an event stream that ends immediately. No real binary
// runs; the event pump just drains to completion.

type OpenCodeAdapterModule = typeof import("./adapters/OpenCodeAdapter.js");

const OPENCODE_ADAPTER_SOURCE = fileURLToPath(
  new URL("./adapters/OpenCodeAdapter.ts", import.meta.url),
);
/** The adapter's own directory — the temp copy's relative imports must be
 *  resolved against it (they're written relative to the adapter file, not the
 *  test file, which sits one directory higher). */
const OPENCODE_ADAPTER_DIR = new URL("./adapters/", import.meta.url);

const OPENCODE_SERVER_STUB_SOURCE = `
export type OpenCodeServer = {
  baseUrl: string;
  child: { once: (event: string, listener: (code: number | null) => void) => void };
  dispose: () => Promise<void>;
};
export async function startOpenCodeServer(): Promise<OpenCodeServer> {
  return {
    baseUrl: "http://127.0.0.1:9",
    child: { once: () => {} },
    dispose: async () => {},
  };
}
`;

async function loadOpenCodeAdapterWithStubbedServer(): Promise<OpenCodeAdapterModule> {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-opencode-adapter-real-"));
  const stubServerPath = path.join(dir, "opencodeServerStub.ts");
  writeFileSync(stubServerPath, OPENCODE_SERVER_STUB_SOURCE);
  let source = readFileSync(OPENCODE_ADAPTER_SOURCE, "utf8");
  // Static imports...
  source = source.replace(/from "(\.[^"]+?)\.js"/g, (_match, spec: string) =>
    spec === "../opencodeServer"
      ? `from ${JSON.stringify(pathToFileURL(stubServerPath).href)}`
      : `from ${JSON.stringify(new URL(`${spec}.ts`, OPENCODE_ADAPTER_DIR).href)}`,
  );
  // ...and the dynamic `await import("../promptAttachments.js")` inside
  // sendTurn — same rewrite, it would otherwise resolve against the temp
  // copy's own directory.
  source = source.replace(/import\("(\.[^"]+?)\.js"\)/g, (_match, spec: string) =>
    `import(${JSON.stringify(new URL(`${spec}.ts`, OPENCODE_ADAPTER_DIR).href)})`,
  );
  const copy = path.join(dir, "OpenCodeAdapter.ts");
  writeFileSync(copy, source);
  // SAFETY: the copied module is OpenCodeAdapter.ts with only the server import
  // rewritten, so its exports match OpenCodeAdapterModule.
  return (await import(pathToFileURL(copy).href)) as OpenCodeAdapterModule;
}

describe("OpenCode steerTurn", () => {
  const THREAD = "thread-1";
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; route: string; body?: unknown }> = [];
  let adapterModule: OpenCodeAdapterModule;

  beforeAll(async () => {
    adapterModule = await loadOpenCodeAdapterWithStubbedServer();
  });

  // The HTTP stub must be per-test (beforeEach/afterEach), not beforeAll:
  // this runner hoists every describe's beforeAll before any test runs, so a
  // beforeAll-installed global fetch stub is clobbered by the next describe's
  // and its afterAll restore is not guaranteed to land before another file's
  // tests — leaking the stub across the suite (an unhandled route answered
  // another file's HTTP tests with 404).
  beforeEach(() => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const route = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const rawBody = init?.body;
      const body = rawBody == null ? undefined : JSON.parse(String(rawBody));
      calls.push({ method, route, body });
      if (method === "GET" && route === "/event") {
        return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (method === "POST" && route === "/session") {
        return new Response(JSON.stringify({ data: { id: "ses_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (route.startsWith("/session/ses_1/")) {
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `unhandled ${method} ${route}` }), {
        status: 404,
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function startSession(adapter: OpenCodeAdapterModule["OpenCodeAdapter"]): Promise<void> {
    await adapter.startSession({
      threadId: THREAD,
      provider: "opencode",
      cwd: "/tmp/kone-test-project",
      model: "opencode-go/deepseek-v4-flash",
    });
  }

  test("steer with a live turn reuses the turn id and emits turn.steered", async () => {
    const events: RuntimeEvent[] = [];
    const adapter = new adapterModule.OpenCodeAdapter((event) => events.push(event));
    await startSession(adapter);
    const first = await adapter.sendTurn({
      threadId: THREAD,
      provider: "opencode",
      input: "hello",
    });

    const result = await adapter.steerTurn({
      threadId: THREAD,
      provider: "opencode",
      input: "keep going",
    });

    expect(result.turnId).toBe(first.turnId);
    expect(ofType(events, "turn.started")).toHaveLength(1);

    // The steer is announced into the live turn.
    const steered = ofType(events, "turn.steered");
    expect(steered).toHaveLength(1);
    expect(steered[0]?.turnId).toBe(first.turnId);
    expect(steered[0]?.message).toBe("keep going");

    // The steer rode the same prompt_async channel as any live-session send.
    const promptPosts = calls.filter((c) => c.route === "/session/ses_1/prompt_async");
    expect(promptPosts).toHaveLength(2);
    // SAFETY: prompt_async posts always carry a JSON body with a parts array.
    const steerBody = promptPosts[1]?.body as { parts: Array<{ text?: string }> } | undefined;
    expect(steerBody?.parts.some((part) => part.text === "keep going")).toBe(true);
  });

  test("steer with no live turn falls back to sendTurn", async () => {
    const events: RuntimeEvent[] = [];
    const adapter = new adapterModule.OpenCodeAdapter((event) => events.push(event));
    await startSession(adapter);

    const result = await adapter.steerTurn({
      threadId: THREAD,
      provider: "opencode",
      input: "hello",
    });

    // The fallback opened a real turn.
    const started = ofType(events, "turn.started");
    expect(started).toHaveLength(1);
    expect(started[0]?.turnId).toBe(result.turnId);
    expect(ofType(events, "turn.steered")).toHaveLength(0);
    const sessions = await adapter.listSessions();
    expect(sessions[0]?.activeTurnId).toBe(result.turnId);
  });
});

// ── OpenCode tool status ladder (real event-pump translation) ───────────────
// The steer harness above drains an immediately-closed event stream; this
// harness keeps the stream open and feeds real `message.part.updated` tool
// parts through the adapter's own SSE pump, so the pending/running/completed/
// error → event-type and item-status ladder is exercised through the real
// translation (handlePart + toolStatus), not a re-implementation of the
// ternary inside the test.
describe("OpenCode tool status ladder", () => {
  const THREAD = "ladder-thread";
  const originalFetch = globalThis.fetch;
  let adapterModule: OpenCodeAdapterModule;
  let pushEvent: ((part: Record<string, unknown>) => void) | null = null;
  let closeStream: (() => void) | null = null;

  beforeAll(async () => {
    adapterModule = await loadOpenCodeAdapterWithStubbedServer();
  });

  // Same per-test stub discipline as the steer describe above (this runner
  // hoists beforeAll hooks across describes and does not guarantee their
  // afterAll restore before the next file's tests).
  beforeEach(() => {
    pushEvent = null;
    closeStream = null;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const route = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      if (method === "GET" && route === "/event") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              pushEvent = (part) =>
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "message.part.updated", properties: { sessionID: "ses_1", part } })}\n\n`,
                  ),
                );
              closeStream = () => controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (method === "POST" && route === "/session") {
        return new Response(JSON.stringify({ data: { id: "ses_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (route.startsWith("/session/ses_1/")) {
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `unhandled ${method} ${route}` }), {
        status: 404,
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("maps pending/running/completed/error tool parts onto the item ladder", async () => {
    const events: RuntimeEvent[] = [];
    const adapter = new adapterModule.OpenCodeAdapter((event) => events.push(event));
    await adapter.startSession({
      threadId: THREAD,
      provider: "opencode",
      cwd: "/tmp/kone-test-project",
      model: "opencode-go/deepseek-v4-flash",
    });
    const turn = await adapter.sendTurn({ threadId: THREAD, provider: "opencode", input: "hello" });

    // The pump fetches /event right after startSession; wait until the stream
    // is wired before pushing parts through it.
    const wired = Date.now() + 1_000;
    while (!pushEvent && Date.now() < wired) await new Promise((resolve) => setTimeout(resolve, 2));
    if (!pushEvent || !closeStream) throw new Error("event stream never opened");

    for (const status of ["pending", "running", "completed", "error"]) {
      pushEvent({
        id: `part-${status}`,
        type: "tool",
        tool: "bash",
        callID: `call-${status}`,
        state: { status, title: `run ${status}` },
      });
    }
    closeStream();

    // The pump translates asynchronously; wait for all four ladder parts.
    const isLadderEvent = (e: RuntimeEvent): e is Extract<RuntimeEvent, { type: "item.started" | "item.updated" | "item.completed" }> => {
      if (e.type !== "item.started" && e.type !== "item.updated" && e.type !== "item.completed") return false;
      return e.item.itemId.startsWith("call-");
    };
    const deadline = Date.now() + 2_000;
    while (events.filter(isLadderEvent).length < 4) {
      if (Date.now() > deadline) throw new Error("tool status ladder events never arrived");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const ladder = events.filter(isLadderEvent);
    expect(ladder.map((e) => e.type)).toEqual([
      "item.started",
      "item.updated",
      "item.completed",
      "item.completed",
    ]);
    // The item status follows toolStatus: error is failed, completed is
    // completed, anything live is in-progress.
    expect(ladder.map((e) => e.item.status)).toEqual([
      "in-progress",
      "in-progress",
      "completed",
      "failed",
    ]);
    expect(ladder.map((e) => e.item.itemId)).toEqual([
      "call-pending",
      "call-running",
      "call-completed",
      "call-error",
    ]);
    expect(ladder.every((e) => e.turnId === turn.turnId)).toBe(true);
  });
});

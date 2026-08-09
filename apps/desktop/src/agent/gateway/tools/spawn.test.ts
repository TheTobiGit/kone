import { beforeAll, describe, expect, mock, test } from "bun:test";

import type { SpawnedThread, SpawnThreadResult, StoredThread } from "../../types.js";
import type { GatewayToolContext, ToolEntry } from "../schemas.js";
import {
  READ_THREAD_JSON_SCHEMA,
  SPAWN_THREAD_JSON_SCHEMA,
  SPAWN_TARGETS_JSON_SCHEMA,
  WAIT_FOR_THREADS_JSON_SCHEMA,
} from "../schemas.js";
import { createRegistry } from "../registry.js";

// The tools import ../../threadSpawn.ts, which the engine worker is writing in
// parallel — stub it wholesale (mock.module before the dynamic import, the
// gateway.test.ts pattern) so this suite runs against a controllable fake.

type FakeSpawnErrorCode =
  | "invalid_input"
  | "capability_denied"
  | "provider_unavailable"
  | "not_found"
  | "idempotency_conflict"
  | "internal";

class FakeSpawnError extends Error {
  readonly code: FakeSpawnErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: FakeSpawnErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SpawnError";
    this.code = code;
    this.details = details;
  }
}

type FakeCaller = { threadId: string; turnId: string; provider: string; model?: string; cwd: string };
type FakeSpawnRequest = {
  requestId: string;
  prompt: string;
  title?: string;
  target: { provider: string; model?: string; effort?: string };
  mode?: string;
};
type FakeWaitInput = { threadIds: string[]; runIds?: (string | undefined)[]; timeoutMs?: number; scopeThreadId: string };
type FakeTargetsReport = {
  providers: Array<{
    provider: string;
    label: string;
    available: boolean;
    hint?: string;
    models: Array<{ id: string; label: string; efforts?: string[]; defaultEffort?: string }>;
  }>;
  caller: { provider: string; model?: string; mode: string };
  limits: { depth: number; maxDepth: number; remainingChildren: number; remainingAppWide: number };
};

type FakeEngine = {
  spawn(caller: FakeCaller, request: FakeSpawnRequest): Promise<SpawnThreadResult>;
  targets(caller: FakeCaller): Promise<FakeTargetsReport>;
  isInSubtree(rootThreadId: string, threadId: string): boolean;
  waitFor(input: FakeWaitInput): Promise<{
    threads: SpawnedThread[];
    allTerminal: boolean;
    timedOut: boolean;
    runIds: (string | null)[];
  }>;
};

let currentEngine: FakeEngine | null = null;

mock.module("../../threadSpawn.js", () => ({
  SpawnError: FakeSpawnError,
  SPAWN_WAIT_DEFAULT_MS: 10_000,
  SPAWN_WAIT_MAX_MS: 60_000,
  getSpawnEngine: () => currentEngine,
}));

type SpawnToolStore = { loadThread(threadId: string): StoredThread | null };
let createSpawnTools: (input: { store: SpawnToolStore }) => ToolEntry[];

beforeAll(async () => {
  ({ createSpawnTools } = await import("./spawn.js"));
});

function makeEngine(overrides: Partial<FakeEngine> = {}): FakeEngine {
  return {
    spawn: async () => {
      throw new Error("spawn not stubbed");
    },
    targets: async () => {
      throw new Error("targets not stubbed");
    },
    isInSubtree: () => true,
    waitFor: async () => ({ threads: [], allTerminal: true, timedOut: false, runIds: [] }),
    ...overrides,
  };
}

function makeStore(threads: StoredThread[] = []): SpawnToolStore {
  const byId = new Map(threads.map((t) => [t.threadId, t]));
  return { loadThread: (threadId) => byId.get(threadId) ?? null };
}

const ctx: GatewayToolContext = {
  threadId: "parent-1",
  turnId: "turn-1",
  provider: "codex",
  model: "gpt-5",
  cwd: "/proj",
  requestId: 1,
};

function spawnedThread(overrides: Partial<SpawnedThread> = {}): SpawnedThread {
  return {
    threadId: "child-1",
    parentThreadId: "parent-1",
    title: "Child one",
    provider: "codex",
    status: "working",
    terminal: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("spawn gateway tools", () => {
  test("the four tools carry the exact permission/turn matrix", () => {
    const tools = createSpawnTools({ store: makeStore() });
    const flags = Object.fromEntries(
      tools.map((t) => [t.name, { permission: t.permission, requiresActiveTurn: t.requiresActiveTurn }]),
    );
    expect(flags).toEqual({
      kone_spawn_targets: { permission: "allow", requiresActiveTurn: false },
      kone_spawn_thread: { permission: "allow", requiresActiveTurn: true },
      kone_wait_for_threads: { permission: "allow", requiresActiveTurn: false },
      kone_read_thread: { permission: "allow", requiresActiveTurn: false },
    });
  });

  test("tools/list advertises all four with their JSON schemas", () => {
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const byName = Object.fromEntries(registry.listTools().map((t) => [t.name, t.inputSchema]));
    expect(Object.keys(byName)).toEqual([
      "kone_spawn_targets",
      "kone_spawn_thread",
      "kone_wait_for_threads",
      "kone_read_thread",
    ]);
    expect(byName["kone_spawn_targets"]).toEqual(SPAWN_TARGETS_JSON_SCHEMA);
    expect(byName["kone_spawn_thread"]).toEqual(SPAWN_THREAD_JSON_SCHEMA);
    expect(byName["kone_wait_for_threads"]).toEqual(WAIT_FOR_THREADS_JSON_SCHEMA);
    expect(byName["kone_read_thread"]).toEqual(READ_THREAD_JSON_SCHEMA);
  });

  test("a missing engine returns internal", async () => {
    currentEngine = null;
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_spawn_thread", {
      prompt: "Do the thing.",
      requestId: "op-1",
      target: { provider: "codex" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "internal" });
  });

  test("the registry refuses kone_spawn_thread without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call({ ...ctx, turnId: null }, "kone_spawn_thread", {
      prompt: "Do the thing.",
      requestId: "op-1",
      target: { provider: "codex" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "capability_denied" });
  });

  test("a SpawnError maps to the same gateway code with isError and details", async () => {
    currentEngine = makeEngine({
      spawn: async () => {
        throw new FakeSpawnError("capability_denied", "Spawn depth limit reached (max 2).", {
          limit: 2,
        });
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_spawn_thread", {
      prompt: "Do the thing.",
      requestId: "op-1",
      target: { provider: "codex" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toEqual({
      code: "capability_denied",
      message: "Spawn depth limit reached (max 2).",
      details: { limit: 2 },
    });
  });

  test("kone_spawn_thread forwards the caller and request, returns the spawn", async () => {
    let capturedCaller: FakeCaller | null = null;
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      spawn: async (caller, request) => {
        capturedCaller = caller;
        capturedRequest = request;
        return {
          requestId: request.requestId,
          threadId: "child-1",
          parentThreadId: caller.threadId,
          title: "Fix tests",
          provider: "codex",
          model: "gpt-5",
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_spawn_thread", {
      prompt: "Fix the tests.",
      requestId: "op-1",
      title: "Fix tests",
      target: { provider: "codex", model: "gpt-5" },
      mode: "ask",
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.spawn).toMatchObject({
      threadId: "child-1",
      status: "dispatched",
      parentThreadId: "parent-1",
    });
    // The caller comes from the bound authority context — never the arguments.
    expect(capturedCaller).toEqual({ threadId: "parent-1", turnId: "turn-1", provider: "codex", model: "gpt-5", cwd: "/proj" });
    expect(capturedRequest).toEqual({
      requestId: "op-1",
      prompt: "Fix the tests.",
      title: "Fix tests",
      target: { provider: "codex", model: "gpt-5" },
      mode: "ask",
    });
  });

  test("kone_spawn_targets returns the report", async () => {
    currentEngine = makeEngine({
      targets: async () => ({
        providers: [
          {
            provider: "codex",
            label: "Codex",
            available: true,
            models: [{ id: "gpt-5", label: "GPT-5" }],
          },
          {
            provider: "claudeAgent",
            label: "Claude",
            available: false,
            hint: "not logged in",
            models: [],
          },
        ],
        caller: { provider: "codex", model: "gpt-5", mode: "full-access" },
        limits: { depth: 0, maxDepth: 2, remainingChildren: 12, remainingAppWide: 32 },
      }),
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_spawn_targets", {});
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.report).toMatchObject({
      providers: [
        { provider: "codex", available: true },
        { provider: "claudeAgent", available: false },
      ],
      caller: { provider: "codex", mode: "full-access" },
      limits: { maxDepth: 2, remainingChildren: 12 },
    });
  });

  test("kone_wait_for_threads forwards ids, runIds, timeout and scope, shapes the outcome", async () => {
    let captured: FakeWaitInput | null = null;
    currentEngine = makeEngine({
      waitFor: async (input) => {
        captured = input;
        return {
          threads: [
            spawnedThread({ threadId: "child-1", status: "completed", terminal: true }),
            spawnedThread({ threadId: "child-2", status: "working", terminal: false }),
          ],
          allTerminal: false,
          timedOut: true,
          runIds: ["turn-1", "turn-9"],
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_wait_for_threads", {
      threadIds: ["child-1", "child-2"],
      runIds: ["turn-1", "turn-9"],
      timeoutMs: 5000,
    });
    expect(captured).toEqual({
      threadIds: ["child-1", "child-2"],
      runIds: ["turn-1", "turn-9"],
      timeoutMs: 5000,
      scopeThreadId: "parent-1",
    });
    expect(res.structuredContent).toMatchObject({
      allTerminal: false,
      timedOut: true,
      runIds: ["turn-1", "turn-9"],
    });
    expect((res.structuredContent as { threads: SpawnedThread[] }).threads).toHaveLength(2);
  });

  test("kone_read_thread on an out-of-subtree id returns not_found", async () => {
    currentEngine = makeEngine({ isInSubtree: () => false });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_read_thread", { threadId: "foreign-1" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("kone_read_thread on a subtree thread with no stored transcript returns not_found", async () => {
    currentEngine = makeEngine({ isInSubtree: () => true });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_read_thread", { threadId: "ghost-1" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("kone_read_thread returns newest-last blocks, truncated, without tool payloads", async () => {
    currentEngine = makeEngine({ isInSubtree: () => true });
    const longAnswer =
      "A very long answer that certainly exceeds the two-hundred-character cap by a comfortable margin. ".repeat(4).trim();
    const thread: StoredThread = {
      threadId: "child-1",
      projectPath: "/proj",
      provider: "codex",
      createdAt: 1,
      updatedAt: 2,
      title: "Child one",
      blocks: [
        { id: "b1", role: "user", text: "first", at: 3 },
        {
          id: "b2",
          role: "assistant",
          turnId: "t1",
          state: "completed",
          at: 4,
          items: [{ itemId: "i1", kind: "assistant_text", status: "completed", text: "answer one" }],
        },
        { id: "b3", role: "user", text: "second", at: 5 },
        {
          id: "b4",
          role: "assistant",
          turnId: "t2",
          state: "completed",
          at: 6,
          items: [
            { itemId: "i2", kind: "assistant_text", status: "completed", text: longAnswer },
            {
              itemId: "i3",
              kind: "tool_call",
              status: "completed",
              text: "bash -c 'echo SECRET'",
              name: "bash",
              detail: "SECRET_PAYLOAD_DO_NOT_LEAK",
            },
          ],
        },
      ],
    };
    const registry = createRegistry(createSpawnTools({ store: makeStore([thread]) }));
    const res = await registry.call(ctx, "kone_read_thread", {
      threadId: "child-1",
      limit: 2,
      maxTextChars: 200,
    });
    expect(res.isError).toBeUndefined();
    const messages = (res.structuredContent as { messages: Array<{ role: string; text: string }> }).messages;
    expect(messages[0]).toEqual({ role: "user", text: "second" });
    expect(messages[1].role).toBe("assistant");
    // Truncated with the visible marker, under the cap, tail intact.
    expect(messages[1].text).toContain("…[truncated]");
    expect(messages[1].text.length).toBeLessThanOrEqual(200);
    expect(messages[1].text.startsWith(longAnswer.slice(0, 20))).toBe(true);
    // The tool payload stayed out of the read.
    expect(JSON.stringify(res.structuredContent)).not.toContain("SECRET_PAYLOAD_DO_NOT_LEAK");
  });

  test("kone_read_thread defaults to the last 20 blocks", async () => {
    currentEngine = makeEngine({ isInSubtree: () => true });
    const blocks = Array.from({ length: 25 }, (_, i) => ({
      id: `b${i}`,
      role: "user" as const,
      text: `message ${i}`,
      at: i,
    }));
    const thread: StoredThread = {
      threadId: "child-1",
      projectPath: "/proj",
      provider: "codex",
      createdAt: 1,
      updatedAt: 2,
      title: "Child one",
      blocks,
    };
    const registry = createRegistry(createSpawnTools({ store: makeStore([thread]) }));
    const res = await registry.call(ctx, "kone_read_thread", { threadId: "child-1" });
    const messages = (res.structuredContent as { messages: Array<{ text: string }> }).messages;
    expect(messages).toHaveLength(20);
    expect(messages[0]).toEqual({ role: "user", text: "message 5" });
    expect(messages[19]).toEqual({ role: "user", text: "message 24" });
  });
});

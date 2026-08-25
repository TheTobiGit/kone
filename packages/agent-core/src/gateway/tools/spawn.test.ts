import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { initSpawnEngine as realInitSpawnEngine } from "../../threadSpawn.js";

import type { AgentPersona, SpawnedThread, SpawnThreadResult, StoredThread } from "../../types.js";
import type { AgentRecord, SubagentPresetRecord } from "../../ConversationStore.js";
import type { GatewayToolContext, ToolEntry } from "../schemas.js";
import {
  DELEGATE_JSON_SCHEMA,
  READ_THREAD_JSON_SCHEMA,
  SPAWN_BATCH_JSON_SCHEMA,
  SPAWN_FROM_PRESET_JSON_SCHEMA,
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

/** Detail payload the fake engine attaches, mirroring SpawnError.details. */
type FakeSpawnErrorDetails = { limit: number };

class FakeSpawnError extends Error {
  readonly code: FakeSpawnErrorCode;
  readonly details?: FakeSpawnErrorDetails;

  constructor(code: FakeSpawnErrorCode, message: string, details?: FakeSpawnErrorDetails) {
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
  /** Set only by a delegation — binds the child to a team agent and carries its
   *  identity into the session. A plain spawn leaves both undefined. */
  delegateToAgentId?: string;
  persona?: AgentPersona;
};
type FakeWaitInput = {
  threadIds: string[];
  turnIds?: (string | undefined)[];
  timeoutMs?: number;
  scopeThreadId: string;
  signal?: AbortSignal;
};
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
  // Folded in by the tool handler, never by the fake engine's `targets`.
  presets?: Array<{ name: string; summary?: string; model?: { provider: string; model: string } }>;
  teammates?: Array<{ id: string; name: string; role?: string; summary?: string }>;
};

type FakeEngine = {
  spawn(caller: FakeCaller, request: FakeSpawnRequest): Promise<SpawnThreadResult>;
  targets(caller: FakeCaller): Promise<FakeTargetsReport>;
  isInSubtree(rootThreadId: string, threadId: string): boolean;
  waitFor(input: FakeWaitInput): Promise<{
    threads: SpawnedThread[];
    allTerminal: boolean;
    timedOut: boolean;
    turnIds: (string | null)[];
  }>;
};

let currentEngine: FakeEngine | null = null;
let initializedEngine: any = null;

mock.module("../../threadSpawn.js", () => ({
  SpawnError: FakeSpawnError,
  SPAWN_WAIT_DEFAULT_MS: 10_000,
  SPAWN_WAIT_MAX_MS: 60_000,
  initSpawnEngine: (deps: any) => {
    initializedEngine = realInitSpawnEngine(deps);
    return initializedEngine;
  },
  getSpawnEngine: () => currentEngine ?? initializedEngine,
}));

type SpawnToolStore = {
  loadThread(threadId: string): StoredThread | null;
  listSubagentPresets(): SubagentPresetRecord[];
  getSubagentPreset(presetId: string): SubagentPresetRecord | null;
  listProjectAgents(projectPath: string): AgentRecord[];
};
let createSpawnTools: (input: { store: SpawnToolStore }) => ToolEntry[];

afterAll(() => {
  currentEngine = null;
});

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
    waitFor: async () => ({ threads: [], allTerminal: true, timedOut: false, turnIds: [] }),
    ...overrides,
  };
}

function makeStore(
  threads: StoredThread[] = [],
  presets: SubagentPresetRecord[] = [],
  team: AgentRecord[] = [],
): SpawnToolStore {
  const byId = new Map(threads.map((t) => [t.threadId, t]));
  const presetById = new Map(presets.map((p) => [p.presetId, p]));
  return {
    loadThread: (threadId) => byId.get(threadId) ?? null,
    listSubagentPresets: () => presets,
    getSubagentPreset: (presetId) => presetById.get(presetId) ?? null,
    listProjectAgents: () => team,
  };
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "agent-backend",
    presetId: null,
    name: "Backend",
    role: null,
    instructions: "You own the API layer.",
    faceBody: null,
    faceInk: null,
    skills: null,
    model: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function makePreset(overrides: Partial<SubagentPresetRecord> = {}): SubagentPresetRecord {
  return {
    presetId: "preset-explorer",
    name: "Explorer",
    instructions: "Read only. Report findings, change nothing.",
    model: { provider: "claudeAgent", model: "haiku" },
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
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
  test("the tools carry the exact permission/turn matrix", () => {
    const tools = createSpawnTools({ store: makeStore() });
    const flags = Object.fromEntries(
      tools.map((t) => [t.name, { permission: t.permission, requiresActiveTurn: t.requiresActiveTurn }]),
    );
    expect(flags).toEqual({
      kone_spawn_targets: { permission: "allow", requiresActiveTurn: false },
      kone_spawn_thread: { permission: "allow", requiresActiveTurn: true },
      kone_spawn_from_preset: { permission: "allow", requiresActiveTurn: true },
      kone_delegate: { permission: "allow", requiresActiveTurn: true },
      kone_spawn_batch: { permission: "allow", requiresActiveTurn: true },
      kone_wait_for_threads: { permission: "allow", requiresActiveTurn: false },
      kone_read_thread: { permission: "allow", requiresActiveTurn: false },
    });
  });

  test("tools/list advertises every tool with its JSON schema", () => {
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const byName = Object.fromEntries(registry.listTools().map((t) => [t.name, t.inputSchema]));
    expect(Object.keys(byName)).toEqual([
      "kone_spawn_targets",
      "kone_spawn_thread",
      "kone_spawn_from_preset",
      "kone_delegate",
      "kone_spawn_batch",
      "kone_wait_for_threads",
      "kone_read_thread",
    ]);
    expect(byName["kone_spawn_targets"]).toEqual(SPAWN_TARGETS_JSON_SCHEMA);
    expect(byName["kone_spawn_thread"]).toEqual(SPAWN_THREAD_JSON_SCHEMA);
    expect(byName["kone_spawn_from_preset"]).toEqual(SPAWN_FROM_PRESET_JSON_SCHEMA);
    expect(byName["kone_delegate"]).toEqual(DELEGATE_JSON_SCHEMA);
    expect(byName["kone_spawn_batch"]).toEqual(SPAWN_BATCH_JSON_SCHEMA);
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
    const presets = [
      makePreset(),
      makePreset({
        presetId: "preset-reviewer",
        name: "Code Reviewer",
        instructions: "Look for regressions and edge cases.",
        model: null,
      }),
    ];
    const team = [
      makeAgent(),
      makeAgent({ agentId: "agent-nameless", name: null, instructions: "Hidden." }),
    ];
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], presets, team) }),
    );
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
    // Presets fold in with a one-line gist and their model, in saved order.
    expect(res.structuredContent?.report).toMatchObject({
      presets: [
        {
          name: "Explorer",
          summary: "Read only. Report findings, change nothing.",
          model: { provider: "claudeAgent", model: "haiku" },
        },
        { name: "Code Reviewer", summary: "Look for regressions and edge cases." },
      ],
    });
    // Teammates fold in too — but the nameless one is dropped, since delegation
    // resolves by name.
    expect(res.structuredContent).toMatchObject({
      report: {
        teammates: [
          { id: "agent-backend", name: "Backend", summary: "You own the API layer." },
        ],
      },
    });
    // The plain-text summary names both surfaces so even a client that ignores
    // structuredContent sees them.
    const text = res.content[0]?.text ?? "";
    expect(text).toContain("Explorer");
    expect(text).toContain("Backend");
  });

  test("kone_wait_for_threads forwards ids, turnIds, timeout and scope, shapes the outcome", async () => {
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
          turnIds: ["turn-1", "turn-9"],
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_wait_for_threads", {
      threadIds: ["child-1", "child-2"],
      turnIds: ["turn-1", "turn-9"],
      timeoutMs: 5000,
    });
    expect(captured).toEqual({
      threadIds: ["child-1", "child-2"],
      turnIds: ["turn-1", "turn-9"],
      timeoutMs: 5000,
      scopeThreadId: "parent-1",
    });
    expect(res.structuredContent).toMatchObject({
      allTerminal: false,
      timedOut: true,
      turnIds: ["turn-1", "turn-9"],
      threads: [{ threadId: "child-1" }, { threadId: "child-2" }],
    });
  });

  test("kone_wait_for_threads forwards ctx.signal into engine.waitFor", async () => {
    const controller = new AbortController();
    let captured: FakeWaitInput | null = null;
    currentEngine = makeEngine({
      waitFor: async (input) => {
        captured = input;
        return { threads: [], allTerminal: true, timedOut: false, turnIds: [] };
      },
    });
    const tools = createSpawnTools({ store: makeStore() });
    const waitTool = tools.find((t) => t.name === "kone_wait_for_threads")!;
    const res = await waitTool.handler({ ...ctx, signal: controller.signal }, {
      threadIds: ["child-1"],
    });
    expect(res.isError).toBeUndefined();
    expect(captured).not.toBeNull();
    expect(captured!.signal).toBe(controller.signal);
  });

  test("an AbortError from engine.waitFor is rethrown, not mapped to an error result", async () => {
    currentEngine = makeEngine({
      waitFor: async () => {
        throw Object.assign(new Error("The wait was cancelled."), { name: "AbortError" });
      },
    });
    const tools = createSpawnTools({ store: makeStore() });
    const waitTool = tools.find((t) => t.name === "kone_wait_for_threads")!;
    await expect(
      waitTool.handler(ctx, { threadIds: ["child-1"] }),
    ).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
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
    const sc = res.structuredContent;
    const messages =
      sc !== undefined && sc !== null && "messages" in sc && Array.isArray(sc.messages)
        ? sc.messages
        : [];
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
    const sc = res.structuredContent;
    const messages =
      sc !== undefined && sc !== null && "messages" in sc && Array.isArray(sc.messages)
        ? sc.messages
        : [];
    expect(messages).toHaveLength(20);
    expect(messages[0]).toEqual({ role: "user", text: "message 5" });
    expect(messages[19]).toEqual({ role: "user", text: "message 24" });
  });
});

/** A targets report offering the given providers/models, all available unless
 *  overridden — the shape the preset tool flattens into an availability
 *  snapshot for the fallback resolver. */
function targetsReport(
  providers: Array<{ provider: string; available?: boolean; models: string[] }>,
): FakeTargetsReport {
  return {
    providers: providers.map((p) => ({
      provider: p.provider,
      label: p.provider,
      available: p.available ?? true,
      models: p.models.map((id) => ({ id, label: id })),
    })),
    caller: { provider: "codex", model: "gpt-5", mode: "ask" },
    limits: { depth: 0, maxDepth: 2, remainingChildren: 4, remainingAppWide: 8 },
  };
}

describe("kone_spawn_from_preset", () => {
  test("resolves a preset by name, lays instructions over the task, spawns the resolved model", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "claudeAgent", models: ["haiku", "opus"] }]),
      spawn: async (caller, request) => {
        capturedRequest = request;
        return {
          requestId: request.requestId,
          threadId: "child-1",
          parentThreadId: caller.threadId,
          title: "Look around",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [makePreset()]) }));
    const res = await registry.call(ctx, "kone_spawn_from_preset", {
      preset: "Explorer",
      task: "Map the auth flow.",
      requestId: "op-1",
    });
    expect(res.isError).toBeUndefined();
    expect(capturedRequest).toEqual({
      requestId: "op-1",
      prompt: "Read only. Report findings, change nothing.\n\nYour task:\nMap the auth flow.",
      title: undefined,
      target: { provider: "claudeAgent", model: "haiku" },
      mode: undefined,
    });
    expect(res.structuredContent).toMatchObject({ preset: "Explorer", selection: "preferred" });
  });

  test("resolves a preset by id when the name doesn't match", async () => {
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "claudeAgent", models: ["haiku"] }]),
      spawn: async (caller, request) => ({
        requestId: request.requestId,
        threadId: "child-1",
        parentThreadId: caller.threadId,
        title: "t",
        provider: request.target.provider,
        model: request.target.model,
        mode: "ask",
        status: "dispatched",
      }),
    });
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [makePreset({ presetId: "preset-explorer" })]) }),
    );
    const res = await registry.call(ctx, "kone_spawn_from_preset", {
      preset: "preset-explorer",
      task: "Go.",
      requestId: "op-1",
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ preset: "Explorer" });
  });

  test("an unknown preset returns not_found", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [makePreset()]) }));
    const res = await registry.call(ctx, "kone_spawn_from_preset", {
      preset: "Nobody",
      task: "Go.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("refuses without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [makePreset()]) }));
    const res = await registry.call({ ...ctx, turnId: null }, "kone_spawn_from_preset", {
      preset: "Explorer",
      task: "Go.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "capability_denied" });
  });

  test("refuses with provider_unavailable when the preset's model can't run", async () => {
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
      spawn: async () => {
        throw new Error("spawn must not be called when nothing resolves");
      },
    });
    const preset = makePreset({ model: { provider: "cursor", model: "auto" } });
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [preset]) }));
    const res = await registry.call(ctx, "kone_spawn_from_preset", {
      preset: "Explorer",
      task: "Go.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({
      code: "provider_unavailable",
      details: { tried: ["cursor/auto"] },
    });
  });

  test("a preset with no model preference spawns on the caller's own provider", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
      spawn: async (caller, request) => {
        capturedRequest = request;
        return {
          requestId: request.requestId,
          threadId: "child-1",
          parentThreadId: caller.threadId,
          title: "t",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const preset = makePreset({ model: null });
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [preset]) }));
    const res = await registry.call(ctx, "kone_spawn_from_preset", {
      preset: "Explorer",
      task: "Go.",
      requestId: "op-1",
    });
    expect(res.isError).toBeUndefined();
    // ctx is codex/gpt-5.
    expect(capturedRequest!.target).toEqual({ provider: "codex", model: "gpt-5" });
    expect(res.structuredContent).toMatchObject({ selection: "caller-default" });
  });
});

describe("kone_delegate", () => {
  test("refuses without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [], [makeAgent()]) }),
    );
    const res = await registry.call({ ...ctx, turnId: null }, "kone_delegate", {
      agent: "Backend",
      task: "Build /users.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "capability_denied" });
  });

  test("an agent that isn't on the project team returns not_found", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [], [makeAgent()]) }),
    );
    const res = await registry.call(ctx, "kone_delegate", {
      agent: "Nobody",
      task: "Build /users.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("binds the child to the teammate, carries its persona, delegates the bare task", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
      spawn: async (caller, request) => {
        capturedRequest = request;
        return {
          requestId: request.requestId,
          threadId: "child-1",
          parentThreadId: caller.threadId,
          title: "Build /users",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [], [makeAgent()]) }),
    );
    const res = await registry.call(ctx, "kone_delegate", {
      agent: "backend", // case-insensitive name match
      task: "Build the /users endpoint.",
      requestId: "op-1",
      title: "Build /users",
    });
    expect(res.isError).toBeUndefined();
    // The teammate names no model, so the delegation rides the caller's own
    // provider/model (ctx is codex/gpt-5), and the child is bound to the agent
    // with its identity carried into the session.
    expect(capturedRequest).toEqual({
      requestId: "op-1",
      prompt: "Build the /users endpoint.",
      title: "Build /users",
      target: { provider: "codex", model: "gpt-5" },
      mode: undefined,
      delegateToAgentId: "agent-backend",
      persona: { name: "Backend", instructions: "You own the API layer." },
    });
    expect(res.structuredContent).toMatchObject({
      agent: "Backend",
      selection: "caller-default",
      delegation: {
        threadId: "child-1",
        status: "dispatched",
      },
    });
  });

  test("a teammate with no resolvable name is refused as invalid_input", async () => {
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
    });
    // A built-in the user never customised: found on the team by id, but its
    // name lives only in the renderer, so the stored row has none.
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [], [makeAgent({ name: null })]) }),
    );
    const res = await registry.call(ctx, "kone_delegate", {
      agent: "agent-backend",
      task: "Build /users.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "invalid_input" });
  });

  test("refuses with provider_unavailable when the teammate's model can't run", async () => {
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
      spawn: async () => {
        throw new Error("spawn must not be called when nothing resolves");
      },
    });
    const agent = makeAgent({ model: { provider: "cursor", model: "auto" } });
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [], [agent]) }),
    );
    const res = await registry.call(ctx, "kone_delegate", {
      agent: "Backend",
      task: "Build /users.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({
      code: "provider_unavailable",
      details: { tried: { provider: "cursor", model: "auto" } },
    });
  });

  test("spawns the teammate's own model when it can run", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
      spawn: async (caller, request) => {
        capturedRequest = request;
        return {
          requestId: request.requestId,
          threadId: "child-1",
          parentThreadId: caller.threadId,
          title: "Build /users",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const agent = makeAgent({ model: { provider: "codex", model: "gpt-5" } });
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [], [agent]) }),
    );
    const res = await registry.call(ctx, "kone_delegate", {
      agent: "Backend",
      task: "Build /users.",
      requestId: "op-1",
    });
    expect(res.isError).toBeUndefined();
    expect(capturedRequest!.target).toEqual({ provider: "codex", model: "gpt-5" });
    expect(res.structuredContent).toMatchObject({ selection: "preferred" });
  });
});

describe("kone_spawn_batch", () => {
  test("refuses without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call({ ...ctx, turnId: null }, "kone_spawn_batch", {
      items: [
        {
          requestId: "op-1",
          prompt: "Do task 1",
          target: { provider: "codex", model: "gpt-5" },
        },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "capability_denied" });
  });

  test("spawns multiple direct target items concurrently and returns results", async () => {
    const capturedRequests: FakeSpawnRequest[] = [];
    currentEngine = makeEngine({
      spawn: async (caller, request) => {
        capturedRequests.push(request);
        return {
          requestId: request.requestId,
          threadId: `child-${request.requestId}`,
          parentThreadId: caller.threadId,
          title: request.title ?? `Task ${request.requestId}`,
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_spawn_batch", {
      items: [
        {
          requestId: "op-1",
          prompt: "Task 1 description.",
          title: "Task 1",
          target: { provider: "codex", model: "gpt-5" },
          mode: "ask",
        },
        {
          requestId: "op-2",
          prompt: "Task 2 description.",
          title: "Task 2",
          target: { provider: "codex", model: "gpt-5" },
          mode: "ask",
        },
      ],
    });
    expect(res.isError).toBe(false);
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]).toEqual({
      requestId: "op-1",
      prompt: "Task 1 description.",
      title: "Task 1",
      target: { provider: "codex", model: "gpt-5" },
      mode: "ask",
    });
    expect(capturedRequests[1]).toEqual({
      requestId: "op-2",
      prompt: "Task 2 description.",
      title: "Task 2",
      target: { provider: "codex", model: "gpt-5" },
      mode: "ask",
    });
    expect(res.content[0]?.text).toBe('Spawned 2 threads: "Task 1" (child-op-1), "Task 2" (child-op-2).');
    expect(res.structuredContent).toEqual({
      batch: {
        total: 2,
        succeeded: 2,
        failed: 0,
        threads: [
          {
            index: 0,
            ok: true,
            threadId: "child-op-1",
            title: "Task 1",
            provider: "codex",
            model: "gpt-5",
            kind: "spawn",
          },
          {
            index: 1,
            ok: true,
            threadId: "child-op-2",
            title: "Task 2",
            provider: "codex",
            model: "gpt-5",
            kind: "spawn",
          },
        ],
      },
    });
  });

  test("spawns batch items from presets with combined instructions and resolved models", async () => {
    const capturedRequests: FakeSpawnRequest[] = [];
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "claudeAgent", models: ["haiku", "opus"] }]),
      spawn: async (caller, request) => {
        capturedRequests.push(request);
        return {
          requestId: request.requestId,
          threadId: `child-${request.requestId}`,
          parentThreadId: caller.threadId,
          title: request.title ?? "Preset Task",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const explorerPreset = makePreset({
      presetId: "preset-explorer",
      name: "Explorer",
      instructions: "Read only. Report findings, change nothing.",
      model: { provider: "claudeAgent", model: "haiku" },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [explorerPreset]) }));
    const res = await registry.call(ctx, "kone_spawn_batch", {
      items: [
        {
          requestId: "op-preset-1",
          prompt: "Map the auth flow.",
          preset: "Explorer",
          title: "Explore Auth",
        },
      ],
    });
    expect(res.isError).toBe(false);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toEqual({
      requestId: "op-preset-1",
      prompt: "Read only. Report findings, change nothing.\n\nYour task:\nMap the auth flow.",
      title: "Explore Auth",
      target: { provider: "claudeAgent", model: "haiku" },
      mode: undefined,
    });
    expect(res.content[0]?.text).toBe('Spawned 1 thread: "Explore Auth" (child-op-preset-1).');
    expect(res.structuredContent).toEqual({
      batch: {
        total: 1,
        succeeded: 1,
        failed: 0,
        threads: [
          {
            index: 0,
            ok: true,
            threadId: "child-op-preset-1",
            title: "Explore Auth",
            provider: "claudeAgent",
            model: "haiku",
            preset: "Explorer",
            kind: "preset",
          },
        ],
      },
    });
  });

  test("spawns batch items delegating to teammates carrying persona and agent binding", async () => {
    const capturedRequests: FakeSpawnRequest[] = [];
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
      spawn: async (caller, request) => {
        capturedRequests.push(request);
        return {
          requestId: request.requestId,
          threadId: `child-${request.requestId}`,
          parentThreadId: caller.threadId,
          title: request.title ?? "Delegation Task",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const backendAgent = makeAgent({
      agentId: "agent-backend",
      name: "Backend",
      instructions: "You own the API layer.",
      model: { provider: "codex", model: "gpt-5" },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [backendAgent]) }));
    const res = await registry.call(ctx, "kone_spawn_batch", {
      items: [
        {
          requestId: "op-delegate-1",
          prompt: "Build the /users endpoint.",
          agent: "Backend",
          title: "Build /users",
        },
      ],
    });
    expect(res.isError).toBe(false);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toEqual({
      requestId: "op-delegate-1",
      prompt: "Build the /users endpoint.",
      title: "Build /users",
      target: { provider: "codex", model: "gpt-5" },
      mode: undefined,
      delegateToAgentId: "agent-backend",
      persona: { name: "Backend", instructions: "You own the API layer." },
    });
    expect(res.content[0]?.text).toBe('Spawned 1 thread: "Build /users" (child-op-delegate-1).');
    expect(res.structuredContent).toEqual({
      batch: {
        total: 1,
        succeeded: 1,
        failed: 0,
        threads: [
          {
            index: 0,
            ok: true,
            threadId: "child-op-delegate-1",
            title: "Build /users",
            provider: "codex",
            model: "gpt-5",
            agent: "Backend",
            kind: "delegation",
          },
        ],
      },
    });
  });

  test("handles mixed batch with partial failures formatting summary and structuredContent", async () => {
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
      spawn: async (caller, request) => {
        return {
          requestId: request.requestId,
          threadId: `child-${request.requestId}`,
          parentThreadId: caller.threadId,
          title: request.title ?? "Direct Task",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_spawn_batch", {
      items: [
        {
          requestId: "op-1",
          prompt: "Valid direct spawn task.",
          title: "Valid Task",
          target: { provider: "codex", model: "gpt-5" },
        },
        {
          requestId: "op-2",
          prompt: "Delegate to missing agent.",
          agent: "Backend",
        },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toBe(
      'Spawned 1 thread: "Valid Task" (child-op-1). 1 spawn failed: item 1: No agent "Backend" on this project\'s team.',
    );
    expect(res.structuredContent).toEqual({
      batch: {
        total: 2,
        succeeded: 1,
        failed: 1,
        threads: [
          {
            index: 0,
            ok: true,
            threadId: "child-op-1",
            title: "Valid Task",
            provider: "codex",
            model: "gpt-5",
            kind: "spawn",
          },
          {
            index: 1,
            ok: false,
            error: 'No agent "Backend" on this project\'s team.',
          },
        ],
      },
    });
  });

  test("marks batch as error when all items fail", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_spawn_batch", {
      items: [
        {
          requestId: "op-1",
          prompt: "Invalid preset item",
          preset: "UnknownPreset",
        },
        {
          requestId: "op-2",
          prompt: "Invalid agent item",
          agent: "UnknownAgent",
        },
        {
          requestId: "op-3",
          prompt: "No target item",
        },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe(
      '3 spawn failed: item 0: No preset sub-agent "UnknownPreset"; item 1: No agent "UnknownAgent" on this project\'s team; item 2: Item must specify either target, preset, or agent.',
    );
    expect(res.structuredContent).toEqual({
      batch: {
        total: 3,
        succeeded: 0,
        failed: 3,
        threads: [
          {
            index: 0,
            ok: false,
            error: 'No preset sub-agent "UnknownPreset".',
          },
          {
            index: 1,
            ok: false,
            error: 'No agent "UnknownAgent" on this project\'s team.',
          },
          {
            index: 2,
            ok: false,
            error: "Item must specify either target, preset, or agent.",
          },
        ],
      },
    });
  });

  test("maps SpawnError thrown by engine onto item failure in batch", async () => {
    currentEngine = makeEngine({
      spawn: async (caller, request) => {
        if (request.requestId === "op-fail") {
          throw new FakeSpawnError("capability_denied", "Spawn depth limit reached (max 2).");
        }
        return {
          requestId: request.requestId,
          threadId: `child-${request.requestId}`,
          parentThreadId: caller.threadId,
          title: request.title ?? "Direct Task",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "kone_spawn_batch", {
      items: [
        {
          requestId: "op-ok",
          prompt: "Task OK",
          title: "Task OK",
          target: { provider: "codex", model: "gpt-5" },
        },
        {
          requestId: "op-fail",
          prompt: "Task Fail",
          target: { provider: "codex", model: "gpt-5" },
        },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toBe(
      'Spawned 1 thread: "Task OK" (child-op-ok). 1 spawn failed: item 1: Spawn depth limit reached (max 2).',
    );
    expect(res.structuredContent).toEqual({
      batch: {
        total: 2,
        succeeded: 1,
        failed: 1,
        threads: [
          {
            index: 0,
            ok: true,
            threadId: "child-op-ok",
            title: "Task OK",
            provider: "codex",
            model: "gpt-5",
            kind: "spawn",
          },
          {
            index: 1,
            ok: false,
            error: "Spawn depth limit reached (max 2).",
          },
        ],
      },
    });
  });
});

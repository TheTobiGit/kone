import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { initSpawnEngine as realInitSpawnEngine } from "../../threadSpawn.js";
import { parseSpawnRecords } from "@kone/protocol/spawn-record";
import { z } from "zod";

import type { AgentPersona, ContractTerms, SpawnedThread, SpawnThreadResult, StoredThread } from "../../types.js";
import type {
  AgentRecord,
  NativeSubagentConfig,
  SubagentPresetRecord,
} from "../../ConversationStore.js";
import type { GatewayToolContext, ToolEntry } from "../schemas.js";
import {
  ANSWER_CHILD_INPUT_JSON_SCHEMA,
  CANCEL_WORKER_JSON_SCHEMA,
  CONTINUE_THREAD_JSON_SCHEMA,
  DECLINE_CHILD_GATE_JSON_SCHEMA,
  DELEGATE_TO_TEAMMATE_JSON_SCHEMA,
  READ_RESPONSE_JSON_SCHEMA,
  SPAWN_BATCH_JSON_SCHEMA,
  SPAWN_WORKER_PRESET_JSON_SCHEMA,
  SPAWN_WORKER_JSON_SCHEMA,
  SPAWN_TARGETS_JSON_SCHEMA,
  WAIT_FOR_RESPONSES_JSON_SCHEMA,
} from "../schemas.js";
import { createRegistry } from "../registry.js";
import { mergeVisiblePresets } from "../../rosterRecord.js";
import type { ModelPreference } from "../../modelPreference.js";

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
type FakeSpawnErrorDetails = { limit: number } | { threadId: string };

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
  /** Set only by a contract — the terms of an agent made up for the job. */
  contract?: ContractTerms;
  fallbacks?: Array<{ provider: string; model?: string }>;
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
  continueThread(
    caller: FakeCaller,
    request: { threadId: string; message: string; requestId?: string },
  ): Promise<{ threadId: string; parentThreadId: string; turnId: string; resumed: boolean }>;
  cancelChild(
    caller: FakeCaller,
    threadId: string,
  ): Promise<{ threadId: string; parentThreadId: string; cancelled: boolean }>;
  declineChildGate(
    caller: FakeCaller,
    request: { threadId: string; requestId: string },
  ): Promise<{ threadId: string; requestId: string; resolved: boolean }>;
  answerChildInput(
    caller: FakeCaller,
    request: { threadId: string; requestId: string; answers: Record<string, string | string[] | null> },
  ): Promise<{ threadId: string; requestId: string; owned: boolean; followUp?: string }>;
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
  listNativeSubagentConfigs(): NativeSubagentConfig[];
  listVisiblePresets(): SubagentPresetRecord[];
  listProjectAgents(projectPath: string): AgentRecord[];
  listModelPreferences(): ModelPreference[];
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
    continueThread: async () => {
      throw new Error("continueThread not stubbed");
    },
    cancelChild: async () => {
      throw new Error("cancelChild not stubbed");
    },
    declineChildGate: async () => {
      throw new Error("declineChildGate not stubbed");
    },
    answerChildInput: async () => {
      throw new Error("answerChildInput not stubbed");
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
  nativeConfigs: NativeSubagentConfig[] = [],
  modelPreferences: ModelPreference[] = [],
): SpawnToolStore {
  const byId = new Map(threads.map((t) => [t.threadId, t]));
  const presetById = new Map(presets.map((p) => [p.presetId, p]));
  return {
    loadThread: (threadId) => byId.get(threadId) ?? null,
    listSubagentPresets: () => presets,
    getSubagentPreset: (presetId) => presetById.get(presetId) ?? null,
    listNativeSubagentConfigs: () => nativeConfigs,
    listVisiblePresets: () => mergeVisiblePresets(presets, nativeConfigs),
    listProjectAgents: () => team,
    listModelPreferences: () => modelPreferences,
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
    modelFallbacks: null,
    avatar: null,
    bot: null,
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
    modelFallbacks: null,
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
      agent_directory: { permission: "allow", requiresActiveTurn: false },
      worker_start: { permission: "allow", requiresActiveTurn: true },
      agent_delegate: { permission: "allow", requiresActiveTurn: true },
      agent_contract: { permission: "allow", requiresActiveTurn: true },
      worker_start_batch: { permission: "allow", requiresActiveTurn: true },
      agent_followup: { permission: "allow", requiresActiveTurn: true },
      agent_withdraw: { permission: "allow", requiresActiveTurn: true },
      agent_keep_or_stop: { permission: "allow", requiresActiveTurn: true },
      agent_decline: { permission: "allow", requiresActiveTurn: true },
      agent_answer: { permission: "allow", requiresActiveTurn: true },
      agent_wait: { permission: "allow", requiresActiveTurn: false },
      agent_read: { permission: "allow", requiresActiveTurn: false },
    });
  });

  test("worker_start takes a preset or a target, never both", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "worker_start", {
      task: "Review the diff.",
      requestId: "r-both",
      preset: "Reviewer",
      target: { provider: "codex" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ error: { code: "invalid_input" } });
  });

  test("every hand-off tool is for agents only", () => {
    const tools = createSpawnTools({ store: makeStore() });
    expect(tools.filter((t) => t.agentsOnly !== true).map((t) => t.name)).toEqual([]);
  });

  test("a worker is listed none of them, and is refused them by any name", async () => {
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    expect(registry.listTools(undefined, "all", "worker")).toEqual([]);
    expect(registry.listToolPrompts(undefined, "worker")).toEqual([]);
    const refused = await registry.call(ctx, "agent_spawn", { prompt: "go", requestId: "r" }, undefined, "worker");
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ error: { code: "permission_denied" } });
  });

  test("tools/list advertises every tool with its JSON schema", () => {
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const byName = Object.fromEntries(registry.listTools().map((t) => [t.name, t.inputSchema]));
    expect(Object.keys(byName)).toEqual([
      "agent_directory",
      "worker_start",
      "agent_delegate",
      "agent_contract",
      "worker_start_batch",
      "agent_followup",
      "agent_withdraw",
      "agent_keep_or_stop",
      "agent_decline",
      "agent_answer",
      "agent_wait",
      "agent_read",
    ]);
    expect(byName["agent_directory"]).toEqual(SPAWN_TARGETS_JSON_SCHEMA);
    expect(byName["worker_start"]).toEqual(SPAWN_WORKER_JSON_SCHEMA);
    expect(byName["worker_start"]).toEqual(SPAWN_WORKER_PRESET_JSON_SCHEMA);
    expect(byName["agent_delegate"]).toEqual(DELEGATE_TO_TEAMMATE_JSON_SCHEMA);
    expect(byName["worker_start_batch"]).toEqual(SPAWN_BATCH_JSON_SCHEMA);
    expect(byName["agent_followup"]).toEqual(CONTINUE_THREAD_JSON_SCHEMA);
    expect(byName["agent_withdraw"]).toEqual(CANCEL_WORKER_JSON_SCHEMA);
    expect(byName["agent_decline"]).toEqual(DECLINE_CHILD_GATE_JSON_SCHEMA);
    expect(byName["agent_answer"]).toEqual(ANSWER_CHILD_INPUT_JSON_SCHEMA);
    expect(byName["agent_wait"]).toEqual(WAIT_FOR_RESPONSES_JSON_SCHEMA);
    expect(byName["agent_read"]).toEqual(READ_RESPONSE_JSON_SCHEMA);
  });

  test("a missing engine returns internal", async () => {
    currentEngine = null;
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_spawn", {
      prompt: "Do the thing.",
      requestId: "op-1",
      target: { provider: "codex" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "internal" });
  });

  test("the registry refuses agent_spawn without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call({ ...ctx, turnId: null }, "agent_spawn", {
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
    const res = await registry.call(ctx, "agent_spawn", {
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

  test("agent_ask forwards the caller and request, returns the continuation", async () => {
    let capturedCaller: FakeCaller | null = null;
    let capturedRequest: {
      threadId: string;
      message: string;
      requestId?: string;
    } | null = null;
    currentEngine = makeEngine({
      continueThread: async (caller, request) => {
        capturedCaller = caller;
        capturedRequest = request;
        return {
          threadId: "child-1",
          parentThreadId: caller.threadId,
          turnId: "turn-9",
          resumed: true,
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_ask", {
      threadId: "child-1",
      message: "Also update the README.",
      requestId: "fu-1",
    });

    expect(res.isError).toBeUndefined();
    expect(capturedCaller).toMatchObject({ threadId: ctx.threadId, turnId: ctx.turnId });
    expect(capturedRequest).toEqual({
      threadId: "child-1",
      message: "Also update the README.",
      requestId: "fu-1",
    });
    expect(res.structuredContent?.continuation).toEqual({
      threadId: "child-1",
      parentThreadId: "parent-1",
      turnId: "turn-9",
      resumed: true,
    });
    // The text hands the agent the two ids its next wait needs, and says the
    // session was woken — a settled child is not a dead one.
    const text = res.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain('threadIds ["child-1"]');
    expect(text).toContain('turnIds ["turn-9"]');
    expect(text).toContain("brought back up");
  });

  test("the registry refuses agent_ask without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call({ ...ctx, turnId: null }, "agent_ask", {
      threadId: "child-1",
      message: "Also update the README.",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "capability_denied" });
  });

  test("a not_found child surfaces as a tool error the agent can act on", async () => {
    currentEngine = makeEngine({
      continueThread: async () => {
        throw new FakeSpawnError(
          "not_found",
          'Thread "child-x" is not in this conversation\'s subtree — you can only continue a thread you (or a descendant of yours) spawned.',
          { limit: 0 },
        );
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_ask", {
      threadId: "child-x",
      message: "Also update the README.",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("agent_cancel forwards the caller and threadId, returns the cancellation", async () => {
    let capturedCaller: FakeCaller | null = null;
    let capturedThreadId: string | null = null;
    currentEngine = makeEngine({
      cancelChild: async (caller, threadId) => {
        capturedCaller = caller;
        capturedThreadId = threadId;
        return {
          threadId,
          parentThreadId: caller.threadId,
          cancelled: true,
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_cancel", {
      threadId: "child-1",
    });

    expect(res.isError).toBeUndefined();
    expect(capturedCaller).toMatchObject({ threadId: ctx.threadId, turnId: ctx.turnId });
    expect(capturedThreadId).toBe("child-1");
    expect(res.structuredContent?.cancellation).toEqual({
      threadId: "child-1",
      parentThreadId: "parent-1",
      cancelled: true,
    });
    // One line naming the stopped worker, pointing at the transcript.
    const text = res.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain("child-1");
    expect(text).toContain("agent_read");
  });

  test("the registry refuses agent_cancel without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call({ ...ctx, turnId: null }, "agent_cancel", {
      threadId: "child-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "capability_denied" });
  });

  test("a cancel outside the caller's subtree surfaces as not_found", async () => {
    currentEngine = makeEngine({
      cancelChild: async () => {
        throw new FakeSpawnError(
          "not_found",
          'Thread "child-x" is not in this conversation\'s subtree — you can only cancel a worker you (or a descendant of yours) spawned.',
          { threadId: "child-x" },
        );
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_cancel", {
      threadId: "child-x",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("agent_decline forwards the caller and request, returns the decline", async () => {
    let capturedCaller: FakeCaller | null = null;
    let capturedRequest: { threadId: string; requestId: string } | null = null;
    currentEngine = makeEngine({
      declineChildGate: async (caller, request) => {
        capturedCaller = caller;
        capturedRequest = request;
        return {
          threadId: request.threadId,
          requestId: request.requestId,
          resolved: true,
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_decline", {
      threadId: "child-1",
      requestId: "gate-1",
    });

    expect(res.isError).toBeUndefined();
    expect(capturedCaller).toMatchObject({ threadId: ctx.threadId, turnId: ctx.turnId });
    expect(capturedRequest).toEqual({
      threadId: "child-1",
      requestId: "gate-1",
    });
    expect(res.structuredContent?.decline).toEqual({
      threadId: "child-1",
      requestId: "gate-1",
      resolved: true,
    });
    // One line naming the declined gate and the worker, pointing at the next wait.
    const text = res.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain("child-1");
    expect(text).toContain("gate-1");
    expect(text).toContain("agent_wait");
  });

  test("the registry refuses agent_decline without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call({ ...ctx, turnId: null }, "agent_decline", {
      threadId: "child-1",
      requestId: "gate-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "capability_denied" });
  });

  test("a decline outside the caller's subtree surfaces as not_found", async () => {
    currentEngine = makeEngine({
      declineChildGate: async () => {
        throw new FakeSpawnError(
          "not_found",
          'Thread "child-x" is not in this conversation\'s subtree — you can only decline a gate on a worker you (or a descendant of yours) spawned.',
          { threadId: "child-x" },
        );
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_decline", {
      threadId: "child-x",
      requestId: "gate-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("agent_answer forwards the caller and request, returns the answer", async () => {
    let capturedCaller: FakeCaller | null = null;
    let capturedRequest: {
      threadId: string;
      requestId: string;
      answers: Record<string, string | string[] | null>;
    } | null = null;
    currentEngine = makeEngine({
      answerChildInput: async (caller, request) => {
        capturedCaller = caller;
        capturedRequest = request;
        return {
          threadId: request.threadId,
          requestId: request.requestId,
          owned: true,
        };
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_answer", {
      threadId: "child-1",
      requestId: "q-1",
      answers: { "q-1": "Use Postgres.", skipped: null, picks: ["a", "b"] },
    });

    expect(res.isError).toBeUndefined();
    expect(capturedCaller).toMatchObject({ threadId: ctx.threadId, turnId: ctx.turnId });
    expect(capturedRequest).toEqual({
      threadId: "child-1",
      requestId: "q-1",
      answers: { "q-1": "Use Postgres.", skipped: null, picks: ["a", "b"] },
    });
    expect(res.structuredContent?.answer).toEqual({
      threadId: "child-1",
      requestId: "q-1",
      owned: true,
    });
    // One line naming the answered question and the worker, pointing at the next wait.
    const text = res.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain("child-1");
    expect(text).toContain("q-1");
    expect(text).toContain("agent_wait");
  });

  test("the registry refuses agent_answer without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call({ ...ctx, turnId: null }, "agent_answer", {
      threadId: "child-1",
      requestId: "q-1",
      answers: { "q-1": "Use Postgres." },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "capability_denied" });
  });

  test("an answer outside the caller's subtree surfaces as not_found", async () => {
    currentEngine = makeEngine({
      answerChildInput: async () => {
        throw new FakeSpawnError(
          "not_found",
          'Thread "child-x" is not in this conversation\'s subtree — you can only answer a question on a worker you (or a descendant of yours) spawned.',
          { threadId: "child-x" },
        );
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_answer", {
      threadId: "child-x",
      requestId: "q-1",
      answers: { "q-1": "Use Postgres." },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("a self-cancel surfaces as not_found", async () => {
    currentEngine = makeEngine({
      cancelChild: async (caller, threadId) => {
        if (threadId === caller.threadId) {
          throw new FakeSpawnError(
            "not_found",
            `Thread "${threadId}" is not in this conversation's subtree — you can only cancel a worker you (or a descendant of yours) spawned.`,
            { threadId },
          );
        }
        throw new Error("cancelChild must reject the caller's own thread");
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_cancel", {
      threadId: "parent-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("a self-decline surfaces as not_found", async () => {
    currentEngine = makeEngine({
      declineChildGate: async (caller, request) => {
        if (request.threadId === caller.threadId) {
          throw new FakeSpawnError(
            "not_found",
            `Thread "${request.threadId}" is not in this conversation's subtree — you can only decline a gate on a worker you (or a descendant of yours) spawned.`,
            { threadId: request.threadId },
          );
        }
        throw new Error("declineChildGate must reject the caller's own thread");
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_decline", {
      threadId: "parent-1",
      requestId: "gate-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("a self-answer surfaces as not_found", async () => {
    currentEngine = makeEngine({
      answerChildInput: async (caller, request) => {
        if (request.threadId === caller.threadId) {
          throw new FakeSpawnError(
            "not_found",
            `Thread "${request.threadId}" is not in this conversation's subtree — you can only answer a question on a worker you (or a descendant of yours) spawned.`,
            { threadId: request.threadId },
          );
        }
        throw new Error("answerChildInput must reject the caller's own thread");
      },
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_answer", {
      threadId: "parent-1",
      requestId: "q-1",
      answers: { "q-1": "Use Postgres." },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("agent_spawn forwards the caller and request, returns the spawn", async () => {
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
    const res = await registry.call(ctx, "agent_spawn", {
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

  test("agent_spawn records the spawn and its why for the thread to read back", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      spawn: async (caller, request) => {
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
    const res = await registry.call(ctx, "agent_spawn", {
      prompt: "Fix the tests.",
      requestId: "op-1",
      why: "  Because the suite is slow and I can keep refactoring meanwhile. ",
    });
    expect(spawnResultOf(res)).toEqual({
      spawns: [
        {
          threadId: "child-1",
          title: "Fix tests",
          provider: "codex",
          model: "gpt-5",
          why: "the suite is slow and I can keep refactoring meanwhile",
        },
      ],
      summary: 'Started worker "Fix tests" on codex/gpt-5 as child-1. Collect its response with agent_wait.',
    });
    // The why is the thread's to show, not the child's to read.
    expect(capturedRequest).not.toHaveProperty("why");
  });

  test("agent_spawn with no target inherits the caller's provider and model", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
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
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_spawn", {
      prompt: "Fix the tests.",
      requestId: "op-inherit",
    });
    expect(res.isError).toBeUndefined();
    expect(capturedRequest?.target).toEqual({ provider: "codex", model: "gpt-5" });
  });

  test("agent_targets returns the report", async () => {
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
      createSpawnTools({
        store: makeStore([], presets, team, [
          {
            presetId: "builtin-librarian",
            enabled: false,
            model: null,
            modelFallbacks: null,
            updatedAt: 1,
          },
        ]),
      }),
    );
    const res = await registry.call(ctx, "agent_targets", {});
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
    // The natives follow the stored ones (a stored preset shadows a native by
    // name), and only the enabled ones — this store's config turns Librarian
    // off, so it must not be offered.
    expect(res.structuredContent?.report).toMatchObject({
      presets: [
        {
          name: "Explorer",
          summary: "Read only. Report findings, change nothing.",
          model: { provider: "claudeAgent", model: "haiku" },
        },
        { name: "Code Reviewer", summary: "Look for regressions and edge cases." },
        { name: "Scout" },
        { name: "Reviewer" },
        { name: "Security Reviewer" },
        { name: "Worker" },
      ],
    });
    const report = res.structuredContent?.report;
    // SAFETY: asserted only after the report exists — the toMatchObject above
    // already proved presets is the array being read here.
    const names = report ? (report as { presets: Array<{ name: string }> }).presets.map((p) => p.name) : [];
    expect(names).not.toContain("Librarian");
    // The plain-text summary names presets so even a client that ignores
    // structuredContent sees them.
    const text = res.content[0]?.text ?? "";
    expect(text).toContain("Explorer");
  });

  test("agent_wait forwards ids, turnIds, timeout and scope, shapes the outcome", async () => {
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
    const res = await registry.call(ctx, "agent_wait", {
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

  test("agent_wait puts each child's reply in the text content", async () => {
    currentEngine = makeEngine({
      waitFor: async () => ({
        threads: [
          spawnedThread({
            threadId: "child-1",
            title: "Maya",
            status: "completed",
            terminal: true,
            elapsedMs: 52_000,
            summary: "Zere, kone and Kwame are on this project.",
          }),
          spawnedThread({
            threadId: "child-2",
            title: "Leo",
            status: "failed",
            terminal: true,
            detail: "The provider refused the model.",
          }),
        ],
        allTerminal: true,
        timedOut: false,
        turnIds: ["turn-1", "turn-2"],
      }),
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_wait", {
      threadIds: ["child-1", "child-2"],
    });
    const text = res.content[0]?.text ?? "";
    expect(text).toContain("All 2 threads settled.");
    expect(text).toContain("[Maya] completed in 52s (child-1):");
    expect(text).toContain("Zere, kone and Kwame are on this project.");
    // A failure explains itself in the same place a success reports.
    expect(text).toContain("[Leo] failed (child-2):");
    expect(text).toContain("The provider refused the model.");
  });

  test("agent_wait says so when a settled child left no reply text", async () => {
    currentEngine = makeEngine({
      waitFor: async () => ({
        threads: [spawnedThread({ status: "completed", terminal: true })],
        allTerminal: true,
        timedOut: false,
        turnIds: ["turn-1"],
      }),
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_wait", { threadIds: ["child-1"] });
    expect(res.content[0]?.text ?? "").toContain("(no reply text — read the full transcript");
  });

  test("agent_wait forwards ctx.signal into engine.waitFor", async () => {
    const controller = new AbortController();
    let captured: FakeWaitInput | null = null;
    currentEngine = makeEngine({
      waitFor: async (input) => {
        captured = input;
        return { threads: [], allTerminal: true, timedOut: false, turnIds: [] };
      },
    });
    const tools = createSpawnTools({ store: makeStore() });
    const waitTool = tools.find((t) => t.name === "agent_wait")!;
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
    const waitTool = tools.find((t) => t.name === "agent_wait")!;
    await expect(
      waitTool.handler(ctx, { threadIds: ["child-1"] }),
    ).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
  });

  test("agent_read on an out-of-subtree id returns not_found", async () => {
    currentEngine = makeEngine({ isInSubtree: () => false });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_read", { threadId: "foreign-1" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("agent_read on a subtree thread with no stored transcript returns not_found", async () => {
    currentEngine = makeEngine({ isInSubtree: () => true });
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_read", { threadId: "ghost-1" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("agent_read returns newest-last blocks, truncated, without tool payloads", async () => {
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
    const res = await registry.call(ctx, "agent_read", {
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

  test("agent_read defaults to the last 20 blocks", async () => {
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
    const res = await registry.call(ctx, "agent_read", { threadId: "child-1" });
    const sc = res.structuredContent;
    const messages =
      sc !== undefined && sc !== null && "messages" in sc && Array.isArray(sc.messages)
        ? sc.messages
        : [];
    expect(messages).toHaveLength(20);
    expect(messages[0]).toEqual({ role: "user", text: "message 5" });
    expect(messages[19]).toEqual({ role: "user", text: "message 24" });
  });

  test("agent_read puts the transcript in the text content", async () => {
    currentEngine = makeEngine({ isInSubtree: () => true });
    const thread: StoredThread = {
      threadId: "child-1",
      projectPath: "/proj",
      provider: "codex",
      createdAt: 1,
      updatedAt: 2,
      title: "Ask Maya about teammates",
      blocks: [
        { id: "b1", role: "user", text: "what teammates do you have?", at: 3 },
        {
          id: "b2",
          role: "assistant",
          turnId: "t1",
          state: "completed",
          at: 4,
          items: [
            { itemId: "i1", kind: "assistant_text", status: "completed", text: "Zere, kone, Kwame." },
          ],
        },
        {
          id: "b3",
          role: "assistant",
          turnId: "t2",
          state: "completed",
          at: 5,
          items: [
            {
              itemId: "i2",
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
    const res = await registry.call(ctx, "agent_read", { threadId: "child-1" });
    const text = res.content[0]?.text ?? "";
    expect(text).toContain('Read 3 messages from "Ask Maya about teammates", oldest first:');
    expect(text).toContain("[user] what teammates do you have?");
    expect(text).toContain("[assistant] Zere, kone, Kwame.");
    // A turn that was all tool calls reads as empty rather than as a blank line.
    expect(text).toContain("[assistant] (no text — tool calls only)");
    // The rendered transcript keeps the same tool-payload isolation as the read.
    expect(text).not.toContain("SECRET_PAYLOAD_DO_NOT_LEAK");
  });

  test("agent_read reports an empty transcript as empty", async () => {
    currentEngine = makeEngine({ isInSubtree: () => true });
    const thread: StoredThread = {
      threadId: "child-1",
      projectPath: "/proj",
      provider: "codex",
      createdAt: 1,
      updatedAt: 2,
      title: "Child one",
      blocks: [],
    };
    const registry = createRegistry(createSpawnTools({ store: makeStore([thread]) }));
    const res = await registry.call(ctx, "agent_read", { threadId: "child-1" });
    expect(res.content[0]?.text).toBe('"Child one" has no messages yet.');
  });
});

/** A targets report offering the given providers/models, all available unless
 *  overridden — the shape the preset tool flattens into an availability
 *  snapshot for the fallback resolver. */
const SummarySchema = z.object({ summary: z.string() });

/** The sentence a dispatch result carries for the model, inside its record. */
function batchSummary(res: { content: Array<{ text?: string }> }): string | undefined {
  const text = res.content[0]?.text;
  if (!text) return undefined;
  const parsed = SummarySchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data.summary : undefined;
}

/** A dispatch result read back the way the thread and the model read it. */
function spawnResultOf(res: { content: Array<{ text?: string }> }) {
  return { spawns: parseSpawnRecords(res.content[0]?.text), summary: batchSummary(res) };
}

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

describe("agent_spawn_preset", () => {
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
    const res = await registry.call(ctx, "agent_spawn_preset", {
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
    expect(res.structuredContent).toMatchObject({ preset: "Explorer", selection: "assigned" });
  });

  test("records the spawn with its preset and why for the thread to read back", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "claudeAgent", models: ["haiku"] }]),
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
    const res = await registry.call(ctx, "agent_spawn_preset", {
      preset: "explorer",
      task: "Map the auth flow.",
      requestId: "op-1",
      why: "I need the map before I touch the middleware",
    });
    // The preset reads back by its own name, not the caller's spelling of it.
    expect(spawnResultOf(res)).toEqual({
      spawns: [
        {
          threadId: "child-1",
          title: "Look around",
          provider: "claudeAgent",
          model: "haiku",
          preset: "Explorer",
          why: "I need the map before I touch the middleware",
        },
      ],
      summary: 'Started worker "Look around" from preset Explorer on claudeAgent/haiku as child-1. Collect its response with agent_wait.',
    });
    expect(capturedRequest).not.toHaveProperty("why");
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
    const res = await registry.call(ctx, "agent_spawn_preset", {
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
    const res = await registry.call(ctx, "agent_spawn_preset", {
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
    const res = await registry.call({ ...ctx, turnId: null }, "agent_spawn_preset", {
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
    const res = await registry.call(ctx, "agent_spawn_preset", {
      preset: "Explorer",
      task: "Go.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({
      code: "provider_unavailable",
      details: { tried: [{ provider: "cursor", model: "auto" }] },
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
    const res = await registry.call(ctx, "agent_spawn_preset", {
      preset: "Explorer",
      task: "Go.",
      requestId: "op-1",
    });
    expect(res.isError).toBeUndefined();
    // ctx is codex/gpt-5.
    expect(capturedRequest!.target).toEqual({ provider: "codex", model: "gpt-5" });
    expect(res.structuredContent).toMatchObject({ selection: "inherited" });
  });

  test("a named model override beats the preset's chain", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "claudeAgent", models: ["haiku", "opus"] }]),
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
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [makePreset()]) }));
    const res = await registry.call(ctx, "agent_spawn_preset", {
      preset: "Explorer",
      task: "Go.",
      requestId: "op-1",
      model: { provider: "claudeAgent", model: "opus" },
    });
    expect(res.isError).toBeUndefined();
    expect(capturedRequest?.target).toEqual({ provider: "claudeAgent", model: "opus" });
    expect(capturedRequest?.fallbacks).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ selection: "requested" });
  });

  test("an assigned chain hands the remaining rungs to the engine", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      targets: async () =>
        targetsReport([
          { provider: "claudeAgent", models: ["opus", "sonnet"] },
          { provider: "codex", models: ["gpt-5"] },
        ]),
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
    const preset = makePreset({
      model: { provider: "claudeAgent", model: "opus" },
      modelFallbacks: [{ provider: "codex", model: "gpt-5" }],
    });
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [preset]) }));
    const res = await registry.call(ctx, "agent_spawn_preset", {
      preset: "Explorer",
      task: "Go.",
      requestId: "op-1",
    });
    expect(res.isError).toBeUndefined();
    expect(capturedRequest?.target).toEqual({ provider: "claudeAgent", model: "opus" });
    expect(capturedRequest?.fallbacks).toEqual([{ provider: "codex", model: "gpt-5" }]);
    expect(res.structuredContent).toMatchObject({ selection: "assigned" });
  });

  test("spawns a native by name, on the model the user pinned on it", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      targets: async () =>
        targetsReport([
          { provider: "claudeAgent", models: ["haiku", "opus"] },
          { provider: "codex", models: ["gpt-5"] },
        ]),
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
    const registry = createRegistry(
      createSpawnTools({
        store: makeStore(
          [],
          [],
          [],
          [
            {
              presetId: "builtin-scout",
              enabled: true,
              model: { provider: "claudeAgent", model: "haiku" },
              modelFallbacks: [{ provider: "codex", model: "gpt-5" }],
              updatedAt: 1,
            },
          ],
        ),
      }),
    );
    const res = await registry.call(ctx, "agent_spawn_preset", {
      preset: "Scout",
      task: "Map the auth flow.",
      requestId: "op-1",
    });
    expect(res.isError).toBeUndefined();
    expect(capturedRequest?.target).toEqual({ provider: "claudeAgent", model: "haiku" });
    expect(capturedRequest?.fallbacks).toEqual([{ provider: "codex", model: "gpt-5" }]);
    expect(capturedRequest?.prompt).toContain("Read-only investigation of the codebase");
    expect(capturedRequest?.prompt).toContain("Map the auth flow.");
    expect(res.structuredContent).toMatchObject({ preset: "Scout", selection: "assigned" });
  });

  test("a native the user turned off reads as gone", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(
      createSpawnTools({
        store: makeStore(
          [],
          [],
          [],
          [
            {
              presetId: "builtin-librarian",
              enabled: false,
              model: null,
              modelFallbacks: null,
              updatedAt: 1,
            },
          ],
        ),
      }),
    );
    const res = await registry.call(ctx, "agent_spawn_preset", {
      preset: "Librarian",
      task: "Go.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
  });

  test("a legacy preset name spawns from its successor native", async () => {
    let capturedRequest: FakeSpawnRequest | null = null;
    currentEngine = makeEngine({
      targets: async () =>
        targetsReport([
          { provider: "claudeAgent", models: ["haiku", "opus"] },
          { provider: "codex", models: ["gpt-5"] },
        ]),
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
    // No stored rows at all: "Explorer" is a name only an earlier build
    // shipped, and the Scout native answers for it.
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_spawn_preset", {
      preset: "Explorer",
      task: "Map the auth flow.",
      requestId: "op-1",
    });
    expect(res.isError).toBeUndefined();
    expect(capturedRequest?.prompt).toContain("Read-only investigation of the codebase");
    expect(res.structuredContent).toMatchObject({ preset: "Scout" });
  });
});



describe("agent_spawn_batch", () => {
  test("refuses without a live turn", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call({ ...ctx, turnId: null }, "agent_spawn_batch", {
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
    const res = await registry.call(ctx, "agent_spawn_batch", {
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
    expect(batchSummary(res)).toBe('Spawned 2 threads: "Task 1" (child-op-1), "Task 2" (child-op-2).');
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
    const res = await registry.call(ctx, "agent_spawn_batch", {
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
    expect(batchSummary(res)).toBe('Spawned 1 thread: "Explore Auth" (child-op-preset-1).');
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

  test("a teammate in a worker batch is refused on its own item — delegation is not a worker start", async () => {
    const capturedRequests: FakeSpawnRequest[] = [];
    currentEngine = makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
      spawn: async (caller, request) => {
        capturedRequests.push(request);
        return {
          requestId: request.requestId,
          threadId: `child-${request.requestId}`,
          parentThreadId: caller.threadId,
          title: request.title ?? "Task",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
    const backendAgent = makeAgent({ agentId: "agent-backend", name: "Backend" });
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [backendAgent]) }));
    const res = await registry.call(ctx, "worker_start_batch", {
      items: [
        { requestId: "op-1", task: "Build the /users endpoint.", agent: "Backend" },
        { requestId: "op-2", task: "Run the test suite." },
      ],
    });
    expect(res.isError).toBe(false);
    // Only the worker opened; the teammate was pointed at agent_delegate.
    expect(capturedRequests.map((r) => r.requestId)).toEqual(["op-2"]);
    expect(batchSummary(res)).toContain('"Backend" is a teammate, not a worker');
    expect(batchSummary(res)).toContain("agent_delegate");
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
    const res = await registry.call(ctx, "agent_spawn_batch", {
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
    expect(batchSummary(res)).toBe(
      'Spawned 1 thread: "Valid Task" (child-op-1). 1 spawn failed: item 1: "Backend" is a teammate, not a worker — hand it work with agent_delegate.',
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
            error: '"Backend" is a teammate, not a worker — hand it work with agent_delegate',
          },
        ],
      },
    });
  });

  test("marks batch as error when all items fail", async () => {
    currentEngine = makeEngine();
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_spawn_batch", {
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
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe(
      '2 spawn failed: item 0: No preset sub-agent "UnknownPreset"; item 1: "UnknownAgent" is a teammate, not a worker — hand it work with agent_delegate.',
    );
    expect(res.structuredContent).toEqual({
      batch: {
        total: 2,
        succeeded: 0,
        failed: 2,
        threads: [
          {
            index: 0,
            ok: false,
            error: 'No preset sub-agent "UnknownPreset".',
          },
          {
            index: 1,
            ok: false,
            error: '"UnknownAgent" is a teammate, not a worker — hand it work with agent_delegate',
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
    const res = await registry.call(ctx, "agent_spawn_batch", {
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
    expect(batchSummary(res)).toBe(
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

describe("agent_delegate", () => {
  const delegatingEngine = (captured: FakeSpawnRequest[]) =>
    makeEngine({
      targets: async () => targetsReport([{ provider: "codex", models: ["gpt-5"] }]),
      spawn: async (caller, request) => {
        captured.push(request);
        return {
          requestId: request.requestId,
          threadId: `child-${request.requestId}`,
          parentThreadId: caller.threadId,
          title: request.title ?? "Build /users",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });
  const backend = makeAgent({ model: { provider: "codex", model: "gpt-5" } });

  test("agent_contract opens an agent under the identity and terms the caller wrote", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = delegatingEngine(captured);
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_contract", {
      name: "Frontend Auth",
      role: "Frontend auth specialist",
      instructions: "Keep components small and accessible.",
      task: "Build the login and signup screens.",
      scope: "The two screens; not the API.",
      deliverable: "Working screens wired to the auth endpoints.",
      doneCriteria: "Both render and the auth tests pass.",
      requestId: "c-1",
      title: "Auth screens",
      why: "the frontend is a job of its own",
    });
    expect(res.isError).toBeUndefined();
    const request = captured[0]!;
    expect(request.contract).toEqual({
      name: "Frontend Auth",
      role: "Frontend auth specialist",
      instructions: "Keep components small and accessible.",
      scope: "The two screens; not the API.",
      deliverable: "Working screens wired to the auth endpoints.",
      doneCriteria: "Both render and the auth tests pass.",
    });
    expect(request.persona?.name).toBe("Frontend Auth");
    expect(request.prompt).toStartWith("Build the login and signup screens.\n\nContract terms:");
    expect(request.delegateToAgentId).toBeUndefined();
    const [record] = parseSpawnRecords(res.content[0]?.text);
    expect(record).toMatchObject({
      threadId: "child-c-1",
      contractor: "Frontend Auth",
      contractorRole: "Frontend auth specialist",
      why: "the frontend is a job of its own",
    });
  });

  test("agent_contract refuses terms with a part missing", async () => {
    currentEngine = delegatingEngine([]);
    const registry = createRegistry(createSpawnTools({ store: makeStore() }));
    const res = await registry.call(ctx, "agent_contract", {
      name: "Frontend Auth",
      role: "Frontend auth specialist",
      instructions: "Keep components small.",
      task: "Build the screens.",
      scope: "The screens.",
      deliverable: "Screens.",
      requestId: "c-2",
    });
    expect(res.structuredContent).toMatchObject({ error: { code: "invalid_input" } });
  });

  test("runs the work as the teammate and records who was asked, and why", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = delegatingEngine(captured);
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [backend]) }));
    const res = await registry.call(ctx, "agent_delegate", {
      agent: "backend",
      task: "Build the /users endpoint.",
      requestId: "op-1",
      why: "the API layer is theirs",
    });
    expect(res.isError).toBeUndefined();
    expect(captured).toEqual([
      {
        requestId: "op-1",
        prompt: "Build the /users endpoint.",
        title: undefined,
        target: { provider: "codex", model: "gpt-5" },
        mode: undefined,
        delegateToAgentId: "agent-backend",
        persona: { name: "Backend", instructions: "You own the API layer." },
      },
    ]);
    expect(spawnResultOf(res)).toEqual({
      spawns: [
        {
          threadId: "child-op-1",
          title: "Build /users",
          provider: "codex",
          model: "gpt-5",
          agent: "Backend",
          agentId: "agent-backend",
          why: "the API layer is theirs",
        },
      ],
      summary: 'Delegated "Build /users" to Backend on codex/gpt-5 as child-op-1. Collect its response with agent_wait.',
    });
    expect(res.structuredContent).toMatchObject({ agent: "Backend", delegation: { threadId: "child-op-1" } });
  });

  test("an agent off this project's team is not found", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = delegatingEngine(captured);
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [backend]) }));
    const res = await registry.call(ctx, "agent_delegate", {
      agent: "Frontend",
      task: "Build the page.",
      requestId: "op-1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: "not_found" });
    expect(captured).toHaveLength(0);
  });

  test("a batch records every thread it opened, in item order, each with its own why", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = delegatingEngine(captured);
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [backend]) }));
    const res = await registry.call(ctx, "worker_start_batch", {
      items: [
        { requestId: "a", task: "Write the tests.", title: "Tests", why: "it's mechanical" },
        { requestId: "b", task: "Run the linter.", title: "Lint", why: "it's quick" },
        { requestId: "c", task: "Nope.", agent: "Frontend" },
      ],
    });
    expect(
      parseSpawnRecords(res.content[0]?.text).map((r) => [r.threadId, r.agent ?? null, r.why]),
    ).toEqual([
      ["child-a", null, "it's mechanical"],
      ["child-b", null, "it's quick"],
    ]);
    expect(batchSummary(res)).toContain('1 spawn failed: item 2: "Frontend" is a teammate, not a worker');
  });
});

describe("model preferences by kind of work", () => {
  const prefs: ModelPreference[] = [
    {
      kind: "quick-fix",
      label: "Quick fixes",
      hint: "A small change.",
      model: { provider: "claudeAgent", model: "haiku" },
      effort: "low",
    },
    { kind: "review", label: "Review", hint: "", model: null, effort: null },
    {
      kind: "git",
      label: "Git work",
      hint: "",
      model: { provider: "cursor", model: "gone" },
      effort: null,
    },
  ];

  const capturingEngine = (captured: FakeSpawnRequest[]) =>
    makeEngine({
      targets: async () =>
        targetsReport([
          { provider: "codex", models: ["gpt-5"] },
          { provider: "claudeAgent", models: ["haiku", "opus"] },
        ]),
      spawn: async (caller, request) => {
        captured.push(request);
        return {
          requestId: request.requestId,
          threadId: `child-${request.requestId}`,
          parentThreadId: caller.threadId,
          title: request.title ?? "t",
          provider: request.target.provider,
          model: request.target.model,
          mode: "ask",
          status: "dispatched",
        };
      },
    });

  test("a briefed worker naming a kind runs on the user's model and effort for it", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = capturingEngine(captured);
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [], [], prefs) }));
    const res = await registry.call(ctx, "worker_start", {
      task: "Fix the typo.",
      requestId: "op-1",
      kind: "Quick Fix",
    });
    expect(res.isError).toBeUndefined();
    expect(captured[0]!.target).toEqual({ provider: "claudeAgent", model: "haiku", effort: "low" });
    expect(res.structuredContent).toMatchObject({
      preference: { kind: "quick-fix", outcome: "applied" },
    });
    expect(JSON.stringify(res.content)).toContain("the user's model for Quick fixes");
  });

  test("a target the caller named beats the kind", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = capturingEngine(captured);
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [], [], prefs) }));
    const res = await registry.call(ctx, "worker_start", {
      task: "Fix it.",
      requestId: "op-1",
      kind: "quick-fix",
      target: { provider: "claudeAgent", model: "opus" },
    });
    expect(captured[0]!.target).toEqual({ provider: "claudeAgent", model: "opus" });
    expect(res.structuredContent).toMatchObject({ preference: { outcome: "overridden" } });
  });

  test("a preset's own chain beats the kind; a preset that inherits takes it", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = capturingEngine(captured);
    const pinned = makePreset({ model: { provider: "claudeAgent", model: "opus" } });
    const inheriting = makePreset({ presetId: "preset-free", name: "Free", model: null });
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [pinned, inheriting], [], [], prefs) }),
    );
    await registry.call(ctx, "worker_start", { preset: "Explorer", task: "Go.", requestId: "a", kind: "quick-fix" });
    await registry.call(ctx, "worker_start", { preset: "Free", task: "Go.", requestId: "b", kind: "quick-fix" });
    expect(captured[0]!.target).toEqual({ provider: "claudeAgent", model: "opus" });
    expect(captured[1]!.target).toEqual({ provider: "claudeAgent", model: "haiku", effort: "low" });
  });

  test("a teammate with no model of its own takes the kind", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = capturingEngine(captured);
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [], [makeAgent({ model: null })], [], prefs) }),
    );
    const res = await registry.call(ctx, "agent_delegate", {
      agent: "Backend",
      task: "Fix it.",
      requestId: "op-1",
      kind: "quick-fix",
    });
    expect(res.isError).toBeUndefined();
    expect(captured[0]!.target).toEqual({ provider: "claudeAgent", model: "haiku", effort: "low" });
    expect(res.structuredContent).toMatchObject({ selection: "preferred" });
  });

  test("a briefed worker placed by a kind keeps the caller's model as its failover", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = capturingEngine(captured);
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [], [], prefs) }));
    const res = await registry.call(ctx, "worker_start", {
      task: "Fix it.",
      requestId: "op-1",
      kind: "quick-fix",
    });
    expect(res.isError).toBeUndefined();
    expect(captured[0]!.target).toMatchObject({ provider: "claudeAgent", model: "haiku" });
    expect(captured[0]!.fallbacks).toHaveLength(1);
    expect(captured[0]!.fallbacks![0]).toMatchObject({ provider: ctx.provider, model: ctx.model });
  });

  test("a kind with no effort asks for the provider's default, not the caller's effort", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = capturingEngine(captured);
    const plain: ModelPreference[] = [
      { kind: "tests", label: "Tests", hint: "", model: { provider: "claudeAgent", model: "haiku" }, effort: null },
    ];
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [], [], plain) }));
    await registry.call(ctx, "worker_start", { task: "Go.", requestId: "a", kind: "tests" });
    expect(captured[0]!.target).toEqual({ provider: "claudeAgent", model: "haiku", effort: null });
  });

  test("a thread that failed over from the kind's model does not claim to run on it", async () => {
    const captured: FakeSpawnRequest[] = [];
    const base = capturingEngine(captured);
    currentEngine = {
      ...base,
      spawn: async (caller, request) => ({
        ...(await base.spawn(caller, request)),
        provider: ctx.provider,
        model: ctx.model,
        failedOverFrom: { provider: "claudeAgent", model: "haiku", reason: "rate limited" },
      }),
    };
    const inheriting = makePreset({ presetId: "preset-free", name: "Free", model: null });
    const registry = createRegistry(
      createSpawnTools({ store: makeStore([], [inheriting], [makeAgent({ model: null })], [], prefs) }),
    );

    const worker = await registry.call(ctx, "worker_start", { task: "Go.", requestId: "a", kind: "quick-fix" });
    expect(worker.structuredContent).toMatchObject({ preference: { kind: "quick-fix", outcome: "failed_over" } });
    const text = JSON.stringify(worker.content);
    expect(text).not.toContain("That is the user's model");
    expect(text).toContain("Fell back from claudeAgent/haiku");

    const preset = await registry.call(ctx, "worker_start", { preset: "Free", task: "Go.", requestId: "b", kind: "quick-fix" });
    expect(preset.structuredContent).toMatchObject({ selection: "inherited", preference: { outcome: "failed_over" } });
    const delegated = await registry.call(ctx, "agent_delegate", { agent: "Backend", task: "Go.", requestId: "c", kind: "quick-fix" });
    expect(delegated.structuredContent).toMatchObject({ selection: "inherited", preference: { outcome: "failed_over" } });
  });

  test("an unavailable kind, or one with no model set, runs on the caller's model — the unset one reads as unknown", async () => {
    const captured: FakeSpawnRequest[] = [];
    currentEngine = capturingEngine(captured);
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [], [], prefs) }));
    const outcomes: string[] = [];
    for (const kind of ["review", "git", "painting"]) {
      const res = await registry.call(ctx, "worker_start", { task: "Go.", requestId: kind, kind });
      expect(res.isError).toBeUndefined();
      // SAFETY: every start above names a kind, so its result carries a preference note.
      outcomes.push((res.structuredContent as { preference: { outcome: string } }).preference.outcome);
    }
    expect(outcomes).toEqual(["unknown", "unavailable", "unknown"]);
    for (const request of captured) expect(request.target).toEqual({ provider: "codex", model: "gpt-5" });
  });

  test("agent_directory lists only the kinds with a model", async () => {
    currentEngine = capturingEngine([]);
    const registry = createRegistry(createSpawnTools({ store: makeStore([], [], [], [], prefs) }));
    const res = await registry.call(ctx, "agent_directory", {});
    // SAFETY: agent_directory's structured result is always { report }.
    const report = (res.structuredContent as { report: { modelPreferences: Array<{ kind: string }> } }).report;
    expect(report.modelPreferences.map((p) => p.kind)).toEqual(["quick-fix", "git"]);
    expect(JSON.stringify(res.content)).toContain("quick-fix (Quick fixes: A small change) → claudeAgent/haiku at low effort");
  });
});

import { describe, expect, it } from "bun:test";

import type { AgentRecord } from "../../ConversationStore.js";
import type { ProviderAvailability } from "../../agentModel.js";
import type { TurnSpan } from "../../conversationStoreTypes.js";
import type { PendingInteraction } from "../../eventSubscriptions.js";
import type { ThreadGateKind } from "../../types.js";
import type { ThreadRuntime } from "../../recipientState.js";
import { IrcMailbox } from "./irc.js";
import type {
  EmitEvent,
  SendTurnInput,
  Session,
  SessionStartInput,
  StoredBlock,
  StoredThread,
  StoredThreadMeta,
} from "../../types.js";
import { encodeCursor } from "../helpers.js";
import { createRegistry, type GatewayToolContext } from "../registry.js";
import type { GatewayRecord } from "../schemas.js";
import type { ProjectRosterEntry } from "./appProjects.js";
import {
  createAppThreadTools,
  type AppThreadsRunner,
  type AppThreadsStore,
  type AppThreadsToolOptions,
} from "./appThreads.js";

const KONE = "/Users/dev/Developer/kone";
/** The assistant's own thread lives on a sentinel project, not a repo; the
 *  read scope exempts it so it can read across projects. The harness must hold
 *  it, exactly as the real store does. */
const ASSISTANT_PROJECT = "__kone_assistant__";
const ASSISTANT_META = thread({
  threadId: "assistant-1",
  title: "kone",
  projectPath: ASSISTANT_PROJECT,
});
const SITE = "/Users/dev/Developer/site";

const PROJECTS: readonly ProjectRosterEntry[] = [
  { path: KONE, name: "kone", active: true, pinned: true, lastOpenedAt: 1_700_000_000_000 },
  { path: SITE, name: "site", active: false, pinned: false, lastOpenedAt: 1_699_000_000_000 },
];

function makeCtx(overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "assistant-1",
    turnId: "turn-1",
    provider: "claudeAgent",
    model: "sonnet",
    cwd: process.cwd(),
    requestId: "req-1",
    ...overrides,
  };
}

function thread(
  overrides: Partial<StoredThreadMeta> & Pick<StoredThreadMeta, "threadId">,
): StoredThreadMeta {
  return {
    projectPath: KONE,
    provider: "claudeAgent",
    createdAt: 1,
    updatedAt: 1_000,
    branch: "dev",
    isPinned: false,
    pinnedAt: null,
    archivedAt: null,
    lastActivityAt: 1_000,
    doneAt: null,
    lastVisitedAt: null,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentRecord> & Pick<AgentRecord, "agentId">): AgentRecord {
  return {
    presetId: null,
    name: overrides.agentId,
    role: null,
    instructions: null,
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

const MAYA = agent({
  agentId: "agent-maya",
  name: "Maya",
  instructions: "Review before you write.",
  model: { provider: "codex", model: "gpt-5" },
});
const REX = agent({ agentId: "agent-rex", name: "Rex" });

const KONE_THREADS: StoredThreadMeta[] = [
  thread({
    threadId: "t-newest",
    title: "Wire the projects module",
    lastActivityAt: 3_000,
    updatedAt: 3_000,
    model: "sonnet",
  }),
  thread({
    threadId: "t-done",
    title: "Fix the strip",
    lastActivityAt: 2_000,
    updatedAt: 2_000,
    doneAt: 2_500,
    lastVisitedAt: 2_500,
  }),
];
const SITE_THREADS: StoredThreadMeta[] = [
  thread({
    threadId: "t-site",
    title: "Landing copy",
    projectPath: SITE,
    lastActivityAt: 2_500,
    updatedAt: 2_500,
  }),
];

function block(role: "user" | "assistant", text: string, at: number): StoredBlock {
  if (role === "user") return { id: `u-${at}`, role: "user", text, at };
  return {
    id: `a-${at}`,
    role: "assistant",
    turnId: `turn-${at}`,
    items: [{ kind: "assistant_text", text }],
    state: "completed",
    at,
  };
}

const TRANSCRIPT: StoredThread = {
  ...thread({ threadId: "t-newest", title: "Wire the projects module" }),
  blocks: [
    block("user", "Add the projects module", 1),
    block("assistant", "Done — two tools and a mirror.", 2),
    block("user", "Now the threads one", 3),
  ],
};

interface StoreCalls {
  bound: Array<{ threadId: string; agentId: string | null }>;
  results: Array<{ requestId: string; resultJson: string }>;
  archived?: Array<{ threadId: string; archived: boolean }>;
  deleted?: string[];
  titles?: Array<{ threadId: string; title: string }>;
  renames?: Array<{ threadId: string; title: string }>;
  cancelledQueues?: string[];
}

function makeStore(
  overrides: Partial<AppThreadsStore> = {},
  calls: StoreCalls = { bound: [], results: [], archived: [], deleted: [], titles: [] },
): AppThreadsStore & { calls: StoreCalls } {
  const reserved = new Map<string, { fingerprint: string; result?: unknown }>();
  const base: AppThreadsStore = {
    listThreads: (path, options) => {
      if (options?.archived) {
        return path === KONE ? [thread({ threadId: "t-old", title: "Old", archivedAt: 5 })] : [];
      }
      if (path === KONE) return KONE_THREADS;
      if (path === SITE) return SITE_THREADS;
      return [];
    },
    loadThread: (threadId) => (threadId === "t-newest" ? TRANSCRIPT : null),
    threadMeta: (threadId) => {
      if (threadId === "assistant-1") return ASSISTANT_META;
      const found = [...KONE_THREADS, ...SITE_THREADS].find((t) => t.threadId === threadId);
      return found ?? null;
    },
    listProjectAgents: (path) => (path === KONE ? [MAYA, REX] : []),
    threadTurnSpan: () => null,
    getThreadAgent: (threadId) =>
      threadId === "t-newest" ? { agentId: "agent-maya" } : { agentId: null },
    getAgent: (agentId) => (agentId === "agent-maya" ? MAYA : agentId === "agent-rex" ? REX : null),
    bindThreadAgent: (threadId, agentId) => {
      calls.bound.push({ threadId, agentId });
      return null;
    },
    reserveGatewayOp: ({ requestId, fingerprint }) => {
      const prior = reserved.get(requestId);
      if (!prior) {
        reserved.set(requestId, { fingerprint });
        return { kind: "reserved" };
      }
      if (prior.fingerprint !== fingerprint) return { kind: "conflict" };
      if (prior.result === undefined) return { kind: "reserved" };
      return { kind: "replay", result: prior.result };
    },
    setGatewayOpResult: ({ requestId, resultJson }) => {
      calls.results.push({ requestId, resultJson });
      const prior = reserved.get(requestId);
      if (prior) prior.result = JSON.parse(resultJson);
    },
    setTitle: (threadId, title) => {
      calls.titles = calls.titles ?? [];
      calls.titles.push({ threadId, title });
      return true;
    },
    renameThread: (threadId, title) => {
      calls.renames = calls.renames ?? [];
      calls.renames.push({ threadId, title });
      return true;
    },
    setArchived: (threadId, archived) => {
      calls.archived = calls.archived ?? [];
      calls.archived.push({ threadId, archived });
      return { ok: true, threadIds: [threadId] };
    },
    canDeleteThread: (threadId) => {
      const exists = threadId === "t-newest" || threadId === "t-done" || threadId === "t-site";
      return exists ? { ok: true } : { ok: false, reason: "missing" };
    },
    deleteThread: (threadId) => {
      calls.deleted = calls.deleted ?? [];
      calls.deleted.push(threadId);
      return { ok: true };
    },
    cancelQueuedTurnsForThread: (threadId) => {
      calls.cancelledQueues = calls.cancelledQueues ?? [];
      calls.cancelledQueues.push(threadId);
      return [];
    },
    ...overrides,
  };
  return { ...base, calls };
}

interface RunnerCalls {
  started: SessionStartInput[];
  turns: Array<{ input: SendTurnInput; options?: { title?: string } }>;
}

function makeRunner(calls: RunnerCalls): AppThreadsRunner {
  return {
    startThread: async (input) => {
      calls.started.push(input);
      const session: Session = {
        threadId: input.threadId,
        provider: input.provider,
        cwd: input.cwd,
        status: "ready",
      };
      return session;
    },
    sendThreadTurn: async (input, options) => {
      calls.turns.push({ input, options });
      return { threadId: input.threadId, turnId: "turn-new" };
    },
  };
}

/** The full provider surface these tests run against: both CLIs installed, with
 *  the models the agents name. */
const AVAILABILITY: ProviderAvailability[] = [
  { provider: "claudeAgent", available: true, models: ["sonnet", "opus"] },
  { provider: "codex", available: true, models: ["gpt-5"] },
];

function tools(
  options: {
    store?: AppThreadsStore;
    projects?: readonly ProjectRosterEntry[] | null;
    runner?: AppThreadsRunner | null;
    live?: string[];
    spans?: Record<string, TurnSpan | null>;
    gates?: Record<string, ThreadGateKind>;
    pendingGates?: () => ReadonlyMap<string, ThreadGateKind>;
    asks?: PendingInteraction[];
    availability?: ProviderAvailability[];
    threadId?: string;
    emit?: EmitEvent;
    stopThread?: (threadId: string) => Promise<{ stopped: boolean; wasRunning: boolean; reason?: string }>;
    archiveThread?: (
      threadId: string,
      archived: boolean,
    ) => Promise<{ ok: boolean; reason?: string; threadIds?: string[] }>;
    deleteThread?: (threadId: string) => Promise<{ ok: boolean; reason?: string }>;
    jobs?: AppThreadsToolOptions["jobs"];
    threadRuntime?: AppThreadsToolOptions["threadRuntime"];
    renameThread?: (
      threadId: string,
      title: string,
    ) => Promise<{ ok: boolean; title?: string; previousTitle?: string | null; reason?: string }>;
    setThreadDone?: (threadId: string, done: boolean) => void;
    listQueuedTurns?: (threadId: string) => import("../../conversationStoreTypes.js").QueuedTurnRow[];
    editQueuedTurn?: (threadId: string, queueId: string, input: string) => Promise<boolean>;
    reorderQueuedTurns?: (threadId: string, queueIds: string[]) => Promise<boolean>;
    cancelQueuedTurn?: (threadId: string, queueId: string) => Promise<boolean>;
    promoteQueuedTurn?: (threadId: string, queueId: string) => Promise<boolean>;
  } = {},
) {
  const live = new Set(options.live ?? []);
  const gates = options.gates ?? {};
  const baseStore = options.store ?? makeStore();
  const storeWithSpans: AppThreadsStore =
    options.spans === undefined
      ? baseStore
      : {
          ...baseStore,
          threadTurnSpan: (threadId) => options.spans?.[threadId] ?? null,
        };
  const toolOptions: AppThreadsToolOptions = {
    store: storeWithSpans,
    readProjects: () => (options.projects === undefined ? PROJECTS : options.projects),
    isThreadLive: (threadId) => live.has(threadId),
    pendingGateFor: (threadId) => gates[threadId] ?? null,
    availability: async () => options.availability ?? AVAILABILITY,
    newThreadId: () => options.threadId ?? "thread-new",
    jobs: options.jobs ?? new IrcMailbox(),
  };
  if (options.pendingGates) toolOptions.pendingGates = options.pendingGates;
  if (options.asks) {
    const asks = options.asks;
    toolOptions.pendingAsks = () => asks;
  }
  if (options.emit) toolOptions.emit = options.emit;
  if (options.stopThread) toolOptions.stopThread = options.stopThread;
  if (options.archiveThread) toolOptions.archiveThread = options.archiveThread;
  if (options.deleteThread) toolOptions.deleteThread = options.deleteThread;
  if (options.renameThread) toolOptions.renameThread = options.renameThread;
  if (options.setThreadDone) toolOptions.setThreadDone = options.setThreadDone;
  if (options.listQueuedTurns) toolOptions.listQueuedTurns = options.listQueuedTurns;
  if (options.editQueuedTurn) toolOptions.editQueuedTurn = options.editQueuedTurn;
  if (options.reorderQueuedTurns) toolOptions.reorderQueuedTurns = options.reorderQueuedTurns;
  if (options.cancelQueuedTurn) toolOptions.cancelQueuedTurn = options.cancelQueuedTurn;
  if (options.promoteQueuedTurn) toolOptions.promoteQueuedTurn = options.promoteQueuedTurn;
  if (options.threadRuntime) toolOptions.threadRuntime = options.threadRuntime;
  // `runner: null` is the "no dispatcher behind the gateway" case, which is a
  // different thing from a runner nobody passed — the option has to be absent,
  // not undefined.
  if (options.runner !== null) {
    toolOptions.runner = options.runner ?? makeRunner({ started: [], turns: [] });
  }
  return createRegistry(createAppThreadTools(toolOptions));
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("app_list_threads", () => {
  it("lists one project's threads, newest first", async () => {
    const result = await tools().call(makeCtx(), "app_list_threads", { project: "kone" });
    const body = text(result);

    expect(result.isError).toBeUndefined();
    expect(body).toContain("2 threads in **kone**");
    expect(body.indexOf("Wire the projects module")).toBeLessThan(body.indexOf("Fix the strip"));
  });

  it("spans every project when none is named, re-sorted across them", async () => {
    const result = await tools().call(makeCtx(), "app_list_threads", {});
    // SAFETY: the list handler always writes `threads` as an array of records.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    expect(text(result)).toContain("in every project");
    // t-site (2500) sits between kone's 3000 and 2000 — proof the merge is
    // sorted rather than concatenated project by project.
    expect(threads.map((row) => row.threadId)).toEqual(["t-newest", "t-site", "t-done"]);
  });

  it("says which threads are live and whose they are, off status alone", async () => {
    const result = await tools({ live: ["t-newest"] }).call(makeCtx(), "app_list_threads", {
      project: "kone",
    });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    // No live turn yet and no assistant history: a live-backed thread with no
    // turns reads starting, which is how a reader tells live from idle — no
    // separate running flag rides the row.
    expect(threads[0]?.status).toBe("starting");
    expect(threads[0]?.agent).toBe("Maya");
    // Absent, not false: a flag only appears on a row it is true of, which is
    // most of what keeps a twenty-row answer small.
    expect(threads[0]).not.toHaveProperty("running");
    expect(threads[1]?.status).toBe("idle");
    expect(threads[1]).not.toHaveProperty("running");
    expect(text(result)).toContain("Maya");
    expect(text(result)).toContain("starting");
  });

  it("reads liveness off status: working and starting are live, idle is not", async () => {
    const result = await tools({
      live: ["t-newest"],
      spans: {
        "t-newest": { startedAt: 1, endedAt: null, runningTurns: 1, lastState: "running" },
        "t-done": { startedAt: 1, endedAt: 2, runningTurns: 0, lastState: "completed" },
      },
    }).call(makeCtx(), "app_list_threads", { project: "kone" });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    const isLive = (row: GatewayRecord): boolean =>
      row.status === "working" || row.status === "starting";
    expect(isLive(threads[0] ?? {})).toBe(true);
    expect(isLive(threads[1] ?? {})).toBe(false);
  });

  it("reads done and unread as comparisons against the last activity", async () => {
    const result = await tools().call(makeCtx(), "app_list_threads", { project: "kone" });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    // Never visited, so still unread; nobody marked it done.
    expect(threads[0]?.unread).toBe(true);
    expect(threads[0]).not.toHaveProperty("done");
    // Marked done after its last activity, and visited since.
    expect(threads[1]?.done).toBe(true);
    expect(threads[1]).not.toHaveProperty("unread");
  });

  it("reports a status on every row", async () => {
    const result = await tools({
      live: ["t-newest"],
      spans: {
        "t-newest": { startedAt: 1, endedAt: null, runningTurns: 1, lastState: "running" },
        "t-done": { startedAt: 1, endedAt: 2, runningTurns: 0, lastState: "completed" },
      },
    }).call(makeCtx(), "app_list_threads", { project: "kone" });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    expect(threads[0]?.status).toBe("working");
    expect(threads[1]?.status).toBe("idle");
    expect(text(result)).toContain("working");
  });

  it("a parked gate outranks the turn readout", async () => {
    const result = await tools({
      live: ["t-newest"],
      spans: {
        "t-newest": { startedAt: 1, endedAt: null, runningTurns: 1, lastState: "running" },
      },
      gates: { "t-newest": "approval" },
    }).call(makeCtx(), "app_list_threads", { project: "kone" });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    expect(threads[0]?.status).toBe("waiting-for-approval");
  });

  it("reads list gates off one supplier call, not one per row", async () => {
    let supplierCalls = 0;
    const result = await tools({
      pendingGates: () => {
        supplierCalls += 1;
        return new Map([["t-newest", "approval"]]);
      },
    }).call(makeCtx(), "app_list_threads", { project: "kone" });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    expect(supplierCalls).toBe(1);
    expect(threads[0]?.status).toBe("waiting-for-approval");
    expect(threads[1]?.status).toBe("idle");
  });

  it("prefers the gate snapshot supplier over the per-thread fallback for lists", async () => {
    let fallbackCalls = 0;
    const store = makeStore();
    const registry = createRegistry(
      createAppThreadTools({
        store,
        readProjects: () => PROJECTS,
        isThreadLive: () => false,
        pendingGateFor: (threadId) => {
          fallbackCalls += 1;
          return threadId === "t-newest" ? "user-input" : null;
        },
        pendingGates: () => new Map([["t-newest", "approval"]]),
      }),
    );
    const result = await registry.call(makeCtx(), "app_list_threads", { project: "kone" });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    expect(threads[0]?.status).toBe("waiting-for-approval");
    expect(fallbackCalls).toBe(0);
  });

  it("falls back to one gate read per row without the supplier", async () => {
    let fallbackCalls = 0;
    const store = makeStore();
    const registry = createRegistry(
      createAppThreadTools({
        store,
        readProjects: () => PROJECTS,
        isThreadLive: () => false,
        pendingGateFor: (threadId) => {
          fallbackCalls += 1;
          return threadId === "t-newest" ? "approval" : null;
        },
      }),
    );
    const result = await registry.call(makeCtx(), "app_list_threads", { project: "kone" });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    expect(fallbackCalls).toBe(2);
    expect(threads[0]?.status).toBe("waiting-for-approval");
    expect(threads[1]?.status).toBe("idle");
  });

  it("a running turn without a session reads interrupted, never working", async () => {
    const result = await tools({
      spans: {
        "t-newest": { startedAt: 1, endedAt: null, runningTurns: 1, lastState: "running" },
        "t-done": { startedAt: 1, endedAt: 2, runningTurns: 0, lastState: "failed" },
      },
    }).call(makeCtx(), "app_list_threads", { project: "kone" });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    expect(threads[0]?.status).toBe("interrupted");
    expect(threads[1]?.status).toBe("failed");
  });

  it("reads the whole page's spans in one batch call when the store offers it", async () => {
    const batchCalls: string[][] = [];
    const store = makeStore({
      threadTurnSpan: () => {
        throw new Error("a batch-capable store must not take the per-row span path");
      },
      threadTurnSpans: (threadIds) => {
        batchCalls.push([...threadIds]);
        const spans: Map<string, TurnSpan> = new Map([
          ["t-newest", { startedAt: 1, endedAt: null, runningTurns: 1, lastState: "running" }],
        ]);
        return spans;
      },
    });
    const result = await tools({ store, live: ["t-newest"] }).call(makeCtx(), "app_list_threads", {
      project: "kone",
    });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    // One call naming every row on the page — not one aggregate per row — and
    // the miss (t-done, no assistant history) reads as idle, not as an error.
    expect(batchCalls).toEqual([["t-newest", "t-done"]]);
    expect(threads[0]?.status).toBe("working");
    expect(threads[1]?.status).toBe("idle");
  });

  it("falls back to one span read per row without the batch method", async () => {
    const singleCalls: string[] = [];
    const store = makeStore({
      threadTurnSpan: (threadId) => {
        singleCalls.push(threadId);
        return threadId === "t-newest"
          ? { startedAt: 1, endedAt: null, runningTurns: 1, lastState: "running" }
          : null;
      },
    });
    expect(store.threadTurnSpans).toBeUndefined();
    const result = await tools({ store, live: ["t-newest"] }).call(makeCtx(), "app_list_threads", {
      project: "kone",
    });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    expect(singleCalls).toEqual(["t-newest", "t-done"]);
    expect(threads[0]?.status).toBe("working");
    expect(threads[1]?.status).toBe("idle");
  });

  it("caps the list and says how many it did not name", async () => {
    const result = await tools().call(makeCtx(), "app_list_threads", {
      project: "kone",
      limit: 1,
    });

    expect(result.structuredContent?.total).toBe(2);
    expect(result.structuredContent?.remaining).toBe(1);
    expect(text(result)).toContain("newest 1");
  });

  it("walks the whole list a page at a time", async () => {
    // Five threads, two at a time: the walk must name each one exactly once and
    // then say it is finished.
    const many = Array.from({ length: 5 }, (_, i) =>
      thread({ threadId: `t${i}`, title: `Thread ${i}`, lastActivityAt: 5_000 - i * 10, updatedAt: 5_000 - i * 10 }),
    );
    const registry = tools({ store: makeStore({ listThreads: () => many }) });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const args: GatewayRecord = { project: "kone", limit: 2 };
      if (cursor) args.cursor = cursor;
      const result = await registry.call(makeCtx(), "app_list_threads", args);
      // SAFETY: the list handler always writes `threads` as an array of records.
      const rows = result.structuredContent?.threads as GatewayRecord[];
      for (const row of rows) seen.push(String(row.threadId));
      const next = result.structuredContent?.nextCursor;
      if (next === undefined) break;
      cursor = String(next);
    }

    expect(seen).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(new Set(seen).size).toBe(5);
  });

  it("does not repeat a row when the list reorders between pages", async () => {
    // The reason this pages by keyset and not by offset. A thread waking up
    // jumps to the top of a list ordered by last activity; asking for "rows 2
    // and 3" after that shift would hand back a row page one already named.
    const rows = Array.from({ length: 4 }, (_, i) =>
      thread({ threadId: `t${i}`, title: `Thread ${i}`, lastActivityAt: 4_000 - i * 10, updatedAt: 4_000 - i * 10 }),
    );
    let live = [...rows];
    const registry = tools({ store: makeStore({ listThreads: () => live }) });

    const first = await registry.call(makeCtx(), "app_list_threads", {
      project: "kone",
      limit: 2,
    });
    // SAFETY: as above.
    const firstRows = first.structuredContent?.threads as GatewayRecord[];
    expect(firstRows.map((row) => row.threadId)).toEqual(["t0", "t1"]);

    // t3 speaks, and jumps to the front of the order.
    live = [
      thread({ threadId: "t3", title: "Thread 3", lastActivityAt: 9_000, updatedAt: 9_000 }),
      ...rows.slice(0, 3),
    ];

    const second = await registry.call(makeCtx(), "app_list_threads", {
      project: "kone",
      limit: 2,
      cursor: String(first.structuredContent?.nextCursor),
    });
    // SAFETY: as above.
    const secondRows = second.structuredContent?.threads as GatewayRecord[];
    // t2 alone: t3 has moved above the boundary and is deliberately not shown
    // again, and neither t0 nor t1 comes back.
    expect(secondRows.map((row) => row.threadId)).toEqual(["t2"]);
  });

  it("advances through threads that share a timestamp", async () => {
    // A keyset on the stamp alone would stall here: every row compares equal,
    // so "older than this" would return the same page forever.
    const tied = ["a", "b", "c"].map((id) =>
      thread({ threadId: id, title: `Thread ${id}`, lastActivityAt: 7_000, updatedAt: 7_000 }),
    );
    const registry = tools({ store: makeStore({ listThreads: () => tied }) });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const args: GatewayRecord = { project: "kone", limit: 1 };
      if (cursor) args.cursor = cursor;
      const result = await registry.call(makeCtx(), "app_list_threads", args);
      // SAFETY: as above.
      const rows = result.structuredContent?.threads as GatewayRecord[];
      for (const row of rows) seen.push(String(row.threadId));
      const next = result.structuredContent?.nextCursor;
      if (next === undefined) break;
      cursor = String(next);
    }

    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("says the walk is over rather than reading as an empty project", async () => {
    const registry = tools();
    const first = await registry.call(makeCtx(), "app_list_threads", {
      project: "kone",
      limit: 2,
    });
    expect(first.structuredContent).not.toHaveProperty("nextCursor");

    const past = await registry.call(makeCtx(), "app_list_threads", {
      project: "kone",
      cursor: encodeCursor("threads", { at: 0, id: "" }),
    });
    expect(past.isError).toBeUndefined();
    expect(text(past)).toContain("end of the list");
  });

  it("refuses a cursor that came from somewhere else", async () => {
    const result = await tools().call(makeCtx(), "app_list_threads", {
      project: "kone",
      cursor: encodeCursor("projects", { skip: 2 }),
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("did not come from app_list_threads");
  });

  it("looks in the archive as a separate place", async () => {
    const result = await tools().call(makeCtx(), "app_list_threads", {
      project: "kone",
      archived: true,
    });

    expect(text(result)).toContain("1 archived thread in **kone**");
    expect(text(result)).toContain("Old");
  });

  it("refuses a project the app does not hold", async () => {
    const result = await tools().call(makeCtx(), "app_list_threads", { project: "nope" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_found");
  });
});

describe("app_read_thread", () => {
  it("returns the messages as prose, oldest first", async () => {
    const result = await tools().call(makeCtx(), "app_read_thread", { threadId: "t-newest" });
    const body = text(result);

    expect(body).toContain("3 messages from");
    expect(body.indexOf("Add the projects module")).toBeLessThan(body.indexOf("Now the threads one"));
    expect(result.structuredContent?.totalMessages).toBe(3);
  });

  it("reads only the tail when a limit is given", async () => {
    const result = await tools().call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      limit: 1,
    });
    // SAFETY: the read handler always writes `messages` as an array of records.
    const messages = result.structuredContent?.messages as GatewayRecord[];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("Now the threads one");
    // The count is of the whole thread, not the slice — a reader has to know
    // there is more above what it was handed.
    expect(result.structuredContent?.totalMessages).toBe(3);
  });

  it("truncates a long message rather than returning the whole thing", async () => {
    const long = "x".repeat(500);
    const store = makeStore({
      loadThread: () => ({ ...TRANSCRIPT, blocks: [block("user", long, 1)] }),
    });
    const result = await tools({ store }).call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      maxTextChars: 100,
    });

    expect(text(result)).toContain("[truncated]");
    expect(text(result)).not.toContain(long);
  });

  it("lets the assistant read a thread it did not open", async () => {
    // The point of the tool: the assistant (on its sentinel project, not in the
    // thread's spawn tree) is exempt from the project read scope and may read
    // across projects on the user's behalf.
    const result = await tools().call(makeCtx(), "app_read_thread", { threadId: "t-newest" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.thread).toMatchObject({ threadId: "t-newest" });
  });

  it("refuses an unrelated project thread for a project caller", async () => {
    const result = await tools().call(
      makeCtx({ threadId: "t-done" }),
      "app_read_thread",
      { threadId: "t-site" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("outside what this conversation may read");
  });

  it("lets a fork read its source across projects (handoff read-back)", async () => {
    const base = makeStore();
    const forkMeta = thread({
      threadId: "t-fork",
      title: "Fork",
      projectPath: SITE,
      sourceThreadId: "t-newest",
    });
    const store: AppThreadsStore = {
      ...base,
      threadMeta: (threadId) =>
        threadId === "t-fork" ? forkMeta : (base.threadMeta?.(threadId) ?? null),
    };
    const result = await tools({ store }).call(makeCtx({ threadId: "t-fork" }), "app_read_thread", {
      threadId: "t-newest",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.thread).toMatchObject({ threadId: "t-newest" });
  });

  it("reports the thread's status alongside its messages", async () => {
    const idle = await tools().call(makeCtx(), "app_read_thread", { threadId: "t-newest" });
    expect(idle.structuredContent?.thread).toMatchObject({ threadId: "t-newest", status: "idle" });

    const working = await tools({
      live: ["t-newest"],
      spans: {
        "t-newest": { startedAt: 1, endedAt: null, runningTurns: 1, lastState: "running" },
      },
    }).call(makeCtx(), "app_read_thread", { threadId: "t-newest" });
    expect(working.structuredContent?.thread).toMatchObject({ status: "working" });
  });

  it("refuses a thread the store does not hold", async () => {
    const result = await tools().call(makeCtx(), "app_read_thread", { threadId: "ghost" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_found");
  });

  it("reads one message by id, whole, with its block and item ids", async () => {
    const result = await tools().call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      blockId: "a-2",
      maxTextChars: 100,
    });
    // SAFETY: the read handler always writes `messages` as an array of records.
    const messages = result.structuredContent?.messages as GatewayRecord[];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.blockId).toBe("a-2");
    expect(messages[0]?.text).toBe("Done — two tools and a mirror.");
    expect(Array.isArray(messages[0]?.itemIds)).toBe(true);
  });

  it("refuses an unknown block id", async () => {
    const result = await tools().call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      blockId: "nope",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_found");
  });

  it("slices an oversized message from textOffset and reports where to resume", async () => {
    const long = "x".repeat(250);
    const store = makeStore({
      loadThread: () => ({ ...TRANSCRIPT, blocks: [block("user", long, 1)] }),
    });
    const read = async (textOffset?: number) => {
      const params: GatewayRecord = { threadId: "t-newest", blockId: "u-1", maxTextChars: 100 };
      if (textOffset !== undefined) params.textOffset = textOffset;
      const result = await tools({ store }).call(makeCtx(), "app_read_thread", params);
      // SAFETY: the read handler always writes `messages` as an array of records.
      const messages = (result.structuredContent?.messages ?? []) as GatewayRecord[];
      return messages[0]!;
    };

    const first = await read();
    expect(first.text).toBe("x".repeat(100));
    expect(first.nextTextOffset).toBe(100);
    const second = await read(100);
    expect(second.text).toBe("x".repeat(100));
    expect(second.nextTextOffset).toBe(200);
    const third = await read(200);
    expect(third.text).toBe("x".repeat(50));
    // Terminal slice: the offset is present and null, not absent.
    expect(third.nextTextOffset).toBeNull();
  });

  it("a blockId read returns the rich content of a tool-only block", async () => {
    const toolOnly: StoredBlock = {
      id: "a-tool",
      role: "assistant",
      turnId: "t",
      state: "completed",
      at: 2,
      items: [
        { itemId: "i1", kind: "tool_call", status: "completed", name: "Bash", text: "bun test", detail: '{"exitCode":0}' },
      ],
    };
    const store = makeStore({
      loadThread: () => ({ ...TRANSCRIPT, blocks: [toolOnly] }),
    });
    const result = await tools({ store }).call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      blockId: "a-tool",
    });
    // SAFETY: the read handler always writes `messages` as an array of records.
    const messages = (result.structuredContent?.messages ?? []) as GatewayRecord[];
    expect(String(messages[0]?.text)).toContain("[Tool] Bash: bun test");
    expect(String(messages[0]?.text)).toContain("exit code 0");
  });

  it("a blockId read of a failed block carries its error", async () => {
    const failed: StoredBlock = {
      id: "a-fail",
      role: "assistant",
      turnId: "t",
      state: "failed",
      error: "boom",
      at: 2,
      items: [
        {
          itemId: "i1",
          kind: "tool_call",
          status: "failed",
          name: "Bash",
          text: "bun test",
          detail: "TypeError: broken\nexit code: 1",
        },
      ],
    };
    const store = makeStore({
      loadThread: () => ({ ...TRANSCRIPT, blocks: [failed] }),
    });
    const result = await tools({ store }).call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      blockId: "a-fail",
    });
    // SAFETY: the read handler always writes `messages` as an array of records.
    const messages = (result.structuredContent?.messages ?? []) as GatewayRecord[];
    expect(String(messages[0]?.text)).toContain("TypeError: broken");
    expect(String(messages[0]?.text)).toContain("[Turn failed: boom]");
  });

  it("continues a default prose read in the same representation", async () => {
    const long = "answer ".repeat(400);
    const mixed: StoredBlock = {
      id: "a-mix",
      role: "assistant",
      turnId: "t",
      state: "completed",
      at: 2,
      items: [
        { itemId: "i1", kind: "tool_call", status: "completed", name: "Read", text: "src/auth.ts" },
        { itemId: "i2", kind: "assistant_text", status: "completed", text: long },
      ],
    };
    const store = makeStore({ loadThread: () => ({ ...TRANSCRIPT, blocks: [mixed] }) });
    const first = await tools({ store }).call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      maxTextChars: 100,
    });
    // SAFETY: the read handler always writes `messages` as an array of records.
    const m1 = ((first.structuredContent?.messages ?? []) as GatewayRecord[])[0]!;
    expect(m1.representation).toBe("prose");
    expect(m1.nextTextOffset).toBe(100);
    // Continue in prose: the two slices reconstruct the prose exactly, with
    // no tool prefix inserted at the offset.
    const cont = await tools({ store }).call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      blockId: "a-mix",
      textOffset: 100,
      maxTextChars: 100,
      representation: "prose",
    });
    // SAFETY: the read handler always writes `messages` as an array of records.
    const m2 = ((cont.structuredContent?.messages ?? []) as GatewayRecord[])[0]!;
    expect(`${String(m1.text)}${String(m2.text)}`).toBe(long.slice(0, 200));
  });

  it("continues a rich read in the same representation", async () => {
    const long = "answer ".repeat(400);
    const rich = `[Tool] Read: src/auth.ts\n${long}`;
    const mixed: StoredBlock = {
      id: "a-mix",
      role: "assistant",
      turnId: "t",
      state: "completed",
      at: 2,
      items: [
        { itemId: "i1", kind: "tool_call", status: "completed", name: "Read", text: "src/auth.ts" },
        { itemId: "i2", kind: "assistant_text", status: "completed", text: long },
      ],
    };
    const store = makeStore({ loadThread: () => ({ ...TRANSCRIPT, blocks: [mixed] }) });
    const first = await tools({ store }).call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      blockId: "a-mix",
      maxTextChars: 100,
    });
    // SAFETY: the read handler always writes `messages` as an array of records.
    const m1 = ((first.structuredContent?.messages ?? []) as GatewayRecord[])[0]!;
    expect(m1.representation).toBe("rich");
    expect(m1.nextTextOffset).toBe(100);
    const cont = await tools({ store }).call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      blockId: "a-mix",
      textOffset: 100,
      maxTextChars: 100,
      representation: "rich",
    });
    // SAFETY: the read handler always writes `messages` as an array of records.
    const m2 = ((cont.structuredContent?.messages ?? []) as GatewayRecord[])[0]!;
    expect(`${String(m1.text)}${String(m2.text)}`).toBe(rich.slice(0, 200));
  });

  it("pages older messages through a cursor", async () => {
    const store = makeStore({
      loadThreadPage: (threadId) => ({
        threadId,
        meta: thread({ threadId }),
        blocks: [block("user", "older one", 0)],
        nextCursor: null,
        hasMore: false,
      }),
    });
    const result = await tools({ store }).call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      cursor: "from-a-previous-reply",
    });
    // SAFETY: the read handler always writes `messages` as an array of records.
    const messages = result.structuredContent?.messages as GatewayRecord[];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("older one");
    expect(result.structuredContent?.hasMore).toBe(false);
  });

  it("reports hasMore and a nextCursor when older messages exist", async () => {
    const result = await tools().call(makeCtx(), "app_read_thread", {
      threadId: "t-newest",
      limit: 1,
    });

    expect(result.structuredContent?.hasMore).toBe(true);
    expect(result.structuredContent?.nextCursor).toEqual(expect.any(String));
  });
});

describe("app_start_thread", () => {
  const START = { project: "kone", prompt: "Rewrite the launcher grid", requestId: "r1" };

  it("opens the thread on the project and sends its first turn", async () => {
    const calls: RunnerCalls = { started: [], turns: [] };
    const result = await tools({ runner: makeRunner(calls) }).call(
      makeCtx(),
      "app_start_thread",
      { ...START, title: "Launcher grid" },
    );

    expect(result.isError).toBeUndefined();
    expect(calls.started[0]).toMatchObject({ threadId: "thread-new", cwd: KONE });
    expect(calls.turns[0]?.input).toMatchObject({
      threadId: "thread-new",
      input: "Rewrite the launcher grid",
    });
    expect(calls.turns[0]?.options).toEqual({ title: "Launcher grid" });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      threadId: "thread-new",
      turnId: "turn-new",
      projectPath: KONE,
    });
  });

  it("runs where this conversation runs when no target is named", async () => {
    const calls: RunnerCalls = { started: [], turns: [] };
    await tools({ runner: makeRunner(calls) }).call(makeCtx(), "app_start_thread", START);

    expect(calls.started[0]).toMatchObject({ provider: "claudeAgent", model: "sonnet" });
  });

  it("hands the thread to a team agent, on that agent's own model", async () => {
    const calls: RunnerCalls = { started: [], turns: [] };
    const store = makeStore();
    const result = await tools({ runner: makeRunner(calls), store }).call(
      makeCtx(),
      "app_start_thread",
      { ...START, agent: "maya" },
    );

    expect(calls.started[0]).toMatchObject({ provider: "codex", model: "gpt-5" });
    expect(calls.started[0]?.agent).toMatchObject({
      name: "Maya",
      instructions: "Review before you write.",
    });
    // Bound before the first turn goes out, so the transcript names who answered
    // from its very first block.
    expect(store.calls.bound).toEqual([{ threadId: "thread-new", agentId: "agent-maya" }]);
    expect(result.structuredContent?.agent).toBe("Maya");
  });

  it("names the team when asked for an agent who is not on it", async () => {
    const result = await tools().call(makeCtx(), "app_start_thread", {
      ...START,
      agent: "Ivy",
    });

    expect(result.isError).toBe(true);
    const body = text(result);
    expect(body).toContain("not_found");
    expect(body).toContain("Maya");
    expect(body).toContain("Rex");
  });

  it("says there is nobody to hand it to when the project has no team", async () => {
    const result = await tools().call(makeCtx(), "app_start_thread", {
      ...START,
      project: "site",
      agent: "Maya",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("No agents are on this project's team yet");
  });

  it("replays the same start instead of opening a second thread", async () => {
    const calls: RunnerCalls = { started: [], turns: [] };
    const registry = tools({ runner: makeRunner(calls), store: makeStore() });
    const first = await registry.call(makeCtx(), "app_start_thread", START);
    const second = await registry.call(makeCtx(), "app_start_thread", START);

    expect(calls.started).toHaveLength(1);
    expect(second.isError).toBeUndefined();
    expect(text(second)).toContain("already open");
    // The retry names the thread in its text: that is the only half a model
    // is handed, and a replay that leaves it out leaves the model holding none.
    expect(text(second)).toContain("Thread id: thread-new.");
    expect(second.structuredContent?.threadId).toBe(first.structuredContent?.threadId);
  });

  it("refuses a different start that reuses a spent requestId", async () => {
    const registry = tools();
    await registry.call(makeCtx(), "app_start_thread", START);
    const second = await registry.call(makeCtx(), "app_start_thread", {
      ...START,
      prompt: "Something else entirely",
    });

    expect(second.isError).toBe(true);
    expect(text(second)).toContain("idempotency_conflict");
  });

  it("refuses without a live turn, so a settled turn cannot open threads", async () => {
    const calls: RunnerCalls = { started: [], turns: [] };
    const result = await tools({ runner: makeRunner(calls) }).call(
      makeCtx({ turnId: null }),
      "app_start_thread",
      START,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("capability_denied");
    expect(calls.started).toHaveLength(0);
  });

  it("refuses rather than reporting a thread nothing is running", async () => {
    const result = await tools({ runner: null }).call(makeCtx(), "app_start_thread", START);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("provider_unavailable");
  });

  it("refuses a project the app does not hold, before anything is started", async () => {
    const calls: RunnerCalls = { started: [], turns: [] };
    const result = await tools({ runner: makeRunner(calls) }).call(
      makeCtx(),
      "app_start_thread",
      { ...START, project: "nope" },
    );

    expect(result.isError).toBe(true);
    expect(calls.started).toHaveLength(0);
  });
});

describe("the thread tools as the gateway serves them", () => {
  it("reads turn-lessly and gates only the start and the send on a live turn", () => {
    const entries = createAppThreadTools({ store: makeStore() });
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    expect(byName.get("app_list_threads")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_read_thread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_start_thread")?.requiresActiveTurn).toBe(true);
    expect(byName.get("app_send_to_thread")?.requiresActiveTurn).toBe(true);
    expect(byName.get("app_stop_thread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_archive_thread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_delete_thread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_rename_thread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_set_thread_pinned")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_set_thread_done")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_mark_thread_unread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_search_threads")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_list_queued_turns")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_edit_queued_turn")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_reorder_queued_turns")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_cancel_queued_turn")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_promote_queued_turn")?.requiresActiveTurn).toBe(false);

    expect(entries).toHaveLength(19);
    for (const entry of entries) {
      expect(entry.promptSnippet).toBeTruthy();
      expect(entry.promptSnippet).not.toContain("\n");
    }
  });
});

describe("app_stop_thread", () => {
  it("stops a live thread via stopThread hook", async () => {
    let stoppedId = "";
    const result = await tools({
      live: ["t-newest"],
      stopThread: async (id) => {
        stoppedId = id;
        return { stopped: true, wasRunning: true };
      },
    }).call(makeCtx(), "app_stop_thread", { threadId: "t-newest" });

    expect(result.isError).toBeUndefined();
    expect(stoppedId).toBe("t-newest");
    expect(text(result)).toContain("Stopped active session and turn for thread \"t-newest\"");
    expect(result.structuredContent).toMatchObject({
      threadId: "t-newest",
      stopped: true,
      wasRunning: true,
    });
  });

  it("reports an idle thread when no session is running", async () => {
    const result = await tools({
      live: [],
    }).call(makeCtx(), "app_stop_thread", { threadId: "t-newest" });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Thread \"t-newest\" was already idle");
    // stopped stays true on idle: it confirms quiescence, not a teardown.
    expect(result.structuredContent).toMatchObject({
      threadId: "t-newest",
      stopped: true,
      wasRunning: false,
    });
  });

  it("refuses when thread does not exist", async () => {
    const result = await tools().call(makeCtx(), "app_stop_thread", { threadId: "nonexistent" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_found");
  });
});

describe("app_archive_thread", () => {
  it("archives a thread by default", async () => {
    const store = makeStore();
    const result = await tools({ store }).call(makeCtx(), "app_archive_thread", {
      threadId: "t-newest",
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Archived thread \"t-newest\"");
    expect(result.structuredContent).toMatchObject({
      threadId: "t-newest",
      archived: true,
      affectedThreadIds: ["t-newest"],
    });
    expect(store.calls.archived).toContainEqual({ threadId: "t-newest", archived: true });
  });

  it("unarchives a thread with archived: false", async () => {
    const store = makeStore();
    const result = await tools({ store }).call(makeCtx(), "app_archive_thread", {
      threadId: "t-newest",
      archived: false,
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Unarchived thread \"t-newest\"");
    expect(result.structuredContent).toMatchObject({
      threadId: "t-newest",
      archived: false,
      affectedThreadIds: ["t-newest"],
    });
    expect(store.calls.archived).toContainEqual({ threadId: "t-newest", archived: false });
  });

  it("refuses archiving when thread is busy mid-turn", async () => {
    const store = makeStore({
      setArchived: () => ({ ok: false, reason: "busy" }),
    });
    const result = await tools({ store }).call(makeCtx(), "app_archive_thread", {
      threadId: "t-newest",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("capability_denied");
  });

  it("refuses when thread does not exist", async () => {
    const result = await tools().call(makeCtx(), "app_archive_thread", {
      threadId: "nonexistent",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_found");
  });
});

describe("what a parked thread is waiting on", () => {
  const APPROVAL: PendingInteraction = {
    threadId: "t-newest",
    requestId: "req-a",
    event: {
      type: "approval.requested",
      threadId: "t-newest",
      provider: "claudeAgent",
      at: 1,
      source: "claude.sdk.message",
      requestId: "req-a",
      approval: { kind: "command", title: "rm -rf dist", detail: "clean the build" },
    },
  };
  const QUESTION: PendingInteraction = {
    threadId: "t-newest",
    requestId: "req-q",
    event: {
      type: "user-input.requested",
      threadId: "t-newest",
      provider: "claudeAgent",
      at: 1,
      source: "claude.sdk.message",
      requestId: "req-q",
      questions: [
        { id: "Which DB?", header: "DB", question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
      ],
    },
  };

  it("reads a parked approval in full", async () => {
    const result = await tools({ gates: { "t-newest": "approval" }, asks: [APPROVAL], live: ["t-newest"] }).call(
      makeCtx(),
      "app_read_thread",
      { threadId: "t-newest" },
    );
    expect(text(result)).toContain('Waiting on the user to approve command "rm -rf dist" (clean the build).');
  });

  it("reads a parked question with its choices", async () => {
    const result = await tools({ gates: { "t-newest": "user-input" }, asks: [QUESTION], live: ["t-newest"] }).call(
      makeCtx(),
      "app_read_thread",
      { threadId: "t-newest" },
    );
    expect(text(result)).toContain('Waiting on the user to answer "Which DB?" [Postgres | SQLite].');
  });

  it("names the ask on the parked row of a list, and nowhere else", async () => {
    const body = text(
      await tools({ gates: { "t-newest": "approval" }, asks: [APPROVAL], live: ["t-newest"] }).call(
        makeCtx(),
        "app_list_threads",
        { project: "kone" },
      ),
    );
    expect(body).toMatch(/- Wire the projects module — .*waiting-for-approval.* · approve command "rm -rf dist"/);
    expect(body).toMatch(/- Fix the strip — [^\n]*done$/m);
  });
});

describe("app_send_to_thread", () => {
  const SEND = { threadId: "t-newest", message: "Also run the tests", requestId: "s1" };
  const BUSY = { startedAt: 1, endedAt: null, runningTurns: 1, lastState: "running" } as const;

  interface SendCalls extends RunnerCalls {
    steered: SendTurnInput[];
    resumed: Array<{ threadId: string; resume: boolean }>;
  }
  function sendRunner(calls: SendCalls, withResume = true): AppThreadsRunner {
    const runner: AppThreadsRunner = {
      ...makeRunner(calls),
      steerThreadTurn: async (input) => {
        calls.steered.push(input);
        return { threadId: input.threadId, turnId: "turn-steer" };
      },
    };
    if (withResume) {
      runner.ensureThreadSession = async (threadId, options) => {
        calls.resumed.push({ threadId, resume: options.resume });
      };
    }
    return runner;
  }
  const newCalls = (): SendCalls => ({ started: [], turns: [], steered: [], resumed: [] });

  it("resumes a thread with no running session before leaving the job", async () => {
    const calls = newCalls();
    const mailbox = new IrcMailbox();
    const result = await tools({ runner: sendRunner(calls), jobs: mailbox }).call(makeCtx(), "app_send_to_thread", SEND);

    expect(calls.resumed).toEqual([{ threadId: "t-newest", resume: true }]);
    expect(calls.turns).toHaveLength(0);
    expect(mailbox.jobCount("t-newest")).toBe(1);
    expect(result.structuredContent).toMatchObject({ resumed: true });
  });

  it("refuses a sessionless thread when the host cannot resume one", async () => {
    const calls = newCalls();
    const result = await tools({ runner: sendRunner(calls, false) }).call(makeCtx(), "app_send_to_thread", SEND);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("cannot bring one back");
    expect(calls.turns).toHaveLength(0);
  });

  it("refuses an archived thread and this conversation itself", async () => {
    const calls = newCalls();
    const archivedStore = makeStore({
      threadMeta: (threadId) =>
        threadId === "t-newest" ? { ...KONE_THREADS[0]!, archivedAt: 9 } : null,
    });
    const archived = await tools({ runner: sendRunner(calls), store: archivedStore }).call(
      makeCtx(),
      "app_send_to_thread",
      SEND,
    );
    expect(archived.isError).toBe(true);
    expect(text(archived)).toContain("is archived");

    const self = await tools({ runner: sendRunner(calls) }).call(
      makeCtx({ threadId: "t-newest" }),
      "app_send_to_thread",
      SEND,
    );
    expect(self.isError).toBe(true);
    expect(text(self)).toContain("That is this conversation");
    expect(calls.turns).toHaveLength(0);
  });

  it("sends a retried message once, and refuses a different one under the same key", async () => {
    const mailbox = new IrcMailbox();
    const registry = tools({ runner: sendRunner(newCalls()), store: makeStore(), live: ["t-newest"], jobs: mailbox });
    await registry.call(makeCtx(), "app_send_to_thread", SEND);
    const retry = await registry.call(makeCtx(), "app_send_to_thread", SEND);
    expect(mailbox.jobCount("t-newest")).toBe(1);
    expect(text(retry)).toContain("Already sent");
    expect(text(retry)).toContain("(t-newest)");

    const clash = await registry.call(makeCtx(), "app_send_to_thread", { ...SEND, message: "Something else" });
    expect(clash.isError).toBe(true);
    expect(text(clash)).toContain("idempotency_conflict");
  });

  it("refuses an unknown thread", async () => {
    const result = await tools({ runner: sendRunner(newCalls()) }).call(makeCtx(), "app_send_to_thread", {
      ...SEND,
      threadId: "ghost",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_found");
  });
  it("takes steer as the old name for urgent", async () => {
    const mailbox = new IrcMailbox();
    const result = await tools({ runner: sendRunner(newCalls()), live: ["t-newest"], jobs: mailbox }).call(
      makeCtx(),
      "app_send_to_thread",
      { ...SEND, steer: true },
    );
    expect(result.structuredContent).toMatchObject({ urgent: true });
    expect(mailbox.urgentCount("t-newest")).toBe(1);
  });

  describe("as a job in the thread's inbox", () => {
    function runtime(over: Partial<ThreadRuntime> = {}): ThreadRuntime {
      return {
        live: true,
        starting: false,
        busy: false,
        turnStartedAt: null,
        parked: null,
        parkedSince: null,
        compacting: false,
        steers: true,
        activeTool: null,
        lastActivityAt: null,
        ...over,
      };
    }
    const ringer = (mailbox: IrcMailbox, rt: ThreadRuntime, over: Parameters<typeof tools>[0] = {}) =>
      tools({ live: ["t-newest"], jobs: mailbox, threadRuntime: () => rt, ...over });

    it("leaves a job in the thread's inbox instead of sending a turn", async () => {
      const calls = newCalls();
      const mailbox = new IrcMailbox();
      const result = await ringer(mailbox, runtime(), { runner: sendRunner(calls) }).call(
        makeCtx(),
        "app_send_to_thread",
        SEND,
      );

      expect(calls.turns).toHaveLength(0);
      expect(mailbox.jobCount("t-newest")).toBe(1);
      expect(result.structuredContent).toMatchObject({ delivery: "waking", urgent: false });
      expect(String(result.structuredContent?.messageId).startsWith("msg_")).toBe(true);
    });

    it("holds a job for a thread parked on the user, and says so", async () => {
      const mailbox = new IrcMailbox();
      const result = await ringer(mailbox, runtime({ busy: true, parked: "approval", parkedSince: 1 }), {
        runner: sendRunner(newCalls()),
        gates: { "t-newest": "approval" },
      }).call(makeCtx(), "app_send_to_thread", SEND);

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ delivery: "held" });
      expect(mailbox.jobCount("t-newest")).toBe(1);
    });

    it("a busy thread takes it next; urgent goes into the running turn", async () => {
      const busy = runtime({ busy: true });
      const plain = await ringer(new IrcMailbox(), busy, { spans: { "t-newest": BUSY } }).call(
        makeCtx(),
        "app_send_to_thread",
        SEND,
      );
      expect(plain.structuredContent).toMatchObject({ delivery: "next" });

      const mailbox = new IrcMailbox();
      const urgent = await ringer(mailbox, busy, { spans: { "t-newest": BUSY } }).call(
        makeCtx(),
        "app_send_to_thread",
        { ...SEND, steer: true },
      );
      expect(urgent.structuredContent).toMatchObject({ delivery: "delivered", urgent: true });
      expect(mailbox.urgentCount("t-newest")).toBe(1);
    });

    it("a retried send leaves one job", async () => {
      const mailbox = new IrcMailbox();
      const registry = ringer(mailbox, runtime(), { store: makeStore() });
      await registry.call(makeCtx(), "app_send_to_thread", SEND);
      const retry = await registry.call(makeCtx(), "app_send_to_thread", SEND);
      expect(text(retry)).toContain("Already sent");
      expect(mailbox.jobCount("t-newest")).toBe(1);
    });
  });
});

describe("app_delete_thread", () => {
  it("refuses without confirm: true, and deletes nothing", async () => {
    const store = makeStore();
    const result = await tools({ store }).call(makeCtx(), "app_delete_thread", { threadId: "t-newest" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("invalid_input");
    expect(store.calls.deleted).not.toContain("t-newest");
  });

  it("deletes a thread when safe", async () => {
    const store = makeStore();
    const result = await tools({ store }).call(makeCtx(), "app_delete_thread", {
      threadId: "t-newest",
      confirm: true,
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Permanently deleted thread \"t-newest\"");
    expect(result.structuredContent).toMatchObject({
      threadId: "t-newest",
      deleted: true,
    });
    expect(store.calls.deleted).toContain("t-newest");
    // The fallback cancels the queue through the same store method the
    // canonical path uses, before the row drop removes the queue rows.
    expect(store.calls.cancelledQueues).toContain("t-newest");
  });

  it("still drops the rows when the store cannot cancel the queue", async () => {
    const store = makeStore();
    store.cancelQueuedTurnsForThread = undefined;
    const result = await tools({ store }).call(makeCtx(), "app_delete_thread", {
      threadId: "t-newest",
      confirm: true,
    });

    expect(result.isError).toBeUndefined();
    expect(store.calls.deleted).toContain("t-newest");
  });

  it("refuses deleting when thread is busy mid-turn", async () => {
    const store = makeStore({
      canDeleteThread: () => ({ ok: false, reason: "busy" }),
    });
    const result = await tools({ store }).call(makeCtx(), "app_delete_thread", {
      threadId: "t-newest",
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("capability_denied");
  });

  it("refuses deleting when thread does not exist", async () => {
    const result = await tools().call(makeCtx(), "app_delete_thread", {
      threadId: "nonexistent",
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_found");
  });
});

describe("app_rename_thread", () => {
  it("renames a thread and updates the store", async () => {
    const store = makeStore();
    const emitted: unknown[] = [];
    const result = await tools({
      store,
      emit: (e) => emitted.push(e),
    }).call(makeCtx(), "app_rename_thread", {
      threadId: "t-newest",
      title: "New Architectural Plan",
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Renamed thread \"t-newest\" from \"Wire the projects module\" to \"New Architectural Plan\"");
    expect(result.structuredContent).toMatchObject({
      threadId: "t-newest",
      title: "New Architectural Plan",
      previousTitle: "Wire the projects module",
    });
    expect(store.calls.renames).toContainEqual({
      threadId: "t-newest",
      title: "New Architectural Plan",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "thread.title.updated",
      threadId: "t-newest",
      title: "New Architectural Plan",
    });
  });

  it("writes through setTitle when renameThread is absent", async () => {
    const store = makeStore();
    store.renameThread = undefined;
    const emitted: unknown[] = [];
    const result = await tools({
      store,
      emit: (e) => emitted.push(e),
    }).call(makeCtx(), "app_rename_thread", {
      threadId: "t-newest",
      title: "Legacy Store Title",
    });

    expect(result.isError).toBeUndefined();
    expect(store.calls.titles).toContainEqual({
      threadId: "t-newest",
      title: "Legacy Store Title",
    });
    expect(store.calls.renames ?? []).toHaveLength(0);
    expect(emitted).toHaveLength(1);
  });

  it("stays silent when the title did not change", async () => {
    const store = makeStore({ renameThread: () => false });
    const emitted: unknown[] = [];
    const result = await tools({
      store,
      emit: (e) => emitted.push(e),
    }).call(makeCtx(), "app_rename_thread", {
      threadId: "t-newest",
      title: "Wire the projects module",
    });

    expect(result.isError).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  it("truncates excessively long titles", async () => {
    const store = makeStore();
    const veryLongTitle = "a".repeat(150);
    const result = await tools({ store }).call(makeCtx(), "app_rename_thread", {
      threadId: "t-newest",
      title: veryLongTitle,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      threadId: "t-newest",
    });
    // SAFETY: checking title string property
    const finalTitle = (result.structuredContent as { title: string }).title;
    expect(finalTitle.length).toBeLessThan(veryLongTitle.length);
    expect(finalTitle.endsWith("...")).toBe(true);
  });

  it("refuses empty or whitespace-only title", async () => {
    const result = await tools().call(makeCtx(), "app_rename_thread", {
      threadId: "t-newest",
      title: "   ",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("invalid_input");
  });

  it("refuses when thread does not exist", async () => {
    const result = await tools().call(makeCtx(), "app_rename_thread", {
      threadId: "nonexistent",
      title: "Valid Title",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_found");
  });
});

describe("app_set_thread_pinned", () => {
  it("pins and unpins through the store", async () => {
    const pinned: Array<[string, boolean]> = [];
    const store = makeStore({ setPinned: (threadId, value) => pinned.push([threadId, value]) });
    const result = await tools({ store }).call(makeCtx(), "app_set_thread_pinned", {
      threadId: "t-newest",
      pinned: true,
    });
    expect(result.isError).toBeUndefined();
    expect(pinned).toEqual([["t-newest", true]]);
    expect(result.structuredContent).toMatchObject({ threadId: "t-newest", pinned: true });
  });
});

describe("app_set_thread_done", () => {
  it("routes done through the canonical service callback when present", async () => {
    const done: Array<[string, boolean]> = [];
    const store = makeStore({ setDone: () => { throw new Error("store fallback should not run"); } });
    const result = await tools({ store, setThreadDone: (id, value) => done.push([id, value]) }).call(
      makeCtx(),
      "app_set_thread_done",
      { threadId: "t-newest", done: true },
    );
    expect(result.isError).toBeUndefined();
    expect(done).toEqual([["t-newest", true]]);
    expect(result.structuredContent).toMatchObject({ threadId: "t-newest", done: true });
  });

  it("falls back to the store when no service callback is wired", async () => {
    const done: Array<[string, boolean]> = [];
    const store = makeStore({ setDone: (id, value) => done.push([id, value]) });
    await tools({ store }).call(makeCtx(), "app_set_thread_done", {
      threadId: "t-newest",
      done: false,
    });
    expect(done).toEqual([["t-newest", false]]);
  });
});

describe("app_mark_thread_unread", () => {
  it("moves the visit below the latest activity, forcing it back", async () => {
    const visited: Array<[string, number, boolean | undefined]> = [];
    const store = makeStore({
      setVisited: (threadId, at, force) => visited.push([threadId, at, force]),
    });
    const result = await tools({ store }).call(makeCtx(), "app_mark_thread_unread", {
      threadId: "t-newest",
    });
    expect(result.isError).toBeUndefined();
    expect(visited).toHaveLength(1);
    const [, at, force] = visited[0]!;
    const meta = store.threadMeta("t-newest");
    expect(force).toBe(true);
    expect(at).toBeLessThan(meta?.lastActivityAt ?? 0);
    expect(result.structuredContent).toMatchObject({ threadId: "t-newest", unread: true });
  });
});

describe("app_search_threads", () => {
  const searchHit = (
    threadId: string,
    entryKind: "block" | "item",
    rank: number,
  ): import("../../conversationStoreTypes.js").ConversationSearchHit => ({
    threadId,
    entryKind,
    blockId: entryKind === "block" ? `b-${threadId}` : null,
    turnId: null,
    itemId: entryKind === "item" ? `i-${threadId}` : null,
    at: 1,
    snippet: `${threadId} snippet`,
    rank,
  });

  it("collapses to one best hit per thread, user messages first", async () => {
    const store = makeStore({
      searchConversations: () => [
        searchHit("t-newest", "item", 1),
        searchHit("t-newest", "block", 5),
        searchHit("t-done", "block", 2),
      ],
    });
    const result = await tools({ store }).call(makeCtx({ threadId: "t-newest" }), "app_search_threads", {
      query: "auth",
    });
    expect(result.isError).toBeUndefined();
    // SAFETY: this tool's own payload always carries `results`.
    const results = (result.structuredContent as { results: Array<{ threadId: string }> }).results;
    // One hit per thread, and both are user blocks: the lower rank first.
    expect(results.map((r) => r.threadId)).toEqual(["t-done", "t-newest"]);
  });

  it("drops a thread the caller may not read", async () => {
    const store = makeStore({
      searchConversations: () => [searchHit("t-newest", "block", 2), searchHit("site-1", "block", 1)],
    });
    const result = await tools({ store }).call(makeCtx({ threadId: "t-newest" }), "app_search_threads", {
      query: "auth",
    });
    // SAFETY: this tool's own payload always carries `results`.
    const results = (result.structuredContent as { results: Array<{ threadId: string }> }).results;
    // site-1 is another project with no lineage/reference to the caller.
    expect(results.map((r) => r.threadId)).toEqual(["t-newest"]);
  });
});

describe("queue gateway tools", () => {
  const queuedRow = (
    queueId: string,
    input: string,
  ): import("../../conversationStoreTypes.js").QueuedTurnRow => ({
    queueId,
    threadId: "t-newest",
    userBlockId: `ub-${queueId}`,
    dispatchMode: "queue",
    state: "queued",
    input,
    attemptCount: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  it("lists a thread's waiting follow-ups in run order", async () => {
    const result = await tools({
      listQueuedTurns: () => [queuedRow("q1", "first"), queuedRow("q2", "second")],
    }).call(makeCtx({ threadId: "t-newest" }), "app_list_queued_turns", { threadId: "t-newest" });
    expect(result.isError).toBeUndefined();
    // SAFETY: this tool's own payload always carries `queuedTurns`.
    const rows = (result.structuredContent as { queuedTurns: Array<{ queueId: string; position: number }> })
      .queuedTurns;
    expect(rows.map((r) => [r.queueId, r.position])).toEqual([
      ["q1", 1],
      ["q2", 2],
    ]);
  });

  it("edits a waiting row in place through the injected service path", async () => {
    const edited: Array<[string, string, string]> = [];
    const result = await tools({
      editQueuedTurn: async (threadId, queueId, input) => {
        edited.push([threadId, queueId, input]);
        return true;
      },
    }).call(makeCtx({ threadId: "t-newest" }), "app_edit_queued_turn", {
      threadId: "t-newest",
      queueId: "q1",
      input: "edited",
    });
    expect(result.isError).toBeUndefined();
    expect(edited).toEqual([["t-newest", "q1", "edited"]]);
    expect(result.structuredContent).toMatchObject({ ok: true });
  });

  it("promotes through the injected send-now path", async () => {
    const promoted: string[] = [];
    await tools({
      promoteQueuedTurn: async (_threadId, queueId) => {
        promoted.push(queueId);
        return true;
      },
    }).call(makeCtx({ threadId: "t-newest" }), "app_promote_queued_turn", {
      threadId: "t-newest",
      queueId: "q1",
    });
    expect(promoted).toEqual(["q1"]);
  });

  it("refuses when the host wires no queue control", async () => {
    const result = await tools().call(makeCtx({ threadId: "t-newest" }), "app_cancel_queued_turn", {
      threadId: "t-newest",
      queueId: "q1",
    });
    expect(result.isError).toBe(true);
  });
});

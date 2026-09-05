import { describe, expect, it } from "bun:test";

import type { AgentRecord } from "../../ConversationStore.js";
import type { ProviderAvailability } from "../../agentModel.js";
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
      const found = [...KONE_THREADS, ...SITE_THREADS].find((t) => t.threadId === threadId);
      return found ?? null;
    },
    listProjectAgents: (path) => (path === KONE ? [MAYA, REX] : []),
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
    availability?: ProviderAvailability[];
    threadId?: string;
    emit?: EmitEvent;
    stopThread?: (threadId: string) => Promise<{ stopped: boolean; wasRunning: boolean; reason?: string }>;
    archiveThread?: (
      threadId: string,
      archived: boolean,
    ) => Promise<{ ok: boolean; reason?: string; threadIds?: string[] }>;
    deleteThread?: (threadId: string) => Promise<{ ok: boolean; reason?: string }>;
    renameThread?: (
      threadId: string,
      title: string,
    ) => Promise<{ ok: boolean; title?: string; previousTitle?: string | null; reason?: string }>;
  } = {},
) {
  const live = new Set(options.live ?? []);
  const toolOptions: AppThreadsToolOptions = {
    store: options.store ?? makeStore(),
    readProjects: () => (options.projects === undefined ? PROJECTS : options.projects),
    isThreadLive: (threadId) => live.has(threadId),
    availability: async () => options.availability ?? AVAILABILITY,
    newThreadId: () => options.threadId ?? "thread-new",
  };
  if (options.emit) toolOptions.emit = options.emit;
  if (options.stopThread) toolOptions.stopThread = options.stopThread;
  if (options.archiveThread) toolOptions.archiveThread = options.archiveThread;
  if (options.deleteThread) toolOptions.deleteThread = options.deleteThread;
  if (options.renameThread) toolOptions.renameThread = options.renameThread;
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

  it("says which threads are running and whose they are", async () => {
    const result = await tools({ live: ["t-newest"] }).call(makeCtx(), "app_list_threads", {
      project: "kone",
    });
    // SAFETY: as above.
    const threads = result.structuredContent?.threads as GatewayRecord[];

    expect(threads[0]?.running).toBe(true);
    expect(threads[0]?.agent).toBe("Maya");
    // Absent, not false: a flag only appears on a row it is true of, which is
    // most of what keeps a twenty-row answer small.
    expect(threads[1]).not.toHaveProperty("running");
    expect(text(result)).toContain("Maya");
    expect(text(result)).toContain("running");
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

  it("reads a thread this conversation did not open", async () => {
    // The point of the tool: the assistant is not in the thread's spawn tree,
    // and is still allowed to read it.
    const result = await tools().call(
      makeCtx({ threadId: "somewhere-else" }),
      "app_read_thread",
      { threadId: "t-newest" },
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.thread).toMatchObject({ threadId: "t-newest" });
  });

  it("refuses a thread the store does not hold", async () => {
    const result = await tools().call(makeCtx(), "app_read_thread", { threadId: "ghost" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_found");
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
  it("reads turn-lessly and gates only the start on a live turn", () => {
    const entries = createAppThreadTools({ store: makeStore() });
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    expect(byName.get("app_list_threads")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_read_thread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_start_thread")?.requiresActiveTurn).toBe(true);
    expect(byName.get("app_stop_thread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_archive_thread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_delete_thread")?.requiresActiveTurn).toBe(false);
    expect(byName.get("app_rename_thread")?.requiresActiveTurn).toBe(false);

    expect(entries).toHaveLength(7);
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

describe("app_delete_thread", () => {
  it("deletes a thread when safe", async () => {
    const store = makeStore();
    const result = await tools({ store }).call(makeCtx(), "app_delete_thread", {
      threadId: "t-newest",
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
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("capability_denied");
  });

  it("refuses deleting when thread does not exist", async () => {
    const result = await tools().call(makeCtx(), "app_delete_thread", {
      threadId: "nonexistent",
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

import { describe, expect, it } from "bun:test";

import type { AgentRecord } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/ConversationStore.js";
import type { ProviderAvailability } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/agentModel.js";
import type { TurnSpan } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/conversationStoreTypes.js";
import type { PendingInteraction } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/eventSubscriptions.js";
import type { ThreadGateKind } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/types.js";
import type { ThreadRuntime } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/recipientState.js";
import { IrcMailbox } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/gateway/tools/irc.js";
import type {
  EmitEvent,
  SendTurnInput,
  Session,
  SessionStartInput,
  StoredBlock,
  StoredThread,
  StoredThreadMeta,
} from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/types.js";
import { encodeCursor } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/gateway/helpers.js";
import { createRegistry, type GatewayToolContext } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/gateway/registry.js";
import type { GatewayRecord } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/gateway/schemas.js";
import type { ProjectRosterEntry } from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/gateway/tools/appProjects.js";
import {
  createAppThreadTools,
  type AppThreadsRunner,
  type AppThreadsStore,
  type AppThreadsToolOptions,
} from "/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/gateway/tools/appThreads.js";

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
    listQueuedTurns?: (threadId: string) => import("/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/conversationStoreTypes.js").QueuedTurnRow[];
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
  return createRegistry(createAppThreadTools(toolOptions).map(tool => ({...tool, target:"assistant"})));
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

it("review: search parent can find its cross-project child", async () => {
 const store = makeStore({
 threadMeta: id => id === "parent" ? thread({threadId:id,projectPath:KONE}) : thread({threadId:id,projectPath:SITE,parentThreadId:"parent"}),
 searchConversations: () => [{threadId:"child",entryKind:"block",blockId:"b",turnId:null,itemId:null,at:1,snippet:"child needle",rank:1}],
 });
 const result = await tools({store}).call(makeCtx({threadId:"parent"}),"app_search_threads",{query:"needle"});
 expect(result.structuredContent).toBeUndefined();
 expect(text(result)).toContain("child needle");
});
it("review: search widens past the real store's 100-hit cap", async () => {
 const hits: import("/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/conversationStoreTypes.ts").ConversationSearchHit[] = Array.from({length:101},(_,i)=>({
 threadId:i === 100 ? "t-newest" : "forbidden-"+i,entryKind:"block",blockId:"b"+i,turnId:null,itemId:null,at:i,snippet:i===100 ? "eligible needle" : "forbidden needle",rank:i,
 }));
 const store = makeStore({searchConversations: (_query, options) => hits.slice(options?.offset ?? 0,(options?.offset ?? 0)+Math.min(options?.limit ?? 20,100))});
 const result = await tools({store}).call(makeCtx({threadId:"t-newest"}),"app_search_threads",{query:"needle",limit:1});
 expect(result.structuredContent).toBeUndefined();
 expect(text(result)).toContain("eligible needle");
});

it("review: real store hides an eligible result behind 100 unreadable hits", async () => {
 const {mkdtempSync,rmSync} = await import("node:fs");
 const {tmpdir} = await import("node:os");
 const {setUserDataDir} = await import("/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/userDataDir.ts");
 const {ConversationStore} = await import("/home/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/ConversationStore.ts");
 const dir = mkdtempSync(tmpdir()+"/p6-search-review-");
 setUserDataDir(dir);
 const real = new ConversationStore();
 try {
 for(let i=0;i<101;i++) {
  real.ensureThread({threadId:"outside"+i,provider:"codex",projectPath:SITE});
  real.recordUserBlock({threadId:"outside"+i,blockId:"outside-b"+i,text:"needlereview"});
 }
 real.ensureThread({threadId:"t-newest",provider:"codex",projectPath:KONE});
 real.recordUserBlock({threadId:"t-newest",blockId:"eligible",text:"eligible needlereview "+"filler ".repeat(1000)});
 const raw = real.searchConversations("needlereview",{limit:1000});
 expect(raw).toHaveLength(100);
 expect(raw.some(h=>h.threadId==="t-newest")).toBe(false);
 const store = makeStore({searchConversations:(q,o)=>real.searchConversations(q,o)});
 const result = await tools({store}).call(makeCtx({threadId:"t-newest"}),"app_search_threads",{query:"needlereview",limit:1});
 expect(result.structuredContent).toBeUndefined();
 expect(text(result)).toContain("t-newest");
 } finally { real.close(); rmSync(dir,{recursive:true,force:true}); }
});

it("review: direct lineage, archive and child caller scopes through assistant mapping", async () => {
 const metas = [thread({threadId:"root",projectPath:KONE}),thread({threadId:"child",projectPath:SITE,parentThreadId:"root",archivedAt:5}),thread({threadId:"grandchild",projectPath:"/third",parentThreadId:"child"}),thread({threadId:"outsider",projectPath:"/fourth"})];
 const store=makeStore({threadMeta:id=>metas.find(m=>m.threadId===id)??null,searchConversations:()=>metas.map(m=>({threadId:m.threadId,entryKind:"block" as const,blockId:"b-"+m.threadId,turnId:null,itemId:null,at:1,snippet:"scope-"+m.threadId,rank:1}))});
 const root=await tools({store}).call(makeCtx({threadId:"root"}),"app_search_threads",{query:"scope"});
 expect(root.structuredContent).toBeUndefined(); expect(text(root)).toContain("scope-child"); expect(text(root)).not.toContain("scope-grandchild"); expect(text(root)).not.toContain("scope-outsider");
 const child=await tools({store}).call(makeCtx({threadId:"child"}),"app_search_threads",{query:"scope"});
 expect(child.structuredContent).toBeUndefined(); expect(text(child)).toContain("scope-root"); expect(text(child)).toContain("scope-grandchild"); expect(text(child)).not.toContain("scope-outsider");
});

it("review: all queue callback refusals reach assistant as isError text", async()=>{
 for(const name of ["app_edit_queued_turn","app_cancel_queued_turn","app_reorder_queued_turns","app_promote_queued_turn"]){
 const result=await tools({editQueuedTurn:async()=>false,cancelQueuedTurn:async()=>false,reorderQueuedTurns:async()=>false,promoteQueuedTurn:async()=>false}).call(makeCtx({threadId:"t-newest"}),name,{threadId:"t-newest",queueId:"q1",queueIds:["q1"],input:"edited"});
 expect(result.structuredContent).toBeUndefined();expect(result.isError).toBe(true);expect(text(result)).toContain(name === "app_reorder_queued_turns" ? "no waiting rows matched" : "no such waiting row");
 }
 const row={queueId:"actionable-q",threadId:"t-newest",userBlockId:"b",dispatchMode:"queue" as const,state:"queued" as const,input:"actionable prompt",attemptCount:0,createdAt:1,updatedAt:1};
 const result=await tools({listQueuedTurns:()=>[row]}).call(makeCtx({threadId:"t-newest"}),"app_list_queued_turns",{threadId:"t-newest"});
 expect(result.structuredContent).toBeUndefined();expect(text(result)).toContain("actionable-q");expect(text(result)).toContain("actionable prompt");
});

it("review: nine full unreadable pages and cross-page collapse preserve eligible user hit",async()=>{
 const calls:Array<[number,number]>=[]; const hits=Array.from({length:950},(_,i)=>({threadId:i<901 ? "forbidden-"+i : "t-newest",entryKind:i===949 ? "block" as const : "item" as const,isUserAuthored:i===949,blockId:i===949 ? "best-user" : null,turnId:null,itemId:"item-"+i,at:i,snippet:i===949 ? "eligible user page ten" : "noise",rank:i}));
 const store=makeStore({searchConversations:(_q,o)=>{calls.push([o?.limit??20,o?.offset??0]);return hits.slice(o?.offset??0,(o?.offset??0)+(o?.limit??20));}});
 const result=await tools({store}).call(makeCtx({threadId:"t-newest"}),"app_search_threads",{query:"needle",limit:1});
 expect(result.structuredContent).toBeUndefined();expect(text(result)).toContain("eligible user page ten");expect(text(result)).toContain("Found 1 conversation");expect(calls).toEqual(Array.from({length:10},(_,i)=>[100,i*100]));
});

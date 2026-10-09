// Threads in a project, as gateway tools: what conversations a project has,
// what was said in one, and opening a new one with work already under way.
//
// The assistant sits outside every project — its own thread is on a sentinel
// path, not a repo — so these three are how it reaches the boards the user
// actually works on. Two of them read and one of them starts real work, and
// that split is the whole shape of the module:
//
// - The reads go straight to the store. A thread's transcript is already there
//   and nothing about it is the renderer's to know, so no mirror is involved.
//   Unlike the worker tools' `agent_read`, these are NOT scoped to a
//   caller's spawn subtree: the assistant is the user's co-pilot across the
//   whole app, and a co-pilot that can only read the threads it opened itself
//   could not answer "what happened in that refactor thread yesterday".
// - The start goes through the SAME dispatcher the renderer's own "new thread"
//   button goes through. That is deliberate and load-bearing: a thread opened
//   here is an ordinary top-level thread on the project's board, not a spawned
//   child of the assistant. The user can see it, open it, and keep talking in
//   it after the assistant's turn has ended, because there is nothing special
//   about it to notice.
//
// The board learns about the new thread without being told: its first turn
// emits `turn.started`, and the renderer's session lists already refetch on
// that. So there is no mutation event here and nothing to apply in the
// renderer — the thread appears because it is real, not because it was
// announced.

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { truncateThreadTitle } from "../../threadTitle.js";
import type {
  ThreadPullRequestLink,
  ThreadPullRequestLinkInput,
} from "../../threadPullRequest.js";
import { projectThreadStatus } from "../../spawnProjection.js";
import {
  modelChainOf,
  planSpawnModel,
  type ModelCandidate,
  type ProviderAvailability,
} from "../../agentModel.js";
import { resolveDelegation } from "../../delegate.js";
import { agentSenderFor } from "../../senderHeader.js";
import { recipientState, type ThreadRuntime } from "../../recipientState.js";
import { deliveryReceipt } from "../../inboxDelivery.js";
import type { AgentSender } from "@kone/protocol/message-sender";
import { compact, decodeCursor, encodeCursor, squash } from "../helpers.js";
import type {
  AgentPersona,
  EmitEvent,
  RuntimeEvent,
  Session,
  SendTurnInput,
  SessionStartInput,
  StoredThread,
  StoredThreadMeta,
  ThreadGateKind,
  ThreadStatus,
  TurnStartResult,
} from "../../types.js";
import type { ConversationSearchHit, ConversationSearchOptions, QueuedTurnRow, TurnSpan } from "../../conversationStoreTypes.js";
import { encodeThreadPageCursor, GLOBAL_ASSISTANT_PROJECT_PATH, type StoredThreadPage } from "../../conversationStoreTypes.js";
import type { PendingInteraction } from "../../eventSubscriptions.js";
import type { AgentModelRef, AgentRecord } from "../../ConversationStore.js";
import type { ThreadAgentBinding } from "../../rosterRecord.js";
import {
  ArchiveAppThreadInputSchema,
  ARCHIVE_APP_THREAD_JSON_SCHEMA,
  DeleteAppThreadInputSchema,
  DELETE_APP_THREAD_JSON_SCHEMA,
  GatewayToolError,
  ListAppThreadsInputSchema,
  LIST_APP_THREADS_JSON_SCHEMA,
  ReadAppThreadInputSchema,
  READ_APP_THREAD_JSON_SCHEMA,
  RenameAppThreadInputSchema,
  RENAME_APP_THREAD_JSON_SCHEMA,
  SetThreadPinnedInputSchema,
  SET_THREAD_PINNED_JSON_SCHEMA,
  SetThreadDoneInputSchema,
  SET_THREAD_DONE_JSON_SCHEMA,
  MarkThreadUnreadInputSchema,
  MARK_THREAD_UNREAD_JSON_SCHEMA,
  SearchAppThreadsInputSchema,
  SEARCH_APP_THREADS_JSON_SCHEMA,
  SEARCH_APP_THREADS_DEFAULT_LIMIT,
  ListQueuedTurnsInputSchema,
  ListQueuedTurnsJson,
  EditQueuedTurnInputSchema,
  EditQueuedTurnJson,
  ReorderQueuedTurnsInputSchema,
  ReorderQueuedTurnsJson,
  CancelQueuedTurnInputSchema,
  CancelQueuedTurnJson,
  PromoteQueuedTurnInputSchema,
  PromoteQueuedTurnJson,
  LinkThreadPullRequestInputSchema,
  LINK_THREAD_PULL_REQUEST_JSON_SCHEMA,
  UnlinkThreadPullRequestInputSchema,
  UNLINK_THREAD_PULL_REQUEST_JSON_SCHEMA,
  StartAppThreadInputSchema,
  START_APP_THREAD_JSON_SCHEMA,
  SendAppThreadMessageInputSchema,
  SEND_APP_THREAD_MESSAGE_JSON_SCHEMA,
  StopAppThreadInputSchema,
  STOP_APP_THREAD_JSON_SCHEMA,
  THREAD_LIST_DEFAULT_LIMIT,
  type GatewayRecord,
  type ListAppThreadsInput,
  type ReadAppThreadInput,
  type SendAppThreadMessageInput,
  type StartAppThreadInput,
  type LinkThreadPullRequestInput,
  type UnlinkThreadPullRequestInput,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";
import { collapseSearchHits, fetchSearchCandidates } from "../searchCollapse.js";
import { canReadThread } from "../readScope.js";
import { requireProjects, resolveProject, type ProjectRosterEntry } from "./appProjects.js";
import {
  readMessageRow,
  renderMessageLine,
  threadLine,
  THREAD_LINE_LEGEND,
  threadPayload,
  type ThreadReading,
} from "./appThreadsFormatting.js";

/** The store slice these tools read and write through. */
export interface AppThreadsStore {
  listThreads(projectPath: string, options?: { archived?: boolean }): StoredThreadMeta[];
  loadThread(threadId: string): StoredThread | null;
  /** Windowed read for paging older messages (app_read_thread's cursor). A
   *  store that does not offer it refuses cursor reads rather than paging the
   *  whole thread. */
  loadThreadPage?(threadId: string, options?: { limit?: number; maxRaw?: number; cursor?: string; countBlocks?: boolean }): StoredThreadPage | null;
  threadMeta?(threadId: string): StoredThreadMeta | null;
  /** The project's team, in roster order — the agents a thread here can be
   *  handed to. A thread is handed to a team member or to nobody: an agent the
   *  user has not put on the project is not on it. */
  listProjectAgents(projectPath: string): AgentRecord[];
  /** The thread's turn readout — when its turns ran, how many are still
   *  running, how the newest assistant block settled. One cheap aggregate
   *  query per thread; what the list's `status` is derived from. Absent, every
   *  thread reads as idle-or-live (the degraded answer for test stores). */
  threadTurnSpan?(threadId: string): TurnSpan | null;
  /** The batch version of threadTurnSpan: the same readout for many threads
   *  in one round trip. The list reads the whole page through this when the
   *  store offers it, falling back to one threadTurnSpan per row otherwise.
   *  A miss reads as null, like the single-thread answer for a thread with
   *  no assistant history. */
  threadTurnSpans?(threadIds: readonly string[]): ReadonlyMap<string, TurnSpan>;
  /** The agent a thread runs as, when it has one — what makes a list entry say
   *  whose thread it is. */
  getThreadAgent(threadId: string): { agentId: string | null } | null;
  getAgent(agentId: string): AgentRecord | null;
  /** Bind the new thread to the agent it was handed to, before its first turn
   *  dispatches, so its transcript carries that identity from the start. */
  bindThreadAgent(threadId: string, agentId: string | null): ThreadAgentBinding | null;
  reserveGatewayOp(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    kind: string;
    fingerprint: string;
  }): { kind: "reserved" } | { kind: "replay"; result: unknown } | { kind: "conflict" } | null;
  setGatewayOpResult(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    resultJson: string;
  }): void;
  /** Blind title write — the first-turn fallback and agent-generated renames.
   *  The rename op prefers `renameThread` below and only uses this on stores
   *  that predate it. */
  setTitle?(threadId: string, title: string): void;
  /** Canonical user-initiated rename: same title-only write as setTitle
   *  (recency untouched), but change-detecting — false when the row is missing
   *  or the title is unchanged, so callers only announce real changes. */
  renameThread?(threadId: string, title: string): boolean;
  /** Thread-state marks (Phase 6). Pin, settle, and unread all read/write the
   *  existing columns; the canonical done path goes through the service so the
   *  done event fans out. */
  setPinned?(threadId: string, pinned: boolean): void;
  setDone?(threadId: string, done: boolean): void;
  setVisited?(threadId: string, at: number, force?: boolean): void;
  /** Full-text conversation search (Phase 6). Returns raw ranked hits; the
   *  tool collapses them to one best per thread. */
  searchConversations?(
    query: string,
    options?: ConversationSearchOptions,
  ): ConversationSearchHit[];
  /** Persist (or clear) a linked pull request on a thread. The settle sweep
   *  reads it to know when a merged PR means the thread is done. Absent, the
   *  link tools refuse. */
  setThreadPullRequestLink?(threadId: string, input: ThreadPullRequestLinkInput): boolean;
  clearThreadPullRequestLink?(threadId: string): boolean;
  threadPullRequestLink?(threadId: string): ThreadPullRequestLink | null;
  setArchived?(
    threadId: string,
    archived: boolean,
  ): { ok: true; threadIds: string[] } | { ok: false; reason: "missing" | "busy" | "error" };
  canDeleteThread?(threadId: string): { ok: true } | { ok: false; reason: "missing" | "busy" };
  deleteThread?(
    threadId: string,
  ): { ok: true } | { ok: false; reason: "missing" | "busy" | "error" };
  /** Flip a thread's queued + promoting rows to cancelled, returning their
   *  ids. The delete fallback calls this when present so a dropped thread's
   *  follow-ups cannot resurrect it. */
  cancelQueuedTurnsForThread?(threadId: string): string[] | null;
}

/** The thread-driving half of the dispatcher — the same two calls the renderer's
 *  IPC handlers forward to. Named structurally so a test can start a thread
 *  without a provider process. */
export interface AppThreadsRunner {
  startThread(input: SessionStartInput): Promise<Session>;
  sendThreadTurn(input: SendTurnInput, options?: { title?: string }): Promise<TurnStartResult>;
  /** Put a message into a thread's running turn. Absent, a steer request is
   *  queued behind the turn instead. */
  steerThreadTurn?(input: SendTurnInput): Promise<TurnStartResult>;
  /** Bring back a thread's stored session so a turn can run on it — a thread
   *  the user has not touched since a restart has none. Absent, a message to
   *  such a thread is refused rather than sent at a session that is not there. */
  ensureThreadSession?(threadId: string, options: { resume: boolean }): Promise<void>;
}

/** What providers and models can actually run right now. Absent, a thread runs
 *  where the caller runs and an agent's own model is taken at its word — which
 *  is the honest answer when nothing can tell us otherwise. */
export type AppThreadsAvailability = () => Promise<readonly ProviderAvailability[]>;

/** Lifecycle ownership: in production the four `*Thread` controls below are the
 *  only path — the desktop shell wires every one to a service-backed
 *  implementation (queue-cancel + broadcast + attachment cleanup + dispatcher
 *  forget composed in one place). The store-adapter branches inside the ops
 *  are a degraded fallback for tests and service-less hosts: they guard and
 *  write through the same store methods the canonical path uses, but they
 *  cannot emit the queued-cancelled broadcasts, remove attachment bytes, or
 *  forget dispatcher state. */
/** The inbox's side of a message sent as a job. */
export interface AppThreadJobs {
  postJob(input: {
    to: string;
    projectPath: string;
    message: string;
    sender: AgentSender;
    urgent?: boolean;
    dedupeKey?: string;
  }): { messageId: string; duplicate: boolean };
}

export interface AppThreadsToolOptions {
  store: AppThreadsStore;
  emit?: EmitEvent;
  /** Where a message goes: a job in the thread's inbox, handed over as a
   *  turn of its own, held while the thread waits on the user. */
  jobs: AppThreadJobs;
  /** What a thread is doing right now, for what a job's send reports. */
  threadRuntime?: (threadId: string) => ThreadRuntime | null;
  /** The projects the renderer last reported — what a project name resolves
   *  against, and what an unscoped list walks. */
  readProjects?: () => readonly ProjectRosterEntry[] | null;
  /** Whether a thread has a live provider session, so a list can say which
   *  threads are running rather than only when they last spoke. */
  isThreadLive?: (threadId: string) => boolean;
  /** What a thread is parked on, if anything — an approval the user must
   *  decide, or a question for the user. Outranks the turn readout when
   *  deriving `status`: a parked thread is the one state where nothing moves
   *  until a human acts. Absent, no thread reads as parked. */
  pendingGateFor?: (threadId: string) => ThreadGateKind | null;
  /** Every parked gate in one indexed snapshot, built once per list — rows
   *  read from the returned map instead of one per-thread call each. Wins
   *  over `pendingGateFor` for lists; `pendingGateFor` stays the fallback
   *  for single-thread reads and hosts without a supplier. */
  pendingGates?: () => ReadonlyMap<string, ThreadGateKind>;
  /** Every parked ask in full — the approval's headline or the question's
   *  text — so a thread's answer can say WHAT it is waiting on, not only that
   *  it waits. Absent, a parked thread reports its gate kind alone. */
  pendingAsks?: () => readonly PendingInteraction[];
  /** Starts threads. Absent, `app_start_thread` refuses rather than pretending:
   *  there is no dispatcher in this process to drive one. */
  runner?: AppThreadsRunner;
  availability?: AppThreadsAvailability;
  /** Mints the new thread's id. Injected so a test can name the thread it is
   *  about to assert on. */
  newThreadId?: () => string;
  /** Stop a live thread's turn and session. `stopped` is the idempotent
   *  guarantee — true whenever the call leaves the thread with nothing
   *  running, including when it was already idle — so read `wasRunning` to
   *  tell whether a live session actually existed. Kept (rather than dropped)
   *  so MCP clients can keep confirming quiescence off the one field. */
  stopThread?: (threadId: string) => Promise<{ stopped: boolean; wasRunning: boolean; reason?: string }>;
  /** Archive or unarchive a thread and its subtree. Canonical in production
   *  (service-backed: cancels the subtree's queued turns and announces the
   *  change); the store fallback writes the column only. */
  archiveThread?: (
    threadId: string,
    archived: boolean,
  ) => Promise<{ ok: boolean; reason?: string; threadIds?: string[] }>;
  /** Permanently delete a thread. Canonical in production (service-backed:
   *  queue-cancel + broadcast + attachment bytes + dispatcher forget); the
   *  store fallback guards, cancels the queue when the adapter offers it, and
   *  drops the rows. */
  deleteThread?: (threadId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Rename a thread. Canonical in production (change-detecting write +
   *  broadcast); the store fallback writes through the same canonical store
   *  method and emits the same event. */
  renameThread?: (
    threadId: string,
    title: string,
  ) => Promise<{ ok: boolean; title?: string; previousTitle?: string | null; reason?: string }>;
  /** Mark a thread done (or clear it). Canonical in production (the service
   *  emits thread.done.updated); the store fallback writes the same column. */
  setThreadDone?: (threadId: string, done: boolean) => void;
  /** Queue controls (Phase 6). All canonical in production, where the service
   *  keeps mirrors and broadcasts in step; absent, the tools refuse. */
  listQueuedTurns?: (threadId: string) => QueuedTurnRow[];
  editQueuedTurn?: (threadId: string, queueId: string, input: string) => Promise<boolean>;
  reorderQueuedTurns?: (threadId: string, queueIds: string[]) => Promise<boolean>;
  cancelQueuedTurn?: (threadId: string, queueId: string) => Promise<boolean>;
  promoteQueuedTurn?: (threadId: string, queueId: string) => Promise<boolean>;
}

/** Tags this module's cursors, so one handed to another tool is refused rather
 *  than read as a boundary in a list it does not describe. */
const THREAD_CURSOR = "threads";

/** Stable FNV-1a hex over the canonicalized start — the idempotency
 *  fingerprint, not a security boundary. Same construction as the scratchpad
 *  write's, for the same reason: a retry of the *same* start replays, and a
 *  different start reusing the key is a conflict rather than a silent second
 *  thread on the user's repo. */
function fingerprintOf(parts: Array<string | undefined>): string {
  let hash = 0x811c9dc5;
  const canonical = parts.map((part) => part ?? "").join("|");
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** The two fields a replayed op's text repeats, read off the stored payload. */
const ReplayedOpSchema = z.object({ summary: z.string().optional(), threadId: z.string().optional() });

/** What a replay says about the op it stands for. The text is all a model
 *  reads, and a retry that does not say which thread leaves it holding none. */
function replayWords(replayed: GatewayRecord, withThreadId: boolean): string {
  const parsed = ReplayedOpSchema.safeParse(replayed);
  if (!parsed.success) return "";
  const { summary, threadId } = parsed.data;
  return `${summary ? ` ${summary}` : ""}${withThreadId && threadId ? `\nThread id: ${threadId}.` : ""}`;
}

/** How much of a parked ask one list row carries. app_read_thread has it whole. */
const ASK_CLIP = 100;

/** What one parked ask wants from the user, in a line: the approval's kind and
 *  headline (and the provider's reason), or the question with its choices. */
function askLine(ask: PendingInteraction): string | null {
  const event = ask.event;
  if (event.type === "approval.requested") {
    const { kind, title, detail } = event.approval;
    return `approve ${kind} "${title}"${detail ? ` (${detail})` : ""}`;
  }
  if (event.type === "user-input.requested") {
    return event.questions
      .map((q) => {
        const choices = q.options.map((o) => o.label).join(" | ");
        return `answer "${q.question}"${choices ? ` [${choices}${q.multiSelect ? ", pick any" : ""}]` : " (free text)"}`;
      })
      .join("; ");
  }
  return null;
}

/** The agent a thread runs as, by name, or null. */
function agentNameFor(store: AppThreadsStore, threadId: string): string | null {
  const bound = store.getThreadAgent(threadId)?.agentId ?? null;
  if (!bound) return null;
  return store.getAgent(bound)?.name?.trim() || null;
}

/** One of the project's team agents, by id or name — or a refusal naming the
 *  team, so a caller that guessed can correct itself in the same turn. A thread
 *  is handed to a team member or to nobody: an agent the user has not put on
 *  this project is not on it. */
function resolveTeamAgent(
  store: AppThreadsStore,
  projectPath: string,
  query: string,
): AgentRecord {
  const team = store.listProjectAgents(projectPath);
  const trimmed = query.trim();
  const byId = team.find((agent) => agent.agentId === trimmed);
  if (byId) return byId;
  const wanted = squash(trimmed);
  const byName = team.filter((agent) => squash(agent.name ?? "") === wanted);
  const [first, ...rest] = byName;
  if (first && rest.length === 0) return first;
  if (first) {
    throw new GatewayToolError(
      "invalid_input",
      `More than one agent on this project is called "${trimmed}". Name it by id instead: ${byName
        .map((agent) => agent.agentId)
        .join(", ")}.`,
    );
  }
  throw new GatewayToolError(
    "not_found",
    team.length === 0
      ? "No agents are on this project's team yet, so there is nobody to hand the thread to. Start it without an agent, or ask the user to add one to the project."
      : `No agent called "${trimmed}" is on this project's team. Its team is: ${team
          .map((agent) => agent.name ?? agent.agentId)
          .join(", ")}.`,
  );
}

/** Where a thread with no agent runs: the model the call named, else the one
 *  this conversation is running on. A named provider that is not the caller's
 *  keeps its own default model, because a model id from one CLI names nothing
 *  on another. */
function inheritTarget(
  ctx: GatewayToolContext,
  params: StartAppThreadInput,
): ModelCandidate {
  const provider = params.provider ?? ctx.provider;
  if (params.model) return { provider, model: params.model };
  if (provider === ctx.provider && ctx.model) return { provider, model: ctx.model };
  return { provider };
}

/** The boundary a cursor names, or a refusal. A cursor the caller could not
 *  have been given is a mistake worth naming: read as "start from the top" it
 *  would silently hand back page one forever. */
function cursorOf(cursor: string | undefined): { at: number; id?: string } | null {
  if (!cursor) return null;
  const fields = decodeCursor(THREAD_CURSOR, cursor);
  if (!fields || fields.at === undefined) {
    throw new GatewayToolError(
      "invalid_input",
      "That cursor did not come from app_list_threads. Pass back the nextCursor this tool returned, or omit it to start from the newest.",
    );
  }
  return fields.id === undefined ? { at: fields.at } : { at: fields.at, id: fields.id };
}

export function createAppThreadTools(options: AppThreadsToolOptions): ToolEntry[] {
  const store = options.store;
  const mintThreadId = options.newThreadId ?? (() => randomUUID());
  const isLive = (threadId: string): boolean => options.isThreadLive?.(threadId) ?? false;

  /** The facts one row's status is derived from, resolved up front so a list
   *  page costs one batch span read plus one gate snapshot pass instead of
   *  one store aggregate per row. */
  interface ReadingFacts {
    span: TurnSpan | null;
    gate: ThreadGateKind | null;
    live: boolean;
  }

  const readingFor = (
    meta: StoredThreadMeta,
    projects: Map<string, ProjectRosterEntry>,
    facts: ReadingFacts,
  ): ThreadReading => ({
    meta,
    project: projects.get(meta.projectPath) ?? null,
    agentName: agentNameFor(store, meta.threadId),
    status: statusFor(facts),
  });

  /** One thread's rolled-up status, derived at read time — never stored, so a
   *  crash cannot leave a dead thread labelled "working". A parked gate
   *  outranks the turn readout; a running turn without a live session reads
   *  interrupted. The span is decomposed into primitives at this boundary so
   *  the projection only ever sees plain facts, never a store row. */
  /** What a thread is parked on, one line per ask, oldest first. */
  const asksFor = (threadId: string): string[] =>
    (options.pendingAsks?.() ?? [])
      .filter((ask) => ask.threadId === threadId)
      .map(askLine)
      .filter((line): line is string => line !== null);

  const statusFor = (facts: ReadingFacts): ThreadStatus =>
    projectThreadStatus({
      gate: facts.gate,
      running: (facts.span?.runningTurns ?? 0) > 0,
      lastState: facts.span?.lastState ?? null,
      hasLiveSession: facts.live,
    });

  // -- lifecycle plumbing (one place, not five handlers) ----------------------
  // Every lifecycle op resolves to a single async fn here: the injected control
  // wins, the store adapter is the fallback, and absence is a no-op success.
  // Handlers below only parse, guard, and narrate.
  const notFound = (threadId: string): GatewayToolError =>
    new GatewayToolError("not_found", `Unknown thread id: "${threadId}".`);

  const requireThread = (threadId: string) => {
    const meta = store.threadMeta?.(threadId) ?? null;
    const thread = meta ? null : store.loadThread(threadId);
    if (!meta && !thread) throw notFound(threadId);
    return { meta, thread };
  };

  const busyRefusal = (threadId: string, verb: "archive" | "delete"): GatewayToolError =>
    new GatewayToolError(
      "capability_denied",
      `Cannot ${verb} thread "${threadId}": a turn or subagent is currently running in this thread or its subtree.`,
    );

  const failInternal = (threadId: string, verb: string, reason?: string): GatewayToolError =>
    new GatewayToolError(
      "internal",
      `Failed to ${verb} thread "${threadId}": ${reason ?? "unknown error"}.`,
    );

  const singleLine = (summary: string, payload: GatewayRecord): GatewayToolResult => ({
    content: [{ type: "text", text: summary }],
    structuredContent: payload,
  });

  const stopWasRunning = async (threadId: string): Promise<boolean> => {
    if (options.stopThread) return (await options.stopThread(threadId)).wasRunning;
    return options.isThreadLive?.(threadId) ?? false;
  };

  const archiveOp = async (threadId: string, archived: boolean): Promise<string[]> => {
    const verb = archived ? "archive" : "unarchive";
    if (options.archiveThread) {
      const res = await options.archiveThread(threadId, archived);
      if (!res.ok) {
        if (res.reason === "busy") throw busyRefusal(threadId, "archive");
        throw failInternal(threadId, verb, res.reason);
      }
      return res.threadIds && res.threadIds.length > 0 ? res.threadIds : [threadId];
    }
    if (store.setArchived) {
      // Degraded fallback (see the ownership note on AppThreadsToolOptions):
      // the column write only. Queue-cancel and the archived-event broadcast
      // happen on the canonical path — this layer deliberately leaves queued
      // turns alone, having no listeners to tell.
      const res = store.setArchived(threadId, archived);
      if (!res.ok) {
        if (res.reason === "busy") throw busyRefusal(threadId, "archive");
        throw failInternal(threadId, verb, res.reason);
      }
      return res.threadIds;
    }
    return [threadId];
  };

  const deleteOp = async (threadId: string): Promise<void> => {
    if (options.deleteThread) {
      const res = await options.deleteThread(threadId);
      if (!res.ok) {
        if (res.reason === "busy") throw busyRefusal(threadId, "delete");
        throw failInternal(threadId, "delete", res.reason);
      }
      return;
    }
    // Degraded fallback (see the ownership note on AppThreadsToolOptions):
    // guard + queue-cancel + row drop through the same store methods the
    // canonical path uses, in the same order — cancelling first, because the
    // row drop removes the queue rows outright. Attachment bytes, the
    // turn.queued-cancelled broadcasts, and dispatcher forget happen only on
    // the canonical path; a store adapter cannot reach them.
    if (store.cancelQueuedTurnsForThread) {
      store.cancelQueuedTurnsForThread(threadId);
    }
    if (store.deleteThread) {
      const res = store.deleteThread(threadId);
      if (!res.ok) {
        if (res.reason === "busy") throw busyRefusal(threadId, "delete");
        throw failInternal(threadId, "delete", res.reason);
      }
    }
  };

  const renameOp = async (threadId: string, title: string, provider?: string): Promise<void> => {
    if (options.renameThread) {
      const res = await options.renameThread(threadId, title);
      if (!res.ok) throw failInternal(threadId, "rename", res.reason);
      return;
    }
    // Degraded fallback: the same canonical store method the IPC rename path
    // uses, falling back to the older blind write only on stores that predate
    // it. Both are title-only (recency untouched). renameThread reports
    // whether anything changed, like the canonical path (which only announces
    // real changes); the blind write cannot, so it always announces.
    let changed = true;
    if (store.renameThread) {
      changed = store.renameThread(threadId, title);
    } else if (store.setTitle) {
      store.setTitle(threadId, title);
    } else {
      return;
    }
    if (changed && options.emit && provider) {
      // SAFETY: constructing runtime event for thread.title.updated
      options.emit({
        type: "thread.title.updated",
        threadId,
        provider,
        title,
        at: Date.now(),
        source: "kone.store",
      } as RuntimeEvent);
    }
  };

  // -- 1. app_list_threads --------------------------------------------------
  const listHandler = async (
    _ctx: GatewayToolContext,
    params: ListAppThreadsInput,
  ): Promise<GatewayToolResult> => {
    const projects = requireProjects(options);
    const scope = params.project ? [resolveProject(projects, params.project)] : projects;
    const archived = params.archived === true;
    const limit = params.limit ?? THREAD_LIST_DEFAULT_LIMIT;
    const byPath = new Map(projects.map((project) => [project.path, project]));

    const metas = scope
      .flatMap((project) => store.listThreads(project.path, { archived }))
      // Each project's list arrives newest-first on its own; across projects
      // they have to be re-sorted or the answer would be "kone's newest, then
      // site's newest", which reads as an ordering and is not one.
      .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt));
    // Keyset, not offset. These rows are ordered by last activity and reorder
    // under you constantly — a thread waking up jumps to the top — so a second
    // page asked for by position would repeat rows the first page already
    // named. Asking instead for "everything after this exact row" is stable
    // however much the list has moved in between.
    const after = cursorOf(params.cursor);
    const page = after
      ? metas.filter((meta) => {
          const at = meta.lastActivityAt ?? meta.updatedAt;
          if (at !== after.at) return at < after.at;
          // Same stamp: the id breaks the tie, in the same direction the sort
          // does, so a run of threads sharing a timestamp still advances.
          return meta.threadId > (after.id ?? "");
        })
      : metas;
    // One batch span read for the whole page plus one gate snapshot, so
    // a twenty-row list is one SQL aggregate — not one per row — and every
    // row's gate is read from the same snapshot. Stores without the batch
    // read fall back to one aggregate per row; hosts without the snapshot
    // supplier fall back to one gate lookup per row.
    const listedMetas = page.slice(0, limit);
    const listedIds = listedMetas.map((meta) => meta.threadId);
    const spanMap = store.threadTurnSpans?.(listedIds) ?? null;
    const gateIndex = options.pendingGates?.() ?? null;
    const gateSnapshot = new Map<string, ThreadGateKind | null>();
    if (gateIndex) {
      for (const threadId of listedIds) gateSnapshot.set(threadId, gateIndex.get(threadId) ?? null);
    } else if (options.pendingGateFor) {
      for (const threadId of listedIds) gateSnapshot.set(threadId, options.pendingGateFor(threadId));
    }
    const listed = listedMetas.map((meta) =>
      readingFor(meta, byPath, {
        span: spanMap ? (spanMap.get(meta.threadId) ?? null) : (store.threadTurnSpan?.(meta.threadId) ?? null),
        gate: gateSnapshot.get(meta.threadId) ?? null,
        live: isLive(meta.threadId),
      }),
    );
    const last = listed[listed.length - 1]?.meta;
    const remaining = page.length - listed.length;
    // A scoped list names its project once, at the top; only a list that spans
    // several has to say which project each row is on.
    const scoped = params.project !== undefined;

    const where = scoped ? `**${scope[0]?.name}**` : "every project";
    const kind = archived ? "archived thread" : "thread";
    if (listed.length === 0) {
      // A cursor that ran off the end is the ordinary way a walk finishes, and
      // is a different thing from a project with no threads at all.
      const text = after
        ? `No more ${kind}s in ${where} - that was the end of the list.`
        : `No ${kind}s in ${where}.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { threads: [], total: metas.length },
      };
    }

    const head = `${metas.length} ${kind}${metas.length === 1 ? "" : "s"} in ${where}${
      metas.length > listed.length ? `, ${after ? `next ${listed.length}` : `newest ${listed.length}`}` : ""
    }:`;
    const payload: GatewayRecord = {
      threads: listed.map((reading) => threadPayload(reading, !scoped)),
      total: metas.length,
    };
    if (scoped && scope[0]) {
      payload.project = { name: scope[0].name, path: scope[0].path };
    }
    // A parked row says what it is parked on, clipped: the list is for seeing
    // what needs the user, and "waiting-for-approval" alone does not say for what.
    const rowFor = (reading: ThreadReading): string => {
      const line = threadLine(reading, !scoped);
      const [ask] = asksFor(reading.meta.threadId);
      if (!ask) return line;
      return `${line} · ${ask.length > ASK_CLIP ? `${ask.slice(0, ASK_CLIP - 1)}…` : ask}`;
    };
    const lines = [head, THREAD_LINE_LEGEND, ...listed.map(rowFor)];
    if (remaining > 0 && last) {
      payload.remaining = remaining;
      payload.nextCursor = encodeCursor(THREAD_CURSOR, {
        at: last.lastActivityAt ?? last.updatedAt,
        id: last.threadId,
      });
      lines.push(
        `${remaining} more. Pass cursor: ${String(payload.nextCursor)} to continue from here.`,
      );
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: payload,
    };
  };

  // -- 2. app_read_thread ---------------------------------------------------
  const readHandler = async (
    ctx: GatewayToolContext,
    params: ReadAppThreadInput,
  ): Promise<GatewayToolResult> => {
    const limit = params.limit ?? 20;
    const maxTextChars = params.maxTextChars ?? 1500;
    const textOffset = params.textOffset ?? 0;

    // Read scope, checked before any paging work. The assistant (kone's own
    // co-pilot, on the sentinel project) reads across projects on the user's
    // behalf; project threads may read themselves, their project, and their
    // fork/source lineage.
    const callerMeta = store.threadMeta?.(ctx.threadId) ?? null;
    const assistantCaller = callerMeta?.projectPath === GLOBAL_ASSISTANT_PROJECT_PATH;
    if (!assistantCaller) {
      const targetMeta = store.threadMeta?.(params.threadId) ?? null;
      const readable = canReadThread({
        callerThreadId: ctx.threadId,
        targetThreadId: params.threadId,
        caller: callerMeta
          ? {
              projectPath: callerMeta.projectPath,
              sourceThreadId: callerMeta.sourceThreadId,
              parentThreadId: callerMeta.parentThreadId,
            }
          : null,
        target: targetMeta
          ? {
              projectPath: targetMeta.projectPath,
              sourceThreadId: targetMeta.sourceThreadId,
              parentThreadId: targetMeta.parentThreadId,
            }
          : null,
      });
      if (!readable) {
        throw new GatewayToolError(
          "capability_denied",
          `Thread "${params.threadId}" is outside what this conversation may read.`,
        );
      }
    }

    // A single message read by id: whole, or a slice from textOffset. This is
    // what a handoff's coverage note points at for a message it omitted.
    if (params.blockId) {
      const thread = store.loadThread(params.threadId);
      if (!thread) {
        throw new GatewayToolError("not_found", `kone holds no thread "${params.threadId}".`);
      }
      const block = thread.blocks.find((candidate) => candidate.id === params.blockId);
      if (!block) {
        throw new GatewayToolError(
          "not_found",
          `kone holds no message "${params.blockId}" in thread "${params.threadId}".`,
        );
      }
      const message = readMessageRow(block, maxTextChars, textOffset, params.representation ?? "rich");
      return {
        content: [
          {
            type: "text",
            text: [
              `Message ${message.blockId} from "${thread.title ?? params.threadId}":`,
              renderMessageLine(message),
            ].join("\n\n"),
          },
        ],
        structuredContent: {
          thread: compact({
            threadId: thread.threadId,
            title: thread.title ?? null,
            projectPath: thread.projectPath,
            provider: thread.provider,
            model: thread.model ?? null,
            agent: agentNameFor(store, thread.threadId),
            status: statusFor({
              span: store.threadTurnSpan?.(thread.threadId) ?? null,
              gate: options.pendingGateFor?.(thread.threadId) ?? null,
              live: isLive(thread.threadId),
            }),
          }),
          messages: [message],
          totalMessages: thread.blocks.length,
        },
      };
    }

    // Paged read: continue older messages from a previous reply's cursor. The
    // store walks backwards from the cursor in arrival order, so a cursor
    // walk can never skip or repeat a message.
    if (params.cursor) {
      if (!store.loadThreadPage) {
        throw new GatewayToolError(
          "capability_denied",
          "Cursor paging is not available in this session.",
        );
      }
      const page = store.loadThreadPage(params.threadId, {
        limit,
        cursor: params.cursor,
        countBlocks: true,
      });
      if (!page) {
        throw new GatewayToolError("not_found", `kone holds no thread "${params.threadId}".`);
      }
      const messages = page.blocks.map((block) =>
        readMessageRow(block, maxTextChars, textOffset, params.representation ?? "rich"),
      );
      const title = page.meta.title ?? params.threadId;
      const heading =
        messages.length === 0
          ? `No older messages in "${title}".`
          : `${messages.length} older message${messages.length === 1 ? "" : "s"} from "${title}", oldest first:`;
      return {
        content: [
          {
            type: "text",
            text: [heading, ...messages.map(renderMessageLine)].join("\n\n"),
          },
        ],
        structuredContent: {
          thread: compact({
            threadId: page.meta.threadId,
            title: page.meta.title ?? null,
            projectPath: page.meta.projectPath,
            provider: page.meta.provider,
            model: page.meta.model ?? null,
            agent: agentNameFor(store, page.meta.threadId),
          }),
          messages,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
      };
    }

    const thread = store.loadThread(params.threadId);
    if (!thread) {
      throw new GatewayToolError("not_found", `kone holds no thread "${params.threadId}".`);
    }
    // Prefer the store's physical-block page so the cursor is a real block:
    // a cursor minted from an assembled block id can name a synthetic
    // steer-continuation segment, and paging from it skips the steering
    // prompt and duplicates the continuation. Fall back to the tail slice
    // only for a store that has no page reader (tests).
    const page = store.loadThreadPage
      ? store.loadThreadPage(params.threadId, { limit, countBlocks: true })
      : null;
    const blocks = page ? page.blocks : thread.blocks.slice(-limit);
    const messages = blocks.map((block) =>
      readMessageRow(block, maxTextChars, textOffset, params.representation ?? "prose"),
    );
    const oldest = blocks[0];
    const hasMore = page ? page.hasMore : thread.blocks.length > messages.length;
    const nextCursor = page
      ? page.nextCursor
      : hasMore && oldest
        ? encodeThreadPageCursor({
            threadId: thread.threadId,
            beforeAnchorAt: oldest.at,
            beforeBlockId: oldest.id,
          })
        : null;

    const title = thread.title ?? params.threadId;
    const agent = agentNameFor(store, thread.threadId);
    const status = statusFor({
      span: store.threadTurnSpan?.(thread.threadId) ?? null,
      gate: options.pendingGateFor?.(thread.threadId) ?? null,
      live: isLive(thread.threadId),
    });
    const about = [
      `Thread ${thread.threadId}`,
      status,
      [agent, thread.provider, thread.model].filter(Boolean).join(" / "),
      `project ${thread.projectPath}`,
      thread.blocks.length > messages.length ? `${thread.blocks.length} messages in all` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const heading =
      messages.length === 0
        ? `"${title}" has no messages yet.`
        : `${messages.length} message${messages.length === 1 ? "" : "s"} from "${title}", oldest first:`;

    return {
      content: [
        {
          type: "text",
          text: [
            [about, ...asksFor(thread.threadId).map((ask) => `Waiting on the user to ${ask}.`), heading].join("\n"),
            ...messages.map(renderMessageLine),
          ].join("\n\n"),
        },
      ],
      structuredContent: {
        thread: compact({
          threadId: thread.threadId,
          title: thread.title ?? null,
          projectPath: thread.projectPath,
          provider: thread.provider,
          model: thread.model ?? null,
          agent,
          status,
        }),
        messages,
        totalMessages: thread.blocks.length,
        nextCursor,
        hasMore,
      },
    };
  };

  // -- 3. app_start_thread --------------------------------------------------
  const startHandler = async (
    ctx: GatewayToolContext,
    params: StartAppThreadInput,
  ): Promise<GatewayToolResult> => {
    const runner = options.runner;
    if (!runner) {
      throw new GatewayToolError(
        "provider_unavailable",
        "kone cannot start threads in this session - no dispatcher is running behind the gateway.",
      );
    }
    const project = resolveProject(requireProjects(options), params.project);

    // The registry refuses this tool without a live turn, so a turn id is
    // present by the time the handler runs - but the op key needs a concrete
    // one, and reading it as "" would collapse every turn's keys together.
    const turnId = ctx.turnId;
    if (!turnId) {
      throw new GatewayToolError(
        "capability_denied",
        "Starting a thread requires an active agent turn.",
      );
    }
    const opKey = { threadId: ctx.threadId, turnId, requestId: params.requestId };
    const reserve = store.reserveGatewayOp({
      ...opKey,
      kind: "app.start_thread",
      fingerprint: fingerprintOf([
        project.path,
        params.prompt,
        params.agent,
        params.provider,
        params.model,
        params.mode,
      ]),
    });
    if (reserve === null) {
      throw new GatewayToolError("internal", "Idempotency reserve failed.");
    }
    if (reserve.kind === "conflict") {
      throw new GatewayToolError(
        "idempotency_conflict",
        "This requestId was already used to start a different thread. Use a fresh one, or repeat the original call exactly to get that thread back.",
      );
    }
    if (reserve.kind === "replay") {
      // SAFETY: the replayed payload is canonical JSON this store recorded from
      // a prior GatewayToolResult, so every field is plain data.
      const replayed = reserve.result as GatewayRecord;
      return {
        content: [
          {
            type: "text",
            // The replayed payload's own words: the text is all a model reads,
            // and a retry that does not say WHICH thread leaves it holding none.
            text: `That thread is already open - this requestId started it, so nothing new was opened.${replayWords(replayed, true)}`,
          },
        ],
        structuredContent: replayed,
      };
    }

    // Who the thread answers as, and where it runs. An agent brings its own
    // identity and its own model chain; without one the thread runs where this
    // conversation runs. Neither branch invents a model the install cannot run:
    // planSpawnModel walks the chain against what is actually available.
    let persona: AgentPersona | undefined;
    let agentId: string | undefined;
    let target: ModelCandidate;
    let fallbacks: readonly ModelCandidate[] = [];
    const availability = (await options.availability?.()) ?? [];
    const caller = ctx.model
      ? { provider: ctx.provider, model: ctx.model }
      : { provider: ctx.provider };

    if (params.agent) {
      const agent = resolveTeamAgent(store, project.path, params.agent);
      const requested: AgentModelRef | null =
        params.provider && params.model
          ? { provider: params.provider, model: params.model }
          : null;
      const plan = resolveDelegation({
        agent,
        task: params.prompt,
        availability,
        caller,
        requestedModel: requested,
      });
      if (!plan.ok) {
        throw new GatewayToolError(
          plan.code === "no_identity" ? "invalid_input" : "provider_unavailable",
          plan.reason,
        );
      }
      persona = plan.persona;
      agentId = agent.agentId;
      target = plan.target;
      fallbacks = plan.fallbacks;
    } else {
      const requested = inheritTarget(ctx, params);
      // Walked through the same planner an agent's chain goes through, so a
      // thread is never started on a provider this install cannot reach - the
      // refusal then names what was tried, instead of surfacing later as a
      // session that dies on its first turn.
      const plan = planSpawnModel({
        requested: requested.model
          ? { provider: requested.provider, model: requested.model }
          : null,
        chain: modelChainOf(null, null),
        caller,
        availability,
      });
      target = plan.ok ? plan.target : requested;
      if (plan.ok) fallbacks = plan.fallbacks;
    }

    const threadId = mintThreadId();
    const sessionInput: SessionStartInput = {
      threadId,
      provider: target.provider,
      cwd: project.path,
    };
    if (target.model) sessionInput.model = target.model;
    if (params.mode) sessionInput.mode = params.mode;
    if (persona) sessionInput.agent = persona;
    if (fallbacks.length > 0) sessionInput.fallbacks = fallbacks.map((rung) => ({ ...rung }));

    await runner.startThread(sessionInput);
    // Bound after the row exists and before the first turn dispatches, so the
    // thread's transcript names who answered from its very first block.
    if (agentId) {
      const binding = store.bindThreadAgent(threadId, agentId);
      // The renderer never made this binding, so it has to be told; otherwise
      // the thread reads as a guest under a name rolled from its id.
      if (binding) {
        options.emit?.({
          type: "thread.agent-bound",
          threadId,
          provider: target.provider,
          at: Date.now(),
          source: "kone.store",
          binding,
        });
      }
    }

    // The brief is this agent's, not the user's: the new thread is the user's
    // own, on their board, but its first words came from here.
    const turnInput: SendTurnInput = {
      threadId,
      input: params.prompt,
      sender: agentSenderFor(store, ctx.threadId, "peer", "brief"),
    };
    if (target.model) turnInput.model = target.model;
    if (params.mode) turnInput.mode = params.mode;
    const turn = await runner.sendThreadTurn(
      turnInput,
      params.title ? { title: params.title } : {},
    );

    const summary = `Opened ${params.title ? `**${params.title}**` : "a new thread"} in ${
      project.name
    } on ${target.model ?? target.provider}${persona ? ` as ${persona.name}` : ""}, and sent its first turn.`;
    const payload: GatewayRecord = {
      ok: true,
      threadId,
      turnId: turn.turnId,
      projectPath: project.path,
      projectName: project.name,
      provider: target.provider,
      model: target.model ?? null,
      agent: persona?.name ?? null,
      title: params.title ?? null,
      summary,
    };

    store.setGatewayOpResult({ ...opKey, resultJson: JSON.stringify(payload) });

    return {
      content: [
        {
          type: "text",
          text: `${summary}\nThread id: ${threadId}. It is on the user's board now and keeps running after this turn ends - read it back with app_read_thread.`,
        },
      ],
      structuredContent: payload,
    };
  };

  // -- 4. app_send_to_thread -------------------------------------------------
  const sendHandler = async (
    ctx: GatewayToolContext,
    params: SendAppThreadMessageInput,
  ): Promise<GatewayToolResult> => {
    const runner = options.runner;
    if (!runner) {
      throw new GatewayToolError(
        "provider_unavailable",
        "kone cannot message threads in this session - no dispatcher is running behind the gateway.",
      );
    }
    const { meta, thread } = requireThread(params.threadId);
    if (params.threadId === ctx.threadId) {
      throw new GatewayToolError(
        "invalid_input",
        "That is this conversation. Answer here instead of messaging yourself.",
      );
    }
    const archivedAt = meta?.archivedAt ?? thread?.archivedAt ?? null;
    if (archivedAt !== null) {
      throw new GatewayToolError(
        "capability_denied",
        `Thread "${params.threadId}" is archived. Restore it with app_archive_thread (archived: false) before messaging it.`,
      );
    }

    const live = isLive(params.threadId);
    const urgent = params.urgent ?? params.steer ?? false;
    if (!live && !runner.ensureThreadSession) {
      throw new GatewayToolError(
        "provider_unavailable",
        `Thread "${params.threadId}" has no running session, and this host cannot bring one back.`,
      );
    }

    const turnId = ctx.turnId;
    if (!turnId) {
      throw new GatewayToolError("capability_denied", "Messaging a thread requires an active agent turn.");
    }
    const opKey = { threadId: ctx.threadId, turnId, requestId: params.requestId };
    const reserve = store.reserveGatewayOp({
      ...opKey,
      kind: "app.send_to_thread",
      fingerprint: fingerprintOf([params.threadId, params.message, urgent ? "steer" : "queue"]),
    });
    if (reserve === null) {
      throw new GatewayToolError("internal", "Idempotency reserve failed.");
    }
    if (reserve.kind === "conflict") {
      throw new GatewayToolError(
        "idempotency_conflict",
        "This requestId was already used to send a different message. Use a fresh one, or repeat the original call exactly.",
      );
    }
    if (reserve.kind === "replay") {
      // SAFETY: the replayed payload is canonical JSON this store recorded from
      // a prior GatewayToolResult, so every field is plain data.
      const replayed = reserve.result as GatewayRecord;
      return {
        content: [
          {
            type: "text",
            text: `Already sent - this requestId delivered it, so nothing was sent twice.${replayWords(replayed, false)}`,
          },
        ],
        structuredContent: replayed,
      };
    }

    // A thread nobody has touched since a restart has no session; resume the
    // stored one, so the agent answers with the conversation it already had.
    if (!live) await runner.ensureThreadSession?.(params.threadId, { resume: true });

    const title = meta?.title ?? thread?.title ?? params.threadId;
    // Read before it is sent: what the send reports is what the thread was
    // doing when it went.
    const state = recipientState({
      runtime: options.threadRuntime?.(params.threadId) ?? null,
      unseen: 0,
      oldestUnseenAt: null,
    });
    const posted = options.jobs.postJob({
      to: params.threadId,
      projectPath: meta?.projectPath ?? thread?.projectPath ?? "",
      message: params.message,
      sender: agentSenderFor(store, ctx.threadId, "peer", "note"),
      urgent,
      dedupeKey: `app-send:${ctx.threadId}:${turnId}:${params.requestId}`,
    });
    const receipt = deliveryReceipt({
      name: `"${title}"`,
      state,
      rings: true,
      urgent,
      returned: false,
      now: Date.now(),
    });
    const summary = `Sent to "${title}" (${params.threadId}). ${receipt.text}`;
    const payload: GatewayRecord = {
      ok: true,
      threadId: params.threadId,
      messageId: posted.messageId,
      delivery: receipt.outcome,
      urgent,
      resumed: !live,
      summary,
    };
    store.setGatewayOpResult({ ...opKey, resultJson: JSON.stringify(payload) });
    return {
      content: [
        {
          type: "text",
          text: `${summary} It runs as a turn of its own and shows in that thread as a message from you, not from the user. Read the reply back with app_read_thread.`,
        },
      ],
      structuredContent: payload,
    };
  };

  const stopHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = StopAppThreadInputSchema.parse(rawInput);
    requireThread(input.threadId);
    const wasRunning = await stopWasRunning(input.threadId);
    const summary = wasRunning
      ? `Stopped active session and turn for thread "${input.threadId}".`
      : `Thread "${input.threadId}" was already idle; no active turn was running.`;
    return singleLine(summary, {
      threadId: input.threadId,
      // Constant by design, not by omission: stopping is idempotent, so an
      // idle thread is left with nothing running exactly like a stopped live
      // one. `wasRunning` says whether a session actually existed; clients
      // confirm quiescence off `stopped` alone.
      stopped: true,
      wasRunning,
      summary,
    });
  };

  const archiveHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = ArchiveAppThreadInputSchema.parse(rawInput);
    const targetArchived = input.archived ?? true;
    requireThread(input.threadId);
    const affectedIds = await archiveOp(input.threadId, targetArchived);
    const action = targetArchived ? "Archived" : "Unarchived";
    const summary = `${action} thread "${input.threadId}"${affectedIds.length > 1 ? ` and ${affectedIds.length - 1} child thread(s)` : ""}.`;
    return singleLine(summary, {
      threadId: input.threadId,
      archived: targetArchived,
      affectedThreadIds: affectedIds,
      summary,
    });
  };

  const deleteHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = DeleteAppThreadInputSchema.parse(rawInput);
    if (store.canDeleteThread) {
      const guard = store.canDeleteThread(input.threadId);
      if (!guard.ok) {
        if (guard.reason === "missing") throw notFound(input.threadId);
        throw busyRefusal(input.threadId, "delete");
      }
    } else {
      requireThread(input.threadId);
    }
    await deleteOp(input.threadId);
    const summary = `Permanently deleted thread "${input.threadId}".`;
    return singleLine(summary, {
      threadId: input.threadId,
      deleted: true,
      summary,
    });
  };

  const renameHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = RenameAppThreadInputSchema.parse(rawInput);
    const cleaned = truncateThreadTitle(input.title.trim());
    if (!cleaned) {
      throw new GatewayToolError("invalid_input", "Thread title cannot be empty.");
    }
    const { meta, thread } = requireThread(input.threadId);
    const previousTitle = meta?.title ?? thread?.title ?? null;
    const provider = meta?.provider ?? thread?.provider;
    await renameOp(input.threadId, cleaned, provider);
    const summary = previousTitle
      ? `Renamed thread "${input.threadId}" from "${previousTitle}" to "${cleaned}".`
      : `Renamed thread "${input.threadId}" to "${cleaned}".`;
    return singleLine(summary, {
      threadId: input.threadId,
      title: cleaned,
      previousTitle,
      summary,
    });
  };

  const pinHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = SetThreadPinnedInputSchema.parse(rawInput);
    const { meta } = requireThread(input.threadId);
    store.setPinned?.(input.threadId, input.pinned);
    const verb = input.pinned ? "Pinned" : "Unpinned";
    return singleLine(`${verb} thread "${meta?.title ?? input.threadId}".`, {
      threadId: input.threadId,
      pinned: input.pinned,
    });
  };

  const doneHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = SetThreadDoneInputSchema.parse(rawInput);
    requireThread(input.threadId);
    // Canonical path first: the service owns the done event every surface
    // reconciles from.
    if (options.setThreadDone) options.setThreadDone(input.threadId, input.done);
    else store.setDone?.(input.threadId, input.done);
    const verb = input.done ? "Marked done" : "Reopened";
    return singleLine(`${verb} thread "${input.threadId}".`, {
      threadId: input.threadId,
      done: input.done,
    });
  };

  const unreadHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = MarkThreadUnreadInputSchema.parse(rawInput);
    const { meta } = requireThread(input.threadId);
    // Unread is derived as "last visit before the latest activity"; setting the
    // visit just below that boundary makes it read unread again (the store's
    // monotonic write needs `force` to move backwards).
    const at = (meta?.lastActivityAt ?? Date.now()) - 1;
    store.setVisited?.(input.threadId, at, true);
    return singleLine(`Marked thread "${input.threadId}" unread.`, {
      threadId: input.threadId,
      unread: true,
    });
  };

  const searchHandler = async (
    ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = SearchAppThreadsInputSchema.parse(rawInput);
    if (!store.searchConversations) {
      throw failInternal(ctx.threadId, "search threads", "unsupported");
    }
    const limit = input.limit ?? SEARCH_APP_THREADS_DEFAULT_LIMIT;
    // Fetch candidate pages and widen until the store is exhausted (or a hard
    // cap), THEN scope-filter, collapse and rank. Limiting raw FTS hits first
    // would let a page full of unreadable or assistant hits hide an eligible
    // user match further down the ranking.
    const raw = fetchSearchCandidates(store.searchConversations.bind(store), input.query);
    const callerMeta = store.threadMeta?.(ctx.threadId) ?? null;
    const caller = callerMeta
      ? {
          projectPath: callerMeta.projectPath,
          sourceThreadId: callerMeta.sourceThreadId,
          parentThreadId: callerMeta.parentThreadId,
        }
      : null;
    const assistantCaller = callerMeta?.projectPath === GLOBAL_ASSISTANT_PROJECT_PATH;
    const results = collapseSearchHits(raw)
      .filter((hit) => {
        if (assistantCaller) return true;
        const meta = store.threadMeta?.(hit.threadId) ?? null;
        return canReadThread({
          callerThreadId: ctx.threadId,
          targetThreadId: hit.threadId,
          caller,
          target: meta
            ? { projectPath: meta.projectPath, sourceThreadId: meta.sourceThreadId }
            : null,
        });
      })
      .slice(0, limit)
      .map((hit) => ({
        threadId: hit.threadId,
        title: store.threadMeta?.(hit.threadId)?.title ?? null,
        snippet: hit.snippet,
        entryKind: hit.entryKind,
        at: hit.at,
      }));

    const lines = results.map(
      (r) =>
        `- ${r.threadId} [${r.entryKind}]${r.title ? ` "${r.title}"` : ""}: ${r.snippet.replace(/\s+/g, " ").trim()}`,
    );
    return singleLine(
      results.length === 0
        ? `No conversations matched "${input.query}".`
        : `Found ${results.length} conversation${results.length === 1 ? "" : "s"} matching "${input.query}":\n${lines.join("\n")}`,
      { query: input.query, results },
    );
  };

  const queuedListHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = ListQueuedTurnsInputSchema.parse(rawInput);
    requireThread(input.threadId);
    const rows = options.listQueuedTurns?.(input.threadId) ?? [];
    const lines = rows.map(
      (row, index) => `- #${index + 1} ${row.queueId} [${row.state}] ${row.input}`,
    );
    return singleLine(
      rows.length === 0
        ? `Thread "${input.threadId}" has no queued follow-ups.`
        : `Thread "${input.threadId}" has ${rows.length} queued follow-up${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
      {
        threadId: input.threadId,
        queuedTurns: rows.map((row, index) => ({
          queueId: row.queueId,
          position: index + 1,
          input: row.input,
          state: row.state,
        })),
      },
    );
  };

  const queuedCancelHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = CancelQueuedTurnInputSchema.parse(rawInput);
    requireThread(input.threadId);
    if (!options.cancelQueuedTurn) {
      throw failInternal(input.threadId, "cancel queued follow-up", "unsupported");
    }
    const ok = await options.cancelQueuedTurn(input.threadId, input.queueId);
    if (!ok) {
      throw failInternal(input.threadId, "cancel queued follow-up", "no such waiting row");
    }
    return singleLine(`Cancelled queued row "${input.queueId}".`, {
      threadId: input.threadId,
      queueId: input.queueId,
      ok: true,
    });
  };

  const queuedPromoteHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = PromoteQueuedTurnInputSchema.parse(rawInput);
    requireThread(input.threadId);
    if (!options.promoteQueuedTurn) {
      throw failInternal(input.threadId, "run queued follow-up now", "unsupported");
    }
    const ok = await options.promoteQueuedTurn(input.threadId, input.queueId);
    if (!ok) {
      throw failInternal(input.threadId, "run queued follow-up now", "no such waiting row");
    }
    return singleLine(`Ran queued row "${input.queueId}" now.`, {
      threadId: input.threadId,
      queueId: input.queueId,
      ok: true,
    });
  };

  const queuedEditHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = EditQueuedTurnInputSchema.parse(rawInput);
    requireThread(input.threadId);
    if (!options.editQueuedTurn) {
      throw failInternal(input.threadId, "edit queued follow-up", "unsupported");
    }
    const ok = await options.editQueuedTurn(input.threadId, input.queueId, input.input);
    if (!ok) {
      throw failInternal(input.threadId, "edit queued follow-up", "no such waiting row");
    }
    return singleLine(`Edited queued row "${input.queueId}" in place.`, {
      threadId: input.threadId,
      queueId: input.queueId,
      ok: true,
    });
  };

  const queuedReorderHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const input = ReorderQueuedTurnsInputSchema.parse(rawInput);
    requireThread(input.threadId);
    if (!options.reorderQueuedTurns) {
      throw failInternal(input.threadId, "reorder queued follow-ups", "unsupported");
    }
    const ok = await options.reorderQueuedTurns(input.threadId, input.queueIds);
    if (!ok) {
      throw failInternal(input.threadId, "reorder queued follow-ups", "no waiting rows matched");
    }
    return singleLine(`Reordered ${input.queueIds.length} queued follow-up(s).`, {
      threadId: input.threadId,
      queueIds: input.queueIds,
      ok: true,
    });
  };

  const unlinkPullRequestHandler = async (
    _ctx: GatewayToolContext,
    params: UnlinkThreadPullRequestInput,
  ): Promise<GatewayToolResult> => {
    if (!store.clearThreadPullRequestLink) {
      throw failInternal(params.threadId, "unlink pull request", "unsupported");
    }
    const changed = store.clearThreadPullRequestLink(params.threadId);
    return singleLine(
      changed
        ? `Unlinked the pull request from thread "${params.threadId}".`
        : `Thread "${params.threadId}" had no linked pull request.`,
      { threadId: params.threadId, changed },
    );
  };

  const linkPullRequestHandler = async (
    _ctx: GatewayToolContext,
    params: LinkThreadPullRequestInput,
  ): Promise<GatewayToolResult> => {
    if (!store.setThreadPullRequestLink) {
      throw failInternal(params.threadId, "link pull request", "unsupported");
    }
    const link: ThreadPullRequestLinkInput = {
      repository: params.repository ?? null,
      number: params.number ?? null,
      url: params.url,
      state: params.state ?? null,
      checkedAt: Date.now(),
    };
    if (!store.setThreadPullRequestLink(params.threadId, link)) {
      throw failInternal(params.threadId, "link pull request", "missing");
    }
    return singleLine(`Linked ${params.url} to thread "${params.threadId}".`, {
      threadId: params.threadId,
      pullRequest: {
        repository: link.repository ?? "",
        number: link.number ?? 0,
        url: link.url,
        state: link.state ?? "unknown",
      },
    });
  };

  return [
    {
      name: "app_list_threads",
      description:
        "List the conversations in a project - or across every project the app holds: title, thread id, the agent and model it runs on, its status (working, waiting-for-approval, waiting-for-user-input, idle, failed, interrupted, starting), whether it is unread or done, and when it was last active. The unread / done / archived flags are only present when they are true; status is always present. Pass archived: true to look in the archive instead, which is a separate place from the live list.",
      inputSchema: ListAppThreadsInputSchema,
      jsonSchema: LIST_APP_THREADS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_list_threads`: the conversations in a project (or all of them) - who is on each, what is running, what is unread. Pages with a cursor.",
      promptGuidelines: [
        "Call `app_list_threads` when the user asks what is going on, what they were working on, or what is still running - it sees every project's threads, not just this conversation.",
      ],
      handler: listHandler,
    },
    {
      name: "app_read_thread",
      description:
        "Read what was said in one of the app's threads, newest messages last. Returns the user's prompts and the agent's replies as prose; tool calls and their payloads stay in the thread. Also reports the thread's status (working, waiting-for-approval, waiting-for-user-input, idle, failed, interrupted, starting). Use it to catch up on a conversation before answering about it or continuing it.",
      inputSchema: ReadAppThreadInputSchema,
      jsonSchema: READ_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_read_thread`: read the messages in any of the app's threads.",
      promptGuidelines: [
        "Read a thread before summarising or acting on it - the list only carries titles, and a title is a guess the thread's first turn made.",
      ],
      handler: readHandler,
    },
    {
      name: "app_start_thread",
      description:
        "Open a new conversation in one of the user's projects and set it working on a brief you write. This is a first-class thread on that project's board - the user sees it, can open it, and can keep talking in it long after your turn ends - not a subagent inside this conversation. Write prompt as a complete standing brief: the thread wakes up with no memory of this conversation and cannot ask you anything. Hand it to one of the project's team agents with `agent` to have it run as that agent on that agent's model, or omit it to run where this conversation runs. Pass a stable requestId so a retry returns the thread you already opened instead of opening a second one.",
      inputSchema: StartAppThreadInputSchema,
      jsonSchema: START_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "`app_start_thread`: open a real thread in one of the user's projects and set it working on a brief.",
      promptGuidelines: [
        "A thread you start is the user's thread, on their repo, spending their tokens - open one when they have asked for work to happen, not to explore something you could read yourself.",
        "Nobody is sitting in a thread you open: one that stops for permission stays stopped until the user notices it. Say what you started and where, so they can go and look.",
      ],
      handler: startHandler,
    },
    {
      name: "app_send_to_thread",
      description:
        "Send a message to an existing thread, so its agent carries on with everything that conversation already knows. It runs as a turn of its own: at once on an idle thread, after the running turn on a busy one (or, with urgent: true, inside the running turn), and once the user answers on a thread waiting on the user's approval or answer. A thread with no running session is resumed first. Refused for an archived thread and this conversation itself. Pass a stable requestId so a retry does not send the message twice.",
      inputSchema: SendAppThreadMessageInputSchema,
      jsonSchema: SEND_APP_THREAD_MESSAGE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "`app_send_to_thread`: send a follow-up message into an existing thread, which answers it with the context it already has.",
      promptGuidelines: [
        "When the user wants something added to work a thread is already doing, message that thread with `app_send_to_thread` instead of starting a new one - a new thread starts with none of that context.",
        "The message appears in the thread as a message from you, not from the user, so tell the user what you sent and where.",
      ],
      handler: sendHandler,
    },
    {
      name: "app_stop_thread",
      description:
        "Halt any active turn, cancel queued follow-ups, and tear down the running provider session for a thread. Use when the user asks to stop, abort, or cancel work happening in a conversation.",
      inputSchema: StopAppThreadInputSchema,
      jsonSchema: STOP_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_stop_thread`: halt any active turn and stop the provider session on a thread.",
      promptGuidelines: [
        "Call `app_stop_thread` when the user asks to cancel, abort, or stop work currently running in a conversation.",
      ],
      handler: stopHandler,
    },
    {
      name: "app_archive_thread",
      description:
        "Archive a conversation to put it away from the live list without destroying its history, or restore an archived conversation back to the live list with archived: false.",
      inputSchema: ArchiveAppThreadInputSchema,
      jsonSchema: ARCHIVE_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_archive_thread`: archive or unarchive a conversation in a project.",
      promptGuidelines: [
        "Archiving puts a thread away without destroying its history. To restore it, call `app_archive_thread` with archived: false.",
      ],
      handler: archiveHandler,
    },
    {
      name: "app_delete_thread",
      description:
        "Permanently delete a conversation, its messages, subagents, and attachments from the project. Irreversible. Requires confirm: true.",
      inputSchema: DeleteAppThreadInputSchema,
      jsonSchema: DELETE_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_delete_thread`: permanently delete a conversation and its attachments (confirm: true required).",
      promptGuidelines: [
        "Deleting a thread is permanent and cannot be undone. Confirm with the user before deleting unless explicitly instructed.",
      ],
      handler: deleteHandler,
    },
    {
      name: "app_rename_thread",
      description:
        "Change the title of any conversation in the app. Updates the title displayed on the project board, tabs, and sidebar.",
      inputSchema: RenameAppThreadInputSchema,
      jsonSchema: RENAME_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_rename_thread`: change the title of any conversation in the app.",
      promptGuidelines: [
        "Use `app_rename_thread` to give a conversation a clear, descriptive title that reflects its topic.",
      ],
      handler: renameHandler,
    },
    {
      name: "app_set_thread_pinned",
      description:
        "Pin a conversation to the front of the project board, or unpin it. Pinning is a durable per-thread mark, not a reorder.",
      inputSchema: SetThreadPinnedInputSchema,
      jsonSchema: SET_THREAD_PINNED_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_set_thread_pinned`: pin or unpin a conversation.",
      promptGuidelines: [
        "Pin a thread only when the user asks, or when they call it important to keep in view.",
      ],
      handler: pinHandler,
    },
    {
      name: "app_set_thread_done",
      description:
        "Mark a conversation done (settled) so it stops asking for attention, or clear the mark to reopen it. Done is an attention mark, not an archive: the thread stays in the live list.",
      inputSchema: SetThreadDoneInputSchema,
      jsonSchema: SET_THREAD_DONE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_set_thread_done`: mark a conversation done, or reopen it.",
      promptGuidelines: [
        "Mark a thread done when the user says the work is finished; use app_archive_thread to put it away entirely.",
      ],
      handler: doneHandler,
    },
    {
      name: "app_mark_thread_unread",
      description:
        "Mark a conversation unread, so it shows as needing attention again in the inbox and board.",
      inputSchema: MarkThreadUnreadInputSchema,
      jsonSchema: MARK_THREAD_UNREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_mark_thread_unread`: mark a conversation unread.",
      promptGuidelines: [
        "Mark a thread unread when the user says they still need to look at it.",
      ],
      handler: unreadHandler,
    },
    {
      name: "app_search_threads",
      description:
        "Search across conversations' text and return one best match per conversation, with the user's own messages ranked above the agent's. Only conversations the caller may read are returned (same project, a fork/source relationship, or a reference the user attached).",
      inputSchema: SearchAppThreadsInputSchema,
      jsonSchema: SEARCH_APP_THREADS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_search_threads`: find conversations by what was said in them, one best hit each.",
      promptGuidelines: [
        "Use app_search_threads to find a thread the user is describing by its content, then app_read_thread to read it.",
      ],
      handler: searchHandler,
    },
    {
      name: "app_list_queued_turns",
      description:
        "List a conversation's waiting follow-ups in the order they will run: queue id, position, prompt, and whether each is waiting, being handed to the provider, or held after a failed start. Queued follow-ups are messages the user sent while a turn was running.",
      inputSchema: ListQueuedTurnsInputSchema,
      jsonSchema: ListQueuedTurnsJson,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_list_queued_turns`: the follow-ups waiting on a conversation.",
      promptGuidelines: [
        "Use app_list_queued_turns before editing, reordering, cancelling or running a queued follow-up, so you have the queue ids.",
      ],
      handler: queuedListHandler,
    },
    {
      name: "app_edit_queued_turn",
      description:
        "Edit a waiting follow-up's prompt in place, keeping its position in the queue. Refused for a row already running or settled.",
      inputSchema: EditQueuedTurnInputSchema,
      jsonSchema: EditQueuedTurnJson,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_edit_queued_turn`: change a waiting follow-up's text without moving it.",
      promptGuidelines: [
        "Edit a queued follow-up only when the user asks; the change is visible to them immediately.",
      ],
      handler: queuedEditHandler,
    },
    {
      name: "app_reorder_queued_turns",
      description:
        "Set the order a conversation's waiting follow-ups will run in, by listing their queue ids in the desired order.",
      inputSchema: ReorderQueuedTurnsInputSchema,
      jsonSchema: ReorderQueuedTurnsJson,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_reorder_queued_turns`: change the order queued follow-ups will run in.",
      promptGuidelines: ["Reorder only when the user asks for a different order."],
      handler: queuedReorderHandler,
    },
    {
      name: "app_cancel_queued_turn",
      description: "Cancel one waiting follow-up so it never runs.",
      inputSchema: CancelQueuedTurnInputSchema,
      jsonSchema: CancelQueuedTurnJson,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_cancel_queued_turn`: drop a waiting follow-up.",
      promptGuidelines: ["Cancel only when the user asks to drop that message."],
      handler: queuedCancelHandler,
    },
    {
      name: "app_promote_queued_turn",
      description:
        "Run one waiting follow-up now, through the same path as the composer's 'send now': steered into the running turn, or started when the thread is idle.",
      inputSchema: PromoteQueuedTurnInputSchema,
      jsonSchema: PromoteQueuedTurnJson,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_promote_queued_turn`: run a waiting follow-up now.",
      promptGuidelines: ["Promote only when the user asks to send that queued message now."],
      handler: queuedPromoteHandler,
    },
    {
      name: "app_link_thread_pr",
      description:
        "Link a pull request to a conversation, so the app knows which PR the thread delivered and can settle the thread when that PR merges. Replaces any existing link. Pass the PR URL and, when known, its repository (owner/repo) and number.",
      inputSchema: LinkThreadPullRequestInputSchema,
      jsonSchema: LINK_THREAD_PULL_REQUEST_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_link_thread_pr`: link a pull request to a conversation so it can settle on merge.",
      promptGuidelines: [
        "Link a PR when the user names one for a thread, or when a thread's work corresponds to a PR they opened. Do not invent a PR number or URL.",
      ],
      handler: linkPullRequestHandler,
    },
    {
      name: "app_unlink_thread_pr",
      description:
        "Remove the pull request linked to a conversation. The thread then no longer settles on that PR's merge.",
      inputSchema: UnlinkThreadPullRequestInputSchema,
      jsonSchema: UNLINK_THREAD_PULL_REQUEST_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_unlink_thread_pr`: remove the pull request linked to a conversation.",
      promptGuidelines: ["Unlink only when the user asks, or the link is for the wrong PR."],
      handler: unlinkPullRequestHandler,
    },
  ];
}

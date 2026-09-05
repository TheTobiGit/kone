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
//   Unlike the worker tools' `kone_read_response`, these are NOT scoped to a
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

import { truncateThreadTitle } from "../../threadTitle.js";
import {
  modelChainOf,
  planSpawnModel,
  type ModelCandidate,
  type ProviderAvailability,
} from "../../agentModel.js";
import { resolveDelegation } from "../../delegate.js";
import { ago, compact, decodeCursor, encodeCursor, squash } from "../helpers.js";
import type {
  AgentPersona,
  EmitEvent,
  RuntimeEvent,
  Session,
  SendTurnInput,
  SessionStartInput,
  StoredBlock,
  StoredThread,
  StoredThreadMeta,
  TurnStartResult,
} from "../../types.js";
import type { AgentModelRef, AgentRecord } from "../../ConversationStore.js";
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
  StartAppThreadInputSchema,
  START_APP_THREAD_JSON_SCHEMA,
  StopAppThreadInputSchema,
  STOP_APP_THREAD_JSON_SCHEMA,
  THREAD_LIST_DEFAULT_LIMIT,
  type GatewayRecord,
  type ListAppThreadsInput,
  type ReadAppThreadInput,
  type StartAppThreadInput,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";
import { requireProjects, resolveProject, type ProjectRosterEntry } from "./appProjects.js";

/** The store slice these tools read and write through. */
export interface AppThreadsStore {
  listThreads(projectPath: string, options?: { archived?: boolean }): StoredThreadMeta[];
  loadThread(threadId: string): StoredThread | null;
  threadMeta?(threadId: string): StoredThreadMeta | null;
  /** The project's team, in roster order — the agents a thread here can be
   *  handed to. A thread is handed to a team member or to nobody: an agent the
   *  user has not put on the project is not on it. */
  listProjectAgents(projectPath: string): AgentRecord[];
  /** The agent a thread runs as, when it has one — what makes a list entry say
   *  whose thread it is. */
  getThreadAgent(threadId: string): { agentId: string | null } | null;
  getAgent(agentId: string): AgentRecord | null;
  /** Bind the new thread to the agent it was handed to, before its first turn
   *  dispatches, so its transcript carries that identity from the start. */
  bindThreadAgent(threadId: string, agentId: string | null): void;
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
  cancelQueuedTurnsForThread?(threadId: string): string[];
}

/** The thread-driving half of the dispatcher — the same two calls the renderer's
 *  IPC handlers forward to. Named structurally so a test can start a thread
 *  without a provider process. */
export interface AppThreadsRunner {
  startThread(input: SessionStartInput): Promise<Session>;
  sendThreadTurn(input: SendTurnInput, options?: { title?: string }): Promise<TurnStartResult>;
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
export interface AppThreadsToolOptions {
  store: AppThreadsStore;
  emit?: EmitEvent;
  /** The projects the renderer last reported — what a project name resolves
   *  against, and what an unscoped list walks. */
  readProjects?: () => readonly ProjectRosterEntry[] | null;
  /** Whether a thread has a live provider session, so a list can say which
   *  threads are running rather than only when they last spoke. */
  isThreadLive?: (threadId: string) => boolean;
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
}

/** Tags this module's cursors, so one handed to another tool is refused rather
 *  than read as a boundary in a list it does not describe. */
const THREAD_CURSOR = "threads";

const TRUNCATION_MARKER = "\n...[truncated]";

function truncateTo(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return `${text.slice(0, budget).trimEnd()}${TRUNCATION_MARKER}`;
}

/** A block's model-readable narrative: the prompt for user blocks, the ordered
 *  assistant text for assistant blocks. Tool calls stay out — the thread's raw
 *  tool traffic belongs to the thread, and a reader asking what was said is not
 *  asking for it. */
function blockText(block: StoredBlock): string {
  if (block.role === "user") return block.text;
  return block.items
    .filter((item) => item.kind === "assistant_text")
    .map((item) => item.text)
    .join("\n");
}

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

/** An epoch stamp as a date a model can reason about, or null. */
function iso(at: number | null | undefined): string | null {
  return at === null || at === undefined ? null : new Date(at).toISOString();
}

/** One thread as a list entry. */
interface ThreadReading {
  meta: StoredThreadMeta;
  project: ProjectRosterEntry | null;
  agentName: string | null;
  running: boolean;
}

/**
 * One thread as a row.
 *
 * `withProject` names which project the thread is on, and is only set on a list
 * that spans several — a list scoped to one project says so once at the top
 * instead of repeating an absolute path on every row. It is the project's NAME
 * rather than its path because every tool here takes a project by name, so the
 * row already reads back as a valid argument.
 *
 * The flags are omitted when false rather than sent as `false`. On a list of
 * twenty that is most of the payload, and "not running, not unread, not done,
 * not archived" is the ordinary case a reader can assume.
 */
function threadPayload(reading: ThreadReading, withProject: boolean): GatewayRecord {
  const meta = reading.meta;
  const lastActivityAt = meta.lastActivityAt ?? meta.updatedAt;
  // Unread and done are both comparisons against the last activity rather than
  // flags, which is why they are computed here instead of read: a thread the
  // agent has spoken in since you marked it done is asking again.
  const unread = (meta.lastVisitedAt ?? 0) < lastActivityAt;
  const done = meta.doneAt !== null && (meta.doneAt ?? 0) >= lastActivityAt;
  const row: GatewayRecord = {
    threadId: meta.threadId,
    title: meta.title ?? null,
    model: meta.model ?? meta.provider,
    agent: reading.agentName,
    branch: meta.branch ?? null,
    lastActivityAt: iso(lastActivityAt),
  };
  if (withProject) row.project = reading.project?.name ?? meta.projectPath;
  if (reading.running) row.running = true;
  if (unread) row.unread = true;
  if (done) row.done = true;
  if (meta.archivedAt !== null) row.archived = true;
  return compact(row);
}

/** One thread as a single prose line. One, not two: on a twenty-row answer the
 *  second line was costing more than everything it carried. */
function threadLine(reading: ThreadReading, withProject: boolean): string {
  const meta = reading.meta;
  const marks = [
    meta.threadId,
    reading.agentName,
    meta.model ?? meta.provider,
    withProject ? (reading.project?.name ?? meta.projectPath) : null,
    ago(meta.lastActivityAt ?? meta.updatedAt),
    reading.running ? "running" : null,
  ].filter((mark): mark is string => mark !== null);
  return `- ${meta.title ?? "(untitled)"} — ${marks.join(" · ")}`;
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

  const readingFor = (
    meta: StoredThreadMeta,
    projects: Map<string, ProjectRosterEntry>,
  ): ThreadReading => ({
    meta,
    project: projects.get(meta.projectPath) ?? null,
    agentName: agentNameFor(store, meta.threadId),
    running: isLive(meta.threadId),
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
    const listed = page.slice(0, limit).map((meta) => readingFor(meta, byPath));
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
    const lines = [head, ...listed.map((reading) => threadLine(reading, !scoped))];
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
    _ctx: GatewayToolContext,
    params: ReadAppThreadInput,
  ): Promise<GatewayToolResult> => {
    const thread = store.loadThread(params.threadId);
    if (!thread) {
      throw new GatewayToolError("not_found", `kone holds no thread "${params.threadId}".`);
    }
    const limit = params.limit ?? 20;
    const maxTextChars = params.maxTextChars ?? 1500;
    const messages = thread.blocks.slice(-limit).map((block) => ({
      role: block.role,
      at: iso(block.at),
      text: truncateTo(blockText(block), maxTextChars),
    }));

    const title = thread.title ?? params.threadId;
    const heading =
      messages.length === 0
        ? `"${title}" has no messages yet.`
        : `${messages.length} message${messages.length === 1 ? "" : "s"} from "${title}", oldest first:`;

    return {
      content: [
        {
          type: "text",
          text: [
            heading,
            ...messages.map(
              (message) =>
                `[${message.role}] ${message.text.trim() || "(no text - tool calls only)"}`,
            ),
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
          running: isLive(thread.threadId),
        }),
        messages,
        totalMessages: thread.blocks.length,
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
            text: "That thread is already open - this requestId started it, so nothing new was opened.",
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
    if (agentId) store.bindThreadAgent(threadId, agentId);

    const turnInput: SendTurnInput = { threadId, input: params.prompt };
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

  return [
    {
      name: "app_list_threads",
      description:
        "List the conversations in a project - or across every project the app holds: title, thread id, the agent and model it runs on, whether it is running right now, whether it is unread or done, and when it was last active. The running / unread / done / archived flags are only present when they are true. Pass archived: true to look in the archive instead, which is a separate place from the live list.",
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
        "Read what was said in one of the app's threads, newest messages last. Returns the user's prompts and the agent's replies as prose; tool calls and their payloads stay in the thread. Use it to catch up on a conversation before answering about it or continuing it.",
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
        "Permanently delete a conversation, its messages, subagents, and attachments from the project. Irreversible.",
      inputSchema: DeleteAppThreadInputSchema,
      jsonSchema: DELETE_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_delete_thread`: permanently delete a conversation and its attachments.",
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
  ];
}

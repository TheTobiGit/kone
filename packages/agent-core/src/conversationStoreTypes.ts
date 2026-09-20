import { z } from "zod";
import type { JsonObject } from "@kone/agent-core/lib-jsonValue.js";
import { decodeChunkArray, decodeStoredText } from "./store/itemTextChunks.js";
import type {
  BlockSource,
  ChatAttachment,
  InteractionMode,
  JobStatus,
  ProviderKind,
  RelationshipToParent,
  RuntimeItem,
  StoredBlock,
  StoredThreadMeta,
  SubagentRun,
} from "./types.js";
import { threadEnvMode } from "./threadWorkspace.js";
import type { ThreadEnvMode, ThreadWorkspace } from "./threadWorkspace.js";

/** The value `done_at` carries when you explicitly un-marked a thread, as
 *  opposed to never having marked it (NULL). Epoch zero is not a time any
 *  thread was marked at, so it can stand for "you said this is not done"
 *  without a second column — the distinction readers need in order to let age
 *  settle an untouched thread while leaving a deliberate un-mark alone. */
export const DONE_CLEARED = 0;

/** Virtual project path assigned to global assistant threads that are not
 *  scoped to any repository on disk. */
export const GLOBAL_ASSISTANT_PROJECT_PATH = "__kone_assistant__";

/** One project's row of the studio — its panes, in left-to-right order, and
 *  which of them it was left focused on. `panes` stays `unknown[]` because the
 *  store holds no opinion about a pane's shape: the renderer owns the canonical
 *  type and the hard validation, and that is what lets a pane field be added
 *  without a migration here. */
export type StoredStudioRow = {
  projectPath: string;
  panes: unknown[];
  focusedId: string | null;
};

/** The studio document as it lives in the store — one plane, one row per
 *  project that has work on it. Read and written whole, like the per-project
 *  board blob it replaced, so the desktop package stays free of a web-package
 *  dependency. `rows` order IS the plane's vertical order. */
export type StoredStudioLayout = {
  version: 2;
  rows: StoredStudioRow[];
  focusedRow: string | null;
};

export type ScratchpadRecord = {
  id: string;
  projectPath: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  sortIndex: number;
  /** Optimistic-concurrency counter, bumped on every write (v15). The web
   *  editor sends its last-known value with each save; gateway agent writes
   *  guard on it so user and agent edits never silently clobber each other. */
  revision: number;
};

export type ScratchpadRow = {
  id: string;
  project_path: string;
  title: string | null;
  body: string;
  created_at: number;
  updated_at: number;
  sort_index: number;
  revision: number;
};

export function rowToScratchpad(row: ScratchpadRow): ScratchpadRecord {
  return {
    id: row.id,
    projectPath: row.project_path,
    title: row.title ?? "",
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sortIndex: row.sort_index,
    revision: row.revision,
  };
}

// ── row → domain mapping ──────────────────────────────────────────────────────

export type StoredAssistantState = "running" | "completed" | "failed" | "interrupted";

export type ThreadRow = {
  thread_id: string;
  project_path: string;
  provider: string;
  model: string | null;
  conversation_id: string | null;
  created_at: number;
  last_activity_at: number;
  branch: string | null;
  added: number | null;
  removed: number | null;
  tokens: number | null;
  context_used: number | null;
  context_window: number | null;
  compacts_auto: number | null;
  archived_at: number | null;
  title: string | null;
  base_tree: string | null;
  source_thread_id: string | null;
  parent_thread_id: string | null;
  relationship_to_parent: RelationshipToParent | null;
  fork_context_json: string | null;
  request_id: string | null;
  pinned_at: number | null;
  model_selection_json: string | null;
  resume_session_at: string | null;
  done_at: number | null;
  last_visited_at: number | null;
  /** Declared intent: "local" / "worktree". NULL on every row written before
   *  worktrees existed, which reads as local. */
  env_mode: string | null;
  /** The materialized worktree directory, NULL until `git worktree add` has
   *  actually succeeded. */
  worktree_path: string | null;
  /** The branch a pending worktree was asked for. NULL on rows written before
   *  the request was persisted, and cleared once the worktree materializes. */
  requested_branch?: string | null;
  snippet?: string | null;
};

export type BlockRow = {
  /** Arrival order within the thread — the row id. Ordering key for the
   *  windowed walk; never a cursor's payload (see loadThreadPage). */
  seq: number;
  block_id: string;
  thread_id: string;
  role: "user" | "assistant";
  turn_id: string | null;
  text: string | null;
  state: string | null;
  error: string | null;
  at: number;
  ended_at: number | null;
  attachments_json: string | null;
  source: BlockSource;
};

/** An attachment's registry row — its metadata plus where the bytes live. */
export type StoredAttachment = ChatAttachment & {
  threadId: string;
  /** Path to the file relative to the attachments dir. */
  relPath: string;
  createdAt?: number;
};

export type AttachmentRow = {
  attachment_id: string;
  thread_id: string;
  type: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  rel_path: string;
  created_at: number;
};

export function rowToAttachment(row: AttachmentRow): StoredAttachment {
  return {
    id: row.attachment_id,
    threadId: row.thread_id,
    type: row.type === "image" ? "image" : "file",
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    relPath: row.rel_path,
    createdAt: row.created_at,
  };
}

/** Parse a user block's denormalized attachment metadata, tolerating bad JSON
 *  (an older/corrupt row just renders without chips). */
export function parseAttachments(json: string | null): ChatAttachment[] | undefined {
  if (!json) return undefined;
  try {
    // SAFETY: the column text came from this app's own serializer.
    const parsed = JSON.parse(json) as unknown;
    // SAFETY: attachments were written by serializeAttachments; a deviant old
    // row degrades to chips-less rendering rather than being trusted blindly.
    return Array.isArray(parsed) ? (parsed as ChatAttachment[]) : undefined;
  } catch {
    return undefined;
  }
}

// ── durable turn queue (v20) ─────────────────────────────────────────────────

/** How a queued follow-up runs when the live turn settles: 'queue' joins the
 *  FIFO line, 'steer' jumps it (most recent steer first). */
export type QueuedTurnDispatchMode = "queue" | "steer";

/** Lifecycle of a queued turn: 'queued' → 'promoting' (claimed) → 'promoted'
 *  (ran), 'promoting' → 'queued' (released after a failed drain), and either
 *  active state → 'cancelled' (stop/delete). Only the active states are
 *  pending; promoted/cancelled rows are inert history. */
export type QueuedTurnState = "queued" | "promoting" | "promoted" | "cancelled";

/** The enqueue payload the service layer hands the store. `userBlockId` is the
 *  journaled user-prompt block UUID (recordUserBlock mints it) — the replay
 *  idempotency key: the same prompt re-delivered by a retrying caller is a
 *  no-op, not a duplicate. The nullable knobs are replayed onto the promoted
 *  send exactly as the user picked them. */
export type QueuedTurnEnqueueInput = {
  /** kone-minted UUID (randomUUID). */
  queueId: string;
  threadId: string;
  userBlockId: string;
  dispatchMode?: QueuedTurnDispatchMode;
  /** The final prompt text (already merged with any prior prompt edits). */
  input: string;
  /** File/image metadata (bytes live on disk; JSON-serialized on the row). */
  attachments?: ChatAttachment[];
  /** Enqueue timestamp; defaults to now (callers pass it for ordering tests). */
  at?: number;
  model?: string;
  mode?: string;
  effort?: string;
  serviceTier?: string;
  contextWindow?: string;
};

/** A queued turn as read back from the store — the shape the service layer
 *  promotes (claim returns it) and the UI lists. */
export type QueuedTurnRow = {
  queueId: string;
  threadId: string;
  userBlockId: string;
  dispatchMode: QueuedTurnDispatchMode;
  state: QueuedTurnState;
  input: string;
  attachments?: ChatAttachment[];
  model?: string;
  mode?: string;
  effort?: string;
  serviceTier?: string;
  contextWindow?: string;
  /** Times this turn was claimed; survives release→reclaim (the retry ledger). */
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  promotedAt?: number;
  /** Explicit queue position from the last reorder (0-based). Absent means
   *  never reordered — the row drains in the default steer-first then FIFO
   *  order. A set key wins over dispatch mode and creation time. */
  sortKey?: number;
};

export type QueuedTurnDbRow = {
  queue_id: string;
  thread_id: string;
  user_block_id: string;
  dispatch_mode: QueuedTurnDispatchMode;
  state: QueuedTurnState;
  input: string;
  attachments_json: string | null;
  model: string | null;
  mode: string | null;
  effort: string | null;
  service_tier: string | null;
  context_window: string | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
  promoted_at: number | null;
  sort_key: number | null;
};

export function rowToQueuedTurn(row: QueuedTurnDbRow): QueuedTurnRow {
  const attachments = parseAttachments(row.attachments_json);
  const queued: QueuedTurnRow = {
    queueId: row.queue_id,
    threadId: row.thread_id,
    userBlockId: row.user_block_id,
    dispatchMode: row.dispatch_mode,
    state: row.state,
    input: row.input,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (attachments?.length) queued.attachments = attachments;
  if (row.model) queued.model = row.model;
  if (row.mode) queued.mode = row.mode;
  if (row.effort) queued.effort = row.effort;
  if (row.service_tier) queued.serviceTier = row.service_tier;
  if (row.context_window) queued.contextWindow = row.context_window;
  if (row.promoted_at !== null) queued.promotedAt = row.promoted_at;
  if (row.sort_key !== null && row.sort_key !== undefined) queued.sortKey = row.sort_key;
  return queued;
}

// ── pre-turn repository snapshots (v6) ───────────────────────────────────────

/** One turn's pre-turn snapshot: the checkpoint ref holding the tree as it
 *  was before the turn ran, so the turn can be reverted. */
export type TurnCheckpointRecord = {
  threadId: string;
  turnId: string;
  checkpointId: string;
  ref: string;
  createdAt: number;
};

export type TurnCheckpointDbRow = {
  thread_id: string;
  turn_id: string;
  checkpoint_id: string;
  ref: string;
  created_at: number;
};

export function rowToTurnCheckpoint(row: TurnCheckpointDbRow): TurnCheckpointRecord {
  return {
    threadId: row.thread_id,
    turnId: row.turn_id,
    checkpointId: row.checkpoint_id,
    ref: row.ref,
    createdAt: row.created_at,
  };
}

/** The store surface the turn-checkpoint paths drive: thread placement reads
 *  plus the checkpoint row methods. The service is typed against this narrow
 *  contract so tests can inject an in-memory fake without opening a database,
 *  while production passes the full store. */
export type CheckpointStore = {
  threadProjectPath(threadId: string): string | null;
  threadWorkspace(threadId: string): ThreadWorkspace | null;
  recordTurnCheckpoint(input: {
    threadId: string;
    turnId: string;
    checkpointId: string;
    ref: string;
    createdAt?: number;
  }): boolean;
  getTurnCheckpoint(threadId: string, turnId: string): TurnCheckpointRecord | null;
  listTurnCheckpoints(threadId: string): TurnCheckpointRecord[];
  pruneTurnCheckpoints(threadId: string, keep: number): TurnCheckpointRecord[];
};

export type ItemRow = {
  item_id: string;
  turn_id: string;
  kind: string;
  status: string;
  text: string;
  /** Encoded fallback for the base text when the raw column cannot round-trip
   *  it (embedded NUL, unpaired surrogate) — null in the common case. */
  text_json: string | null;
  /** Pending streaming chunks, present only when the row was read with the
   *  chunk-array expression (see itemChunkArraySql): a JSON array of the
   *  JSON-encoded deltas in sequence order, '[]' when settled. */
  chunk_text?: string | null;
  name: string | null;
  detail: string | null;
  tasks_json: string | null;
  subagent_tool_use_id: string | null;
};

export type SubagentRow = {
  tool_use_id: string;
  turn_id: string;
  task_id: string | null;
  parent_item_id: string | null;
  agent_type: string | null;
  description: string | null;
  prompt: string | null;
  model: string | null;
  effort: string | null;
  background: number | null;
  status: string;
  summary: string | null;
  last_tool_name: string | null;
  tokens: number | null;
  tool_uses: number | null;
  started_at: number;
  ended_at: number | null;
};

/** The item and subagent rows of a thread's turns, fetched together. */
export type TurnPartRows = {
  itemRows: ItemRow[];
  subagentRows: SubagentRow[];
};

/** A thread's elapsed-time readout: when its turns started and ended, how many
 *  are still running, and how the newest assistant block settled. */
export type TurnSpan = {
  startedAt: number;
  endedAt: number | null;
  runningTurns: number;
  lastState: "running" | "interrupted" | "failed" | "completed" | null;
  /** The NEWEST assistant block's `error`, when it has one — carried up so
   *  the boot-fallback projection can surface the reason a child failed
   *  (e.g. the undispatched-spawn seal), not just the bare status. */
  lastError?: string;
};

export function cleanSnippet(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const cleaned = firstLine.replace(/^[#*`\-\s]+/, "").trim();
  return cleaned.slice(0, 160) || undefined;
}

export function rowToMeta(row: ThreadRow): StoredThreadMeta {
  const selection = parseJsonObject<{
    effort?: string;
    serviceTier?: string;
    contextWindow?: string;
    mode?: InteractionMode;
  }>(row.model_selection_json);
  const forkContext = parseJsonObject<StoredThreadMeta["forkContext"]>(row.fork_context_json);
  const isPinned = row.pinned_at !== null && row.pinned_at > 0;
  const meta: StoredThreadMeta = {
    threadId: row.thread_id,
    projectPath: row.project_path,
    // SAFETY: the provider column is only ever written from ProviderKind values.
    provider: row.provider as ProviderKind,
    model: row.model ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.last_activity_at,
    branch: row.branch ?? null,
    /** Declared intent and materialized place. Read through the threadWorkspace
     *  resolver rather than separately — the pending gap between them is a
     *  state of its own. */
    envMode: threadEnvMode(row.env_mode),
    worktreePath: row.worktree_path ?? null,
    requestedBranch: row.requested_branch?.trim() ? row.requested_branch : null,
    added: row.added ?? undefined,
    removed: row.removed ?? undefined,
    tokens: row.tokens ?? undefined,
    contextUsed: row.context_used ?? undefined,
    contextWindow: row.context_window ?? undefined,
    compactsAutomatically:
      row.compacts_auto === null || row.compacts_auto === undefined ? undefined : row.compacts_auto === 1,
    title: row.title ?? undefined,
    /** Pins live in the DB as pinned_at (v1 baseline), or null when unpinned. */
    isPinned,
    pinnedAt: row.pinned_at ?? null,
    archivedAt: row.archived_at ?? null,
    /** Recency ordering key: last conversation activity. */
    lastActivityAt: row.last_activity_at,
    sourceThreadId: row.source_thread_id ?? undefined,
    parentThreadId: row.parent_thread_id ?? undefined,
    relationshipToParent: row.relationship_to_parent ?? null,
    resumeSessionAt: row.resume_session_at ?? undefined,
    /** When you marked the thread done (v29), or null. Compared against
     *  `lastActivityAt` rather than read alone: a thread the agent has spoken
     *  in since is asking again, whatever this says. */
    doneAt: row.done_at ?? null,
    /** When you last had this thread in front of you (v30), or null for a row
     *  written before the column existed. Compared against `lastActivityAt`:
     *  the agent having spoken since is what makes a thread unread. */
    lastVisitedAt: row.last_visited_at ?? null,
  };
  if (selection) meta.selection = selection;
  if (forkContext) meta.forkContext = forkContext;
  if (row.parent_thread_id || row.relationship_to_parent) {
    meta.lineage = {
      parentThreadId: row.parent_thread_id,
      relationshipToParent: row.relationship_to_parent,
      rootThreadId: row.parent_thread_id ?? row.thread_id,
    };
  }
  if (row.snippet) {
    const s = cleanSnippet(row.snippet);
    if (s) meta.snippet = s;
  }
  return meta;
}

/** Parse a JSON blob column, tolerating bad/absent JSON (a corrupt row reads
 *  as absent — persistence is best-effort). */
export function parseJsonObject<T>(json: string | null): T | undefined {
  if (!json) return undefined;
  try {
    // SAFETY: the column text came from this app's own serializer.
    const parsed = JSON.parse(json) as unknown;
    // SAFETY: callers name the T this column was serialized as; the object
    // check here is the gate, field-level trust lives at the read sites.
    return parsed && parsed instanceof Object && !Array.isArray(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

export function rowToItem(row: ItemRow): RuntimeItem {
  let tasks: RuntimeItem["tasks"];
  if (row.tasks_json) {
    try {
      // SAFETY: the column text came from this app's own item writer.
      const parsed = JSON.parse(row.tasks_json) as unknown;
      if (Array.isArray(parsed)) {
        // SAFETY: tasks_json was serialized from RuntimeItem["tasks"]; anything
        // else reads as no task list.
        tasks = parsed as RuntimeItem["tasks"];
      }
    } catch {
      tasks = undefined;
    }
  }
  // SAFETY: kind/status columns are written only from the matching unions.
  const item: RuntimeItem = {
    itemId: row.item_id,
    kind: row.kind as RuntimeItem["kind"],
    status: row.status as RuntimeItem["status"],
    // The full text is the settled base (preferring the encoded fallback
    // when the raw column cannot round-trip it) plus the pending streaming
    // chunks, which the read query aggregated in sequence order — '[]' when
    // the row was read without the chunk expression or the item is settled,
    // so every caller sees the same bytes the writer streamed.
    text: decodeStoredText(row.text, row.text_json) + decodeChunkArray(row.chunk_text ?? null),
    name: row.name ?? undefined,
    detail: row.detail ?? undefined,
  };
  if (tasks?.length) item.tasks = tasks;
  return item;
}

export function rowToSubagent(row: SubagentRow): SubagentRun {
  return {
    toolUseId: row.tool_use_id,
    taskId: row.task_id ?? undefined,
    parentItemId: row.parent_item_id ?? undefined,
    agentType: row.agent_type ?? undefined,
    description: row.description ?? undefined,
    prompt: row.prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    background: row.background === null ? undefined : row.background === 1,
    // SAFETY: the status column is written only from SubagentRun["status"].
    status: row.status as SubagentRun["status"],
    summary: row.summary ?? undefined,
    lastToolName: row.last_tool_name ?? undefined,
    tokens: row.tokens ?? undefined,
    toolUses: row.tool_uses ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    items: [],
  };
}

/** Rebuild the nested runs first: each run is a snapshot plus the items its
 *  child emitted, keyed per turn by the spawning tool-use id. */
export function assembleBlocks(
  blockRows: BlockRow[],
  itemRows: ItemRow[],
  subagentRows: SubagentRow[],
): StoredBlock[] {
  const runsByTurn = new Map<string, Map<string, SubagentRun>>();
  for (const r of subagentRows) {
    const perTurn = runsByTurn.get(r.turn_id) ?? new Map<string, SubagentRun>();
    perTurn.set(r.tool_use_id, rowToSubagent(r));
    runsByTurn.set(r.turn_id, perTurn);
  }

  // Group items by turn once, then attach — avoids a query per assistant
  // block. Items tagged with a run's tool-use id go into that run instead of
  // the turn body, and the run is hung off its parent tool_call item below.
  const itemsByTurn = new Map<string, RuntimeItem[]>();
  const itemsById = new Map<string, RuntimeItem>();
  for (const r of itemRows) {
    const item = rowToItem(r);
    const run = r.subagent_tool_use_id
      ? runsByTurn.get(r.turn_id)?.get(r.subagent_tool_use_id)
      : undefined;
    if (run) {
      run.items.push(item);
      continue;
    }
    itemsById.set(`${r.turn_id}\u0000${r.item_id}`, item);
    const list = itemsByTurn.get(r.turn_id) ?? [];
    list.push(item);
    itemsByTurn.set(r.turn_id, list);
  }

  for (const [turnId, perTurn] of runsByTurn) {
    for (const run of perTurn.values()) {
      if (!run.parentItemId) continue;
      const parent = itemsById.get(`${turnId}\u0000${run.parentItemId}`);
      if (parent) parent.subagent = run;
    }
  }

  return blockRows.map((b) => {
    if (b.role === "user") {
      const block: StoredBlock = {
        id: b.block_id,
        role: "user",
        text: b.text ?? "",
        at: b.at,
      };
      const attachments = parseAttachments(b.attachments_json);
      if (attachments?.length) block.attachments = attachments;
      if (b.source === "fork-import") block.source = "fork-import";
      return block;
    }
    const block: StoredBlock = {
      id: b.block_id,
      role: "assistant",
      turnId: b.turn_id ?? b.block_id,
      items: itemsByTurn.get(b.turn_id ?? "") ?? [],
      // SAFETY: state column is written only from StoredAssistantState.
      state: (b.state as StoredAssistantState | null) ?? "completed",
      error: b.error ?? undefined,
      at: b.at,
      endedAt: b.ended_at ?? undefined,
    };
    if (b.source === "fork-import") block.source = "fork-import";
    return block;
  });
}

// ── full-text conversation search ───────────────────────────────────────────
// One hit of `searchConversations`: which thread matched, what kind of entry
// it was, where the renderer jumps to show it, and the excerpt + score that
// ordered it. `entryKind` is 'block' for a user prompt and 'item' for a turn
// item (assistant text, reasoning, plan, tool call).

/** Which transcript row a search hit points at. */
export type ConversationSearchEntryKind = "block" | "item";

/** Options for `searchConversations`. Omit `threadId` to search every thread;
 *  set it to scope the query to one. `limit` bounds the hits (default 20,
 *  capped at 100). */
export type ConversationSearchOptions = {
  threadId?: string;
  limit?: number;
};

/** One ranked search hit. `blockId` is the block itself for prompt hits and
 *  the assistant block carrying the turn for item hits (null when the turn
 *  has no block yet); `itemId` is set only on item hits. `snippet` is an
 *  FTS5 excerpt of the matched text with `<mark>` around each matched span;
 *  `rank` is the FTS5 bm25 score, best (most negative) first. */
export type ConversationSearchHit = {
  threadId: string;
  entryKind: ConversationSearchEntryKind;
  blockId: string | null;
  turnId: string | null;
  itemId: string | null;
  at: number;
  snippet: string;
  rank: number;
};

// ── windowed thread reads (user-anchored keyset cursor) ───────────────────────
// kone's block model: blocks are the turn analog. The walk is ordered by `seq`
// (arrival order — the only order that keeps a reply behind its own prompt),
// while the cursor travels as the content-derived pair (`at`, `block_id`),
// deliberately NOT that seq, so it survives a renumbering rewrite; the
// boundary's seq is resolved from its block_id on each read (see
// loadThreadPage).

/** User blocks (user prompts) per page — each page's window ends at the
 *  limit-th newest prompt. */
export const PAGE_DEFAULT_USER_BLOCKS = 10;
/** Ceiling multiplier over the user-block limit that bounds pathological
 *  fan-out (one prompt answered by dozens of turns) before the LIMIT applies
 *  — the raw fanout cap. */
export const PAGE_RAW_FANOUT = 8;

/** Opaque, exclusive cursor for windowed thread reads. Encodes the thread id
 *  and the keyset boundary of an already-delivered page: the boundary block's
 *  anchor timestamp (`at`) and block id. Passing it back requests the adjacent
 *  disjoint slice of strictly older blocks under (at, block_id) ordering. */
export type ThreadPageCursor = {
  threadId: string;
  /** The boundary block's `at` — the user-anchored timestamp. */
  beforeAnchorAt: number;
  /** The boundary block's id; the string tiebreak (never the row id). */
  beforeBlockId: string;
};

/** One windowed page of a thread: metadata plus the slice's blocks in
 *  ascending timeline order, and the cursor for the next older page. */
export type StoredThreadPage = {
  threadId: string;
  meta: StoredThreadMeta;
  blocks: StoredBlock[];
  /** Cursor for the next strictly older page; null when the walk is complete.
   *  Opaque — consumers echo it back verbatim. */
  nextCursor: string | null;
  /** Whether older blocks exist beyond this page. */
  hasMore: boolean;
};

export function encodeThreadPageCursor(cursor: ThreadPageCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.threadId, a: cursor.beforeAnchorAt, i: cursor.beforeBlockId }),
  ).toString("base64url");
}

/** Returns null for anything that is not a well-formed cursor. Callers degrade
 *  a malformed or foreign-thread cursor to a first-page request. */
export function decodeThreadPageCursor(encoded: string): ThreadPageCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || !(parsed instanceof Object) || Array.isArray(parsed)) return null;
  // SAFETY: the object check passed and the value came out of JSON.parse, so
  // it satisfies JsonObject; each field is verified below before use.
  const record = parsed as JsonObject;
  if (!record.t || record.t instanceof Object || record.t === true || !String(record.t).length) return null;
  if (record.a === undefined || record.a === null || !Number.isFinite(record.a)) return null;
  if (!record.i || record.i instanceof Object || record.i === true || !String(record.i).length) return null;
  return {
    threadId: String(record.t),
    beforeAnchorAt: Number(record.a),
    beforeBlockId: String(record.i),
  };
}

/** One turn's per-turn token audit row: the latest known input/output/total
 *  split for a single turn, plus the cache/reasoning counts providers report
 *  alongside. Counts the provider never reported read as null (unknown); the
 *  split counts default to 0 at write time so SUM() over them needs no
 *  COALESCE. Ordered oldest first by the read below. */
export type TurnUsageRecord = {
  turnId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  at: number;
};

/** A day-streak tally: how many consecutive days lead up to the most recent
 *  active day, and the longest such run anywhere in the set. */
export type Streak = {
  current: number;
  longest: number;
};

/** Current + longest run of consecutive local days from a sorted-ascending set
 *  of `YYYY-MM-DD` date strings. "Current" counts back from today; a gap of one
 *  day (activity yesterday but not today) still counts as live, so the streak
 *  doesn't reset the instant a new day begins before the first prompt. Days are
 *  compared as UTC-midnight epochs of the local date label, which sidesteps DST
 *  arithmetic (we only ever step by whole days). */
export function computeStreaks(datesAsc: string[]): Streak {
  if (datesAsc.length === 0) return { current: 0, longest: 0 };
  const DAY = 86_400_000;
  const toDay = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY;
  const days = datesAsc.map(toDay);

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i]! - days[i - 1]! === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // Walk back from the most recent active day, but only if it's today or
  // yesterday in the machine's local calendar.
  const todayLabel = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
  const today = toDay(todayLabel);
  const last = days[days.length - 1]!;
  let current = 0;
  if (today - last <= 1) {
    current = 1;
    for (let i = days.length - 1; i > 0; i--) {
      if (days[i]! - days[i - 1]! === 1) current++;
      else break;
    }
  }
  return { current, longest };
}

// ── jobs ────────────────────────────────────────────────────────────────────

/** Where a job sits in the user's list. `draft` never runs on its own — it is
 *  work described and parked. `queued` is the only state the runner claims
 *  from. The three settled states are terminal for the job, though a settled
 *  job can be re-queued, which opens a new run rather than reviving the old
 *  one. Defined in ./types.js, where the runtime event that carries it lives. */
export type { ChatAttachment, JobStatus } from "./types.js";

/** One attempt's own state. Distinct from the job's: a failed run can sit
 *  under a job the user then re-queued, and the list has to be able to show
 *  "attempt 2 running" over "attempt 1 failed" without either row lying.
 *  `claimed` is the window between a runner taking the row and the thread
 *  actually starting — the state a crash strands, and what the lease sweep
 *  looks for. */
export type JobRunStatus = "claimed" | "running" | "done" | "failed" | "cancelled";

/** Where a job runs, as the composer captured it. These are the session-start
 *  fields and nothing else: starting a job is handing them to the dispatcher,
 *  so a field that the dispatcher would not read has no reason to be stored. */
export type JobTarget = {
  provider: ProviderKind;
  /** Provider model id; the provider's own default when absent. */
  model?: string;
  /** Reasoning-effort tier, in the provider's own vocabulary. */
  effort?: string;
  /** Approval posture, fixed when the job was filed rather than read at
   *  dispatch. A job can start with nobody watching, so the person who filed
   *  it is the only one who can answer for how much it may do unattended. */
  mode?: InteractionMode;
  /** Worktree choice. Absent runs in the project's own checkout. */
  workspace?: { mode: ThreadEnvMode; branch?: string; base?: string };
  /** Providers/models to retry in order when a run hits a rate limit. */
  fallbacks?: Array<{ provider: ProviderKind; model?: string }>;
};

/** A job as callers read it. */
export type JobRow = {
  jobId: string;
  projectPath: string;
  title: string;
  body: string;
  status: JobStatus;
  target: JobTarget;
  /** Files filed with the job. They ride to the opening turn rather than being
   *  re-picked at dispatch: the bytes are already on disk when the job is
   *  filed, and a job that runs unattended has nobody to ask for them again. */
  attachments?: ChatAttachment[];
  createdAt: number;
  updatedAt: number;
  /** Explicit queue position from a reorder. Absent rows drain oldest-first
   *  behind every row that has one. */
  sortKey?: number;
  startedAt?: number;
  endedAt?: number;
  /** The branch the job's latest attempt actually ran on, read back from the
   *  thread that attempt opened.
   *
   *  Observed, not chosen. `target.workspace` is the request — which checkout
   *  the job asked for — and a job running in the project's own checkout asks
   *  for nothing, so that field is empty for most jobs and never says where the
   *  work landed. This does, and only once a run has started: a queued job has
   *  no answer yet, because the checkout can still move before it is taken.
   *
   *  Populated by the list reads, which join the attempt and its thread. */
  branch?: string;
};

/** One attempt at a job, and the thread that carried it. `threadId` is absent
 *  only in the claimed window before the thread exists, or after the thread was
 *  deleted out from under a settled run. */
export type JobRunRow = {
  runId: string;
  jobId: string;
  attempt: number;
  status: JobRunStatus;
  createdAt: number;
  threadId?: string;
  claimedBy?: string;
  claimedAt?: number;
  leaseExpiresAt?: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
};

/** What the composer supplies. `status` is the one thing the two create paths
 *  differ on — filing a draft versus queueing it — so it is required rather
 *  than defaulted, to keep a caller from queueing work by forgetting a field. */
export type JobCreateInput = {
  jobId: string;
  projectPath: string;
  title: string;
  body: string;
  status: Extract<JobStatus, "draft" | "queued">;
  target: JobTarget;
  attachments?: ChatAttachment[];
  at?: number;
};

/** Fields an edit may change. Absent means "leave alone"; `null` clears.
 *  `status` is deliberately not here — moving a job between states goes
 *  through the named transitions so the timestamps stay consistent. */
export type JobPatch = {
  title?: string;
  body?: string;
  target?: JobTarget;
  sortKey?: number | null;
};

/** Where a job sits when nobody has reordered it: behind every row that has a
 *  real position. Written as a large number rather than NULL so the drain order
 *  is plain column order — NULL sorted first in SQLite and had to be pushed
 *  last by a CASE, which no index can match, so every drain and every list
 *  sorted the project's rows to find a queue of a dozen. Hidden from JobRow by
 *  `rowToJob`, so "unordered" stays absent in the domain and is only a number
 *  in the column. Must match the DEFAULT in migration 0009. */
export const JOB_SORT_UNSET = 1e18;

export type JobDbRow = {
  job_id: string;
  project_path: string;
  title: string;
  body: string;
  status: JobStatus;
  /** JOB_SORT_UNSET for a row nobody reordered.
   *
   *  Nullable because migration 0010 could not make the column NOT NULL without
   *  rebuilding a table `job_runs` cascades from, not because a null is
   *  expected: 0010 emptied the column of them and every writer since puts a
   *  number there. Read defensively anyway — the type says what the schema
   *  allows, not what the writers promise. */
  sort_key: number | null;
  provider: ProviderKind;
  model: string | null;
  effort: string | null;
  mode: string | null;
  workspace_json: string | null;
  fallbacks_json: string | null;
  attachments_json: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  /** Joined in by the list reads only — see `JobRow.branch`. Absent on the
   *  projections that read the jobs table alone. */
  ran_on_branch?: string | null;
};

export type JobRunDbRow = {
  run_id: string;
  job_id: string;
  attempt: number;
  thread_id: string | null;
  status: JobRunStatus;
  claimed_by: string | null;
  claimed_at: number | null;
  lease_expires_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  error: string | null;
  created_at: number;
};

/** Every ProviderKind as a value, so a decoded chain can reject a provider id
 *  the runtime has no adapter for. Declared as a record `satisfies
 *  Record<ProviderKind, null>` rather than a bare list because that makes the
 *  union and this set one edit: a provider added to the union without a key
 *  here fails to compile. */
const PROVIDER_KINDS = {
  codex: null,
  claudeAgent: null,
  opencode: null,
  cursor: null,
  droid: null,
  antigravity: null,
} satisfies Record<ProviderKind, null>;

// SAFETY: the keys of a record declared `satisfies Record<ProviderKind, null>`
// are exactly the ProviderKind members, and the literal above is non-empty, so
// the tuple form z.enum requires holds by construction.
const ProviderKindSchema = z.enum(Object.keys(PROVIDER_KINDS) as [ProviderKind, ...ProviderKind[]]);

const InteractionModeSchema = z.enum(["ask", "accept-edits", "full-access"]);

/** A stored worktree choice. A record naming no mode is not a choice and fails
 *  to parse, which reads as absent — the same outcome as never having chosen,
 *  and the same run in the project's own checkout. */
const JobWorkspaceSchema = z.object({
  mode: z.enum(["local", "worktree"]),
  branch: z.string().trim().min(1).optional(),
  base: z.string().trim().min(1).optional(),
});

/** A stored failover chain. A rung naming no known provider is not something
 *  the runtime could act on, so the whole chain fails rather than silently
 *  running one rung shorter than the user configured. */
const JobFallbacksSchema = z
  .array(
    z.object({
      provider: ProviderKindSchema,
      model: z.string().trim().min(1).optional(),
    }),
  )
  .min(1);

/** Decode a stored JSON column against its schema, or undefined when the
 *  column is absent or will not parse. A column that will not parse is treated
 *  as absent rather than thrown on: the job's own row is still worth showing,
 *  and every field these columns carry has a working default. */
function decodeJobJson<T>(json: string | null, schema: z.ZodType<T>): T | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse yields whatever the column held; the schema below is
    // the only gate before the value is trusted.
    parsed = JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export function rowToJob(row: JobDbRow): JobRow {
  const target: JobTarget = { provider: row.provider };
  if (row.model) target.model = row.model;
  if (row.effort) target.effort = row.effort;

  // An unreadable mode decodes as absent, which runs at the provider's own
  // default rather than at a posture nobody chose.
  const mode = InteractionModeSchema.safeParse(row.mode);
  if (mode.success) target.mode = mode.data;

  const workspace = decodeJobJson(row.workspace_json, JobWorkspaceSchema);
  if (workspace) target.workspace = workspace;

  const fallbacks = decodeJobJson(row.fallbacks_json, JobFallbacksSchema);
  if (fallbacks) target.fallbacks = fallbacks;

  const attachments = parseAttachments(row.attachments_json);

  const job: JobRow = {
    jobId: row.job_id,
    projectPath: row.project_path,
    title: row.title,
    body: row.body,
    status: row.status,
    target,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (attachments?.length) job.attachments = attachments;
  if (row.ran_on_branch) job.branch = row.ran_on_branch;
  // The sentinel is a column detail, not a position the user chose, so it
  // stays out of the domain row. A null reads the same way: a row nobody
  // ordered, whatever spelling it was left in.
  if (row.sort_key !== null && row.sort_key !== JOB_SORT_UNSET) job.sortKey = row.sort_key;
  if (row.started_at !== null) job.startedAt = row.started_at;
  if (row.ended_at !== null) job.endedAt = row.ended_at;
  return job;
}

export function rowToJobRun(row: JobRunDbRow): JobRunRow {
  const run: JobRunRow = {
    runId: row.run_id,
    jobId: row.job_id,
    attempt: row.attempt,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.thread_id) run.threadId = row.thread_id;
  if (row.claimed_by) run.claimedBy = row.claimed_by;
  if (row.claimed_at !== null) run.claimedAt = row.claimed_at;
  if (row.lease_expires_at !== null) run.leaseExpiresAt = row.lease_expires_at;
  if (row.started_at !== null) run.startedAt = row.started_at;
  if (row.ended_at !== null) run.endedAt = row.ended_at;
  if (row.error) run.error = row.error;
  return run;
}

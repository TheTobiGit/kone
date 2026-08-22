import type {
  ChatAttachment,
  ProviderKind,
  RuntimeItem,
  StoredBlock,
  StoredThreadMeta,
  SubagentRun,
} from "./types.js";

/** The board document as it lives in the store — a serialisable layout blob.
 *  desktop package stays free of a web-package dependency; the renderer owns the
 *  canonical `BoardLayout` type and the hard pane validation. */
export type StoredBoardLayout = {
  version: 1;
  panes: unknown[];
  focusedId: string | null;
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
  updated_at: number;
  branch: string | null;
  added: number | null;
  removed: number | null;
  tokens: number | null;
  context_used: number | null;
  context_window: number | null;
  compacts_auto: number | null;
  archived: number | null;
  title: string | null;
  base_tree: string | null;
  source_thread_id: string | null;
  fork_context_json: string | null;
  lineage_json: string | null;
  request_id: string | null;
  parent_thread_id: string | null;
  is_pinned: number;
  model_selection_json: string | null;
  resume_session_at: string | null;
  last_activity_at: number | null;
};

export type BlockRow = {
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
  source: string | null;
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
    const parsed = JSON.parse(json) as unknown;
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
  return queued;
}

export type ItemRow = {
  item_id: string;
  turn_id: string;
  kind: string;
  status: string;
  text: string;
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

export function rowToMeta(row: ThreadRow): StoredThreadMeta {
  const selection = parseJsonObject<{ effort?: string; serviceTier?: string; contextWindow?: string }>(
    row.model_selection_json,
  );
  const forkContext = parseJsonObject<StoredThreadMeta["forkContext"]>(row.fork_context_json);
  const lineage = parseJsonObject<StoredThreadMeta["lineage"]>(row.lineage_json);
  const meta: StoredThreadMeta = {
    threadId: row.thread_id,
    projectPath: row.project_path,
    provider: row.provider as ProviderKind,
    model: row.model ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    branch: row.branch ?? null,
    added: row.added ?? undefined,
    removed: row.removed ?? undefined,
    tokens: row.tokens ?? undefined,
    contextUsed: row.context_used ?? undefined,
    contextWindow: row.context_window ?? undefined,
    compactsAutomatically: row.compacts_auto === null ? undefined : row.compacts_auto === 1,
    title: row.title ?? undefined,
    /** Pins live in the DB (v18) so they follow the thread across profiles. */
    isPinned: row.is_pinned === 1,
    /** Recency ordering key (v18): last conversation activity, distinct from
     *  `updatedAt` which title/archive bookkeeping also bumps. Backfilled from
     *  updated_at for pre-v18 rows. */
    lastActivityAt: row.last_activity_at ?? row.updated_at,
    resumeSessionAt: row.resume_session_at ?? undefined,
  };
  if (selection) meta.selection = selection;
  if (forkContext) meta.forkContext = forkContext;
  if (lineage) meta.lineage = lineage;
  return meta;
}

/** Parse a JSON blob column, tolerating bad/absent JSON (a corrupt row reads
 *  as absent — persistence is best-effort). */
export function parseJsonObject<T>(json: string | null): T | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

export function rowToItem(row: ItemRow): RuntimeItem {
  let tasks: RuntimeItem["tasks"];
  if (row.tasks_json) {
    try {
      const parsed = JSON.parse(row.tasks_json) as unknown;
      if (Array.isArray(parsed)) tasks = parsed as RuntimeItem["tasks"];
    } catch {
      tasks = undefined;
    }
  }
  const item: RuntimeItem = {
    itemId: row.item_id,
    kind: row.kind as RuntimeItem["kind"],
    status: row.status as RuntimeItem["status"],
    text: row.text,
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
      state: (b.state as StoredAssistantState | null) ?? "completed",
      error: b.error ?? undefined,
      at: b.at,
      endedAt: b.ended_at ?? undefined,
    };
    if (b.source === "fork-import") block.source = "fork-import";
    return block;
  });
}

// ── windowed thread reads (user-anchored keyset cursor) ───────────────────────
// kone's block model: blocks are the turn analog, the anchor is a block's
// `at` (the user-visible timestamp — the analog of requested_at/started_at),
// and the tiebreak is the content-derived `block_id` string — deliberately NOT
// `seq`, the row_id analog (see loadThreadPage).

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
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.t !== "string" || record.t.length === 0) return null;
  if (typeof record.a !== "number" || !Number.isFinite(record.a)) return null;
  if (typeof record.i !== "string" || record.i.length === 0) return null;
  return {
    threadId: record.t,
    beforeAnchorAt: record.a,
    beforeBlockId: record.i,
  };
}

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

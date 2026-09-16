import type { ConversationDb } from "./ConversationDb.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "../sqlite.js";
import type { ChatAttachment, InteractionMode, ProviderKind, StoredThreadMeta } from "../types.js";
import { DONE_CLEARED, parseJsonObject, rowToMeta, type ThreadRow, GLOBAL_ASSISTANT_PROJECT_PATH } from "../conversationStoreTypes.js";
import { itemFullTextSql } from "./itemTextChunks.js";

export class ThreadRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Record (or refresh) the thread a session belongs to. Called when a session
   *  starts, so the project/provider/model association exists before any turn
   *  streams in. */
  ensureThread(input: {
    threadId: string;
    projectPath: string;
    provider: ProviderKind;
    model?: string;
  }): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      const now = Date.now();
      // `last_visited_at` is stamped on the insert and left alone on the
      // conflict. Unread is a comparison against when you last looked, so a row
      // born with no visit is born unread — a thread you are creating, and
      // therefore looking at, would carry a mark for whatever it says first
      // until some surface got around to stamping it. Updating it on conflict
      // would be the opposite mistake: ensureThread runs on every session start,
      // and that is not a visit.
      db.prepare(
        `INSERT INTO threads (
           thread_id, project_path, provider, model, created_at, last_activity_at,
           last_visited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           project_path = excluded.project_path,
           provider     = excluded.provider,
           model        = COALESCE(excluded.model, threads.model),
           last_activity_at = excluded.last_activity_at`,
      ).run(
        input.threadId,
        input.projectPath,
        input.provider,
        input.model ?? null,
        now,
        now,
        now,
      );
    } catch (err) {
      console.error("[conversation-store] ensureThread failed:", err);
    }
  }

  /** Persist a user prompt as its own block. Written on send-turn, before the
   *  turn.started event, so it precedes the assistant turn in arrival order.
   *  Returns the 1-based user-turn count after the insert (so IPC can detect
   *  the first turn and kick off title naming). `0` on failure. */
  recordUserBlock(input: {
    blockId?: string;
    threadId: string;
    text: string;
    at?: number;
    attachments?: ChatAttachment[];
  }): number {
    const db = this.dbh.handle();
    if (!db) return 0;
    try {
      const at = input.at ?? Date.now();
      // Durable: the prompt is the one row in a conversation that cannot be
      // reconstructed from anywhere else — the provider's own transcript may hold
      // the reply, but if kone loses the ask, the thread reads as an answer to
      // nothing. Cheap here: once per user turn, not per streamed delta.
      this.dbh.durably(db, () => {
        db.prepare(
          `INSERT INTO blocks (block_id, thread_id, role, text, at, attachments_json)
           VALUES (?, ?, 'user', ?, ?, ?)`,
        ).run(
          input.blockId ?? randomUUID(),
          input.threadId,
          input.text,
          at,
          input.attachments?.length ? JSON.stringify(input.attachments) : null,
        );
      });
      this.touch(db, input.threadId, at);
      // SAFETY: COUNT(*) always arrives under the alias asked for.
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM blocks WHERE thread_id = ? AND role = 'user'`,
        )
        .get(input.threadId) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch (err) {
      console.error("[conversation-store] recordUserBlock failed:", err);
      return 0;
    }
  }

  /** Read the thread's current working title, or null if unset / missing. */
  getTitle(threadId: string): string | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection names only the nullable TEXT title column.
      const row = db
        .prepare(`SELECT title FROM threads WHERE thread_id = ?`)
        .get(threadId) as { title: string | null } | undefined;
      return row?.title ?? null;
    } catch (err) {
      console.error("[conversation-store] getTitle failed:", err);
      return null;
    }
  }

  /** Persist a working title. Used for the first-turn word fallback and the
   *  subsequent agent-generated rename. Deliberately does NOT touch
   *  `updated_at` / `last_activity_at`: a rename is bookkeeping, not
   *  conversation activity, and must not reshuffle the recents list. */
  setTitle(threadId: string, title: string): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET title = ? WHERE thread_id = ?`).run(title, threadId);
    } catch (err) {
      console.error("[conversation-store] setTitle failed:", err);
    }
  }

  /** User-initiated rename (agent:rename-thread). Same title-only semantics as
   *  setTitle — recency ordering is untouched, and an unchanged title is a
   *  no-op. Returns whether the title actually changed, so the IPC layer only
   *  broadcasts when something user-visible happened. */
  renameThread(threadId: string, title: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      // SAFETY: same single-column projection as getTitle.
      const current = db
        .prepare(`SELECT title FROM threads WHERE thread_id = ?`)
        .get(threadId) as { title: string | null } | undefined;
      if (!current) return false;
      if (current.title === title) return false;
      db.prepare(`UPDATE threads SET title = ? WHERE thread_id = ?`).run(title, threadId);
      return true;
    } catch (err) {
      console.error("[conversation-store] renameThread failed:", err);
      return false;
    }
  }

  /** Pin (or unpin) a thread. Pins live in the DB — not browser localStorage —
   *  so a pinned thread follows the thread across browser profiles and shows
 */
  setPinned(threadId: string, pinned: boolean): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET pinned_at = ? WHERE thread_id = ?`).run(
        pinned ? Date.now() : null,
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] setPinned failed:", err);
    }
  }

  /** Mark a thread done, or take the mark off. Done says you are finished with
   *  the thread's claim on your attention — it does not stop the agent, close
   *  the thread, or archive it, and the work is untouched either way.
   *
   *  Stamped rather than flagged, because the mark expires on its own: a thread
   *  the agent has spoken in since carries a `done_at` older than its
   *  `last_activity_at`, and reads compare the two instead of trusting the
   *  stamp alone. So nothing has to clear this when a turn lands, and no crash
   *  between a turn and a clear can leave a live thread silently marked done.
   *
   *  Un-marking writes epoch zero, not NULL. The two are different answers:
   *  NULL is "you never said", which leaves a thread free to be counted done by
   *  age once it has been quiet long enough, and zero is "you said you are not
   *  finished", which outranks age for good. Writing NULL for both would make
   *  the un-mark silently reverse itself on exactly the old threads someone is
   *  most likely to press it on. Zero is safe as the marker because it is not a
   *  time any thread was ever marked at. */
  setDone(threadId: string, done: boolean): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(`UPDATE threads SET done_at = ? WHERE thread_id = ?`).run(
        done ? Date.now() : DONE_CLEARED,
        threadId,
      );
    } catch (err) {
      console.error("[conversation-store] setDone failed:", err);
    }
  }

  /** Record that the user has just had this thread in front of them.
   *
   *  Monotonic on purpose: a stamp only ever moves forward, so two surfaces
   *  showing the same thread (a studio column and the inbox reader) cannot have
   *  the slower one's write undo the faster one's, and a late-arriving write
   *  from a pane that has since been closed cannot re-hide a reply that landed
   *  after it. The one caller that needs to go backwards is marking a thread
   *  unread again, which passes the earlier time deliberately — hence `force`.
   */
  setVisited(threadId: string, at: number, force = false): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      if (force) {
        db.prepare(`UPDATE threads SET last_visited_at = ? WHERE thread_id = ?`).run(at, threadId);
        return;
      }
      db.prepare(
        `UPDATE threads SET last_visited_at = ?
         WHERE thread_id = ? AND (last_visited_at IS NULL OR last_visited_at < ?)`,
      ).run(at, threadId, at);
    } catch (err) {
      console.error("[conversation-store] setVisited failed:", err);
    }
  }

  /** Persist the user's per-thread picker selection so a reopened thread
   *  restores it exactly (agent:set-thread-selection; fix_registry contract).
   *  `model` lands on the existing threads.model column (the display model);
   *  effort / serviceTier / contextWindow / mode ride `model_selection_json` — the
   *  same axes SendTurnInput carries. Absent fields are left untouched. */
  setThreadSelection(
    threadId: string,
    selection: {
      model?: string;
      effort?: string;
      serviceTier?: string;
      contextWindow?: string;
      mode?: InteractionMode | string;
    },
  ): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      // Merge over the stored knobs: a partial update (the picker commits one
      // axis at a time) must never wipe the knobs it didn't touch.
      // SAFETY: the projection names only model_selection_json, the nullable
      // TEXT knob blob this class writes via JSON.stringify.
      const row = db
        .prepare(`SELECT model_selection_json FROM threads WHERE thread_id = ?`)
        .get(threadId) as { model_selection_json: string | null } | undefined;
      const knobs: {
        effort?: string;
        serviceTier?: string;
        contextWindow?: string;
        mode?: string;
      } =
        parseJsonObject<{
          effort?: string;
          serviceTier?: string;
          contextWindow?: string;
          mode?: string;
        }>(row?.model_selection_json ?? null) ?? {};
      if (selection.effort !== undefined) knobs.effort = selection.effort;
      if (selection.serviceTier !== undefined) knobs.serviceTier = selection.serviceTier;
      if (selection.contextWindow !== undefined) knobs.contextWindow = selection.contextWindow;
      if (selection.mode !== undefined) knobs.mode = selection.mode;
      const json = Object.keys(knobs).length ? JSON.stringify(knobs) : null;
      db.prepare(
        `UPDATE threads
           SET model = COALESCE(?, model),
               model_selection_json = COALESCE(?, model_selection_json)
         WHERE thread_id = ?`,
      ).run(selection.model ?? null, json, threadId);
    } catch (err) {
      console.error("[conversation-store] setThreadSelection failed:", err);
    }
  }

  touch(db: DatabaseSync, threadId: string, at: number): void {
    // Bumps both clocks: `updated_at` is the generic "row changed" stamp,
    // `last_activity_at` is the recency ordering key (title/archive bookkeeping
    // touches only the former — see renameThread).
    this.dbh.prepare(
      db,
      `UPDATE threads SET last_activity_at = ? WHERE thread_id = ?`,
    ).run(at, threadId);
  }

  /** The project path a thread belongs to — so the IPC layer can run git against
   *  it after a turn without threading the cwd through the event stream. */
  threadProjectPath(threadId: string): string | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection names only project_path, NOT NULL TEXT.
      const row = db
        .prepare(`SELECT project_path FROM threads WHERE thread_id = ?`)
        .get(threadId) as { project_path: string } | undefined;
      return row?.project_path ?? null;
    } catch (err) {
      console.error("[conversation-store] threadProjectPath failed:", err);
      return null;
    }
  }

  /** Whether a thread belongs to the global assistant rather than a project. */
  isAssistantThread(threadId: string): boolean {
    return this.threadProjectPath(threadId) === GLOBAL_ASSISTANT_PROJECT_PATH;
  }

  /** All non-archived assistant threads in recency order. */
  listAssistantThreads(): StoredThreadMeta[] {
    return this.listThreads(GLOBAL_ASSISTANT_PROJECT_PATH);
  }

  /** Cheap metadata lookup by id — used when the live session isn't in memory
   *  (e.g. title naming right after send) but the store row already exists. */
  threadMeta(threadId: string): StoredThreadMeta | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: `SELECT *` of threads is exactly ThreadRow — the columns this
      // schema creates.
      const row = db
        .prepare(`SELECT * FROM threads WHERE thread_id = ?`)
        .get(threadId) as ThreadRow | undefined;
      return row ? rowToMeta(row) : null;
    } catch (err) {
      console.error("[conversation-store] threadMeta failed:", err);
      return null;
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** The most recently active thread for a project, without its transcript.
   *  Cheap enough to poll when opening a project. */
  latestThreadMeta(projectPath: string): StoredThreadMeta | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: `SELECT *` of threads is exactly ThreadRow — the columns this
      // schema creates.
      const row = db
        .prepare(
          `SELECT * FROM threads WHERE project_path = ? AND archived_at IS NULL
           ORDER BY last_activity_at DESC LIMIT 1`,
        )
        .get(projectPath) as ThreadRow | undefined;
      return row ? rowToMeta(row) : null;
    } catch (err) {
      console.error("[conversation-store] latestThreadMeta failed:", err);
      return null;
    }
  }

  /** Fast indexed lookup for the ID of the most recent user block in a thread,
   *  avoiding full-transcript parsing on turn enqueues. */
  latestUserBlockId(threadId: string): string | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection names only the newest user block's block_id
      // (NOT NULL TEXT).
      const row = this.dbh.prepare(
        db,
        `SELECT block_id FROM blocks WHERE thread_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1`,
      ).get(threadId) as { block_id: string } | undefined;
      return row?.block_id ?? null;
    } catch {
      return null;
    }
  }

  /** Every thread for a project (metadata only), newest first — the backing
   *  read for the "recent conversations" block. Only threads that have at
   *  least one user turn are returned (a started-but-empty session stays out
   *  of the list).
   *
   *  The two states are disjoint views of the same table, never a union: by
   *  default the live threads, and with `archived: true` only the put-away
   *  ones. A caller asking for archived threads is looking at the archive as a
   *  place, so mixing the live ones back in would defeat the request. */
  listThreads(projectPath: string, options?: { archived?: boolean }): StoredThreadMeta[] {
    const db = this.dbh.handle();
    if (!db) return [];
    const archivedOnly = options?.archived === true;
    try {
      // The snippet reads each candidate's reassembled text (settled base
      // plus any still-streaming chunks), so a list rendered mid-stream shows
      // the same partial text the transcript shows — not the stale base.
      const snippetSql = itemFullTextSql("i");
      // SAFETY: `t.*` plus the computed snippet is exactly ThreadRow.
      const rows = db
        .prepare(
          `SELECT t.*,
            (SELECT ${snippetSql} FROM items i WHERE i.thread_id = t.thread_id AND i.kind = 'assistant_text' AND TRIM(${snippetSql}) != '' ORDER BY i.seq DESC LIMIT 1) AS snippet
          FROM threads t
            WHERE t.project_path = ?
              AND t.archived_at IS ${archivedOnly ? "NOT NULL" : "NULL"}
              AND EXISTS (
                SELECT 1 FROM blocks b
                WHERE b.thread_id = t.thread_id AND b.role = 'user'
              )
            ORDER BY ${archivedOnly ? "t.archived_at DESC" : "t.last_activity_at DESC"}`,
        )
        .all(projectPath) as ThreadRow[];
      return rows.map(rowToMeta);
    } catch (err) {
      console.error("[conversation-store] listThreads failed:", err);
      return [];
    }
  }

  /** Whether this thread has ever had a user turn — i.e. whether there is a
   *  conversation here that a fresh provider session would be missing. Cheap
   *  enough for the session-open path, unlike loadThread. */
  hasUserTurn(threadId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const row = db
        .prepare(`SELECT 1 FROM blocks WHERE thread_id = ? AND role = 'user' LIMIT 1`)
        .get(threadId);
      // Both drivers' "no row" shape: node:sqlite yields undefined, bun:sqlite
      // yields null. Either means no user turn yet.
      return row !== undefined && row !== null;
    } catch (err) {
      console.error("[conversation-store] hasUserTurn failed:", err);
      return false;
    }
  }

  // ── side chats (fork pointer, lineage, fork-import blocks) ─────────────────

  /** Whether a thread row already exists under this id. The natural
   *  idempotency for client-minted thread ids: a replayed create resolves as
   *  "exists" instead of writing a second row. */
  threadExists(threadId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      return (
        db.prepare(`SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1`).get(threadId) !==
        undefined
      );
    } catch (err) {
      console.error("[conversation-store] threadExists failed:", err);
      return false;
    }
  }
}

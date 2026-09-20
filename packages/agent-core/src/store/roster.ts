import type { ConversationDb } from "./ConversationDb.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "../sqlite.js";
import { withTransaction } from "../conversationMigrations.js";
import { AGENT_COLUMNS, AGENT_NAME_MAX, AGENT_PAINT_MAX, AGENT_PROSE_MAX, AGENT_ROLE_MAX, clampAgentField, normalizeSkillRef, rowToAgent, serializeAgentAvatar, serializeAgentBot, serializeAgentList, serializeModelRef, type AgentCreateInput, type AgentDuplicateInput, type AgentPatch, type AgentRecord, type AgentRow, type ThreadAgentBinding, type ThreadAgentRoute } from "../rosterRecord.js";

/** The binding row as stored. The two route columns are NULL together or set
 *  together — nothing writes one without the other. */
type ThreadAgentRow = {
  thread_id: string;
  agent_id: string | null;
  route_outcome: string | null;
  route_confidence: number | null;
};

const BINDING_COLUMNS = "thread_id, agent_id, route_outcome, route_confidence";

/**
 * A stored binding row, as the renderer reads it. A row from before the route
 * columns existed reads as unrouted, which is what it was.
 *
 * The confidence is held to the 0–1 scale it is documented on. The column is a
 * plain REAL and the tag beside it is whatever its writer called it, so a row
 * from a newer build — or one written through a bug — can carry a number off
 * the scale, and every reader downstream turns it into a percentage. One clamp
 * here, where a stored row becomes a binding, rather than one in each of them.
 * A value that is no number at all has no scale to be held to, so the route
 * reads as absent rather than as a decision nobody can describe.
 */
function rowToBinding(row: ThreadAgentRow): ThreadAgentBinding {
  const confidence = row.route_confidence;
  const route: ThreadAgentRoute | null =
    row.route_outcome === null || confidence === null || !Number.isFinite(confidence)
      ? null
      : { outcome: row.route_outcome, confidence: Math.min(1, Math.max(0, confidence)) };
  return { threadId: row.thread_id, agentId: row.agent_id, route };
}

export class RosterRepo {
  constructor(private readonly dbh: ConversationDb) {}

  // ── the roster: agents, and each project's team ────────────────────────────
  // See the v22 rung for the shape. The rule that governs every method here:
  // NULL is returned verbatim, never resolved. A NULL on an overlay row means
  // "inherit from the shipped preset", and only the renderer holds the shipped
  // presets — a store that guessed a default would be inventing an agent's
  // character.

  /** Give every shipped preset an overlay row, in the order they were handed
   *  over. Idempotent, and deliberately unable to resurrect a deleted built-in:
   *  a user who dismissed one does not find it back on next launch.
   *
   *  Called on hydrate rather than from a migration rung, so a built-in added
   *  by a later build gets its row without a schema change — the renderer is
   *  the only layer that knows which presets exist, so it is the layer that
   *  says so. A built-in that arrives that way appends like anything else,
   *  landing after the agents the user already had rather than inserting itself
   *  above them. */
  ensurePresetAgents(presetIds: readonly string[]): void {
    const db = this.dbh.handle();
    if (!db) return;
    if (presetIds.length === 0) return;
    try {
      const now = Date.now();
      withTransaction(db, () => {
        const insert = db.prepare(
          `INSERT INTO agents (agent_id, preset_id, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO NOTHING`,
        );
        for (const presetId of presetIds) {
          // Read per insert, not once: the previous row of this loop is already
          // visible inside the transaction, so the first launch lays the
          // presets out in shipped order and no two rows share a position.
          insert.run(presetId, presetId, this.nextAgentSortOrder(db), now, now);
        }
      });
    } catch (err) {
      console.error("[conversation-store] ensurePresetAgents failed:", err);
    }
  }

  /** The roster, in order. Deleted agents are left out unless asked for — the
   *  renderer wants them when it has to name whoever worked an old thread, and
   *  never when it is drawing a list you can pick from. */
  listAgents(options?: { includeDeleted?: boolean }): AgentRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `AGENT_COLUMNS` is the column list `AgentRow` is declared from,
      // so the projection and the type are the same list in both directions.
      const rows = db
        .prepare(
          `SELECT ${AGENT_COLUMNS} FROM agents
            ${options?.includeDeleted ? "" : "WHERE deleted_at IS NULL"}
            ORDER BY sort_order ASC, created_at ASC, agent_id ASC`,
        )
        .all() as AgentRow[];
      return rows.map(rowToAgent);
    } catch (err) {
      console.error("[conversation-store] listAgents failed:", err);
      return [];
    }
  }

  /** One agent by id, deleted or not. A deleted agent still has to answer for
   *  the threads they worked, so this read is deliberately not filtered — the
   *  caller decides whether a tombstone belongs where it is going. */
  getAgent(agentId: string): AgentRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: same column list `AgentRow` is declared from, and `agent_id` is
      // the primary key, so this is at most one row of exactly that shape.
      const row = db
        .prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE agent_id = ?`)
        .get(agentId) as AgentRow | undefined;
      return row ? rowToAgent(row) : null;
    } catch (err) {
      console.error("[conversation-store] getAgent failed:", err);
      return null;
    }
  }

  /** Add a user-made agent to the end of the roster. The caller mints the id so
   *  it can draw the new agent before the write lands. Fields are clamped, not
   *  rejected: the editor is expected to hold the real limits, and this is the
   *  floor that keeps a runaway paste out of the database. A bot is the one
   *  exception — an agent without its creature has nothing to show while it
   *  works, so a bot-less create is refused rather than stored. */
  createAgent(input: AgentCreateInput): AgentRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const name = clampAgentField(input.name, AGENT_NAME_MAX);
    if (!name) return null;
    if (serializeAgentBot(input.bot) === null) return null;
    try {
      const now = Date.now();
      const agentId = input.agentId ?? randomUUID();
      db.prepare(
        `INSERT INTO agents
           (agent_id, preset_id, name, role, instructions,
            face_body, face_ink, skills, models,
            avatar, bot, sort_order, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        agentId,
        name,
        clampAgentField(input.role, AGENT_ROLE_MAX),
        clampAgentField(input.instructions, AGENT_PROSE_MAX),
        clampAgentField(input.faceBody, AGENT_PAINT_MAX),
        clampAgentField(input.faceInk, AGENT_PAINT_MAX),
        serializeAgentList(input.skills, normalizeSkillRef),
        serializeModelRef(input.model, input.modelFallbacks),
        serializeAgentAvatar(input.avatar),
        serializeAgentBot(input.bot),
        this.nextAgentSortOrder(db),
        now,
        now,
      );
      return this.getAgent(agentId);
    } catch (err) {
      console.error("[conversation-store] createAgent failed:", err);
      return null;
    }
  }

  /** Edit an agent, one field at a time. A field left out of the patch is left
   *  alone; an explicit `null` clears it, which on an overlay row means handing
   *  the field back to the shipped preset and on a user-made agent means
   *  unsetting it. Refuses a deleted agent — editing a tombstone would put an
   *  agent back in the roster through the side door. */
  updateAgent(agentId: string, patch: AgentPatch): AgentRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const edits: Array<[column: string, value: string | null]> = [];
    if (patch.name !== undefined) {
      edits.push(["name", clampAgentField(patch.name, AGENT_NAME_MAX)]);
    }
    if (patch.role !== undefined) {
      edits.push(["role", clampAgentField(patch.role, AGENT_ROLE_MAX)]);
    }
    if (patch.instructions !== undefined) {
      edits.push(["instructions", clampAgentField(patch.instructions, AGENT_PROSE_MAX)]);
    }
    if (patch.faceBody !== undefined) {
      edits.push(["face_body", clampAgentField(patch.faceBody, AGENT_PAINT_MAX)]);
    }
    if (patch.faceInk !== undefined) {
      edits.push(["face_ink", clampAgentField(patch.faceInk, AGENT_PAINT_MAX)]);
    }
    if (patch.skills !== undefined) {
      edits.push(["skills", serializeAgentList(patch.skills, normalizeSkillRef)]);
    }
    if (patch.model !== undefined || patch.modelFallbacks !== undefined) {
      // Primary and fallbacks share one ordered column, so a patch that names
      // only one of them has to be merged against what is stored rather than
      // written alone — otherwise pinning a new primary would silently drop the
      // fallbacks the user had already lined up behind it.
      const current = this.getAgent(agentId);
      const primary = patch.model !== undefined ? patch.model : (current?.model ?? null);
      const fallbacks =
        patch.modelFallbacks !== undefined
          ? patch.modelFallbacks
          : (current?.modelFallbacks ?? null);
      edits.push(["models", serializeModelRef(primary, fallbacks)]);
    }
    if (patch.avatar !== undefined) {
      edits.push(["avatar", serializeAgentAvatar(patch.avatar)]);
    }
    if (patch.bot !== undefined) {
      edits.push(["bot", serializeAgentBot(patch.bot)]);
    }
    if (edits.length === 0) return this.getAgent(agentId);
    try {
      const assignments = edits.map(([column]) => `${column} = ?`).join(", ");
      const values = edits.map(([, value]) => value);
      // The CHECK is the guard, not a read-then-write: clearing the name of an
      // agent that inherits nothing raises rather than storing a nameless row.
      const result = db
        .prepare(
          `UPDATE agents SET ${assignments}, updated_at = ?
            WHERE agent_id = ? AND deleted_at IS NULL`,
        )
        .run(...values, Date.now(), agentId);
      return Number(result.changes) > 0 ? this.getAgent(agentId) : null;
    } catch (err) {
      console.error("[conversation-store] updateAgent failed:", err);
      return null;
    }
  }

  /** Take an agent out of the roster, keeping the row. Returns whether an agent
   *  that was in the roster left it — deleting one twice is not a failure the
   *  second time, it just changes nothing. */
  deleteAgent(agentId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const now = Date.now();
      let changes = 0;
      withTransaction(db, () => {
        const result = db
          .prepare(
            `UPDATE agents SET deleted_at = ?, updated_at = ?
              WHERE agent_id = ? AND deleted_at IS NULL`,
          )
          .run(now, now, agentId);
        changes = Number(result.changes);
        // Nothing may be left pointing at them for work still to come: a
        // selection on a departed agent would send the next turn to nobody.
        // Their thread bindings are untouched — that is the past, and it keeps
        // its record.
        if (changes > 0) {
          db.prepare(
            `UPDATE app_state SET value = '', updated_at = ?
              WHERE key = 'selected_agent' AND value = ?`,
          ).run(now, agentId);
        }
      });
      return changes > 0;
    } catch (err) {
      console.error("[conversation-store] deleteAgent failed:", err);
      return false;
    }
  }

  /** Fork an agent into a new user-made one, sitting straight after the
   *  original.
   *
   *  A copy is a fork, not a second overlay: it keeps no inheritance, so what
   *  it copies is what the source *reads as*, and the fields the source leaves
   *  to its preset have to be supplied by the caller — the renderer is the only
   *  layer holding that text. `inherited` fills exactly those gaps and is
   *  ignored wherever the source row has its own value.
   *
   *  The copy takes the position straight below its original, which means
   *  shifting everybody under it down one. Deliberately not "same position,
   *  younger, let the created-at tiebreak sort it out": a duplicate raised in
   *  the same millisecond as its source has no tiebreak left but the id, and the
   *  copy would land above the thing it was copied from. Renumbering a roster
   *  of a handful of rows costs nothing and can't be ambiguous. */
  duplicateAgent(input: AgentDuplicateInput): AgentRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const source = this.getAgent(input.agentId);
    if (!source || source.deletedAt !== null) return null;
    const inherited = input.inherited ?? {};
    const name = clampAgentField(input.name ?? source.name ?? inherited.name, AGENT_NAME_MAX);
    if (!name) return null;
    if (serializeAgentBot(source.bot ?? inherited.bot) === null) return null;
    try {
      const now = Date.now();
      const agentId = input.newAgentId ?? randomUUID();
      withTransaction(db, () => {
        db.prepare(`UPDATE agents SET sort_order = sort_order + 1 WHERE sort_order > ?`).run(
          source.sortOrder,
        );
        db.prepare(
          `INSERT INTO agents
             (agent_id, preset_id, name, role, instructions,
              face_body, face_ink, skills, models,
              avatar, bot, sort_order, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          agentId,
          name,
          clampAgentField(source.role ?? inherited.role, AGENT_ROLE_MAX),
          clampAgentField(source.instructions ?? inherited.instructions, AGENT_PROSE_MAX),
          clampAgentField(source.faceBody ?? inherited.faceBody, AGENT_PAINT_MAX),
          clampAgentField(source.faceInk ?? inherited.faceInk, AGENT_PAINT_MAX),
          serializeAgentList(source.skills ?? inherited.skills, normalizeSkillRef),
          // Primary and fallbacks travel together: a fork that took its
          // primary from the shipped preset must take that preset's chain too,
          // not splice the source row's fallbacks under a different model.
          source.model
            ? serializeModelRef(source.model, source.modelFallbacks)
            : serializeModelRef(inherited.model, inherited.modelFallbacks),
          serializeAgentAvatar(source.avatar ?? inherited.avatar),
          serializeAgentBot(source.bot ?? inherited.bot),
          source.sortOrder + 1,
          now,
          now,
        );
      });
      return this.getAgent(agentId);
    } catch (err) {
      console.error("[conversation-store] duplicateAgent failed:", err);
      return null;
    }
  }

  /** Put an agent on a project's team. Idempotent, and refuses an agent who
   *  isn't in the roster — a team is a list of people you can actually hand work
   *  to, so a missing or deleted id is a no. */
  addAgentToProject(projectPath: string, agentId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const alive = db
        .prepare(`SELECT 1 FROM agents WHERE agent_id = ? AND deleted_at IS NULL`)
        .get(agentId);
      if (alive == null) return false;
      db.prepare(
        `INSERT INTO project_agents (project_path, agent_id, sort_order, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_path, agent_id) DO NOTHING`,
      ).run(projectPath, agentId, this.nextTeamSortOrder(db, projectPath), Date.now());
      return true;
    } catch (err) {
      console.error("[conversation-store] addAgentToProject failed:", err);
      return false;
    }
  }

  /** Take an agent off a project's team. The agent itself is untouched — they
   *  stay in the roster and on every other team. */
  removeAgentFromProject(projectPath: string, agentId: string): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(`DELETE FROM project_agents WHERE project_path = ? AND agent_id = ?`).run(
        projectPath,
        agentId,
      );
    } catch (err) {
      console.error("[conversation-store] removeAgentFromProject failed:", err);
    }
  }

  /** A project's team, in the order they were added. Deleted agents fall out
   *  here rather than being cascaded away on delete, so restoring an agent
   *  restores every team they were on. */
  listProjectAgents(projectPath: string): AgentRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: projecting AGENT_COLUMNS matches AgentRow.
      const rows = db
        .prepare(
          `SELECT ${AGENT_COLUMNS.split(", ").map((col) => `a.${col}`).join(", ")}
             FROM project_agents m
             JOIN agents a ON a.agent_id = m.agent_id
            WHERE m.project_path = ? AND a.deleted_at IS NULL
            ORDER BY m.sort_order ASC, m.added_at ASC, a.agent_id ASC`,
        )
        .all(projectPath) as AgentRow[];
      return rows.map(rowToAgent);
    } catch (err) {
      console.error("[conversation-store] listProjectAgents failed:", err);
      return [];
    }
  }

  /** One past the last roster position, counting deleted rows: a restored agent
   *  has to land back where it was rather than on top of somebody. */
  private nextAgentSortOrder(db: DatabaseSync): number {
    // SAFETY: an aggregate over an INTEGER column, wrapped in COALESCE, so the
    // one row this returns has an integer under the name asked for.
    const row = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM agents`).get() as
      | { next: number }
      | undefined;
    return row?.next ?? 0;
  }

  private nextTeamSortOrder(db: DatabaseSync, projectPath: string): number {
    // SAFETY: as above — a COALESCE'd aggregate over an INTEGER column.
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
           FROM project_agents WHERE project_path = ?`,
      )
      .get(projectPath) as { next: number } | undefined;
    return row?.next ?? 0;
  }

  // ── who worked a thread, and who is up next ─────────────────────────────────


  /** Every binding there is, so the renderer can answer "who worked this?"
   *  without a round trip per thread. Rows are tiny and one per conversation. */
  listThreadAgents(): ThreadAgentBinding[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the four columns named, of the table this schema declares —
      // `thread_id` is a TEXT primary key, `agent_id` is nullable TEXT, and the
      // two route columns are nullable TEXT / REAL.
      const rows = db
        .prepare(`SELECT ${BINDING_COLUMNS} FROM thread_agents ORDER BY settled_at ASC`)
        .all() as ThreadAgentRow[];
      return rows.map(rowToBinding);
    } catch (err) {
      console.error("[conversation-store] listThreadAgents failed:", err);
      return [];
    }
  }

  /** Who worked one thread, or null if it never started. */
  getThreadAgent(threadId: string): ThreadAgentBinding | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: as above, and `thread_id` is the primary key, so this is at most
      // one row of exactly that shape.
      const row = db
        .prepare(`SELECT ${BINDING_COLUMNS} FROM thread_agents WHERE thread_id = ?`)
        .get(threadId) as ThreadAgentRow | undefined;
      return row ? rowToBinding(row) : null;
    } catch (err) {
      console.error("[conversation-store] getThreadAgent failed:", err);
      return null;
    }
  }

  /**
   * Settle who works a thread, at the moment it starts.
   *
   * Write-once, in SQL rather than in a read-then-write the renderer could race:
   * a thread that already has a binding keeps it, so a later send can never
   * rewrite who wrote the lines already above it. `null` settles it on a guest,
   * which closes the thread to being claimed afterwards.
   *
   * Returns what the thread is bound to now — which for an already-settled
   * thread is what it was bound to before, not what was just asked for.
   */
  bindThreadAgent(
    threadId: string,
    agentId: string | null,
    route?: ThreadAgentRoute | null,
  ): ThreadAgentBinding | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      db.prepare(
        `INSERT INTO thread_agents (thread_id, agent_id, settled_at, route_outcome, route_confidence)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO NOTHING`,
      ).run(threadId, agentId, Date.now(), route?.outcome ?? null, route?.confidence ?? null);
      return this.getThreadAgent(threadId);
    } catch (err) {
      console.error("[conversation-store] bindThreadAgent failed:", err);
      return null;
    }
  }

  /**
   * Hand a new thread the agent an old one had.
   *
   * The same colleague follows the work wherever it goes next, and a guest
   * binding carries too — a guest thread restarted has to come back a guest
   * rather than fall through to whoever is picked by then. Write-once at the
   * far end.
   *
   * `withRoute` decides whether the reason follows as well, and the two callers
   * mean different things by carrying. A thread reborn under a new id — a
   * provider or model switch tearing a live session down and starting another —
   * is the same conversation, staffed by the same decision, so the reason
   * travels with the colleague it explains; without it the reborn thread would
   * read as hand-picked, which is not what happened. A thread forked off this
   * one is new work that was never put to a router at all, and a reason copied
   * onto it would claim a router read a request it never saw. Off by default,
   * because "this is the same conversation" is the rarer claim and the one
   * worth making out loud.
   */
  carryThreadAgent(
    fromThreadId: string,
    toThreadId: string,
    withRoute = false,
  ): ThreadAgentBinding | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const source = this.getThreadAgent(fromThreadId);
    if (!source) return null;
    return this.bindThreadAgent(toThreadId, source.agentId, withRoute ? source.route : null);
  }

  /** Who the next turn goes to, or null for a guest — which is also what nobody
   *  having chosen yet reads as. */
  readSelectedAgent(): string | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: one TEXT column of app_state for key 'selected_agent'.
      const row = db
        .prepare(`SELECT value FROM app_state WHERE key = 'selected_agent'`)
        .get() as { value: string } | undefined;
      return row && row.value.length > 0 ? row.value : null;
    } catch (err) {
      console.error("[conversation-store] readSelectedAgent failed:", err);
      return null;
    }
  }

  /** Point the next turn at an agent, or at a guest with null. */
  writeSelectedAgent(agentId: string | null): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES ('selected_agent', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(agentId ?? "", Date.now());
    } catch (err) {
      console.error("[conversation-store] writeSelectedAgent failed:", err);
    }
  }
}

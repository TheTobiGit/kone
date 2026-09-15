import type { ConversationDb } from "./ConversationDb.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "../sqlite.js";
import { AGENT_NAME_MAX, AGENT_PROSE_MAX, SUBAGENT_PRESET_COLUMNS, clampAgentField, isColumnRecord, mergeVisiblePresets, normalizeNativeSubagentEntry, type ColumnRecord, type ColumnValue, rowToSubagentPreset, serializeModelRef, type NativeSubagentConfig, type NativeSubagentConfigPatch, type SubagentPresetCreateInput, type SubagentPresetPatch, type SubagentPresetRecord, type SubagentPresetRow } from "../rosterRecord.js";
import { BUILTIN_SUBAGENT_PRESET_IDS, normalizeChain } from "@kone/protocol/subagent-presets";

export class SubagentPresetRepo {
  constructor(private readonly dbh: ConversationDb) {}

  // ── preset sub-agents ───────────────────────────────────────────────────────

  /** Every preset sub-agent, in the order they were made. Globally available,
   *  so there is no project or team to scope by — one flat list. */
  listSubagentPresets(): SubagentPresetRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the columns `SubagentPresetRow` is declared from, of the table
      // this schema creates at v26.
      const rows = db
        .prepare(
          `SELECT ${SUBAGENT_PRESET_COLUMNS} FROM subagent_presets
            ORDER BY sort_order ASC, created_at ASC, preset_id ASC`,
        )
        .all() as SubagentPresetRow[];
      return rows.map(rowToSubagentPreset);
    } catch (err) {
      console.error("[conversation-store] listSubagentPresets failed:", err);
      return [];
    }
  }

  /** One preset by id, or null when there is no such preset. */
  getSubagentPreset(presetId: string): SubagentPresetRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: same column list as `SubagentPresetRow`, keyed on the primary
      // key, so at most one row of exactly that shape.
      const row = db
        .prepare(`SELECT ${SUBAGENT_PRESET_COLUMNS} FROM subagent_presets WHERE preset_id = ?`)
        .get(presetId) as SubagentPresetRow | undefined;
      return row ? rowToSubagentPreset(row) : null;
    } catch (err) {
      console.error("[conversation-store] getSubagentPreset failed:", err);
      return null;
    }
  }

  /** Add a preset to the end of the list. The caller mints the id so it can
   *  draw the preset before the write lands. A preset must have a name; the
   *  fields are clamped the way an agent's are — the editor holds the real
   *  limits, this is the floor that keeps a runaway paste out of the database. */
  createSubagentPreset(input: SubagentPresetCreateInput): SubagentPresetRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const name = clampAgentField(input.name, AGENT_NAME_MAX);
    if (!name) return null;
    try {
      const now = Date.now();
      const presetId = input.presetId ?? randomUUID();
      db.prepare(
        `INSERT INTO subagent_presets
           (preset_id, name, instructions, models, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        presetId,
        name,
        clampAgentField(input.instructions, AGENT_PROSE_MAX),
        serializeModelRef(input.model, input.modelFallbacks),
        this.nextSubagentPresetSortOrder(db),
        now,
        now,
      );
      return this.getSubagentPreset(presetId);
    } catch (err) {
      console.error("[conversation-store] createSubagentPreset failed:", err);
      return null;
    }
  }

  /** Edit a preset, one field at a time. A field left out of the patch is left
   *  alone. The name is the one field that can't be cleared — a preset with no
   *  name is not a preset, so a patch that would blank it changes nothing. */
  updateSubagentPreset(
    presetId: string,
    patch: SubagentPresetPatch,
  ): SubagentPresetRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const edits: Array<[column: string, value: string | null]> = [];
    if (patch.name !== undefined) {
      const name = clampAgentField(patch.name, AGENT_NAME_MAX);
      if (!name) return null;
      edits.push(["name", name]);
    }
    if (patch.instructions !== undefined) {
      edits.push(["instructions", clampAgentField(patch.instructions, AGENT_PROSE_MAX)]);
    }
    if (patch.model !== undefined || patch.modelFallbacks !== undefined) {
      // Same one-column merge as an agent's: see updateAgent.
      const current = this.getSubagentPreset(presetId);
      const primary = patch.model !== undefined ? patch.model : (current?.model ?? null);
      const fallbacks =
        patch.modelFallbacks !== undefined
          ? patch.modelFallbacks
          : (current?.modelFallbacks ?? null);
      edits.push(["models", serializeModelRef(primary, fallbacks)]);
    }
    if (edits.length === 0) return this.getSubagentPreset(presetId);
    try {
      const assignments = edits.map(([column]) => `${column} = ?`).join(", ");
      const values = edits.map(([, value]) => value);
      const result = db
        .prepare(
          `UPDATE subagent_presets SET ${assignments}, updated_at = ? WHERE preset_id = ?`,
        )
        .run(...values, Date.now(), presetId);
      return Number(result.changes) > 0 ? this.getSubagentPreset(presetId) : null;
    } catch (err) {
      console.error("[conversation-store] updateSubagentPreset failed:", err);
      return null;
    }
  }

  /** Remove a preset for good. A preset keeps no thread history — a spawn cut
   *  from it copies the instructions and the resolved model by value — so there
   *  is nothing a tombstone would answer for, and this deletes the row outright.
   *  Returns whether a row was there to remove; deleting a gone preset changes
   *  nothing and is not a failure. */
  deleteSubagentPreset(presetId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const result = db
        .prepare(`DELETE FROM subagent_presets WHERE preset_id = ?`)
        .run(presetId);
      return Number(result.changes) > 0;
    } catch (err) {
      console.error("[conversation-store] deleteSubagentPreset failed:", err);
      return false;
    }
  }

  private nextSubagentPresetSortOrder(db: DatabaseSync): number {
    // SAFETY: a COALESCE'd aggregate over an INTEGER column, as the roster's.
    const row = db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM subagent_presets`)
      .get() as { next: number } | undefined;
    return row?.next ?? 0;
  }

  // ── native sub-agent config ─────────────────────────────────────────────────
  /** The app_state key holding the one JSON document every native's config
   *  lives in: a map of presetId to { enabled, model, modelFallbacks,
   *  updatedAt }. One row rather than a table because the document is small,
   *  read whole, and written whole — a per-native row would only split the
   *  one read every consumer makes. */
  private static readonly NATIVE_SUBAGENT_CONFIG_KEY = "native_subagent_config";

  /** Read the whole config document, or an empty record for a store that never
   *  wrote one. Never throws: a corrupt blob reads as empty, which turns every
   *  native back on with no model — the shipped defaults — rather than closing
   *  the app over a bad row. Parsed here to the column-value terms the
   *  roster-record decoders take, so every entry below goes through the same
   *  validation gate the agent columns do. */
  private readNativeSubagentConfigDoc(db: DatabaseSync): ColumnRecord {
    try {
      // SAFETY: app_state holds at most one row for this key, one TEXT column.
      const row = db
        .prepare(`SELECT value FROM app_state WHERE key = ?`)
        .get(SubagentPresetRepo.NATIVE_SUBAGENT_CONFIG_KEY) as { value: string } | undefined;
      if (!row?.value) return {};
      // SAFETY: disk content is untrusted — parse to the column-value shape
      // and let isColumnRecord below decide, as every JSON column does.
      const parsed = JSON.parse(row.value) as ColumnValue;
      return isColumnRecord(parsed) ? parsed : {};
    } catch (err) {
      console.error("[conversation-store] readNativeSubagentConfigDoc failed:", err);
      return {};
    }
  }

  /** Every native's config, one per shipped definition in list order. A
   *  native with no stored entry reports the default — on, no model — so the
   *  list is always the full five, whatever the document holds. */
  listNativeSubagentConfigs(): NativeSubagentConfig[] {
    const db = this.dbh.handle();
    if (!db) return [];
    const doc = this.readNativeSubagentConfigDoc(db);
    return BUILTIN_SUBAGENT_PRESET_IDS.map((presetId) => {
      const stored = normalizeNativeSubagentEntry(presetId, doc[presetId]);
      return stored ?? { presetId, enabled: true, model: null, modelFallbacks: null, updatedAt: 0 };
    });
  }

  /** One native's config, or the on/no-model default when nothing was stored. */
  getNativeSubagentConfig(presetId: string): NativeSubagentConfig {
    const defaults = { presetId, enabled: true, model: null, modelFallbacks: null, updatedAt: 0 };
    if (!BUILTIN_SUBAGENT_PRESET_IDS.includes(presetId)) return defaults;
    const db = this.dbh.handle();
    if (!db) return defaults;
    const doc = this.readNativeSubagentConfigDoc(db);
    const stored = normalizeNativeSubagentEntry(presetId, doc[presetId]);
    return stored ?? defaults;
  }

  /** Write one native's config. A patch field left out keeps the entry's
   *  current value; a native with no entry yet starts from the default. An
   *  id that is not one of the shipped definitions is refused — a config for
   *  a preset this build never shipped would sit unread in the document. */
  setNativeSubagentConfig(
    presetId: string,
    patch: NativeSubagentConfigPatch,
  ): NativeSubagentConfig | null {
    if (!BUILTIN_SUBAGENT_PRESET_IDS.includes(presetId)) return null;
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      const current = this.getNativeSubagentConfig(presetId);
      // A patch field left out keeps the entry's current value; the pairing is
      // the one normalizeChain owns, so clearing the model drops the tail with
      // it rather than storing a chain with nothing to fall back from.
      const chain = normalizeChain(
        patch.model !== undefined ? patch.model : current.model,
        patch.modelFallbacks !== undefined ? patch.modelFallbacks : current.modelFallbacks,
      );
      const next: NativeSubagentConfig = {
        presetId,
        enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
        model: chain.primary,
        modelFallbacks: chain.fallbacks,
        updatedAt: Date.now(),
      };
      const doc = this.readNativeSubagentConfigDoc(db);
      doc[presetId] = next;
      db.prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(SubagentPresetRepo.NATIVE_SUBAGENT_CONFIG_KEY, JSON.stringify(doc), Date.now());
      return next;
    } catch (err) {
      console.error("[conversation-store] setNativeSubagentConfig failed:", err);
      return null;
    }
  }

  /** Every preset an agent can name, stored first: the user's own rows, then
   *  the configured natives a stored row hasn't shadowed by name. The one
   *  precedence the gateway resolves by, read straight from the store so a
   *  toggle mid-session reaches the next spawn without a restart. */
  listVisiblePresets(): SubagentPresetRecord[] {
    return mergeVisiblePresets(this.listSubagentPresets(), this.listNativeSubagentConfigs());
  }
}

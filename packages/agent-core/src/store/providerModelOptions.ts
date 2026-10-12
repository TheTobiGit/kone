import type { ConversationDb } from "./ConversationDb.js";
import type { InteractionMode, ProviderKind } from "../types.js";
import type { SelectionKnobs } from "../selection.js";

// What each provider+model last ran with. One row per pair, holding the picker
// knobs — effort, service tier, context window, mode — so returning to a model
// restores the knobs it ran with rather than the knobs of whatever ran in
// between. Upserted when a turn is sent or a picker selection commits.

/** A remembered provider+model pair and the knobs that last ran with it.
 *  Absent knobs mean nothing was ever recorded for that axis. */
export type ProviderModelOptionsRecord = {
  provider: ProviderKind;
  model: string;
  knobs: SelectionKnobs;
  updatedAt: number;
};

export type ProviderModelOptionsRow = {
  provider: string;
  model: string;
  effort: string | null;
  service_tier: string | null;
  context_window: string | null;
  mode: string | null;
  updated_at: number;
};

/** The knobs half of the upsert. `model` is required because the pair is the
 *  key; a selection with no model has nowhere to be remembered and the caller
 *  skips it. */
export type ProviderModelOptionsInput = {
  provider: ProviderKind;
  model: string;
  knobs: SelectionKnobs;
  at?: number;
};

function rowToRecord(row: ProviderModelOptionsRow): ProviderModelOptionsRecord {
  const knobs: SelectionKnobs = {};
  if (row.effort) knobs.effort = row.effort;
  if (row.service_tier) knobs.serviceTier = row.service_tier;
  if (row.context_window) knobs.contextWindow = row.context_window;
  if (row.mode === "ask" || row.mode === "accept-edits" || row.mode === "full-access") {
    // SAFETY: the mode column is only ever written from InteractionMode values.
    knobs.mode = row.mode as InteractionMode;
  }
  // SAFETY: the provider column is only ever written from ProviderKind values.
  return { provider: row.provider as ProviderKind, model: row.model, knobs, updatedAt: row.updated_at };
}

export class ProviderModelOptionsRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Remember (or refresh) the knobs that last ran with `provider`+`model`.
   *  Replace, never merge: the value is "what this pair last ran with", and a
   *  knob the current run does not carry has to clear the remembered one, or
   *  a model that once ran with high effort would keep it after the user
   *  turned it down. */
  upsert(input: ProviderModelOptionsInput): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      this.dbh.durably(db, () => {
        db.prepare(
          `INSERT INTO provider_model_options
             (provider, model, effort, service_tier, context_window, mode, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, model) DO UPDATE SET
             effort = excluded.effort,
             service_tier = excluded.service_tier,
             context_window = excluded.context_window,
             mode = excluded.mode,
             updated_at = excluded.updated_at`,
        ).run(
          input.provider,
          input.model,
          input.knobs.effort ?? null,
          input.knobs.serviceTier ?? null,
          input.knobs.contextWindow ?? null,
          input.knobs.mode ?? null,
          input.at ?? Date.now(),
        );
      });
    } catch (err) {
      console.error("[conversation-store] upsertProviderModelOptions failed:", err);
    }
  }

  /** What `provider`+`model` last ran with, or null when nothing was recorded.
   *  A recorded row with every knob absent still answers (the pair was seen,
   *  with the provider's defaults), which is different from never seen. */
  get(provider: ProviderKind, model: string): ProviderModelOptionsRecord | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection names exactly the columns the table creates.
      const row = db
        .prepare(
          `SELECT provider, model, effort, service_tier, context_window, mode, updated_at
             FROM provider_model_options WHERE provider = ? AND model = ?`,
        )
        .get(provider, model) as ProviderModelOptionsRow | undefined;
      return row ? rowToRecord(row) : null;
    } catch (err) {
      console.error("[conversation-store] getProviderModelOptions failed:", err);
      return null;
    }
  }

  /** Every remembered pair, newest first — the read the IPC getter answers. */
  list(): ProviderModelOptionsRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection names exactly the columns the table creates.
      const rows = db
        .prepare(
          `SELECT provider, model, effort, service_tier, context_window, mode, updated_at
             FROM provider_model_options ORDER BY updated_at DESC`,
        )
        .all() as ProviderModelOptionsRow[];
      return rows.map(rowToRecord);
    } catch (err) {
      console.error("[conversation-store] listProviderModelOptions failed:", err);
      return [];
    }
  }
}

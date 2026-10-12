import { z } from "zod";

import type { ConversationDb } from "./ConversationDb.js";
import type { InteractionMode, ProviderKind } from "../types.js";

// The mark for a model or knob change between turns: the same conversation,
// running on a different model or the same model with different knobs, without
// changing provider. A provider change is a hand-in and writes its own
// from→to row, so this table holds only same-provider changes.

/** One between-turns model/knob change. Providers are recorded on both sides
 *  even though they match, so the mark renders the same way a hand-in's does
 *  and a future cross-check needs no extra read. `changedKnobs` names the knob
 *  axes that moved (effort, serviceTier, contextWindow, mode); the model move
 *  is the `fromModel`→`toModel` pair itself. */
export type ModelChangeRecord = {
  threadId: string;
  at: number;
  fromProvider: ProviderKind;
  fromModel?: string;
  toProvider: ProviderKind;
  toModel?: string;
  changedKnobs: string[];
};

export type ModelChangeRow = {
  thread_id: string;
  at: number;
  from_provider: string | null;
  from_model: string | null;
  to_provider: string;
  to_model: string | null;
  changed_knobs_json: string | null;
};

const KnobNamesWire = z.array(z.string().min(1));

function parseKnobNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = KnobNamesWire.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: ModelChangeRow): ModelChangeRecord {
  // SAFETY: to_provider is only ever written from a ProviderKind-typed input.
  const record: ModelChangeRecord = {
    threadId: row.thread_id,
    at: row.at,
    // SAFETY: from_provider is only ever written from a ProviderKind value, or
    // NULL on a row whose change named no provider.
    fromProvider: row.from_provider as ProviderKind,
    toProvider: row.to_provider as ProviderKind,
    changedKnobs: parseKnobNames(row.changed_knobs_json),
  };
  if (row.from_model) record.fromModel = row.from_model;
  if (row.to_model) record.toModel = row.to_model;
  return record;
}

export type ModelChangeInput = {
  threadId: string;
  at: number;
  fromProvider: ProviderKind;
  fromModel?: string;
  toProvider: ProviderKind;
  toModel?: string;
  changedKnobs: readonly string[];
};

export class ModelChangeRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Record one same-provider model/knob change. A change that moved nothing
   *  should not reach here; the caller decides what counts. */
  record(input: ModelChangeInput): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      this.dbh.durably(db, () => {
        db.prepare(
          `INSERT INTO thread_model_changes
             (thread_id, at, from_provider, from_model, to_provider, to_model, changed_knobs_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.threadId,
          input.at,
          input.fromProvider,
          input.fromModel ?? null,
          input.toProvider,
          input.toModel ?? null,
          input.changedKnobs.length > 0 ? JSON.stringify(input.changedKnobs) : null,
        );
      });
    } catch (err) {
      console.error("[conversation-store] recordModelChange failed:", err);
    }
  }

  /** Every model/knob change on a thread, oldest first — the timeline marks.
   *  Empty for a thread that never changed model or knobs between turns. */
  forThread(threadId: string): ModelChangeRecord[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection names exactly the columns the table creates.
      const rows = db
        .prepare(
          `SELECT thread_id, at, from_provider, from_model, to_provider, to_model, changed_knobs_json
             FROM thread_model_changes WHERE thread_id = ? ORDER BY at ASC, change_id ASC`,
        )
        .all(threadId) as ModelChangeRow[];
      return rows.map(rowToRecord);
    } catch (err) {
      console.error("[conversation-store] modelChangesForThread failed:", err);
      return [];
    }
  }
}

/** The knob axes two knob sets differ on, in picker order. Empty when they
 *  are equal. */
export function changedKnobNames(
  from: {
    effort?: string;
    serviceTier?: string;
    contextWindow?: string;
    mode?: InteractionMode;
  },
  to: {
    effort?: string;
    serviceTier?: string;
    contextWindow?: string;
    mode?: InteractionMode;
  },
): string[] {
  const names: string[] = [];
  if ((from.effort ?? "") !== (to.effort ?? "")) names.push("effort");
  if ((from.serviceTier ?? "") !== (to.serviceTier ?? "")) names.push("serviceTier");
  if ((from.contextWindow ?? "") !== (to.contextWindow ?? "")) names.push("contextWindow");
  if ((from.mode ?? "") !== (to.mode ?? "")) names.push("mode");
  return names;
}

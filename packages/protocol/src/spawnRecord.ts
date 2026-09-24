// The record a worker spawn leaves behind, written and read in one place.
//
// A spawn opens a second thread, which the parent's transcript cannot see. What
// survives the call in the parent is its tool result — stored against the item,
// re-read by the agent resuming the thread and by the thread's own UI long after
// the spawn itself. That makes the result a contract between two packages:
// agent-core writes it, the renderer reads it back to say, in the reply, who was
// handed what and why.
//
// Both halves live here so neither can be changed alone. The result text is a
// JSON record (the child's handle, what it was given, why, plus the human
// sentence the model reads), the same shape of contract the appearance tools
// keep in themeSummary.ts.

import { z } from "zod";

const SpawnRecordSchema = z.object({
  /** The child thread's kone id — also the seed its agent's face and name are
   *  derived from. */
  threadId: z.string().min(1),
  /** The worker's working title — what it was given. */
  title: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  /** The preset the worker was cut from, by name — absent for a worker the
   *  parent briefed from scratch. */
  preset: z.string().min(1).optional(),
  /** The project teammate the work was delegated to, by name — the child runs
   *  as that agent rather than as an anonymous worker. */
  agent: z.string().min(1).optional(),
  /** That teammate's roster id — what the thread draws their face from, so a
   *  renamed teammate still reads as themselves. */
  agentId: z.string().min(1).optional(),
  /** Why the parent handed this off, in its own words, when it said. */
  why: z.string().min(1).nullable(),
  /** The human sentence for this spawn, kept for the model reading the result
   *  and the agent resuming the thread. */
  summary: z.string().min(1),
});

export type SpawnRecord = z.infer<typeof SpawnRecordSchema>;

/** Encode a spawn as the tool result text the item stores. */
export function formatSpawnRecord(record: SpawnRecord): string {
  return JSON.stringify(record);
}

/** A batch dispatch: every spawn that opened, in item order, plus the sentence
 *  for the whole batch — which also names the items that were refused. */
const SpawnBatchRecordSchema = z.object({
  spawns: z.array(SpawnRecordSchema).min(1),
  summary: z.string().min(1),
});

export type SpawnBatchRecord = z.infer<typeof SpawnBatchRecordSchema>;

/** Encode a batch as the tool result text the item stores. */
export function formatSpawnBatchRecord(record: SpawnBatchRecord): string {
  return JSON.stringify(record);
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    // SAFETY: JSON.parse yields whatever the text held; the zod schemas are
    // the only gate before the value is trusted.
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The spawn a result text records, or null for anything that records none — a
 *  refusal, a sentence written before results carried data, or an in-progress
 *  input dump. Reads data only: the sentence inside is never interpreted. */
export function parseSpawnRecord(text: string | null | undefined): SpawnRecord | null {
  const result = SpawnRecordSchema.safeParse(parseJson(text));
  return result.success ? result.data : null;
}

/** Every spawn a result text records — one for a single spawn or delegation,
 *  each that opened for a batch, none for anything else. */
export function parseSpawnRecords(text: string | null | undefined): SpawnRecord[] {
  const parsed = parseJson(text);
  const single = SpawnRecordSchema.safeParse(parsed);
  if (single.success) return [single.data];
  const batch = SpawnBatchRecordSchema.safeParse(parsed);
  return batch.success ? batch.data.spawns : [];
}

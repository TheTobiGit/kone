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
// JSON envelope — every thread the call opened, plus the human sentence the
// model reads — the same shape of contract the appearance tools keep in
// themeSummary.ts. A single spawn is an envelope of one.

import { z } from "zod";

/** The tools that open threads and leave a spawn result behind. The gateway
 *  registers them under these names and the renderer reads their results by
 *  them, so a rename lands on both sides at once. */
export const SPAWN_TOOL_NAMES = [
  "kone_spawn_worker",
  "kone_spawn_worker_preset",
  "kone_delegate_to_teammate",
  "kone_spawn_batch",
] as const;

export type SpawnToolName = (typeof SPAWN_TOOL_NAMES)[number];

const SPAWN_TOOL_NAME_SET: ReadonlySet<string> = new Set(SPAWN_TOOL_NAMES);

export function isSpawnToolName(name: string): name is SpawnToolName {
  return SPAWN_TOOL_NAME_SET.has(name);
}

/** The longest reason a dispatch accepts. The tool input refuses anything
 *  longer, so a record never holds more. */
export const SPAWN_WHY_MAX_CHARS = 280;

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
  /** Why the parent handed this off, as the clause that follows "because" —
   *  already cleaned by spawnWhy, or null when it gave no reason. */
  why: z.string().min(1).nullable(),
});

export type SpawnRecord = z.infer<typeof SpawnRecordSchema>;

/** A dispatch's result: every thread that opened, in item order, plus the
 *  sentence for the model — which for a batch also names the items that were
 *  refused. */
export type SpawnResult = {
  spawns: SpawnRecord[];
  summary: string;
};

/** The reason as a record keeps it: the clause after "because", so a model
 *  that wrote its own "because" or closed on a full stop reads the same as one
 *  that didn't. Null when nothing is left. */
export function spawnWhy(text: string | null | undefined): string | null {
  const clause = (text ?? "")
    .trim()
    .replace(/^because\s+/i, "")
    .replace(/[.\s]+$/, "");
  return clause || null;
}

/** Encode a dispatch as the tool result text the item stores. */
export function formatSpawnResult(result: SpawnResult): string {
  return JSON.stringify(result);
}

// Read keyed on `spawns`. A bare record is the single-spawn text an earlier
// build wrote before every result was an envelope — still stored in threads
// from then, so it still reads as one spawn.
const StoredSpawnsSchema = z.union([
  z.object({ spawns: z.array(SpawnRecordSchema).min(1) }).transform((result) => result.spawns),
  SpawnRecordSchema.transform((record) => [record]),
]);

/** Every thread a result text records, in item order — none for anything that
 *  records none: a refusal, a sentence written before results carried data, or
 *  an in-progress input dump. Reads data only: the sentence inside is never
 *  interpreted. */
export function parseSpawnRecords(text: string | null | undefined): SpawnRecord[] {
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const parsed = StoredSpawnsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

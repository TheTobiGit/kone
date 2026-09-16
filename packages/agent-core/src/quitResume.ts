import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { z } from "zod";

import { writeFileAtomicSync } from "./lib-atomicWrite.js";
import type { JsonValue } from "./lib-jsonValue.js";
import { userDataPath } from "./userDataDir.js";

// quitResume — pick up chats that were running when the app quit.
//
// Quitting while turns are in flight used to lose them silently: the process
// died, the next launch sealed every orphaned turn as interrupted, and nothing
// ever continued them. This module closes that loop with a small JSON record
// beside the other agent state:
//
// - Before the quit is allowed to proceed, `prepareQuitResume` snapshots every
//   thread with a live turn (naming the turn that was running, or nothing while
//   the provider was still connecting), writes the record durably, arms an
//   abandon sweep, and interrupts those turns. A failed write rejects so the
//   caller can fall back to a plain interrupt-and-quit.
// - A quit can still be cancelled after the record exists. If this process is
//   still alive `QUIT_RESUME_ABANDON_AFTER_MS` after writing it, the quit
//   evidently did not happen and the sweep removes the record, so an unrelated
//   later start never resurrects those chats.
// - At the next start `claimQuitResumeRecordAtStartup` consumes the record
//   before the window exists (one existence check when there is nothing to do;
//   an atomic rename-then-delete when there is — a crash in between loses the
//   resume rather than doubling it), and `resumeQuitInterruptedChats` filters
//   out threads that moved on since, then dispatches one silent continuation
//   turn per remaining thread. Dispatches run serialized with a fresh
//   precondition re-check immediately before each, so a client command landing
//   between the plan and a dispatch meets either the re-check or the busy
//   claim of an already-dispatched turn, never a stale plan row.
//
// Accepted residual windows (each needs a second quit or a new turn to land
// within microseconds of the first): a turn that replaces the recorded one
// inside the prepare call is interrupted and not resumed; a second quit
// prepared exactly when the first one's abandon sweep fires loses its record;
// a client turn that wins the race onto an idle thread between the re-check
// and the adapter's busy claim queues the continuation behind it instead of
// running it first.

/** File this module owns, next to the other agent state in the user data dir. */
export const QUIT_RESUME_FILENAME = "quit-resume.json";

/**
 * A record still owned by a live process this long after it was written
 * belongs to a quit that was cancelled and must not survive. A real quit
 * tears this process down within seconds, so anything this old is stale.
 */
export const QUIT_RESUME_ABANDON_AFTER_MS = 30_000;

/** Upper bound on one record: one file, one boot storm, both stay small. */
export const QUIT_RESUME_MAX_THREADS = 50;

/** Upper bound on the continuation prompt a caller may supply. */
export const QUIT_RESUME_MAX_PROMPT_CHARS = 4_000;

/** What the resumed turn asks for. The thread's transcript digest (when the
 *  provider came up without context) rides in front of it automatically. */
export const DEFAULT_QUIT_RESUME_PROMPT =
  "Kone was closed while this chat was still running. Continue where you left off.";

/** One thread remembered by a record: the turn in flight when it was written,
 *  or null while the provider was still connecting and no turn existed yet. */
export interface QuitResumeThreadEntry {
  threadId: string;
  turnId: string | null;
}

export interface QuitResumeRecord {
  version: 1;
  /** Unique per quit, so a retried prepare never collides with its own past. */
  recordId: string;
  /** ms epoch the snapshot was taken — the "moved on since" baseline. */
  recordedAt: number;
  continuationPrompt: string;
  threads: QuitResumeThreadEntry[];
}

export type QuitResumeRecordRead =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "record"; record: QuitResumeRecord };

export type QuitResumeSkipReason =
  | "thread-missing"
  | "thread-archived"
  | "turn-in-flight"
  | "turn-completed"
  | "dispatch-failed";

export interface QuitResumeSkipped {
  threadId: string;
  reason: QuitResumeSkipReason;
}

export interface QuitResumePlan {
  threadIds: string[];
  skipped: QuitResumeSkipped[];
}

/** One live turn at prepare time: the running turn id, or null while the send
 *  is still on its way to the adapter and no turn has been announced yet. */
export interface QuitResumeFlight {
  threadId: string;
  turnId: string | null;
}

/** The live side prepare needs: snapshot who is busy, interrupt them after. */
export interface QuitResumeQuitter {
  inFlightTurns(): QuitResumeFlight[];
  interruptTurn(threadId: string): Promise<void>;
}

/** The settled-state facts the boot-time filter needs per assistant turn. */
export interface QuitResumeAssistantTurn {
  turnId: string;
  state: "running" | "completed" | "failed" | "interrupted";
  /** ms epoch the turn started. */
  at: number;
  /** ms epoch the turn settled, or null while it never did. */
  endedAt: number | null;
}

/** Everything the filter reads about one recorded thread, fresh per read. */
export interface QuitResumeThreadSnapshot {
  threadId: string;
  /** No row for this id — deleted, or never existed here. */
  missing: boolean;
  archived: boolean;
  /** A turn is live on the service right now. */
  busy: boolean;
  /** Assistant turns oldest first; empty on a thread that never ran one. */
  turns: QuitResumeAssistantTurn[];
}

const QuitResumeRecordSchema = z.object({
  version: z.literal(1),
  recordId: z.string().min(1),
  recordedAt: z.number(),
  continuationPrompt: z.string().min(1).max(QUIT_RESUME_MAX_PROMPT_CHARS),
  threads: z
    .array(
      z.object({
        threadId: z.string().min(1),
        turnId: z.string().min(1).nullable(),
      }),
    )
    .max(QUIT_RESUME_MAX_THREADS),
});

/** This module's state file. No caching — it runs at most twice per process. */
export function quitResumeFilePath(): string {
  return userDataPath(QUIT_RESUME_FILENAME);
}

/**
 * Snapshot the live flights into a record. Pure: duplicates collapse, order
 * is kept, the cap bounds one file and one boot storm.
 */
export function buildQuitResumeRecord(input: {
  inFlight: QuitResumeFlight[];
  recordId: string;
  now: number;
  continuationPrompt: string;
}): QuitResumeRecord {
  const seen = new Set<string>();
  const threads: QuitResumeThreadEntry[] = [];
  for (const flight of input.inFlight) {
    if (seen.has(flight.threadId)) continue;
    seen.add(flight.threadId);
    threads.push({ threadId: flight.threadId, turnId: flight.turnId });
    if (threads.length >= QUIT_RESUME_MAX_THREADS) break;
  }
  return {
    version: 1,
    recordId: input.recordId,
    recordedAt: input.now,
    continuationPrompt: input.continuationPrompt,
    threads,
  };
}

/**
 * Why one recorded thread must not be resumed right now, or null when it is
 * still exactly where the quit left it. A thread moved on when a turn
 * completed on its own after the record was written — an answer that arrived
 * leaves nothing to continue. Anything else (interrupted, failed, never
 * started) still wants its continuation.
 */
export function quitResumeSkipReason(
  snapshot: QuitResumeThreadSnapshot | null,
  recordedAt: number,
): QuitResumeSkipReason | null {
  if (snapshot === null || snapshot.missing) return "thread-missing";
  if (snapshot.archived) return "thread-archived";
  if (snapshot.busy) return "turn-in-flight";
  for (const turn of snapshot.turns) {
    // A block still marked running has an owner the snapshot cannot see (or
    // the boot sealer has not run yet) — never dispatch a second turn onto it.
    if (turn.state === "running") return "turn-in-flight";
  }
  for (const turn of snapshot.turns) {
    if (turn.state === "completed" && (turn.endedAt ?? turn.at) > recordedAt) {
      return "turn-completed";
    }
  }
  return null;
}

/**
 * Map a consumed record onto fresh snapshots. Pure: keeps every thread the
 * filter clears, skips the rest with its reason.
 */
export function planQuitResumeTurns(input: {
  record: QuitResumeRecord;
  snapshots: QuitResumeThreadSnapshot[];
}): QuitResumePlan {
  const byId = new Map<string, QuitResumeThreadSnapshot>();
  for (const snapshot of input.snapshots) byId.set(snapshot.threadId, snapshot);
  const threadIds: string[] = [];
  const skipped: QuitResumeSkipped[] = [];
  for (const entry of input.record.threads) {
    const snapshot = byId.get(entry.threadId) ?? null;
    const reason = quitResumeSkipReason(snapshot, input.record.recordedAt);
    if (reason === null) threadIds.push(entry.threadId);
    else skipped.push({ threadId: entry.threadId, reason });
  }
  return { threadIds, skipped };
}

/** Durably replace the record. Throws on failure — the caller falls back to a
 *  plain interrupt-and-quit when there is no record to resume from. */
export function persistQuitResumeRecord(recordPath: string, record: QuitResumeRecord): void {
  writeFileAtomicSync(recordPath, `${JSON.stringify(record)}\n`);
}

function decodeQuitResumeRecord(raw: JsonValue): QuitResumeRecord | null {
  const parsed = QuitResumeRecordSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  return {
    version: 1,
    recordId: data.recordId,
    recordedAt: data.recordedAt,
    continuationPrompt: data.continuationPrompt,
    threads: data.threads.map((entry) => ({ threadId: entry.threadId, turnId: entry.turnId })),
  };
}

/** `absent` when there is no file; `invalid` when one is there but unreadable. */
export function readQuitResumeRecord(recordPath: string): QuitResumeRecordRead {
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath, "utf8");
  } catch {
    return { kind: "absent" };
  }
  if (raw.trim().length === 0) return { kind: "invalid" };
  let json: JsonValue;
  try {
    // SAFETY: JSON.parse yields only plain JSON values, which JsonValue models.
    json = JSON.parse(raw) as JsonValue;
  } catch {
    return { kind: "invalid" };
  }
  const record = decodeQuitResumeRecord(json);
  if (record === null) return { kind: "invalid" };
  return { kind: "record", record };
}

/** Remove the record. Best-effort: absence reads the same as removed. */
export function clearQuitResumeRecord(recordPath: string): void {
  try {
    fs.unlinkSync(recordPath);
  } catch {
    // Already gone, or never written — either way there is nothing to resume.
  }
}

/**
 * Take exclusive ownership of whatever record is at `recordPath`: an atomic
 * rename to a claimant-unique sibling (so two claimants cannot both win),
 * read it, then remove the private copy. `absent` when there was nothing to
 * claim. A private copy stranded by a crash between the rename and the delete
 * is never mistaken for a fresh record — the original path is already gone,
 * so the next claim reads absent and the resume is lost rather than doubled.
 */
export function claimQuitResumeRecord(recordPath: string): QuitResumeRecordRead {
  if (!fs.existsSync(recordPath)) return { kind: "absent" };
  const claimedPath = `${recordPath}.${process.pid}.${randomUUID()}.claimed`;
  try {
    fs.renameSync(recordPath, claimedPath);
  } catch (err) {
    console.warn("[quit-resume] record could not be claimed; skipping resume:", err);
    return { kind: "absent" };
  }
  const read = readQuitResumeRecord(claimedPath);
  try {
    fs.unlinkSync(claimedPath);
  } catch (err) {
    console.warn("[quit-resume] claimed record could not be removed:", err);
  }
  return read;
}

/**
 * Boot-time claim. Cheap when there is nothing to resume — one existence
 * check. Must run before the window exists so no freshly connected client can
 * interleave a new command (or a new quit) with the consume.
 */
export function claimQuitResumeRecordAtStartup(recordPath?: string): QuitResumeRecordRead {
  const claimed = claimQuitResumeRecord(recordPath ?? quitResumeFilePath());
  if (claimed.kind === "invalid") {
    console.warn("[quit-resume] dropped an unreadable quit-resume record");
  }
  return claimed;
}

/** Remove the record only if it is still the one with `recordId`: a newer
 *  quit may have replaced it meanwhile and must keep its own record. */
function clearQuitResumeRecordIfOwned(recordPath: string, recordId: string): boolean {
  const current = readQuitResumeRecord(recordPath);
  if (current.kind !== "record" || current.record.recordId !== recordId) return false;
  try {
    fs.unlinkSync(recordPath);
  } catch {
    return false;
  }
  return true;
}

/**
 * Record first (a failed write rejects so the caller can fall back to a plain
 * interrupt-and-quit), then arm the abandon sweep and interrupt every recorded
 * thread. Interrupts are best-effort and detached — the write is the
 * acknowledgement, shutdown itself stops any turn an interrupt does not reach,
 * and the boot reconciliation seals whatever is left. Nothing in flight means
 * no record at all: absence already reads as nothing to resume.
 */
export async function prepareQuitResume(input: {
  quitter: QuitResumeQuitter;
  recordPath?: string;
  continuationPrompt?: string;
  recordId?: string;
  now?: number;
  abandonAfterMs?: number;
}): Promise<{ recordedThreadIds: string[]; recordedAt: number }> {
  const now = input.now ?? Date.now();
  const record = buildQuitResumeRecord({
    inFlight: input.quitter.inFlightTurns(),
    recordId: input.recordId ?? randomUUID(),
    now,
    continuationPrompt: input.continuationPrompt ?? DEFAULT_QUIT_RESUME_PROMPT,
  });
  if (record.threads.length === 0) return { recordedThreadIds: [], recordedAt: now };
  const target = input.recordPath ?? quitResumeFilePath();
  persistQuitResumeRecord(target, record);

  // Detached on purpose: if this process is still alive this long later, the
  // quit was cancelled and the record must go. On a real quit the process dies
  // first and the timer dies with it — and it never holds the process open.
  const abandonAfterMs = input.abandonAfterMs ?? QUIT_RESUME_ABANDON_AFTER_MS;
  const sweep = setTimeout(() => {
    try {
      if (clearQuitResumeRecordIfOwned(target, record.recordId)) {
        console.warn("[quit-resume] quit did not complete; dropped the quit-resume record");
      }
    } catch (err) {
      console.warn("[quit-resume] abandon sweep failed:", err);
    }
  }, abandonAfterMs);
  sweep.unref?.();

  for (const entry of record.threads) {
    void input.quitter.interruptTurn(entry.threadId).catch((err) => {
      console.warn(`[quit-resume] interrupt for thread ${entry.threadId} failed:`, err);
    });
  }
  return {
    recordedThreadIds: record.threads.map((entry) => entry.threadId),
    recordedAt: record.recordedAt,
  };
}

function missingSnapshot(threadId: string): QuitResumeThreadSnapshot {
  return { threadId, missing: true, archived: false, busy: false, turns: [] };
}

/**
 * Boot-time consumer of a claimed record. Plans from one snapshot read per
 * thread, then dispatches serialized — one thread fully re-checked and sent
 * before the next begins — so a client command landing mid-loop meets either
 * the fresh re-check or the busy claim of a dispatched turn. Every failure is
 * contained per thread: resuming must never fail startup.
 */
export async function resumeQuitInterruptedChats(input: {
  claimed: QuitResumeRecordRead;
  readSnapshot: (threadId: string) => QuitResumeThreadSnapshot | null;
  dispatchResumeTurn: (threadId: string, prompt: string) => Promise<void>;
}): Promise<{ resumed: string[]; skipped: QuitResumeSkipped[] }> {
  const resumed: string[] = [];
  const skipped: QuitResumeSkipped[] = [];
  if (input.claimed.kind !== "record") return { resumed, skipped };
  const record = input.claimed.record;
  const plan = planQuitResumeTurns({
    record,
    snapshots: record.threads.map(
      (entry) => input.readSnapshot(entry.threadId) ?? missingSnapshot(entry.threadId),
    ),
  });
  for (const skip of plan.skipped) skipped.push(skip);
  for (const threadId of plan.threadIds) {
    const fresh = input.readSnapshot(threadId) ?? missingSnapshot(threadId);
    const reason = quitResumeSkipReason(fresh, record.recordedAt);
    if (reason !== null) {
      skipped.push({ threadId, reason });
      continue;
    }
    try {
      await input.dispatchResumeTurn(threadId, record.continuationPrompt);
      resumed.push(threadId);
    } catch (err) {
      console.warn(`[quit-resume] resume turn for thread ${threadId} failed:`, err);
      skipped.push({ threadId, reason: "dispatch-failed" });
    }
  }
  return { resumed, skipped };
}

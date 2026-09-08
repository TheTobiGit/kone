// ── spawn status projection (docs/thread-spawning-design.md §6 Wave 1 row C) ─
// One pure function turns the raw facts about a spawned child — its stored
// turns, its gate, whether a live session still backs it — into the single
// `SpawnedThread` snapshot BOTH consumers read: the parent agent via
// kone_wait_for_responses, and the UI via thread.spawned / thread.spawn-updated.
// Exactly one projection, deliberately: two view models over one child is how
// panel models drift apart (trap #10), and drift here means a parent waits on
// a child the UI already shows as dead.
//
// The status precedence is load-bearing, not cosmetic:
//
//   gate → running turn → last settled turn → no turns (starting | stillborn)
//
// A gate outranks a running turn because a parked child is the only state
// where nothing moves until a human acts — a parked child that still reads
// "working" is how an orchestrator waits forever. A 'running' block without a
// live session is the same trap in another costume: the process that would
// finish the turn is gone, so the child reads interrupted, never working. A
// thread with no turns at all reads "starting" while a live session backs it
// (the spawn is in flight) and STILLBORN once nothing does (a crash between
// the row write and dispatch) — stillborn is terminal, so a parent wait on a
// half-created child settles instead of hanging forever (F8).
//
// The module holds no store and no I/O; the engine gathers the facts and
// feeds them in. The only thing it lets cross back into the parent's context
// is `summary` — the child's capped narrative — because everything else (tool
// calls, reasoning, intermediate output) stays isolated in the child thread,
// readable on demand.

import { SPAWN_SUMMARY_CHAR_CAP } from "./types.js";
import type {
  ApprovalRequest,
  ProviderKind,
  SpawnedThread,
  SpawnedThreadStatus,
  ThreadGateKind,
  ThreadStatus,
} from "./types.js";

/** One stored assistant turn, oldest first. */
export type SpawnProjectionTurn = {
  turnId: string;
  state: "running" | "completed" | "failed" | "interrupted";
  at: number;
  endedAt?: number;
  error?: string;
};

/** A child parked on a human: the one thing that outranks "working". An
 *  approval gate carries the parked requestId + the normalized ask, so the
 *  renderer can answer it in place via the child's own thread id —
 *  `agent:respond(threadId, requestId, decision)` — without routing through
 *  the parent. A user-input gate has no decide action: it resolves through the
 *  child's own thread, so it carries only the words. */
export type SpawnGate = {
  kind: ThreadGateKind;
  detail: string;
  /** The parked approval's requestId — present exactly for approval gates. */
  requestId?: string;
  /** The normalized ask — present exactly for approval gates. */
  approval?: ApprovalRequest;
};

/** Everything the projection needs about a child. The engine resolves each
 *  piece from the store and the agent layer — none of them this module's job. */
export type SpawnProjectionInput = {
  thread: {
    threadId: string;
    parentThreadId: string;
    title: string;
    provider: ProviderKind;
    model?: string;
    effort?: string;
    createdAt: number;
    updatedAt: number;
  };
  /** The child's assistant turns, oldest first. */
  turns: SpawnProjectionTurn[];
  /** The child's most recent assistant text — the narrative only; reasoning,
   *  plan and tool-call items were already excluded upstream. */
  latestAssistantText?: string | null;
  /** Set while the child is blocked on an approval or a question. */
  gate?: SpawnGate | null;
  /** Whether a live provider session still backs this thread. */
  hasLiveSession: boolean;
  tokens?: number;
  now: number;
};

// ── shared status projection ──────────────────────────────────────────────
// One pure precedence ladder for every thread status in the app — top-level
// threads (via projectThreadStatus) and spawned children (via
// projectSpawnedThread) alike. Two projections over one ladder is how the
// list and the dock drift apart: a parked thread reading "working" in one
// place and "waiting" in another is how an orchestrator waits forever.
//
// The precedence is load-bearing, not cosmetic:
//
//   gate → running turn → last settled turn → no turns (starting | terminal)
//
// A gate outranks a running turn because a parked thread is the only state
// where nothing moves until a human acts. A running turn without a live
// session reads interrupted, never working: the process that would finish it
// is gone. A thread with no turns at all reads "starting" while a live
// session backs it (the first turn is in flight) and settles into its
// terminal kind once nothing does.
//
// The single divergence between the two readers is what "settled and quiet"
// means: an ordinary top-level thread goes back to `idle` — nothing
// happening, ready for the next turn — while a spawned child is terminal,
// `completed` when it turned and `stillborn` when it never started (a crash
// between the row write and dispatch must settle a parent's wait, not hang
// it). Callers name it with `terminalKind`; everything above it is shared.

/** What "settled and quiet" reads as: `idle` for a top-level thread the user
 *  can keep talking in, `completed` for a spawned child that turned,
 *  `stillborn` for one that never started. */
export type ThreadTerminalKind = "idle" | "completed" | "stillborn";

/** Everything the status ladder needs, as plain facts — no store rows. The
 *  caller decomposes its readout at the boundary (a TurnSpan's running count
 *  and newest state, a turn list's running flag and last state), so this
 *  stays pure over primitives and both readers feed it the same shape. */
export interface ThreadStatusInput {
  /** Set while the thread is blocked on an approval or a question. */
  gate?: ThreadGateKind | null;
  /** Whether any turn is still running. */
  running: boolean;
  /** How the newest turn settled, or null when the thread has no turns yet. */
  lastState: "running" | "completed" | "failed" | "interrupted" | null;
  /** Whether a live provider session still backs this thread. */
  hasLiveSession: boolean;
}

/** The full status input: the shared facts plus what "settled and quiet"
 *  reads as for this reader. */
export interface StatusProjectionInput extends ThreadStatusInput {
  terminalKind: ThreadTerminalKind;
}

/** Project the raw facts about a thread into its status. Pure: no store, no
 *  I/O, never throws. The status is derived at read time and never
 *  persisted, so a crash between a turn's start and its finish cannot leave
 *  a dead thread labelled "working" — the next read recomputes from what is
 *  actually there. */
export function projectStatus(input: StatusProjectionInput): SpawnedThreadStatus {
  const gate = input.gate ?? null;
  if (gate === "approval") return "waiting-for-approval";
  if (gate === "user-input") return "waiting-for-user-input";
  // A last state of "running" with the flag down is contradictory input (the
  // newest block cannot be running while no turn is); read it as running
  // rather than as settled, so a torn readout never reports a quiet thread.
  if (input.running || input.lastState === "running") {
    return input.hasLiveSession ? "working" : "interrupted";
  }
  if (input.lastState === "failed") return "failed";
  if (input.lastState === "interrupted") return "interrupted";
  if (input.lastState === null) {
    // No turns at all. A live session still backing the thread means the
    // first turn is in flight; otherwise the thread is settled into whatever
    // quiet means for this reader.
    return input.hasLiveSession ? "starting" : input.terminalKind;
  }
  // Settled-ok (lastState "completed"): quiet for a top-level thread, done
  // for a spawned child. "stillborn" is unreachable here — a caller that
  // names it has no turns, so it always answers from the branch above.
  return input.terminalKind === "idle" ? "idle" : "completed";
}

/** Project the raw facts about a top-level thread into its status. The
 *  shared ladder with the quiet kind fixed to `idle`: a top-level thread
 *  never settles terminally. Pure: no store, no I/O, never throws. */
export function projectThreadStatus(input: ThreadStatusInput): ThreadStatus {
  const status = projectStatus({ ...input, terminalKind: "idle" });
  // SAFETY: terminalKind "idle" answers "starting", "idle" or a shared rung —
  // never "completed" or "stillborn" — so narrowing to ThreadStatus holds.
  return status as ThreadStatus;
}

/** One scan over every parked ask into the gate each thread is parked on. An
 *  approval outranks a question on the same thread: it is the same
 *  gate-outranks precedence the status ladder reads, applied once here so a
 *  thread with both parked never reports the lesser block. Snapshot the
 *  result and answer per-thread lookups off it rather than rescanning the
 *  parked list once per thread. */
export function indexThreadGates(
  pending: Iterable<{ threadId: string; kind: "approval" | "user-input" }>,
): Map<string, ThreadGateKind> {
  const gates = new Map<string, ThreadGateKind>();
  for (const row of pending) {
    if (row.kind === "approval") {
      gates.set(row.threadId, "approval");
    } else if (!gates.has(row.threadId)) {
      gates.set(row.threadId, "user-input");
    }
  }
  return gates;
}

/** One thread's gate out of a snapshot built by indexThreadGates: an O(1)
 *  lookup, null when nothing is parked on the thread. */
export function threadGateFor(
  gates: ReadonlyMap<string, ThreadGateKind>,
  threadId: string,
): ThreadGateKind | null {
  return gates.get(threadId) ?? null;
}

/** Appended to a summary that exceeded SPAWN_SUMMARY_CHAR_CAP, on its own
 *  line, so the reader knows the rest exists and where to find it. */
export const SPAWN_SUMMARY_TRUNCATION_MARKER =
  "\n— the rest of the reply is in the child's transcript; read it with kone_read_response —";

/** Project the raw facts about a spawned child into the single snapshot both
 *  the wait tool and the UI consume. Pure: no store, no I/O, never throws —
 *  malformed input (a completed turn missing its ended_at, turns out of
 *  order) still produces a sane snapshot. */
export function projectSpawnedThread(input: SpawnProjectionInput): SpawnedThread {
  const { thread, turns, now } = input;
  const gate = input.gate ?? null;
  const latestText = (input.latestAssistantText ?? "").trim();

  let status: SpawnedThreadStatus;
  let terminal: boolean;
  let detail: string | undefined;
  const last = turns[turns.length - 1];

  if (gate) {
    // A parked child outranks everything, including a running turn: nothing
    // moves until a human acts, and the parent must surface that block
    // instead of burning its wait window on a thread that cannot progress.
    // The gate rung itself comes from the shared ladder; only the parked
    // detail stays here, because the top-level reader has no detail to carry.
    status = gate.kind === "approval" ? "waiting-for-approval" : "waiting-for-user-input";
    terminal = false;
    detail = gate.detail;
  } else {
    // Every other rung is the shared ladder, with the quiet kind picked by
    // whether the child ever turned: a thread with turns settles `completed`,
    // one reserved but never dispatched settles `stillborn`.
    status = projectStatus({
      gate: null,
      running: turns.some((t) => t.state === "running"),
      lastState: last?.state ?? null,
      hasLiveSession: input.hasLiveSession,
      terminalKind: turns.length > 0 ? "completed" : "stillborn",
    });
    // Only a live-backed rung moves on its own: "working" is mid-turn and
    // "starting" is pre-first-turn, and everything else has settled.
    terminal = status !== "working" && status !== "starting";
    if (status === "failed") {
      // A failed turn carries its error up as the detail, so the parent can
      // tell the user what broke.
      detail = last?.error || undefined;
    }
  }

  // Wall-clock the child's turns have actually occupied: running turns measure
  // to "now", settled turns to their ended_at. Floored per turn — clock skew
  // must never sum into a negative elapsed. Omitted when the child has never
  // turned.
  const elapsedMs =
    turns.length === 0
      ? undefined
      : turns.reduce((sum, t) => sum + Math.max(0, (t.endedAt ?? now) - t.at), 0);

  // The narrative is the ONLY thing that rides back to the parent, capped so
  // a verbose child cannot flood the parent's context.
  const summary = latestText
    ? latestText.length > SPAWN_SUMMARY_CHAR_CAP
      ? `${latestText.slice(0, SPAWN_SUMMARY_CHAR_CAP)}${SPAWN_SUMMARY_TRUNCATION_MARKER}`
      : latestText
    : undefined;

  const projection: SpawnedThread = {
    threadId: thread.threadId,
    parentThreadId: thread.parentThreadId,
    title: thread.title,
    provider: thread.provider,
    status,
    terminal,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
  if (thread.model) projection.model = thread.model;
  if (thread.effort) projection.effort = thread.effort;
  if (elapsedMs !== undefined) projection.elapsedMs = elapsedMs;
  if (summary) projection.summary = summary;
  if (detail) projection.detail = detail;
  // An approval gate rides its parked ask through to the consumer — the
  // parent agent sees it (via the wait tool) and the renderer can answer it
  // via agent:respond without routing through the parent.
  if (gate && gate.kind === "approval" && gate.requestId && gate.approval) {
    projection.gate = { requestId: gate.requestId, approval: gate.approval };
  }
  if (input.tokens !== undefined) projection.tokens = input.tokens;
  return projection;
}

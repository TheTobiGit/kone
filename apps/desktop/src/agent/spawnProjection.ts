// ── spawn status projection (docs/thread-spawning-design.md §6 Wave 1 row C) ─
// One pure function turns the raw facts about a spawned child — its stored
// turns, its gate, whether a live session still backs it — into the single
// `SpawnedThread` snapshot BOTH consumers read: the parent agent via
// kone_wait_for_threads, and the UI via thread.spawned / thread.spawn-updated.
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
import type { ApprovalRequest, ProviderKind, SpawnedThread, SpawnedThreadStatus } from "./types.js";

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
  kind: "approval" | "user-input";
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

/** Appended to a summary that exceeded SPAWN_SUMMARY_CHAR_CAP, on its own
 *  line, so the reader knows the rest exists and where to find it. */
export const SPAWN_SUMMARY_TRUNCATION_MARKER =
  "\n— the rest of the reply is in the child's transcript; read it with kone_read_thread —";

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
    // 1. A parked child outranks everything, including a running turn: nothing
    //    moves until a human acts, and the parent must surface that block
    //    instead of burning its wait window on a thread that cannot progress.
    status = gate.kind === "approval" ? "waiting-for-approval" : "waiting-for-user-input";
    terminal = false;
    detail = gate.detail;
  } else if (turns.some((t) => t.state === "running")) {
    // 2. The row says running — only a live session can finish it. Without one
    //    (an app restart, a crash) the child reads interrupted: a dead thread
    //    that still says "working" is how a parent waits forever.
    status = input.hasLiveSession ? "working" : "interrupted";
    terminal = !input.hasLiveSession;
  } else if (last) {
    // 3. Settled — the LAST turn decides. A failed turn carries its error up
    //    as the detail, so the parent can tell the user what broke.
    if (last.state === "failed") {
      status = "failed";
      detail = last.error || undefined;
    } else if (last.state === "interrupted") {
      status = "interrupted";
    } else {
      status = "completed";
    }
    terminal = true;
  } else {
    // 4. The thread exists but has not started work. A live session still
    //    backing it reads "starting" — the spawn is in flight and the first
    //    turn is imminent. With no live session the child is STILLBORN: it was
    //    created (a crash between the row write and dispatch) but never
    //    dispatched, and nothing will ever drive it — terminal, so a parent
    //    wait on it settles instead of timing out forever with no signal
    //    distinguishing "starting" from "never started".
    status = input.hasLiveSession ? "starting" : "stillborn";
    terminal = !input.hasLiveSession;
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

  return {
    threadId: thread.threadId,
    parentThreadId: thread.parentThreadId,
    title: thread.title,
    provider: thread.provider,
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.effort ? { effort: thread.effort } : {}),
    status,
    terminal,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(summary ? { summary } : {}),
    ...(detail ? { detail } : {}),
    // An approval gate rides its parked ask through to the consumer — the
    // parent agent sees it (via the wait tool) and the renderer can answer it
    // via agent:respond without routing through the parent.
    ...(gate && gate.kind === "approval" && gate.requestId && gate.approval
      ? { gate: { requestId: gate.requestId, approval: gate.approval } }
      : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
  };
}

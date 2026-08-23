// Derive the set of nested subagent runs the agent has spawned this thread — the
// model behind the corner "Subagents" dock, a sibling of the Changes and Tasks
// docks. It reads the `subagent` runs the reducer nests onto the `tool_call`
// items that spawned them (see useAgent's upsertRun), one row per run, ordered by
// when each was spawned. Purely derived: the dock is presentational, the same way
// ChangedFilesList and PlanTaskList are.
//
// The same file carries the shared *presentation* helpers (title, engine, effort)
// and the open-subagent injection key, so the dock rows, the activity-feed
// affordance, and the transcript panel all speak with one voice.
//
// Since the spawn design, the dock also lists a SECOND kind of delegate — real
// child threads the agent opened via kone_spawn_thread — so this file carries
// deriveDelegates, the unified model behind the same dock: nested runs and
// spawned threads project into one normalized DelegateRow list, in handoff
// order. One view model over both kinds, the same single-projection ruling as
// the backend's spawnProjection.ts.

import type { InjectionKey } from "vue";
import type { ThreadBlock } from "~/composables/useAgent";
import { describeModelId, EFFORT_META } from "~/utils/modelCatalog";
import type { EffortTier } from "~/utils/modelCatalog";
import type { ProviderKind } from "~/types/desktop";
import type {
  SpawnedThread,
  SpawnedThreadStatus,
  SubagentRun,
  SubagentRunSnapshot,
  SubagentStatus,
} from "~/types/desktop";

/** Call to open a subagent run's transcript, keyed by its `toolUseId`. Provided
 *  by ProjectView, injected where a run surfaces without a direct emit path
 *  (the activity feed's subagent step rows). Absent → no affordance is shown. */
export const SUBAGENT_OPEN_KEY: InjectionKey<(toolUseId: string) => void> = Symbol(
  "subagent-open",
);

export type SubagentRunView = SubagentRun & {
  /** True while the run is still starting or running. */
  live: boolean;
};

export type ActiveSubagentsState = {
  runs: SubagentRunView[];
  /** How many runs are still in flight. */
  running: number;
  /** Any run is still in flight this thread — keeps the dock open + peeking. */
  streaming: boolean;
};

const LIVE_STATUSES: ReadonlySet<SubagentStatus> = new Set(["starting", "running"]);

/** The subagents spawned across this thread's turns, in spawn order — what the
 *  corner Subagents dock lists, with the running count it shows in the header.
 *  A run whose child is still working is flagged `live` so the dock can peek its
 *  current activity while collapsed. */
export function deriveActiveSubagents(blocks: ThreadBlock[]): ActiveSubagentsState {
  const runs: SubagentRunView[] = [];

  for (const b of blocks) {
    if (b.role !== "assistant") continue;
    for (const it of b.items) {
      const run = it.subagent;
      if (!run) continue;
      runs.push({ ...run, live: LIVE_STATUSES.has(run.status) });
    }
  }

  runs.sort((a, b) => a.startedAt - b.startedAt);
  const running = runs.reduce((n, r) => (r.live ? n + 1 : n), 0);
  return { runs, running, streaming: running > 0 };
}

// ── presentation ───────────────────────────────────────────────────────────────
// The run's human label + identity, shared by the dock rows, the activity-feed
// affordance, and the transcript panel's header.

// worker-<tier> agents exist only to carry reasoning effort, so their role isn't
// a meaningful label — fall back to the description instead.
const WORKER_TIER = /^worker-(?:low|medium|high|xhigh)$/i;

export function isWorkerTier(role: string | undefined): boolean {
  return typeof role === "string" && WORKER_TIER.test(role.trim());
}

/** The run's label: its Task-tool `description`, else the agent definition
 *  (unless that's a worker-<tier> effort carrier), else "Subagent". */
export function subagentTitle(run: Pick<SubagentRunSnapshot, "description" | "agentType">): string {
  if (run.description) return run.description;
  if (run.agentType && !isWorkerTier(run.agentType)) return run.agentType;
  return "Subagent";
}

/** The engine's logomark + human model name (never the raw id). */
export function subagentModel(
  run: Pick<SubagentRunSnapshot, "model">,
): ReturnType<typeof describeModelId> {
  return describeModelId(run.model);
}

/** Our effort indicator — the same brain-cluster + hue the composer uses. */
export function subagentEffort(
  run: Pick<SubagentRunSnapshot, "effort">,
): (typeof EFFORT_META)[EffortTier] | null {
  // SAFETY: the snapshot carries effort as a raw string off the bridge; the
  // checks below reject undefined and any tier EFFORT_META doesn't know, so an
  // out-of-set value degrades to null rather than rendering wrong.
  const tier = run.effort as EffortTier | undefined;
  if (!tier) return null;
  const meta = EFFORT_META[tier];
  if (!meta || tier === "base" || tier === "none") return null;
  return meta;
}

/** The brain-cluster stack for a run's effort (at least one brain). */
export function brainStack(n: number): number[] {
  return Array.from({ length: Math.max(1, n) }, (_, i) => i);
}

// ── unified delegate rows ──────────────────────────────────────────────────────
// Both delegate kinds the dock lists — nested runs and spawned threads — project
// into one row, so the dock renders a single chronological handoff timeline and
// never drifts into two panels (the same trap the backend's spawnProjection.ts
// rules out).

export type DelegateState = "working" | "parked" | "done" | "failed" | "idle";

export type DelegateRow = {
  /** Stable list key, unique across both kinds: `run:<toolUseId>` / `thread:<threadId>`. */
  id: string;
  kind: "run" | "thread";
  title: string;
  state: DelegateState;
  /** working or parked — the dock stays open and counts these. */
  live: boolean;
  startedAt: number;
  model?: string;
  effort?: string;
  /** The delegate's engine provider (spawned threads always carry one) — a
   *  brand fallback when no model id crossed the bridge, so a row without a
   *  model still names its engine. */
  provider?: ProviderKind;
  /** True while a live run's tail item is still reasoning — the "Thinking"
   *  read that tells a working child from one chewing on the problem. Spawned
   *  threads carry no such signal, so the field is run-only. */
  thinking?: boolean;
  /** The row's status, said out loud — the word beside the orb. */
  statusText: string;
  /** The single line under the title. "" when there is nothing to say. */
  hint: string;
  /** Long form for a `title=` tooltip when `hint` is a truncated detail. */
  hintFull?: string;
  target: { kind: "run"; toolUseId: string } | { kind: "thread"; threadId: string };
};

/** Just the hint half of a row — what the per-status helpers below decide,
 *  before the rest of the row is assembled. Taken from the row rather than
 *  restated so the two can't drift apart. */
export type DelegateRowHint = Pick<DelegateRow, "hint" | "hintFull">;

export type DelegatesState = { rows: DelegateRow[]; running: number; streaming: boolean };

// A spawned child's rolled-up status → one delegate state. Approval/input gates
// are "parked", not terminal: the child is paused on the one thing that needs
// the user, so it still counts as live and keeps the dock open. An interrupted
// child stopped mid-flight, the same way the dock already renders a `stopped`
// run — so it reads "failed", not a state of its own.
const THREAD_STATUS_TO_STATE = {
  starting: "working",
  working: "working",
  "waiting-for-approval": "parked",
  "waiting-for-user-input": "parked",
  completed: "done",
  failed: "failed",
  interrupted: "failed",
  stillborn: "failed",
  idle: "idle",
} satisfies Record<SpawnedThreadStatus, DelegateState>;

/** Wall-clock millis → the conversation view's "replied in 52s" compact form,
 *  plus the hour unit that view's local formatter skips: `52s`, `1m 20s`,
 *  `1h 4m`. Sub-second reads `0s`; minutes keep their seconds until an hour
 *  passes, then drop them. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** A failure detail as one line — newlines and space runs collapse to a single
 *  space so a multi-line error can't break the dock row. */
function singleLineDetail(detail: string): string {
  return detail.replace(/\s+/g, " ").trim();
}

/** A failed thread's hint: its `detail`, else nothing (the status word already
 *  said "Failed"). A detail that won't fit on one row is capped at 80 characters
 *  (trailing whitespace trimmed, then a single `…`) with the untruncated line
 *  carried in `hintFull` for the tooltip. */
function failedThreadHint(thread: SpawnedThread): DelegateRowHint {
  const detail = thread.detail;
  if (!detail) return { hint: "" };
  const oneLine = singleLineDetail(detail);
  if (!oneLine) return { hint: "" };
  if (oneLine.length <= 80) return { hint: oneLine };
  return { hint: `${oneLine.slice(0, 80).trimEnd()}…`, hintFull: oneLine };
}

/** The one-liner under a spawned thread's title. Status words live on the row's
 *  `statusText` now — the hint carries only the *extra* facts: how long a
 *  working child has been at it, what a failure said. A parked child's ask is
 *  the status word itself, so its hint is empty. */
function threadHint(thread: SpawnedThread): DelegateRowHint {
  switch (thread.status) {
    case "starting":
      return { hint: "" };
    case "working":
      return typeof thread.elapsedMs === "number"
        ? { hint: formatElapsed(thread.elapsedMs) }
        : { hint: "" };
    case "waiting-for-approval":
      return { hint: "" };
    case "waiting-for-user-input":
      return { hint: "" };
    case "completed":
      return { hint: "" };
    case "failed":
      return failedThreadHint(thread);
    case "stillborn":
      return failedThreadHint(thread);
    case "interrupted":
      return { hint: "" };
    case "idle":
      return { hint: "" };
  }
}

/** The spawned thread's status word — the terminal outcome keeps its clock
 *  ("Done in 52s") because that IS the report; live states stay terse and let
 *  the hint carry elapsed time. */
function threadStatusText(thread: SpawnedThread): string {
  switch (thread.status) {
    case "starting":
      return "Starting…";
    case "working":
      return "Working";
    case "waiting-for-approval":
      return "Waiting for approval";
    case "waiting-for-user-input":
      return "Waiting for your answer";
    case "completed":
      return typeof thread.elapsedMs === "number"
        ? `Done in ${formatElapsed(thread.elapsedMs)}`
        : "Done";
    case "failed":
      return "Failed";
    case "stillborn":
      return "Failed to start";
    case "interrupted":
      return "Interrupted";
    case "idle":
      return "Queued";
  }
}

/** A nested run → delegate row, reusing the existing live/status projection. A
 *  run is never "parked": it has no human gate, so live simply means working. */
function runRow(run: SubagentRunView): DelegateRow {
  const state: DelegateState = run.live
    ? "working"
    : run.status === "completed"
      ? "done"
      : run.status === "failed" || run.status === "stopped"
        ? "failed"
        : "idle";
  const row: DelegateRow = {
    id: `run:${run.toolUseId}`,
    kind: "run",
    title: subagentTitle(run),
    state,
    live: run.live,
    startedAt: run.startedAt,
    thinking: run.live ? runThinking(run) : false,
    statusText: runStatusText(run),
    // The live progress line — the dock's exact current wording, kept.
    hint: run.live && run.lastToolName ? `Running ${run.lastToolName}…` : "",
    target: { kind: "run", toolUseId: run.toolUseId },
  };
  if (run.model) row.model = run.model;
  if (run.effort) row.effort = run.effort;
  return row;
}

/** A spawned child thread → delegate row. */
function threadRow(thread: SpawnedThread): DelegateRow {
  const state = THREAD_STATUS_TO_STATE[thread.status];
  const { hint, hintFull } = threadHint(thread);
  const row: DelegateRow = {
    id: `thread:${thread.threadId}`,
    kind: "thread",
    title: thread.title,
    state,
    live: state === "working" || state === "parked",
    startedAt: thread.createdAt,
    provider: thread.provider,
    statusText: threadStatusText(thread),
    hint,
    target: { kind: "thread", threadId: thread.threadId },
  };
  if (thread.model) row.model = thread.model;
  if (thread.effort) row.effort = thread.effort;
  if (hintFull) row.hintFull = hintFull;
  return row;
}

/** The run's status word, thinking read included. */
function runStatusText(run: SubagentRunView): string {
  if (run.status === "starting") return "Starting…";
  if (run.live) return runThinking(run) ? "Thinking" : "Working";
  if (run.status === "completed") return "Done";
  if (run.status === "failed") return "Failed";
  if (run.status === "stopped") return "Stopped";
  return "Queued";
}

/** "Thinking" vs "Working": a live run whose transcript tail is still a
 *  reasoning segment (a child can only have paused on a thought — the next
 *  tool call is what marks the thinking over). */
function runThinking(run: SubagentRunView): boolean {
  const tail = run.items[run.items.length - 1];
  return tail?.kind === "reasoning_text";
}

/** Every delegate the agent handed off this thread — nested runs and spawned
 *  threads — as one list in handoff order. `running` counts the rows still live
 *  (a parked child included: it's the one thing waiting on the user), and
 *  `streaming` keeps the dock open while any of them is. */
export function deriveDelegates(blocks: ThreadBlock[], spawned: SpawnedThread[]): DelegatesState {
  const rows: DelegateRow[] = [];
  for (const r of deriveActiveSubagents(blocks).runs) rows.push(runRow(r));
  for (const t of spawned) rows.push(threadRow(t));
  rows.sort((a, b) => a.startedAt - b.startedAt);
  const running = rows.reduce((n, r) => (r.live ? n + 1 : n), 0);
  return { rows, running, streaming: running > 0 };
}

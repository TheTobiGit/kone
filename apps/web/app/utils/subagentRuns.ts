// Derive the set of nested subagent runs the agent has spawned this thread — the
// model behind the corner "Subagents" dock, a sibling of the Changes and Tasks
// docks. It reads the `subagent` runs the reducer nests onto the `tool_call`
// items that spawned them (see useAgent's upsertRun), one row per run, ordered by
// when each was spawned. Purely derived: the dock is presentational, the same way
// ChangedFilesList and PlanTaskList are.

import type { ThreadBlock } from "~/composables/useAgent";
import type { SubagentRun, SubagentStatus } from "~/types/desktop";

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

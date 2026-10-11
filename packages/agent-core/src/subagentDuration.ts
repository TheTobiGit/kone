import type { SubagentRunSnapshot } from "./types.js";

/** Freeze elapsed time once; later lifecycle notifications can reopen a run. */
export function freezeSubagentDuration(snapshot: SubagentRunSnapshot, endedAt: number): void {
  if (snapshot.durationMs === undefined) {
    snapshot.durationMs = Math.max(0, endedAt - snapshot.startedAt);
  }
}

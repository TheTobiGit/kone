import type { BaseEvent, EmitEvent, RuntimeEvent } from "../types.js";
import { cleanCompactedCount } from "../types.js";

// One payload dialect for every settled-compaction boundary. Codex announces
// `thread/compacted` (routing-only params, no counts), OpenCode announces
// `session.compacted` (no counts), Claude announces `compact_boundary` (with
// `pre_tokens`/`post_tokens`) — all four construction sites route through
// emitCompacted below, so the store, the journal and the renderer only ever
// see this one shape: counts the provider reported, or explicit nulls.

/** Window-fill counts on either side of a settled compaction boundary, as the
 *  provider reported them — already narrowed at the adapter's ingress (e.g.
 *  Claude's `readNumber`); unknown stays null here, never 0 and never
 *  omitted, so "compacted, size unknown" cannot read as "compacted down to
 *  nothing". */
export type CompactedCounts = {
  beforeTokens?: number | null;
  afterTokens?: number | null;
};

/** Emit the settled-compaction boundary: the `thread.state.changed`
 *  "compacted" event the store invalidates its usage snapshot on. Counts ride
 *  explicitly (number or null), so consumers never have to distinguish an
 *  omitted field from an unknown one. */
export function emitCompacted(emit: EmitEvent, base: BaseEvent, counts?: CompactedCounts): void {
  const compacted: Extract<RuntimeEvent, { type: "thread.state.changed" }> = {
    ...base,
    type: "thread.state.changed",
    state: "compacted",
    beforeTokens: cleanCompactedCount(counts?.beforeTokens),
    afterTokens: cleanCompactedCount(counts?.afterTokens),
  };
  emit(compacted);
}

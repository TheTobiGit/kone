// The ordered-parts model for an assistant turn.
//
// The rule (the convention every serious agent UI + every provider wire format
// converges on): a turn is a single ORDERED list of parts — thinking, tool
// calls, and text — rendered strictly in the order they arrived. We never
// regroup by kind. The provider stream already hands `block.items` in arrival
// order; here we only coalesce *adjacent* same-kind items into segments (a run
// of thoughts, a run of tool calls, a run of text) so the layout has rhythm.
//
// Shared between ConversationThread (which splits a turn into step/text groups)
// and AgentActivity (which turns a step group into its live activity feed), so
// both agree on exactly what a "segment" and an "activity entry" are.

import { parseSpawnRecords, type SpawnRecord } from "@kone/protocol/spawn-record";
import type { AssistantBlock } from "~/composables/useAgent";
import type { RuntimeItem } from "~/types/desktop";

export type SegKind = "thinking" | "tools" | "text";
export type Segment = { kind: SegKind; key: string; items: RuntimeItem[] };

export function segKindOf(item: RuntimeItem): SegKind {
  if (item.kind === "reasoning_text") return "thinking";
  if (item.kind === "tool_call") return "tools";
  return "text"; // assistant_text — plan_text renders in the dock, not the thread
}

export function segmentsOf(block: AssistantBlock): Segment[] {
  const out: Segment[] = [];
  for (const it of block.items) {
    if (it.kind === "plan_text") continue;
    const kind = segKindOf(it);
    const cur = out[out.length - 1];
    if (cur && cur.kind === kind) cur.items.push(it);
    else out.push({ kind, key: `${block.id}:${it.itemId}`, items: [it] });
  }
  return out;
}

export function segStreaming(seg: Segment): boolean {
  return seg.items.some((i) => i.status === "in-progress");
}

export function segText(seg: Segment): string {
  return seg.items
    .map((i) => i.text)
    .join("\n\n")
    .trim();
}

// Some models never surface their reasoning — the turn carries a thinking marker
// but no text. There's nothing to reveal, so such a segment renders as a bare
// label with no disclosure (no chevron, no expand/collapse).
export function thinkHasContent(seg: Segment): boolean {
  return segText(seg).length > 0;
}

export function toolCalls(seg: Segment): RuntimeItem[] {
  return seg.items.filter((i) => i.kind === "tool_call");
}

/** The tools that open threads and leave spawn records behind. */
const SPAWN_TOOLS = new Set([
  "kone_spawn_worker",
  "kone_spawn_worker_preset",
  "kone_delegate_to_teammate",
  "kone_spawn_batch",
]);

/** The threads a settled spawn call opened — one for a spawn or delegation,
 *  each that opened for a batch — or none for any other item: a different
 *  tool, a call still running, or one that was refused and so recorded
 *  nothing. */
export function spawnRecordsOf(item: RuntimeItem): SpawnRecord[] {
  if (item.kind !== "tool_call" || item.status !== "completed") return [];
  if (!item.name || !SPAWN_TOOLS.has(item.name)) return [];
  return parseSpawnRecords(item.detail);
}

// Thinking and tool calls are "steps" — rows in one continuous list. The agent's
// task plan lives in the bottom-right dock, not here. Text breaks the rail and
// starts fresh.
//
// A worker spawn breaks it too. Handing work to another agent is something the
// agent says it did, not a step on the way to saying something, so it reads as
// part of the reply at the point it happened — the step feed it would otherwise
// sit in folds away once the turn settles.
export type RenderGroup =
  | { kind: "steps"; key: string; segments: Segment[] }
  | { kind: "text"; seg: Segment }
  | { kind: "spawn"; key: string; item: RuntimeItem; record: SpawnRecord };

/** The groups a settled turn folds behind its work toggler. */
export type WorkGroup = Exclude<RenderGroup, { kind: "spawn" }>;

export function renderGroups(block: AssistantBlock): RenderGroup[] {
  const out: RenderGroup[] = [];
  const pushStep = (seg: Segment): void => {
    const last = out[out.length - 1];
    if (last && last.kind === "steps") last.segments.push(seg);
    else out.push({ kind: "steps", key: seg.key, segments: [seg] });
  };
  for (const seg of segmentsOf(block)) {
    if (seg.kind === "text") {
      out.push({ kind: "text", seg });
      continue;
    }
    if (seg.kind === "thinking") {
      pushStep(seg);
      continue;
    }
    // A run of tool calls splits around each spawn, so the calls either side of
    // it stay in their own batches and the spawn stands where it landed. A
    // batch stands as one line per thread it opened, in item order.
    let run: RuntimeItem[] = [];
    const flush = (): void => {
      if (!run.length) return;
      // The run's first item keys it, the same way segmentsOf keys a segment —
      // an unsplit run keeps the key it always had.
      pushStep({ kind: "tools", key: `${block.id}:${run[0]!.itemId}`, items: run });
      run = [];
    };
    for (const item of seg.items) {
      const records = spawnRecordsOf(item);
      if (!records.length) {
        run.push(item);
        continue;
      }
      flush();
      for (const record of records) {
        // A retried call replays the same spawn; the work was handed off once.
        if (out.some((g) => g.kind === "spawn" && g.record.threadId === record.threadId)) continue;
        out.push({ kind: "spawn", key: `${block.id}:${item.itemId}:${record.threadId}`, item, record });
      }
    }
    flush();
  }
  return out;
}

// ── activity entries ──────────────────────────────────────────────────────────
// A step group flattened into one ordered list — thinking segments and tool
// calls interleaved exactly as they happened. This is the spine of the Agent
// Activity feed: the visible window, the history strip, and the expanded list
// all read the same entries, so an item's identity is stable whether it's live,
// sliding out, or archived.
export type ActivityEntry =
  | { type: "thinking"; key: string; index: number; seg: Segment }
  | { type: "tool"; key: string; index: number; item: RuntimeItem; seg: Segment };

export function activityEntries(segments: Segment[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const seg of segments) {
    if (seg.kind === "thinking") {
      out.push({ type: "thinking", key: seg.key, index: out.length, seg });
      continue;
    }
    for (const item of toolCalls(seg)) {
      out.push({ type: "tool", key: item.itemId, index: out.length, item, seg });
    }
  }
  return out;
}

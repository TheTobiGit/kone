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

import { isSpawnToolName, parseSpawnRecords, type SpawnRecord } from "@kone/protocol/spawn-record";
import { PAGE_SHOW_TOOL_NAME, parsePageShown, type PageRef } from "@kone/protocol/page-render";
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

/** Whether an item is a tool call that finished, under a name `named` accepts:
 *  a refused or still-running call carries no record to read back. */
function settledToolCallOf(item: RuntimeItem, named: (name: string) => boolean): boolean {
  return item.kind === "tool_call" && item.status === "completed" && item.name !== undefined && named(item.name);
}

/** The threads a settled spawn call opened — one for a spawn or delegation,
 *  each that opened for a batch — or none for any other item: a different
 *  tool, a call still running, or one that was refused and so recorded
 *  nothing. */
export function spawnRecordsOf(item: RuntimeItem): SpawnRecord[] {
  return settledToolCallOf(item, isSpawnToolName) ? parseSpawnRecords(item.detail) : [];
}

// Thinking and tool calls are "steps" — rows in one continuous list. The agent's
// task plan lives in the bottom-right dock, not here. Text breaks the rail and
// starts fresh.
//
// A worker spawn breaks it too. Handing work to another agent is something the
// agent says it did, not a step on the way to saying something, so it reads as
// part of the reply at the point it happened — the step feed it would otherwise
// sit in folds away once the turn settles.
//
// Each segment comes out as its own steps group. Whether adjacent batches read
// as one depends on what shows between them, so the joining is utils/turnPlan's,
// done once the reader's choices are known.
//
// `placement` is that split as data. A "reply" group is something the agent
// said: it stands in the open wherever it falls and never folds. A "work"
// group is steps or text, which fold or show by the reader's choices and by
// where they fall in the turn. A new kind of thing the agent says is one more
// "reply" member here, and nothing downstream changes.
export type RenderGroup =
  | { kind: "steps"; placement: "work"; key: string; segments: Segment[] }
  | { kind: "text"; placement: "work"; seg: Segment }
  | { kind: "spawn"; placement: "reply"; key: string; item: RuntimeItem; record: SpawnRecord }
  | { kind: "decision"; placement: "reply"; key: string; item: RuntimeItem; text: string }
  | { kind: "page"; placement: "reply"; key: string; item: RuntimeItem; page: PageRef };

/** The groups a settled turn folds behind its work toggler. */
export type WorkGroup = Extract<RenderGroup, { placement: "work" }>;

/** The page a settled page_show call put in the reply, or null for any other
 *  item. A page is part of what the agent says, so like a hand-off it stands
 *  in the reply rather than among the steps that folded away. */
export function pageOf(item: RuntimeItem): PageRef | null {
  return settledToolCallOf(item, (name) => name === PAGE_SHOW_TOOL_NAME) ? parsePageShown(item.detail) : null;
}

/** What a settled agent_keep_or_stop call said it decided — "Kept Frontend
 *  Auth running · stopped Auth API." — or null for any other item. Like a
 *  hand-off, it is something the agent says it did, not a step. */
export function decisionTextOf(item: RuntimeItem): string | null {
  if (!settledToolCallOf(item, (name) => name === "agent_keep_or_stop")) return null;
  const text = item.detail?.trim();
  return text ? text : null;
}

export function renderGroups(block: AssistantBlock): RenderGroup[] {
  const out: RenderGroup[] = [];
  const spawned = new Set<string>();
  // kone puts each page in the turn itself, and a provider that reports the
  // call carries the same page; it stands once, where it first landed.
  const pages = new Set<string>();
  const pushStep = (seg: Segment): void =>
    void out.push({ kind: "steps", placement: "work", key: seg.key, segments: [seg] });
  for (const seg of segmentsOf(block)) {
    if (seg.kind === "text") {
      out.push({ kind: "text", placement: "work", seg });
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
      const decided = decisionTextOf(item);
      if (decided) {
        flush();
        out.push({ kind: "decision", placement: "reply", key: `${block.id}:${item.itemId}`, item, text: decided });
        continue;
      }
      const page = pageOf(item);
      if (page) {
        if (pages.has(page.attachmentId)) continue;
        pages.add(page.attachmentId);
        flush();
        out.push({ kind: "page", placement: "reply", key: `${block.id}:${item.itemId}`, item, page });
        continue;
      }
      const records = spawnRecordsOf(item);
      if (!records.length) {
        run.push(item);
        continue;
      }
      flush();
      for (const record of records) {
        // A retried call replays the same spawn; the work was handed off once.
        if (spawned.has(record.threadId)) continue;
        spawned.add(record.threadId);
        out.push({ kind: "spawn", placement: "reply", key: `${block.id}:${item.itemId}:${record.threadId}`, item, record });
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

import type { ToolCallClip, ToolFileChange } from "@kone/protocol/tool-call";
import { diffStats } from "@kone/protocol/unified-diff";
import type { RuntimeEvent, RuntimeItem, StoredBlock, StoredThread } from "./types.js";

// ── IPC wire projection ───────────────────────────────────────────────────────
// A tool_call can carry the provider's whole result — MBs of stdout, a JSON
// record, a multi-file patch — and every streaming update re-sends the item's
// full snapshot. The store keeps the full call (persistence is the source of
// truth); only the copy crossing IPC is bounded, and it says so in data rather
// than prose: `clipped` names where the whole call lives and how long each
// clipped body was, and a clipped diff keeps its line counts measured on the
// whole diff. The renderer reads the whole call back on demand
// (`history.toolItem`). The three text kinds are never touched: their `text`
// is the streamed reply and must arrive byte-identical.

/** Wire cap for a tool_call's output (`detail`) and its serialized input. */
export const TOOL_DETAIL_WIRE_CAP = 8_000;
/** Wire cap for one file's diff, and for all of one call's diffs together. */
export const TOOL_DIFF_WIRE_CAP = 64 * 1024;
export const TOOL_DIFFS_WIRE_BUDGET = 256 * 1024;

/** Cut at the last line break inside the cap, so a clipped diff or output
 *  never ends mid-line. */
function clip(text: string, cap: number): string {
  const head = text.slice(0, cap);
  const lastBreak = head.lastIndexOf("\n");
  return lastBreak > 0 ? head.slice(0, lastBreak + 1) : head;
}

function projectFileChanges(changes: ToolFileChange[]): ToolFileChange[] | undefined {
  let budget = TOOL_DIFFS_WIRE_BUDGET;
  let changed = false;
  const projected = changes.map((change) => {
    const diff = change.diff;
    if (diff === undefined) return change;
    const cap = Math.min(TOOL_DIFF_WIRE_CAP, budget);
    if (diff.length <= cap) {
      budget -= diff.length;
      return change;
    }
    changed = true;
    budget -= cap;
    const { added, removed } = diffStats(diff);
    return { ...change, diff: clip(diff, cap), added, removed, diffClipped: true };
  });
  return changed ? projected : undefined;
}

/** Project one item for the wire. Returns the same object when nothing
 *  changes, so the hot streaming path allocates nothing per event. */
export function projectRuntimeItemForIpc(item: RuntimeItem, threadId: string, turnId: string): RuntimeItem {
  if (item.kind !== "tool_call") return item;
  const receipt: ToolCallClip = { threadId, turnId };
  const projected: RuntimeItem = { ...item };
  let changed = false;
  if (item.detail && item.detail.length > TOOL_DETAIL_WIRE_CAP) {
    projected.detail = clip(item.detail, TOOL_DETAIL_WIRE_CAP);
    receipt.detail = item.detail.length;
    changed = true;
  }
  const input = item.tool?.input;
  if (item.tool && input && input.length > TOOL_DETAIL_WIRE_CAP) {
    projected.tool = { ...item.tool, input: clip(input, TOOL_DETAIL_WIRE_CAP) };
    receipt.input = input.length;
    changed = true;
  }
  const fileChanges = item.fileChanges && projectFileChanges(item.fileChanges);
  if (fileChanges) {
    projected.fileChanges = fileChanges;
    receipt.diffs = true;
    changed = true;
  }
  if (changed) projected.clipped = receipt;
  const run = item.subagent;
  if (run) {
    const items = run.items.map((child) => projectRuntimeItemForIpc(child, threadId, turnId));
    if (items.some((child, index) => child !== run.items[index])) {
      projected.subagent = { ...run, items };
      changed = true;
    }
  }
  return changed ? projected : item;
}

/** Project a runtime event for the wire. Only the item-carrying events can
 *  hold tool bodies; everything else crosses unchanged (same object). */
export function projectRuntimeEventForIpc(event: RuntimeEvent): RuntimeEvent {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
    return event;
  }
  const item = projectRuntimeItemForIpc(event.item, event.threadId, event.turnId);
  return item === event.item ? event : { ...event, item };
}

/** Project a stored thread's blocks for the wire (history reads — the renderer
 *  rehydrates from these, so a reloaded thread lands with bounded bodies too). */
export function projectStoredBlocksForIpc(blocks: StoredBlock[], threadId: string): StoredBlock[] {
  let changed = false;
  const projected = blocks.map((b) => {
    if (b.role !== "assistant") return b;
    const items = b.items.map((it) => projectRuntimeItemForIpc(it, threadId, b.turnId));
    const blockChanged = items.some((it, index) => it !== b.items[index]);
    if (!blockChanged) return b;
    changed = true;
    return { ...b, items };
  });
  return changed ? projected : blocks;
}

export function projectStoredThreadForIpc(thread: StoredThread): StoredThread {
  const blocks = projectStoredBlocksForIpc(thread.blocks, thread.threadId);
  return blocks === thread.blocks ? thread : { ...thread, blocks };
}

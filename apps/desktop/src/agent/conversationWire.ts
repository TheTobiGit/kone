import type { RuntimeEvent, RuntimeItem, StoredBlock, StoredThread } from "./types.js";

// ── IPC wire projection ───────────────────────────────────────────────────────
// payload projection): a tool_call's expandable body (`detail`) can carry the
// provider's FULL tool result — MBs of stdout/stderr/diff on Codex's MCP and
// shell calls — and it dominates wire size on tool-heavy threads. The store
// keeps the full payload (persistence is the source of truth); only the copy
// crossing IPC is bounded. The three text kinds are NEVER touched: their
// `text` is the streamed reply and must arrive byte-identical.
//
// The superseded-update half of that model — dropping tool.updated rows a
// completion supersedes — has no kone equivalent: kone's
// store upserts one row per item per turn and the renderer replaces items by
// itemId in place, so an in-flight tool call never accumulates rows anywhere —
// there is no history of updates to drop (verified in conversationStore.test.ts
// and the renderer's upsertItem). Live updates still stream, slimmed, matching

/** Wire cap for a tool_call's expandable body. Bounded, but generous enough
 *  that the expandable row still shows real content (kone renders `detail`
 */
export const TOOL_DETAIL_WIRE_CAP = 8_000;

export function capDetail(detail: string | undefined): string | undefined {
  if (!detail || detail.length <= TOOL_DETAIL_WIRE_CAP) return detail;
  return (
    detail.slice(0, TOOL_DETAIL_WIRE_CAP) +
    "\n\n… (output truncated; the full result stays in this thread's local history)"
  );
}

/** Project one item for the wire. Returns the same object when nothing
 *  changes, so the hot streaming path allocates nothing per event. */
export function projectRuntimeItemForIpc(item: RuntimeItem): RuntimeItem {
  if (item.kind !== "tool_call") return item;
  const detail = capDetail(item.detail);
  let subagent = item.subagent;
  if (subagent) {
    const items = subagent.items.map(projectRuntimeItemForIpc);
    if (items.some((it, index) => it !== subagent?.items[index])) {
      subagent = { ...subagent, items };
    }
  }
  if (detail === item.detail && subagent === item.subagent) return item;
  const projected: RuntimeItem = { ...item };
  if (detail !== item.detail) projected.detail = detail;
  if (subagent) projected.subagent = subagent;
  return projected;
}

/** Project a runtime event for the wire. Only the item-carrying events can
 *  hold tool bodies; everything else crosses unchanged (same object). */
export function projectRuntimeEventForIpc(event: RuntimeEvent): RuntimeEvent {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
    return event;
  }
  const item = projectRuntimeItemForIpc(event.item);
  return item === event.item ? event : { ...event, item };
}

/** Project a stored thread's blocks for the wire (history reads — the renderer
 *  rehydrates from these, so a reloaded thread lands with bounded bodies too). */
export function projectStoredBlocksForIpc(blocks: StoredBlock[]): StoredBlock[] {
  let changed = false;
  const projected = blocks.map((b) => {
    if (b.role !== "assistant") return b;
    const items = b.items.map((it) => projectRuntimeItemForIpc(it));
    const blockChanged = items.some((it, index) => it !== b.items[index]);
    if (!blockChanged) return b;
    changed = true;
    return { ...b, items };
  });
  return changed ? projected : blocks;
}

export function projectStoredThreadForIpc(thread: StoredThread): StoredThread {
  const blocks = projectStoredBlocksForIpc(thread.blocks);
  return blocks === thread.blocks ? thread : { ...thread, blocks };
}

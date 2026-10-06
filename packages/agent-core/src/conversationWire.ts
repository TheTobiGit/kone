import type { RuntimeEvent, RuntimeItem, StoredBlock, StoredThread } from "./types.js";

// Tool output crosses IPC intact. Clipping serialized JSON or patches here
// corrupts the data used by detail views and the Changes dock.
/** @deprecated Output is no longer clipped at this boundary. */
export const TOOL_DETAIL_WIRE_CAP = 8_000;

export function capDetail(detail: string | undefined): string | undefined { return detail; }

/** Project one item for the wire. Returns the same object when nothing
 *  changes, so the hot streaming path allocates nothing per event. */
export function projectRuntimeItemForIpc(item: RuntimeItem): RuntimeItem { return item; }

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
 *  rehydrates from these with the full bodies). */
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

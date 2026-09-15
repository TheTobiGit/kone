import { computed, ref, type Ref } from "vue";
import type { ChatAttachment, KoneAgentApi } from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";
import { seedFromBridge } from "../useCompaction";
import type { QueuedTurnEntry, QueueBridge, ThreadBlock } from "../agentTypes";

/** Safe-parse a queued turn's attachments payload. Returns undefined when the
 *  row carries none, or when the stored JSON is missing or malformed — every
 *  send-now path and label read goes through here so the shape lives once. */
export function parseQueuedAttachments(json?: string | null): ChatAttachment[] | undefined {
  if (!json) return undefined;
  try {
    // SAFETY: attachmentsJson is stored as a JSON-encoded ChatAttachment array
    const parsed = JSON.parse(json) as ChatAttachment[];
    if (!Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** The transcript ids a queued-turn row hides or orders around: its anchored
 *  transcript block (entry.blockId, set when turn.queued matched a block
 *  already in blocks.value) plus its stored userBlockId (the id promotion
 *  rebuilds the block under, so a row whose anchor and stored id differ still
 *  matches either copy). Timeline filtering and turn boundaries both read this
 *  one set so they can never disagree. */
export function queuedBlockIdsOf(rows: QueuedTurnEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const q of rows) {
    if (q.blockId) ids.add(q.blockId);
    if (q.userBlockId) ids.add(q.userBlockId);
  }
  return ids;
}

/** Order queued rows by an explicit id list (the optimistic reorder or the
 *  backend's reordered event). Ids missing from the list sort behind every
 *  listed row; Array.sort is stable, so unlisted rows keep their relative
 *  order instead of swapping. Returns a new array. */
export function sortQueuedByIds(rows: QueuedTurnEntry[], ids: readonly string[]): QueuedTurnEntry[] {
  const order = new Map(ids.map((id, index) => [id, index]));
  const last = ids.length;
  return [...rows].sort(
    (a, b) => (order.get(a.queueId) ?? last) - (order.get(b.queueId) ?? last),
  );
}

/** Follow-ups durably queued behind the running turn. The send path stays in
 *  the session that creates this unit — a queued entry sent now is steered
 *  into the live turn when one runs, else sent as a fresh turn — so it
 *  arrives as the `send`/`steerTurn` callbacks below. */
export type SessionQueueDeps = {
  blocks: Ref<ThreadBlock[]>;
  threadId: Ref<string>;
  bridge: () => KoneAgentApi | null;
  error: Ref<string | null>;
  busy: Ref<boolean>;
  send: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  steerTurn: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
};

/** Durable follow-ups queued behind the running turn (the AgentService queue
 *  slice: a send while busy is enqueued, promoted on settle, cancelled on
 *  stop). Live entries fold from turn.queued; a thread that adopts a stored
 *  identity re-seeds by an explicit bridge query — the rows survive crashes,
 *  so a reloaded renderer has no record of them otherwise. */
export function useSessionQueue(deps: SessionQueueDeps) {
  const { blocks, threadId, bridge, error, busy, send, steerTurn } = deps;

  /** Follow-ups durably queued behind the running turn (the AgentService queue
   *  slice: a send while busy is enqueued, promoted on settle, cancelled on
   *  stop). Live entries fold from turn.queued; a thread that adopts a stored
   *  identity re-seeds by an explicit bridge query (seedQueuedTurns) — the
   *  rows survive crashes, so a reloaded renderer has no record of them
   *  otherwise. Kept raw (backend positions); the exported `queuedTurns`
   *  computed renumbers for display. */
  const queuedTurnsRaw = ref<QueuedTurnEntry[]>([]);
  /** queueId → the renderer-minted user block id of the send that produced it.
   *  The store journals user prompts under ITS OWN block id (recordUserBlock
   *  mints internally), so a live optimistic block can't be matched by the
   *  turn.queued userBlockId until a reload reconciles the timeline. The
   *  send/steer ack carries the queue id (a busy enqueue acks with the queue
   *  id as turnId), which is how the row finds its own block: recorded here
   *  on ack, consumed by the matching turn.queued, pruned at the next turn
   *  boundary (no queue event can arrive after the turn it belongs to has
   *  started). */
  const pendingQueueAnchors = new Map<string, string>();
  /** The queue as the UI reads it — entries renumbered so a cancellation
   *  leaves no gaps (1-based order within the queue of waiting follow-ups:
   *  the first queued follow-up is #1, the second #2, …). */
  const queuedTurns = computed<QueuedTurnEntry[]>(() =>
    queuedTurnsRaw.value.map((q, i) => ({ ...q, position: i + 1 })),
  );

  /** Anchor a queue row to a transcript user block by the store's userBlockId,
   *  else by the send-ack record for this queueId. Returns undefined when the
   *  row has no block here — a busy send never pushes, so a live row usually
   *  anchors to nothing and promotion rebuilds it from the entry. */
  function anchorFor(userBlockId: string, queueId: string): string | undefined {
    const byId = blocks.value.find((b) => b.role === "user" && b.id === userBlockId);
    if (byId) return byId.id;
    const fromAck = pendingQueueAnchors.get(queueId);
    if (fromAck) {
      pendingQueueAnchors.delete(queueId);
      return fromAck;
    }
    return undefined;
  }

  /** Re-seed this session's queued follow-ups from the bridge, for a thread
   *  that just adopted a stored identity (rehydrate / openStored) — the rows
   *  are durable (they survive crashes), but the queue events are not
   *  journaled, so a reloaded renderer must rebuild the strip by an explicit
   *  query. Best-effort via seedFromBridge, like every other seed. */
  function seedQueuedTurns(api: NonNullable<ReturnType<typeof bridge>>): void {
    // SAFETY: QueueBridge is the optional queued-turns slice of the bridge.
    const query = (api as KoneAgentApi & QueueBridge).queuedTurns;
    seedFromBridge(query, threadId, (rows) => {
      if (!rows || rows.length === 0) {
        queuedTurnsRaw.value = [];
        return;
      }
      const anchored = new Set(queuedTurnsRaw.value.map((q) => q.blockId).filter(Boolean));
      const entries: QueuedTurnEntry[] = rows
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((row, i) => {
          const byId = blocks.value.find(
            (b) => b.role === "user" && b.id === row.userBlockId,
          );
          const entry: QueuedTurnEntry = { ...row, position: i + 1 };
          if (byId && !anchored.has(byId.id)) entry.blockId = byId.id;
          return entry;
        });
      queuedTurnsRaw.value = entries;
    });
  }

  /** Cancel one queued follow-up (user-initiated drop from the strip). The
   *  backend emits turn.queued-cancelled; the row clears on that event. */
  async function cancelQueuedTurn(queueId: string): Promise<void> {
    const api = bridge();
    // SAFETY: QueueBridge is the optional queued-turns slice of the bridge.
    const cancel = (api as KoneAgentApi & QueueBridge | undefined)?.cancelQueuedTurn;
    if (!cancel) return;
    try {
      await cancel(threadId.value, queueId);
    } catch (e) {
      error.value = peelIpcError(e, "Could not remove queued message");
    }
  }

  /** Send a queued follow-up now: drop its row, then steer its prompt into
   *  the live turn when one runs, else send it as a fresh turn. */
  async function sendQueuedEntryNow(entry: QueuedTurnEntry): Promise<void> {
    await cancelQueuedTurn(entry.queueId);
    const attachments = parseQueuedAttachments(entry.attachmentsJson);
    if (busy.value) {
      void steerTurn(entry.input, attachments);
    } else {
      void send(entry.input, attachments);
    }
  }

  /** Reorder the active queued turns. Optimistically re-sorts queuedTurnsRaw
   *  and dispatches the new order to the backend. */
  async function reorderQueuedTurns(queueIds: string[]): Promise<void> {
    queuedTurnsRaw.value = sortQueuedByIds(queuedTurnsRaw.value, queueIds);
    const api = bridge();
    // SAFETY: QueueBridge is the optional queued-turns slice of the bridge.
    const reorder = (api as KoneAgentApi & QueueBridge | undefined)?.reorderQueuedTurns;
    if (!reorder) return;
    try {
      await reorder(threadId.value, queueIds);
    } catch (e) {
      console.warn("[agent] reorderQueuedTurns failed:", e);
    }
  }

  return {
    queuedTurnsRaw,
    pendingQueueAnchors,
    queuedTurns,
    anchorFor,
    seedQueuedTurns,
    cancelQueuedTurn,
    sendQueuedEntryNow,
    reorderQueuedTurns,
  };
}

import { onScopeDispose, ref, watch, type Ref } from "vue";
import type { InboxEntry, KoneAgentApi, RuntimeEvent } from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";

/** One hand-over moves a row twice in quick succession (claimed, then seen),
 *  and a broadcast lands several at once: re-read once per burst. */
const REREAD_DELAY_MS = 120;

/** How much history the panel shows. */
const HISTORY_LIMIT = 20;

export type AgentInboxBridge = Pick<KoneAgentApi, "inboxList" | "inboxHistory" | "onEvent">;

function defaultBridge(): Partial<AgentInboxBridge> | undefined {
  return import.meta.client ? window.koneDesktop?.agent : undefined;
}

/** One thread's agent inbox, kept current while something shows it: what
 *  waits for it and what it has seen. Reads again whenever the thread's inbox
 *  moves, and when the thread changes. */
export function useAgentInbox(
  threadId: Readonly<Ref<string>>,
  bridge: () => Partial<AgentInboxBridge> | undefined = defaultBridge,
) {
  const waiting = ref<InboxEntry[]>([]);
  const seen = ref<InboxEntry[]>([]);
  const loaded = ref(false);
  const error = ref<string | null>(null);

  /** Only the newest read lands: a slow read for a thread the panel has
   *  since left must not overwrite the one it moved to. */
  let readSeq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function read(): Promise<void> {
    const id = threadId.value;
    const api = bridge();
    const mine = ++readSeq;
    if (!id || !api?.inboxList || !api.inboxHistory) {
      waiting.value = [];
      seen.value = [];
      loaded.value = true;
      return;
    }
    try {
      const [w, h] = await Promise.all([api.inboxList(id), api.inboxHistory(id, HISTORY_LIMIT)]);
      if (mine !== readSeq) return;
      waiting.value = w;
      seen.value = h;
      error.value = null;
    } catch (e) {
      if (mine !== readSeq) return;
      error.value = peelIpcError(e, "Could not read the inbox");
    } finally {
      if (mine === readSeq) loaded.value = true;
    }
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void read();
    }, REREAD_DELAY_MS);
  }

  const detach = bridge()?.onEvent?.((event: RuntimeEvent) => {
    if (event.type === "thread.inbox-changed" && event.threadId === threadId.value) schedule();
  });

  watch(
    threadId,
    () => {
      loaded.value = false;
      void read();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    if (timer) clearTimeout(timer);
    detach?.();
  });

  return { waiting, seen, loaded, error, refresh: read };
}

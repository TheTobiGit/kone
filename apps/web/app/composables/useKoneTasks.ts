import { shallowReactive } from "vue";
import type { KoneTaskList } from "@kone/protocol/kone-tasks";
import type { KoneAgentApi, RuntimeEvent } from "~/types/desktop";

// Every thread's kone task list, as the renderer holds it: one shared map, so
// the dock and the away-from-thread pills read the same list without each
// asking the main process for it. A thread's list is read once, the first time
// something shows that thread; every change after that arrives whole on
// thread.tasks-updated, and the highest revision wins, so a slow first read
// can never overwrite a newer write.

export type KoneTasksBridge = Pick<KoneAgentApi, "taskList" | "onEvent">;

const lists = shallowReactive(new Map<string, KoneTaskList>());
const requested = new Set<string>();
let detach: (() => void) | null = null;
let bridgeOf: () => Partial<KoneTasksBridge> | undefined = () =>
  import.meta.client ? window.koneDesktop?.agent : undefined;

function keep(list: KoneTaskList): void {
  const held = lists.get(list.threadId);
  if (held && held.revision >= list.revision) return;
  lists.set(list.threadId, list);
}

function attach(): void {
  if (detach) return;
  const off = bridgeOf()?.onEvent?.((event: RuntimeEvent) => {
    if (event.type !== "thread.tasks-updated") return;
    keep({ threadId: event.threadId, tasks: event.tasks, revision: event.revision, updatedAt: event.updatedAt });
  });
  if (off) detach = off;
}

/** A failed first read is tried again a few times, further apart each time.
 *  A reader that already showed the thread keeps showing what it had (its
 *  provider's checklist), and lands on the kone list once a retry reads it. */
const RETRY_DELAYS_MS = [500, 2000, 8000];

function load(threadId: string, attempt = 0): void {
  if (attempt === 0) {
    if (requested.has(threadId)) return;
    requested.add(threadId);
  }
  const api = bridgeOf();
  if (!api?.taskList) return;
  api.taskList(threadId).then(
    (list) => {
      if (list) keep(list);
    },
    () => {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) setTimeout(() => load(threadId, attempt + 1), delay);
    },
  );
}

/** The kone task list a thread keeps, or null while it has none. Reading it
 *  is reactive; the first read for a thread also fetches it. */
export function koneTaskListFor(threadId: string | null | undefined): KoneTaskList | null {
  if (!threadId) return null;
  attach();
  if (!requested.has(threadId)) queueMicrotask(() => load(threadId));
  return lists.get(threadId) ?? null;
}

/** Test seam: swap the bridge and forget everything held. */
export function resetKoneTasksForTest(bridge?: () => Partial<KoneTasksBridge> | undefined): void {
  detach?.();
  detach = null;
  lists.clear();
  requested.clear();
  if (bridge) bridgeOf = bridge;
}

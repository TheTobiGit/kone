import { computed, ref, watch } from "vue";
import { tryOnScopeDispose, useStorage } from "@vueuse/core";
import type { RuntimeEvent, StoredThreadMeta } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";
import {
  byRecency,
  liftLegacyPins,
  SESSION_PIN_KEY,
  summarizeSession,
  type SessionProjectTag,
} from "~/utils/sessionList";

// Shared reactive core for the PINNED / RECENT conversations block, used by
// useRecentSessions (one project) and useAllRecentSessions (cross-project). The
// two differ only in how they gather raw thread metadata — a single
// history.list call vs. a fan-out over recent projects — so everything else
// (the pinned/recent split, the recency sort, pin/archive/delete actions, the
// one-time localStorage→DB pin lift, and the live event-driven refresh) lives
// here in one place.

export interface SessionListSource {
  /** Gather the raw thread metadata rows. The caller owns its own filtering and
   *  project tagging; it resolves to the full list to render. */
  fetch: () => Promise<Array<{ meta: StoredThreadMeta; project?: SessionProjectTag }>>;
  /** Browser-dev stand-in list, used when there's no desktop bridge. */
  mock: () => SessionSummary[];
  /** Optional reactive dependency — reload when its value changes. Only the
   *  value's identity is watched, never read, so its type is deliberately open. */
  // eslint-disable-next-line anti-slop/no-unknown-returns
  trigger?: () => unknown;
}

const historyApi = () =>
  import.meta.client ? window.koneDesktop?.agent?.history : undefined;

export function useSessionList(source: SessionListSource) {
  const api = () => historyApi();

  const pinnedIds = useStorage<string[]>(SESSION_PIN_KEY, []);
  const items = ref<SessionSummary[]>([]);
  const loading = ref(true);

  // `silent` re-reads in place (live event-driven refresh) without dropping the
  // block back to its loading state.
  async function load(silent = false): Promise<void> {
    if (!silent) loading.value = true;
    const history = api();
    if (!history) {
      items.value = source.mock();
      loading.value = false;
      return;
    }
    try {
      // One-time lift of browser-localStorage pins into the DB. Only cleared
      // once every write succeeded, so a failed migration retries next load.
      if (pinnedIds.value.length > 0) {
        const legacy = [...pinnedIds.value];
        if (await liftLegacyPins(history, legacy)) pinnedIds.value = [];
      }
      const pins = new Set(pinnedIds.value);
      const rows = await source.fetch();
      items.value = rows.map(({ meta, project }) =>
        summarizeSession(meta, meta.isPinned ?? pins.has(meta.threadId), project),
      );
    } catch {
      // History is a convenience — never surface an error over an empty list.
      if (!silent) items.value = [];
    } finally {
      loading.value = false;
    }
  }

  // Re-key the pinned flag reactively without a full reload — a pin toggle
  // shouldn't re-hit the bridge. Only applies in browser-dev mode: with the
  // bridge present the DB row is the source of truth, and re-keying from
  // localStorage would wipe DB pins after the one-time migration clears it.
  watch(pinnedIds, (ids) => {
    if (api()) return;
    const pins = new Set(ids);
    items.value = items.value.map((s) => ({ ...s, pinned: pins.has(s.threadId) }));
  });

  const pinned = computed(() => items.value.filter((s) => s.pinned).sort(byRecency));
  const recent = computed(() => items.value.filter((s) => !s.pinned).sort(byRecency));
  const hasAny = computed(() => pinned.value.length > 0 || recent.value.length > 0);

  function togglePin(threadId: string): void {
    const row = items.value.find((s) => s.threadId === threadId);
    const history = api();
    if (history) {
      const next = !(row?.pinned ?? pinnedIds.value.includes(threadId));
      void history.setPinned(threadId, next).catch(() => {});
      if (row) row.pinned = next;
      return;
    }
    // Browser-dev fallback: no DB to write to, keep the localStorage behaviour.
    const set = new Set(pinnedIds.value);
    if (set.has(threadId)) set.delete(threadId);
    else set.add(threadId);
    pinnedIds.value = [...set];
  }

  // Mark a thread done, or take the mark off. Unlike archive this never drops
  // the row: done is a fact about your attention, and which list a done thread
  // belongs in is the caller's question to answer, not this composable's.
  function toggleDone(threadId: string): void {
    const row = items.value.find((s) => s.threadId === threadId);
    if (!row) return;
    const next = !row.done;
    row.done = next;
    void api()?.setDone(threadId, next).catch(() => {});
  }

  // Drop a row from the on-screen list immediately, so archive/delete feel
  // instant; the bridge call (when present) is fire-and-forget behind it.
  function dropLocally(threadId: string): void {
    items.value = items.value.filter((s) => s.threadId !== threadId);
    if (pinnedIds.value.includes(threadId)) {
      pinnedIds.value = pinnedIds.value.filter((id) => id !== threadId);
    }
  }

  function archive(threadId: string): void {
    dropLocally(threadId);
    void api()?.archive(threadId, true).catch(() => {});
  }

  function remove(threadId: string): void {
    dropLocally(threadId);
    void api()?.remove(threadId).catch(() => {});
  }

  // Keep the list live. Titles rename on first turn; tokens / branch / diffstat
  // settle as a turn runs. Debounced and trailing so a burst of events costs one
  // refetch.
  const agent = () => (import.meta.client ? window.koneDesktop?.agent : undefined);
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const detach = agent()?.onEvent((event: RuntimeEvent) => {
    if (
      event.type !== "turn.completed" &&
      event.type !== "thread.token-usage.updated" &&
      event.type !== "thread.title.updated"
    ) {
      return;
    }
    // Title updates are cheap and user-visible — apply in place when we already
    // have the row, otherwise fall through to a silent reload.
    if (event.type === "thread.title.updated") {
      const row = items.value.find((s) => s.threadId === event.threadId);
      if (row) {
        row.title = event.title;
        return;
      }
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void load(true);
    }, 600);
  });

  // Initial load plus a reload whenever the trigger's value changes.
  watch(source.trigger ?? (() => null), () => load(), { immediate: true });

  tryOnScopeDispose(() => {
    if (refreshTimer) clearTimeout(refreshTimer);
    detach?.();
  });

  return {
    pinned,
    recent,
    loading,
    hasAny,
    reload: () => load(),
    togglePin,
    toggleDone,
    archive,
    remove,
  };
}

import { computed, ref, watch } from "vue";
import { tryOnScopeDispose, useStorage } from "@vueuse/core";
import type { RuntimeEvent, StoredThreadMeta } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";
import {
  byRecency,
  liftLegacyPins,
  markThreadVisited,
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

  // Record that the user has just had this thread in front of them, which is
  // what makes a reply seen. Applied to the row first so the mark clears under
  // the eye that just read it, and written behind that — a row is re-summarized
  // from the DB on the next load, so the two agree without waiting on each
  // other.
  //
  // The stamp only moves forward (the store enforces it too): two surfaces can
  // be showing the same thread, and the slower one's write must not undo the
  // faster one's.
  function markVisited(threadId: string, at = Date.now()): void {
    const row = items.value.find((s) => s.threadId === threadId);
    if (row) {
      if ((row.lastVisitedAt ?? 0) >= at) return;
      row.lastVisitedAt = at;
      row.unread = row.updatedAt > at;
    }
    markThreadVisited(threadId, undefined, at);
  }

  /** Put the mark back on a thread you have already seen — the visit is moved
   *  to just before its last activity, which is the only way to say "unread"
   *  in a model where unread is a comparison. Forced, because this is the one
   *  write that deliberately goes backwards. */
  function markUnread(threadId: string): void {
    const row = items.value.find((s) => s.threadId === threadId);
    if (!row) return;
    const at = row.updatedAt - 1;
    row.lastVisitedAt = at;
    row.unread = true;
    void api()?.setVisited(threadId, at, true).catch(() => {});
  }

  // Drop a row from the on-screen list immediately, so archive/delete feel
  // instant; the bridge call (when present) is fire-and-forget behind it.
  function dropLocally(threadId: string): void {
    items.value = items.value.filter((s) => s.threadId !== threadId);
    if (pinnedIds.value.includes(threadId)) {
      pinnedIds.value = pinnedIds.value.filter((id) => id !== threadId);
    }
  }

  // Put a thread away, or take it back out. The row drops from the on-screen
  // list immediately, so the stamp feels instant — but the store can refuse the
  // write (a spawned descendant mid-turn), so the drop is held open until the
  // bridge answers: a refusal puts the row back exactly where it was, instead of
  // the row flickering away and quietly reappearing on the next reload.
  //
  // Both directions are the same movement seen from opposite lists. The live
  // list and the archive are disjoint queries over one column, so archiving
  // drops a row from here and restoring drops a row from there — neither view
  // ever has to know which of the two it is.
  //
  // Resolves to whether the store took it. Callers that do something
  // irreversible behind an archive — the studio forgetting the live session and
  // closing its column — have to wait for that answer, or a refusal leaves them
  // torn down around a thread that is still there.
  async function archive(threadId: string, archived = true): Promise<boolean> {
    const index = items.value.findIndex((s) => s.threadId === threadId);
    const row = index >= 0 ? items.value[index] : undefined;
    const wasPinned = pinnedIds.value.includes(threadId);
    dropLocally(threadId);
    const bridge = api();
    if (!bridge) return true; // browser-dev mock: no store behind the list, the drop is the whole story
    const result = await bridge.archive(threadId, archived).catch(() => null);
    if (result?.ok) return true;
    if (row) {
      const at = Math.min(index, items.value.length);
      items.value.splice(at, 0, row);
      if (wasPinned) pinnedIds.value = [...pinnedIds.value, threadId];
    }
    return false;
  }

  /** Take a thread back out of the archive. Named rather than left as
   *  `archive(id, false)` at every call site: restoring is a gesture in its own
   *  right, and a boolean argument at the point of use reads as a typo. */
  function restore(threadId: string): Promise<boolean> {
    return archive(threadId, false);
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
      event.type !== "thread.title.updated" &&
      // Archive/restore changed which set this list reads from — the live
      // list and the archive are disjoint queries, so a stamp anywhere moves
      // the row across. Reconcile by refetch rather than by patching rows:
      // the stamp may have landed on a subtree, and this list may not even
      // be the surface that asked for it.
      event.type !== "thread.archived" &&
      event.type !== "thread.unarchived"
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
    markVisited,
    markUnread,
    archive,
    restore,
    remove,
  };
}

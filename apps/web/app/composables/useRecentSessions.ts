import { computed, ref, watch } from "vue";
import { tryOnScopeDispose, useStorage } from "@vueuse/core";
import type { RuntimeEvent, StoredThreadMeta } from "~/types/desktop";
import { SESSION_BRAND, type SessionSummary } from "~/types/session";

// Feeds the Project Home "recent conversations" block (PINNED / RECENT). It
// reads the project's persisted agent threads back off disk (the main-process
// ConversationStore, via the history bridge), flattens each into a SessionSummary
// and splits them into pinned vs. recent. In `nuxt dev` (no bridge) it falls back
// a plain browser — the same real-bridge / mock-fallback shape as useGitClone and
// useAgent.
//
// Titles are persisted on the thread (first-turn word fallback, then an
// agent-generated rename), so the desktop path reads them
// straight off the metadata list without reconstructing every transcript. Rows
// render the diff / token columns only when a value is present.

const MAX = 8;
// A running total that survives project switches — a pin is "keep this thread in
// front" and isn't stored alongside the thread itself.
const PIN_KEY = "kone:pinned-sessions";

function summarize(meta: StoredThreadMeta, pinned: boolean): SessionSummary {
  return {
    threadId: meta.threadId,
    title: meta.title?.trim() || "Untitled session",
    provider: meta.provider,
    brand: SESSION_BRAND[meta.provider] ?? "generic",
    model: meta.model,
    branch: meta.branch ?? undefined,
    added: meta.added,
    removed: meta.removed,
    tokens: meta.tokens,
    updatedAt: meta.updatedAt,
    pinned,
  };
}

// with the branch / diff / token columns the design shows. Timestamps are
// relative to now so the "2d ago" stamps stay honest as the day rolls over.
function mockSessions(): SessionSummary[] {
  const DAY = 86_400_000;
  const now = Date.now();
  return [
    {
      threadId: "mock-1",
      title: "Wire up the Droid bridge protocol",
      provider: "claudeAgent",
      brand: "claude",
      branch: "main",
      added: 410,
      removed: 88,
      tokens: 3_200_000,
      updatedAt: now - 7 * DAY,
      pinned: true,
    },
    {
      threadId: "mock-2",
      title: "Design system tokens + main.css",
      provider: "codex",
      brand: "gpt",
      branch: "main",
      added: 256,
      removed: 40,
      tokens: 1_900_000,
      updatedAt: now - 7 * DAY,
      pinned: true,
    },
    {
      threadId: "mock-3",
      title: "Fix structuredClone crash on re-open",
      provider: "claudeAgent",
      brand: "claude",
      branch: "calm-agent-ui",
      added: 128,
      removed: 34,
      tokens: 1_240_000,
      updatedAt: now - 2 * DAY,
    },
    {
      threadId: "mock-4",
      title: "Calm material pass across tokens",
      provider: "claudeAgent",
      brand: "claude",
      branch: "main",
      added: 342,
      removed: 96,
      tokens: 2_100_000,
      updatedAt: now - 2 * DAY,
    },
    {
      threadId: "mock-5",
      title: "Polish agent-activity rendering",
      provider: "codex",
      brand: "gpt",
      branch: "agent-ui",
      added: 64,
      removed: 20,
      tokens: 480_000,
      updatedAt: now - 3 * DAY,
    },
    {
      threadId: "mock-6",
      title: "Wire the droid ACP turn params",
      provider: "droid",
      brand: "droid",
      branch: "droid-bridge",
      added: 118,
      removed: 31,
      tokens: 740_000,
      updatedAt: now - 0.6 * DAY,
    },
  ];
}

export function useRecentSessions(cwd: () => string) {
  const bridge = () =>
    import.meta.client ? window.koneDesktop?.agent?.history : undefined;

  const pinnedIds = useStorage<string[]>(PIN_KEY, []);
  const items = ref<SessionSummary[]>([]);
  const loading = ref(true);

  // `silent` refreshes in place (live event-driven re-read) without dropping the
  // block back to its loading state — the numbers update under the cursor rather
  // than flashing the whole list out and in.
  async function load(silent = false): Promise<void> {
    if (!silent) loading.value = true;
    const api = bridge();
    if (!api) {
      // block is fully demoable.
      items.value = mockSessions();
      loading.value = false;
      return;
    }
    try {
      const path = cwd();
      const metas = await api.list(path);
      const pins = new Set(pinnedIds.value);
      items.value = metas.slice(0, MAX).map((m) => summarize(m, pins.has(m.threadId)));
    } catch {
      // History is a convenience — never surface an error over an empty list.
      // A failed *silent* refresh keeps whatever's on screen rather than blanking it.
      if (!silent) items.value = [];
    } finally {
      loading.value = false;
    }
  }

  // Re-key the pinned flag reactively without a full reload — a pin toggle
  // shouldn't re-hit the bridge.
  watch(pinnedIds, (ids) => {
    const pins = new Set(ids);
    items.value = items.value.map((s) => ({ ...s, pinned: pins.has(s.threadId) }));
  });

  // Newest first, within each group. Pins float to their own header above.
  const byRecency = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt;
  const pinned = computed(() => items.value.filter((s) => s.pinned).sort(byRecency));
  const recent = computed(() => items.value.filter((s) => !s.pinned).sort(byRecency));

  function togglePin(threadId: string): void {
    const set = new Set(pinnedIds.value);
    if (set.has(threadId)) set.delete(threadId);
    else set.add(threadId);
    pinnedIds.value = [...set];
  }

  // Drop a row from the on-screen list immediately, so archive/delete feel
  // instant; the bridge call (when present) is fire-and-forget behind it.
  function dropLocally(threadId: string): void {
    items.value = items.value.filter((s) => s.threadId !== threadId);
    if (pinnedIds.value.includes(threadId)) {
      pinnedIds.value = pinnedIds.value.filter((id) => id !== threadId);
    }
  }

  /** Hide a thread from the recent list. Recoverable — the row stays in the DB
   *  with an `archived` stamp; only the store's reads filter it out. */
  function archive(threadId: string): void {
    dropLocally(threadId);
    void bridge()?.archive(threadId, true).catch(() => {});
  }

  /** Permanently delete a thread. Irreversible — the row expects the caller
   *  (RecentSessions) to have confirmed first. */
  function remove(threadId: string): void {
    dropLocally(threadId);
    void bridge()?.remove(threadId).catch(() => {});
  }

  load();
  watch(cwd, () => load());

  // Keep the list live. Titles rename on first turn (fallback then generated);
  // tokens / branch / diffstat settle as a turn runs. Debounced and trailing so
  // a burst of events costs one refetch, and so the git snapshot has committed
  // before we read after turn.completed.
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
    // have the row, otherwise fall through to a silent reload (new first turn).
    if (event.type === "thread.title.updated") {
      const row = items.value.find((s) => s.threadId === event.threadId);
      if (row) {
        row.title = event.title;
        row.updatedAt = event.at;
        return;
      }
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void load(true);
    }, 600);
  });

  tryOnScopeDispose(() => {
    if (refreshTimer) clearTimeout(refreshTimer);
    detach?.();
  });

  return { pinned, recent, loading, reload: () => load(), togglePin, archive, remove };
}

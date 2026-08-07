import { computed, ref, watch } from "vue";
import { tryOnScopeDispose, useStorage } from "@vueuse/core";
import type { RuntimeEvent, StoredThreadMeta } from "~/types/desktop";
import { SESSION_BRAND, type SessionSummary } from "~/types/session";
import { useRecentProjects } from "~/composables/useRecentProjects";

// The App Home ("launcher") counterpart to useRecentSessions: the same PINNED /
// RECENT conversations block, but pooled across *every* recent project instead
// of the one that's open. It fans out over the recent-projects list, reads each
// project's persisted threads off disk (the history bridge), tags every row with
// the project it came from, then merges and sorts them into one recency-ranked
// stream. In `nuxt dev` (no bridge) it stands in a small cross-project mock so
// the launcher list is demoable in a plain browser.
//
// Pins and archive/delete work by thread id alone, so they share the exact same
// stores and bridge calls as the in-project block — a session pinned here shows
// pinned there, and vice versa.

const MAX = 6;
// Shared with useRecentSessions — a pin is global "keep this thread in front",
// independent of which project's list is showing it.
const PIN_KEY = "kone:pinned-sessions";

function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function summarize(
  meta: StoredThreadMeta,
  pinned: boolean,
  projectName: string,
): SessionSummary {
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
    projectPath: meta.projectPath,
    projectName,
    sideChat: Boolean(meta.forkContext),
  };
}

// A faithful cross-project stand-in for browser dev — a handful of sessions
// spread over a few projects and two vendors, so the launcher list (and its
// project chips) is fully demoable without the desktop bridge.
function mockSessions(): SessionSummary[] {
  const DAY = 86_400_000;
  const now = Date.now();
  return [
    {
      threadId: "all-mock-1",
      title: "Wire up the Droid bridge protocol",
      provider: "claudeAgent",
      brand: "claude",
      branch: "main",
      added: 410,
      removed: 88,
      tokens: 3_200_000,
      updatedAt: now - 0.2 * DAY,
      pinned: true,
      projectPath: "/Users/you/Developer/kone",
      projectName: "kone",
    },
    {
      threadId: "all-mock-2",
      title: "Token-usage parsing fix",
      provider: "codex",
      brand: "gpt",
      branch: "dev",
      added: 76,
      removed: 22,
      tokens: 620_000,
      updatedAt: now - 0.9 * DAY,
      projectPath: "/Users/you/Developer/nova",
      projectName: "nova",
    },
    {
      threadId: "all-mock-3",
      title: "Fix structuredClone crash on re-open",
      provider: "claudeAgent",
      brand: "claude",
      branch: "calm-agent-ui",
      added: 128,
      removed: 34,
      tokens: 1_240_000,
      updatedAt: now - 2 * DAY,
      projectPath: "/Users/you/Developer/kone",
      projectName: "kone",
    },
    {
      threadId: "all-mock-4",
      title: "Model catalog real-shape pass",
      provider: "codex",
      brand: "gpt",
      branch: "main",
      added: 342,
      removed: 96,
      tokens: 2_100_000,
      updatedAt: now - 3 * DAY,
      projectPath: "/Users/you/Developer/atlas",
      projectName: "atlas",
    },
    {
      threadId: "all-mock-5",
      title: "Polish agent-activity rendering",
      provider: "claudeAgent",
      brand: "claude",
      branch: "agent-ui",
      added: 64,
      removed: 20,
      tokens: 480_000,
      updatedAt: now - 5 * DAY,
      projectPath: "/Users/you/Developer/paper",
      projectName: "paper",
    },
    {
      threadId: "all-mock-6",
      title: "Wire the droid ACP turn params",
      provider: "droid",
      brand: "droid",
      branch: "droid-bridge",
      added: 118,
      removed: 31,
      tokens: 740_000,
      updatedAt: now - 0.6 * DAY,
      projectPath: "/Users/you/Developer/kone",
      projectName: "kone",
    },
  ];
}

export function useAllRecentSessions() {
  const { recents } = useRecentProjects();
  const bridge = () =>
    import.meta.client ? window.koneDesktop?.agent?.history : undefined;

  const pinnedIds = useStorage<string[]>(PIN_KEY, []);
  const items = ref<SessionSummary[]>([]);
  const loading = ref(true);

  // `silent` re-reads in place (live event-driven refresh) without dropping the
  // block back to its loading state — the same behaviour as the in-project list.
  async function load(silent = false): Promise<void> {
    if (!silent) loading.value = true;
    const api = bridge();
    if (!api) {
      items.value = mockSessions();
      loading.value = false;
      return;
    }
    try {
      const projects = recents.value;
      const nameByPath = new Map(projects.map((p) => [p.path, p.name]));
      const pins = new Set(pinnedIds.value);
      // One local SQLite read per project; a failed project drops to an empty
      // list rather than sinking the whole aggregate.
      const lists = await Promise.all(
        projects.map((p) =>
          api.list(p.path).catch(() => [] as StoredThreadMeta[]),
        ),
      );
      items.value = lists
        .flat()
        .map((m) =>
          summarize(
            m,
            pins.has(m.threadId),
            nameByPath.get(m.projectPath) ?? basename(m.projectPath),
          ),
        );
    } catch {
      if (!silent) items.value = [];
    } finally {
      loading.value = false;
    }
  }

  // Re-key the pinned flag reactively without a full reload — a pin toggle
  // shouldn't re-fan-out over every project's history.
  watch(pinnedIds, (ids) => {
    const pins = new Set(ids);
    items.value = items.value.map((s) => ({ ...s, pinned: pins.has(s.threadId) }));
  });

  // Newest first, within each group. Pins float to their own header above; the
  // RECENT group is capped so the launcher list stays a glance, not a backlog.
  const byRecency = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt;
  const pinned = computed(() => items.value.filter((s) => s.pinned).sort(byRecency));
  const recent = computed(() =>
    items.value.filter((s) => !s.pinned).sort(byRecency).slice(0, MAX),
  );
  const hasAny = computed(() => pinned.value.length > 0 || recent.value.length > 0);

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

  function archive(threadId: string): void {
    dropLocally(threadId);
    void bridge()?.archive(threadId, true).catch(() => {});
  }

  function remove(threadId: string): void {
    dropLocally(threadId);
    void bridge()?.remove(threadId).catch(() => {});
  }

  // Reload when the set of recent projects changes (a project opened, cloned,
  // removed) — the pool of histories to scan moves with it.
  watch(
    () => recents.value.map((p) => p.path).join("\n"),
    () => load(),
    { immediate: true },
  );

  // Keep the list live across projects: any thread finishing a turn, renaming,
  // or settling its token tally refreshes the whole pool. Debounced + trailing
  // so a burst of events costs one refetch.
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

  return { pinned, recent, loading, hasAny, reload: () => load(), togglePin, archive, remove };
}

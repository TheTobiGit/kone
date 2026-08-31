import type { StoredThreadMeta } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";
import { useRecentProjects } from "~/composables/useRecentProjects";
import { useSessionList } from "~/composables/useSessionList";

// The App Home ("launcher") counterpart to useRecentSessions: the same PINNED /
// RECENT conversations block, but pooled across *every* recent project instead
// of the one that's open. It fans out over the recent-projects list, reads each
// project's persisted threads off disk (the history bridge), tags every row with
// the project it came from, then merges and sorts them into one recency-ranked
// stream. In `nuxt dev` (no bridge) it stands in a small cross-project mock.
//
// Pins and archive/delete work by thread id alone, so they share the exact same
// stores and bridge calls as the in-project block — a session pinned here shows
// pinned there, and vice versa. The shared behaviour lives in useSessionList;
// this wrapper only owns the cross-project fan-out and the clickable-path guard.
//
// One hard rule on the open path: a row is only clickable when its stored
// project path is one of the recents grid's paths. The fan-out reads each
// recent project's history, but a thread's `projectPath` can trail behind the
// grid (a project removed from recents, or a path that drifted after a rename
// or symlink change). Clicking such a row would silently re-add a project under
// a path the user never opened — and open the board under that path, so the
// saved layout and known-thread set wouldn't match the project the row came
// from. Filtering keeps the launcher list exactly "every recent project's
// conversations", with every row's target fields consistent with the grid.

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
      costUsd: 15.36,
      updatedAt: now - 0.2 * DAY,
      // Two of the stand-in rows carry the unread mark so the list's read /
      // unread split is visible without a database behind it.
      unread: true,
      pinned: true,
      projectPath: "/Users/you/Developer/kone",
      projectName: "kone",
      snippet: "Added WebSocket transport layer and validated IPC payloads.",
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
      costUsd: 2.17,
      updatedAt: now - 0.9 * DAY,
      projectPath: "/Users/you/Developer/nova",
      projectName: "nova",
      snippet: "Corrected regex match for token totals in stream response envelopes.",
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
      costUsd: 5.95,
      updatedAt: now - 2 * DAY,
      projectPath: "/Users/you/Developer/kone",
      projectName: "kone",
      snippet: "Ensured prototype-free serialization before storing state snapshots.",
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
      costUsd: 7.35,
      updatedAt: now - 3 * DAY,
      projectPath: "/Users/you/Developer/atlas",
      projectName: "atlas",
      snippet: "Synced capability flags and max output token schemas with latest provider specs.",
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
      costUsd: 2.30,
      updatedAt: now - 5 * DAY,
      projectPath: "/Users/you/Developer/paper",
      projectName: "paper",
      snippet: "Smoothed state transitions for turn orbs and unified edge masking.",
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
      costUsd: 2.59,
      updatedAt: now - 0.6 * DAY,
      unread: true,
      projectPath: "/Users/you/Developer/kone",
      projectName: "kone",
      snippet: "Mapped reasoning effort and temperature overrides to CLI flags.",
    },
  ];
}

export interface AllRecentSessionsOptions {
  /** Read the archive instead of the live list. The two are disjoint views of
   *  the same table, so an instance shows one or the other, never both. */
  archived?: boolean;
}

export function useAllRecentSessions(options?: AllRecentSessionsOptions) {
  const { recents } = useRecentProjects();
  const archived = options?.archived === true;
  const history = () =>
    import.meta.client ? window.koneDesktop?.agent?.history : undefined;

  return useSessionList({
    fetch: async () => {
      const api = history();
      if (!api) return [];
      const projects = recents.value;
      const nameByPath = new Map(projects.map((p) => [p.path, p.name]));
      // One local SQLite read per project; a failed project drops to an empty
      // list rather than sinking the whole aggregate.
      const lists = await Promise.all(
        // SAFETY: api.list resolves StoredThreadMeta[]; the catch substitutes
        // an empty list of that same element type.
        projects.map((p) => api.list(p.path, { archived }).catch(() => [] as StoredThreadMeta[])),
      );
      return lists
        .flat()
        .filter((m) => nameByPath.has(m.projectPath))
        .map((meta) => ({
          meta,
          project: {
            projectName: nameByPath.get(meta.projectPath)!,
            projectPath: meta.projectPath,
          },
        }));
    },
    // Browser dev has no archive to read, so a slice of the same stand-ins
    // takes its place — enough for the archived view to be demoable, and
    // disjoint from the live slice so switching between them actually changes
    // what is on screen.
    mock: () => (archived ? mockSessions().slice(-2) : mockSessions().slice(0, -2)),
    trigger: () => recents.value.map((p) => p.path).join("\n"),
  });
}

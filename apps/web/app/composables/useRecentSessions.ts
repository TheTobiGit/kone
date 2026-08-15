import type { StoredThreadMeta } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";
import { useSessionList } from "~/composables/useSessionList";

// Feeds the Project Home "recent conversations" block (PINNED / RECENT). It
// reads the project's persisted agent threads back off disk (the main-process
// ConversationStore, via the history bridge) and splits them into pinned vs.
// recent. In `nuxt dev` (no bridge) it falls back to a plain browser — the same
// real-bridge / mock-fallback shape as useGitClone and useAgent.
//
// The shared behaviour — the pinned/recent split, recency sort, pin/archive/
// delete actions, the one-time localStorage→DB pin lift and the live
// event-driven refresh — lives in useSessionList; this wrapper only owns how the
// raw metadata for the single open project is gathered.

// A faithful in-project stand-in for browser dev, so the block (with the branch
// / diff / token columns the design shows) is demoable without the bridge.
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
  const history = () =>
    import.meta.client ? window.koneDesktop?.agent?.history : undefined;

  return useSessionList({
    fetch: async () => {
      const api = history();
      if (!api) return [];
      const metas = await api.list(cwd());
      return metas.map((meta) => ({ meta }));
    },
    mock: mockSessions,
    trigger: cwd,
  });
}

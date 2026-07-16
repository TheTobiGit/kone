import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitRepo,
  GitStatus,
} from "~/types/desktop";

// Reads git state through the Electron bridge. Git inspection lives in the
// main process (it needs a real filesystem + the `git` binary), so there is no
// browser fallback for the heavier reads — in `nuxt dev` status/branches/log
// resolve to empty/null and `available` is false. `detect` is the exception: it
// returns a small canned summary for the mock repos so the folder picker's
// branch + diffstat is demoable in the browser (mirrors useFileSystem's mock).
export function useGit() {
  const bridge = import.meta.client ? window.koneDesktop : undefined;
  const git = bridge?.git;

  return {
    available: Boolean(git),

    detect(dir: string): Promise<GitRepo | null> {
      if (git) return git.detect(dir);
      const repo = mockDetect(dir);
      if (!repo) return Promise.resolve(null);
      // A short, slightly-staggered delay stands in for real git latency, so the
      // picker's processing→reveal beat is faithful (and visible) in `nuxt dev`.
      const delay = 140 + Math.random() * 260;
      return new Promise((resolve) => setTimeout(() => resolve(repo), delay));
    },
    status(dir: string): Promise<GitStatus | null> {
      if (git) return git.status(dir);
      const status = mockStatus(dir);
      if (!status) return Promise.resolve(null);
      const delay = 140 + Math.random() * 260;
      return new Promise((resolve) => setTimeout(() => resolve(status), delay));
    },
    branches(dir: string): Promise<GitBranch[]> {
      return git ? git.branches(dir) : Promise.resolve([]);
    },
    log(dir: string, limit?: number): Promise<GitCommit[]> {
      return git ? git.log(dir, limit) : Promise.resolve([]);
    },
  };
}

// ── dev fallback ──────────────────────────────────────────────────────────────
// Canned summaries for the mock repo paths in useFileSystem, so the picker shows
// a plausible branch + line diffstat in `nuxt dev`. Keep these paths in sync.

const MOCK_SUMMARIES: Record<
  string,
  Pick<GitRepo, "branch" | "ahead" | "behind" | "changeCount" | "added" | "removed">
> = {
  "/Users/you/Developer/kone": {
    branch: "calm-agent-ui-continuation",
    ahead: 2,
    behind: 0,
    changeCount: 5,
    added: 128,
    removed: 34,
  },
  "/Users/you/Developer/nxui": {
    branch: "main",
    ahead: 0,
    behind: 0,
    changeCount: 0,
    added: 0,
    removed: 0,
  },
  "/Users/you/Developer/sandbox": {
    branch: "spike/particles",
    ahead: 0,
    behind: 3,
    changeCount: 2,
    added: 12,
    removed: 47,
  },
};

function mockDetect(dir: string): GitRepo | null {
  const summary = MOCK_SUMMARIES[dir];
  if (!summary) return null;
  const name = dir.split("/").filter(Boolean).pop() ?? dir;
  return {
    root: dir,
    name,
    detached: false,
    clean: summary.changeCount === 0,
    ...summary,
  };
}

// The changed-file lists behind each mock repo — these become the folder's
// peeking papers. Kept in sync with MOCK_SUMMARIES so the three demo repos each
// show a distinct folder state: kone (active), sandbox (deletions), nxui (clean).
const MOCK_CHANGES: Record<string, GitChange[]> = {
  "/Users/you/Developer/kone": [
    { path: "apps/web/app/components/ProjectFolder.vue", status: "added", staged: true, unstaged: false, added: 96, removed: 0 },
    { path: "apps/web/app/composables/useGit.ts", status: "modified", staged: true, unstaged: false, added: 22, removed: 6 },
    { path: "apps/web/nuxt.config.js", status: "modified", staged: true, unstaged: false, added: 5, removed: 1 },
    { path: "apps/web/app/assets/css/main.css", status: "modified", staged: false, unstaged: true, added: 4, removed: 25 },
    { path: "apps/web/app/pages/index.vue", status: "modified", staged: false, unstaged: true, added: 1, removed: 2 },
  ],
  "/Users/you/Developer/sandbox": [
    { path: "src/legacy-emitter.js", status: "deleted", staged: false, unstaged: true, added: 0, removed: 34 },
    { path: "src/particles.ts", status: "modified", staged: false, unstaged: true, added: 12, removed: 13 },
  ],
  "/Users/you/Developer/nxui": [],
};

function mockStatus(dir: string): GitStatus | null {
  const summary = MOCK_SUMMARIES[dir];
  const changes = MOCK_CHANGES[dir];
  if (!summary || !changes) return null;
  return {
    root: dir,
    branch: summary.branch,
    detached: false,
    head: "0000000",
    upstream: null,
    ahead: summary.ahead,
    behind: summary.behind,
    changes,
    staged: changes.filter((c) => c.staged).length,
    unstaged: changes.filter((c) => c.unstaged).length,
    untracked: changes.filter((c) => c.status === "untracked").length,
    clean: changes.length === 0,
  };
}

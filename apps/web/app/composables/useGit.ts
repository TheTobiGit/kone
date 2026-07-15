import type {
  GitBranch,
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
      return git ? git.detect(dir) : Promise.resolve(mockDetect(dir));
    },
    status(dir: string): Promise<GitStatus | null> {
      return git ? git.status(dir) : Promise.resolve(null);
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

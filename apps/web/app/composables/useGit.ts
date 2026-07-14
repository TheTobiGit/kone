import type {
  GitBranch,
  GitCommit,
  GitRepo,
  GitStatus,
} from "~/types/desktop";

// Reads git state through the Electron bridge. Git inspection lives in the
// main process (it needs a real filesystem + the `git` binary), so there is no
// browser fallback — in `nuxt dev` these resolve to empty/null and `available`
// is false.
export function useGit() {
  const bridge = import.meta.client ? window.koneDesktop : undefined;
  const git = bridge?.git;

  return {
    available: Boolean(git),

    detect(dir: string): Promise<GitRepo | null> {
      return git ? git.detect(dir) : Promise.resolve(null);
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

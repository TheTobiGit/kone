import type {
  GitBranch,
  GitCommit,
  GitFileContent,
  GitFileDiff,
  GitProjectFile,
  GitRepo,
  GitStatus,
} from "~/types/desktop";
import {
  mockBranches,
  mockContent,
  mockDetect,
  mockDiff,
  mockFiles,
  mockStatus,
} from "~/lib/devMocks";

// Reads git state through the Electron bridge. Git inspection lives in the
// main process (it needs a real filesystem + the `git` binary), so there is no
// browser fallback for the heavier reads — in `nuxt dev` status/branches/log
// resolve to empty/null and `available` is false. `detect`/`status`/`diff`/
// `content` are the exception: they resolve against the shared dev-world repos
// (see lib/devMocks) so the picker + detail view stay demoable in the browser.
export function useGit() {
  const bridge = import.meta.client ? window.koneDesktop : undefined;
  const git = bridge?.git;

  return {
    available: Boolean(git),

    detect(dir: string): Promise<GitRepo | null> {
      if (git) return git.detect(dir);
      return withLatency(mockDetect(dir));
    },
    status(dir: string): Promise<GitStatus | null> {
      if (git) return git.status(dir);
      return withLatency(mockStatus(dir));
    },
    diff(dir: string, path: string, staged: boolean): Promise<GitFileDiff | null> {
      if (git) return git.diff(dir, path, staged);
      return withLatency(mockDiff(dir, path));
    },
    content(dir: string, path: string): Promise<GitFileContent | null> {
      if (git) return git.content(dir, path);
      return withLatency(mockContent(dir, path));
    },
    files(dir: string, query?: string): Promise<GitProjectFile[]> {
      if (git) return git.files(dir, query);
      return withLatency(mockFiles(dir, query)).then((files) => files ?? []);
    },
    branches(dir: string): Promise<GitBranch[]> {
      if (git) return git.branches(dir);
      // Browser dev: resolve against the demo-world repos so the switcher is
      // demoable (checkout below stays a no-op — nothing on disk to move).
      return withLatency(mockBranches(dir)).then((b) => b ?? []);
    },
    log(dir: string, limit?: number): Promise<GitCommit[]> {
      return git ? git.log(dir, limit) : Promise.resolve([]);
    },
    // Live status. Only the desktop bridge can watch a real filesystem, so in
    // `nuxt dev` this is a no-op (the mock repos never change on disk anyway).
    watchStatus(dir: string, cb: (status: GitStatus) => void): () => void {
      return git ? git.watchStatus(dir, cb) : () => {};
    },
    // Mutations. Without the bridge (browser dev) they resolve as no-ops — the
    // renderer's optimistic update is the only effect there.
    stage(dir: string, paths: string[]): Promise<void> {
      return git ? git.stage(dir, paths) : Promise.resolve();
    },
    unstage(dir: string, paths: string[]): Promise<void> {
      return git ? git.unstage(dir, paths) : Promise.resolve();
    },
    discard(dir: string, paths: string[]): Promise<void> {
      return git ? git.discard(dir, paths) : Promise.resolve();
    },
    // Switch to a local branch. Browser dev has no real repo to move, but it
    // still waits a git-like beat so the caller's switching state gets a frame
    // (an instant resolve would snap the picker shut with no in-progress cue).
    checkout(dir: string, branch: string): Promise<void> {
      if (git) return git.checkout(dir, branch);
      return withLatency(branch).then(() => undefined);
    },
  };
}

// A short, slightly-staggered delay stands in for real git latency, so the dev
// build's processing→reveal beats (the picker, the detail view's loading state)
// are faithful and visible. A null result resolves immediately (nothing to show).
function withLatency<T>(value: T | null): Promise<T | null> {
  if (value === null) return Promise.resolve(null);
  const delay = 130 + Math.random() * 240;
  return new Promise((resolve) => setTimeout(() => resolve(value), delay));
}

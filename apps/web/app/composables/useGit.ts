import type {
  GitBranch,
  GitCommit,
  GitCommitAuthors,
  GitCommitDetail,
  GitCommitOptions,
  GitContributors,
  GitFileContent,
  GitFileDiff,
  GitIdentity,
  GitLogo,
  GitHubPrCreateOptions,
  GitHubPrCreateResult,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  GitHubRepoInfo,
  GitHubStatus,
  GitHubUser,
  GitProjectFile,
  GitPullOptions,
  GitPushOptions,
  GitReadme,
  GitRemote,
  GitRepo,
  GitRepoState,
  GitStashEntry,
  GitStatus,
} from "~/types/desktop";
import {
  mockBranches,
  mockCommitAuthors,
  mockCommitDetail,
  mockCommitDiff,
  mockContent,
  mockContributors,
  mockDetect,
  mockDiff,
  mockFiles,
  mockGhContributors,
  mockGhMe,
  mockGhRepo,
  mockGhStatus,
  mockIdentity,
  mockLog,
  mockLogo,
  mockPrDetail,
  mockPrDiff,
  mockPrs,
  mockReadme,
  mockRemotes,
  mockRepoState,
  mockStashes,
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
    log(dir: string, limit?: number, skip?: number): Promise<GitCommit[]> {
      if (git) return git.log(dir, limit, skip);
      return withLatency(mockLog(dir, limit, skip)).then((c) => c ?? []);
    },
    remotes(dir: string): Promise<GitRemote[]> {
      if (git) return git.remotes(dir);
      return withLatency(mockRemotes(dir)).then((r) => r ?? []);
    },
    repoState(dir: string): Promise<GitRepoState | null> {
      if (git) return git.repoState(dir);
      return withLatency(mockRepoState(dir));
    },
    commitDetail(dir: string, hash: string): Promise<GitCommitDetail | null> {
      if (git) return git.commitDetail(dir, hash);
      return withLatency(mockCommitDetail(dir, hash));
    },
    commitDiff(dir: string, hash: string, path: string): Promise<GitFileDiff | null> {
      if (git) return git.commitDiff(dir, hash, path);
      return withLatency(mockCommitDiff(dir, hash, path));
    },
    stashes(dir: string): Promise<GitStashEntry[]> {
      if (git) return git.stashes(dir);
      return withLatency(mockStashes(dir)).then((s) => s ?? []);
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
      return beat();
    },

    // ── Git Space mutations ──────────────────────────────────────────────────
    // Same rule as above: real git through the bridge, a latency beat and no
    // effect in the browser. Every one of these rejects with git's own message
    // when it fails — useGitSpace turns that into the masthead's error line.
    commit(dir: string, opts: GitCommitOptions): Promise<void> {
      return git ? git.commit(dir, opts) : beat();
    },
    fetch(dir: string, remote?: string): Promise<void> {
      return git ? git.fetch(dir, remote) : beat();
    },
    pull(dir: string, opts?: GitPullOptions): Promise<void> {
      return git ? git.pull(dir, opts) : beat();
    },
    push(dir: string, opts?: GitPushOptions): Promise<void> {
      return git ? git.push(dir, opts) : beat();
    },
    createBranch(
      dir: string,
      name: string,
      opts?: { from?: string; checkout?: boolean },
    ): Promise<void> {
      return git ? git.createBranch(dir, name, opts) : beat();
    },
    deleteBranch(
      dir: string,
      name: string,
      opts?: { force?: boolean; remote?: boolean },
    ): Promise<void> {
      return git ? git.deleteBranch(dir, name, opts) : beat();
    },
    renameBranch(dir: string, from: string, to: string): Promise<void> {
      return git ? git.renameBranch(dir, from, to) : beat();
    },
    mergeBranch(dir: string, name: string, opts?: { noFf?: boolean }): Promise<void> {
      return git ? git.mergeBranch(dir, name, opts) : beat();
    },
    continueOperation(dir: string): Promise<void> {
      return git ? git.continueOperation(dir) : beat();
    },
    abortOperation(dir: string): Promise<void> {
      return git ? git.abortOperation(dir) : beat();
    },
    stashPush(
      dir: string,
      opts?: { message?: string; includeUntracked?: boolean },
    ): Promise<void> {
      return git ? git.stashPush(dir, opts) : beat();
    },
    stashApply(dir: string, index: number, opts?: { pop?: boolean }): Promise<void> {
      return git ? git.stashApply(dir, index, opts) : beat();
    },
    stashDrop(dir: string, index: number): Promise<void> {
      return git ? git.stashDrop(dir, index) : beat();
    },

    // ── About section ───────────────────────────────────────────────────────
    // Same rule as the reads above: the bridge reads the real repo, browser
    // dev resolves against the demo world.
    readme(dir: string): Promise<GitReadme | null> {
      if (git) return git.readme(dir);
      return withLatency(mockReadme(dir));
    },
    identity(dir: string): Promise<GitIdentity> {
      if (git) return git.identity(dir);
      return withLatency(mockIdentity(dir)).then(
        (id) => id ?? { name: null, email: null },
      );
    },
    logo(dir: string): Promise<GitLogo | null> {
      if (git) return git.logo(dir);
      return withLatency(mockLogo(dir));
    },
    contributors(dir: string): Promise<GitContributors> {
      if (git) return git.contributors(dir);
      return withLatency(mockContributors(dir)).then(
        (c) => c ?? { source: "git", people: [], total: 0 },
      );
    },

    // ── GitHub, through the `gh` CLI ─────────────────────────────────────────
    // Browser dev answers with an installed, signed-in GitHub so the pull-request
    // section is demoable; its writes are no-ops.
    github: {
      status(): Promise<GitHubStatus> {
        if (git) return git.github.status();
        return withLatency(mockGhStatus()).then((s) => s ?? mockGhStatus());
      },
      repo(dir: string): Promise<GitHubRepoInfo | null> {
        if (git) return git.github.repo(dir);
        return withLatency(mockGhRepo(dir));
      },
      contributors(dir: string): Promise<GitContributors | null> {
        if (git) return git.github.contributors(dir);
        return withLatency(mockGhContributors(dir));
      },
      commitAuthors(dir: string): Promise<GitCommitAuthors | null> {
        if (git) return git.github.commitAuthors(dir);
        return withLatency(mockCommitAuthors());
      },
      me(): Promise<GitHubUser | null> {
        if (git) return git.github.me();
        return withLatency(mockGhMe());
      },
      prs(
        dir: string,
        opts?: { state?: "open" | "all"; limit?: number },
      ): Promise<GitHubPullRequest[]> {
        if (git) return git.github.prs(dir, opts);
        return withLatency(mockPrs(dir, opts?.state ?? "open")).then((p) => p ?? []);
      },
      prDetail(dir: string, number: number): Promise<GitHubPullRequestDetail | null> {
        if (git) return git.github.prDetail(dir, number);
        return withLatency(mockPrDetail(number));
      },
      prDiff(dir: string, number: number): Promise<GitFileDiff[]> {
        if (git) return git.github.prDiff(dir, number);
        return withLatency(mockPrDiff(number)).then((f) => f ?? []);
      },
      createPr(dir: string, opts: GitHubPrCreateOptions): Promise<GitHubPrCreateResult> {
        if (git) return git.github.createPr(dir, opts);
        // The dev world mints the next number so the composer's success line reads
        // like the real thing.
        const next = (mockPrs(dir, "all")[0]?.number ?? 0) + 1;
        return withLatency({
          number: next,
          url: `https://github.com/kone-dev/kone/pull/${next}`,
        }).then((r) => r!);
      },
      checkoutPr(dir: string, number: number): Promise<void> {
        return git ? git.github.checkoutPr(dir, number) : beat();
      },
      open(url: string): Promise<void> {
        if (git) return git.github.open(url);
        window.open(url, "_blank", "noopener");
        return Promise.resolve();
      },
    },
  };
}

/** A browser-dev mutation: no effect, but it takes a git-like moment so the
 *  caller's in-flight state gets at least one frame on screen. */
function beat(): Promise<void> {
  return withLatency(true).then(() => undefined);
}

// A short, slightly-staggered delay stands in for real git latency, so the dev
// build's processing→reveal beats (the picker, the detail view's loading state)
// are faithful and visible. A null result resolves immediately (nothing to show).
function withLatency<T>(value: T | null): Promise<T | null> {
  if (value === null) return Promise.resolve(null);
  const delay = 130 + Math.random() * 240;
  return new Promise((resolve) => setTimeout(() => resolve(value), delay));
}

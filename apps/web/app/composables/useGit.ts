import type { KoneGitApi } from "~/types/desktop";
import { desktopBridge, needsDesktop } from "~/utils/desktopBridge";

// Reads and writes git through the bridge. Git lives in the main process (it
// needs a real filesystem and the `git` binary), so with no bridge there is no
// repo to read: reads come back empty or null, plain writes resolve having done
// nothing (the renderer's optimistic update is the only effect), writes that
// promise a result reject with the reason, and `available` is false.
export function useGit() {
  const git = desktopBridge()?.git;
  return { available: Boolean(git), ...(git ?? NO_GIT) };
}

const none = (): Promise<null> => Promise.resolve(null);
const empty = (): Promise<never[]> => Promise.resolve([]);
const done = (): Promise<void> => Promise.resolve();
const refuse = (what: string) => (): Promise<never> => Promise.reject(new Error(needsDesktop(what)));

/** Git with no bridge behind it. */
const NO_GIT: KoneGitApi = {
  detect: none,
  status: none,
  diff: none,
  content: none,
  files: empty,
  branches: empty,
  log: empty,
  remotes: empty,
  repoState: none,
  commitDetail: none,
  commitDiff: none,
  stashes: empty,
  worktrees: empty,
  worktreePrune: empty,
  readme: none,
  logo: none,
  identity: () => Promise.resolve({ name: null, email: null }),
  contributors: () => Promise.resolve({ source: "git", people: [], total: 0 }),

  watchStatus: () => () => {},
  onActionProgress: () => () => {},
  onCloneProgress: () => () => {},

  stage: done,
  unstage: done,
  discard: done,
  checkout: done,
  commit: done,
  fetch: done,
  pull: done,
  push: done,
  createBranch: done,
  deleteBranch: done,
  renameBranch: done,
  mergeBranch: done,
  continueOperation: done,
  abortOperation: done,
  stashPush: done,
  stashApply: done,
  stashDrop: done,
  worktreeRemove: done,
  cancelClone: done,

  clone: refuse("Cloning"),
  create: refuse("Creating a project"),
  worktreeAdd: refuse("Worktrees"),
  generateCommitMessage: refuse("Generating a commit message"),
  runStackedAction: refuse("Committing"),

  github: {
    status: () => Promise.resolve({ installed: false, authenticated: false, user: null, message: null }),
    repo: none,
    contributors: none,
    commitAuthors: none,
    me: none,
    prs: empty,
    prDetail: none,
    prDiff: empty,
    createPr: refuse("Creating a pull request"),
    checkoutPr: done,
    open: (url) => {
      window.open(url, "_blank", "noopener");
      return Promise.resolve();
    },
  },
};

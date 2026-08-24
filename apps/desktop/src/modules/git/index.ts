// The git module's public surface. Git inspection + mutation lives in the main
// process (it needs a real filesystem + the `git` binary); this barrel is what
// the rest of the app (main.ts, the preload bridge types) reaches for. The
// concerns are split across sibling files — parsing/status, diff, history,
// watching, mutations, clone, create, and the IPC wiring — over a shared `core`
// (the git runner + path guards).

export * from "@kone/git-core/types.js";

export { detect, diffStatBetween, snapshotWorkingTree, status } from "@kone/git-core/status.js";
export { content, diff } from "./diff.js";
export { files } from "./files.js";
export { branches, commitDetail, commitDiff, log } from "./history.js";
export { watchStatus } from "./watch.js";
export {
  abortOperation,
  checkout,
  commit,
  continueOperation,
  createBranch,
  deleteBranch,
  discard,
  mergeBranch,
  renameBranch,
  stage,
  unstage,
} from "./mutations.js";
export { fetch, pull, push } from "./sync.js";
export { stashes, stashApply, stashDrop, stashPush } from "./stash.js";
export { remoteExists, remotes, repoState } from "./state.js";
export { contributors, identity, logo, readme } from "./about.js";
export * as github from "./github.js";
export { cancelAllClones, cancelClone, clone } from "@kone/git-core/clone.js";
export { createProject } from "./create.js";
export { generateCommitMessage } from "./textGen.js";
export { runStackedAction } from "./stacked.js";
export { registerGitIpc } from "./ipc.js";


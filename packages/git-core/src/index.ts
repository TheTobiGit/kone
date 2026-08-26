// The shared git/process foundation — the parts of the desktop's git and
// terminal modules the agent layer (and anything else environment-agnostic)
// needs: the git process runner + path guards, porcelain-v2 status parsing,
// conversation-scoped working-tree snapshots, progress-reporting clone, and
// full-system process-tree walks. Plain Node only — no electron, no DOM.
//
// The desktop keeps its user-facing git/terminal features in apps/desktop/src/
// modules, importing this package for the primitives they build on.

export * from "./types.js";
export * from "./core.js";
export { numstat, parseNumstat } from "./numstat.js";
export type { NumstatEntry } from "./numstat.js";
export {
  detect,
  diffStatBetween,
  snapshotWorkingTree,
  status,
} from "./status.js";
export {
  cancelAllClones,
  cancelClone,
  clone,
  configureCloneForTests,
  resetCloneForTests,
} from "./clone.js";
export {
  inspectSubprocessActivityAsync,
  killProcessTree,
} from "./processTree.js";
export {
  createCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
  dropCheckpoint,
} from "./checkpoint.js";

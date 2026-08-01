// The git module's public surface. Git inspection + mutation lives in the main
// process (it needs a real filesystem + the `git` binary); this barrel is what
// the rest of the app (main.ts, the preload bridge types) reaches for. The
// concerns are split across sibling files — parsing/status, diff, history,
// watching, mutations, clone, create, and the IPC wiring — over a shared `core`
// (the git runner + path guards).

export * from "./types.js";

export { detect, diffStatBetween, snapshotWorkingTree, status } from "./status.js";
export { content, diff } from "./diff.js";
export { files } from "./files.js";
export { branches, log } from "./history.js";
export { watchStatus } from "./watch.js";
export { discard, stage, unstage } from "./mutations.js";
export { cancelClone, clone } from "./clone.js";
export { createProject } from "./create.js";
export { registerGitIpc } from "./ipc.js";

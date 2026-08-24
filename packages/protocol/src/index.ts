// @kone/protocol — contracts shared between the desktop main process and the
// web renderer. Everything here must stay environment-agnostic (no electron,
// no DOM, no node builtins beyond standard globals) so both sides can import
// it directly.
export * from "./ipcError.js";
export * from "./planTasks.js";

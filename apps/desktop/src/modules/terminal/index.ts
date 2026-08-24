// The terminal module's public surface. The integrated terminal runs in the
// main process (node-pty PTY shells), bridged to the renderer through the
// terminal:* IPC in ipc.ts. This barrel is what main.ts and the preload bridge
// types reach for.

export * from "./types.js";
export { getTerminalManager, TerminalManager } from "./TerminalManager.js";
export { registerTerminalIpc, shutdownTerminals } from "./ipc.js";

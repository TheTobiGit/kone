// The agent module's public surface. The multi-provider agent layer runs in the
// main process (it spawns and streams from the user's own agent CLIs — Codex
// first), bridged to the renderer through the agent:* IPC in ipc.ts. This barrel
// is what main.ts and the preload bridge types reach for.
//
// See docs/agentic-providers-plan.md for the architecture and the "bring your own
// subscription" stance (detect an installed, logged-in CLI and drive it — never
// store provider credentials).

export * from "./types.js";
export { AgentService } from "./AgentService.js";
export { registerAgentIpc, getAgentService, shutdownAgents } from "./ipc.js";

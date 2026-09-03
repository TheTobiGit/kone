// The agent core's public surface. The multi-provider agent layer runs in the
// main process (it spawns and streams from the user's own agent CLIs — Codex
// first); this barrel is what consumers reach for. The renderer-facing IPC
// bridge (registerAgentIpc/getAgentService/shutdownAgents) stays in
// apps/desktop (src/agent/agent-ipc.ts) because it is the one Electron-coupled
// module — everything here is plain Node.
//
// See docs/archive/agentic-providers-plan.md for the architecture and the "bring your own
// subscription" stance (detect an installed, logged-in CLI and drive it — never
// store provider credentials).

export * from "./types.js";
export { AgentService } from "./AgentService.js";
export type { ProviderSurfaceSnapshot } from "./providerCache.js";
export * from "./compaction/index.js";
export * from "./commandSafety.js";
export * from "./conversationDAG.js";
export * from "./inventory/index.js";
export { GLOBAL_ASSISTANT_PROJECT_PATH } from "./conversationStoreTypes.js";
export {
  assistantWorkingDir,
  isAssistantProjectPath,
  workingDirFor,
} from "./assistantWorkspace.js";

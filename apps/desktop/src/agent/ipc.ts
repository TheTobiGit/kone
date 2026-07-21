import { ipcMain, type WebContents } from "electron";

import { AgentService } from "./AgentService.js";
import type {
  ApprovalDecision,
  ProviderKind,
  SendTurnInput,
  SessionStartInput,
} from "./types.js";

// IPC wiring for the agent layer — the direct analogue of git/ipc.ts. Request/
// ack calls are `ipcMain.handle` (agent:*); the one runtime event stream is
// pushed on the "agent:event" side channel to every live renderer, exactly like
// git's "git:status-changed". Each renderer forwards it into its own store.

let service: AgentService | null = null;

/** The single AgentService instance (lazily created). */
export function getAgentService(): AgentService {
  if (!service) service = new AgentService();
  return service;
}

// Renderers currently subscribed to the event stream. We hold WebContents and
// drop them on destroy so a closed window leaks no forwarding.
const subscribers = new Set<WebContents>();

/** Register the agent:* IPC handlers. Call once, before creating the window. */
export function registerAgentIpc(): void {
  const svc = getAgentService();

  // Fan the merged event stream out to every subscribed renderer.
  svc.onEvent((event) => {
    for (const wc of subscribers) {
      if (!wc.isDestroyed()) wc.send("agent:event", event);
    }
  });

  // Discovery + models (read-only probes of the user's installed CLIs).
  ipcMain.handle("agent:discover", () => svc.discover());
  ipcMain.handle("agent:models", (_event, provider: ProviderKind) =>
    svc.listModels(provider),
  );

  // Subscribe/unsubscribe the calling renderer to the event stream.
  ipcMain.handle("agent:subscribe", (event) => {
    const wc = event.sender;
    if (subscribers.has(wc)) return;
    subscribers.add(wc);
    wc.once("destroyed", () => subscribers.delete(wc));
  });
  ipcMain.handle("agent:unsubscribe", (event) => {
    subscribers.delete(event.sender);
  });

  // Session lifecycle (request/ack — results flow through agent:event).
  ipcMain.handle("agent:start-session", (_event, input: SessionStartInput) =>
    svc.startSession(input),
  );
  ipcMain.handle("agent:send-turn", (_event, input: SendTurnInput) => svc.sendTurn(input));
  ipcMain.handle("agent:interrupt", (_event, threadId: string) =>
    svc.interruptTurn(threadId),
  );
  ipcMain.handle("agent:stop-session", (_event, threadId: string) =>
    svc.stopSession(threadId),
  );
  ipcMain.handle(
    "agent:respond",
    (_event, threadId: string, requestId: string, decision: ApprovalDecision) =>
      svc.respondToRequest(threadId, requestId, decision),
  );
  ipcMain.handle("agent:list-sessions", () => svc.listSessions());
}

/** Stop every agent subprocess. Call from app quit so nothing is orphaned. */
export async function shutdownAgents(): Promise<void> {
  if (service) await service.stopAll();
}

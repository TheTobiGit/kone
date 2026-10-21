import { ipcMain } from "electron";

import type { AgentService } from "@kone/agent-core/AgentService.js";
import { resolveProviderSignInCommand } from "@kone/agent-core/providerSignIn.js";
import { ProviderKindSchema } from "@kone/agent-core/types.js";
import type { ProviderKind, ProviderStatus } from "@kone/agent-core/types.js";
import type { ProviderSignInCommand, ProviderSignInStartInput } from "@kone/agent-core/providerSignIn.js";
import { getTerminalManager } from "../modules/terminal/index.js";
import {
  createProviderSignInController,
  type ProviderSignInStart,
} from "./providerSignInController.js";

// Electron glue for provider sign-in. The lifecycle, the terminal ownership
// claim and the per-provider queue live in providerSignInController.ts, which
// imports no Electron and is covered by tests with fake senders.

export type { ProviderSignInStart } from "./providerSignInController.js";

/** The preload bridge for in-app provider sign-in. Mirrors the renderer
 *  contract in apps/web/app/types/desktop.d.ts. */
export type KoneProviderSignInApi = {
  command: (provider: ProviderKind) => Promise<ProviderSignInCommand | null>;
  start: (input: ProviderSignInStartInput) => Promise<ProviderSignInStart>;
  check: (provider: ProviderKind) => Promise<ProviderStatus>;
};

/** Register the provider-signin:* IPC handlers. Call once, with the live
 *  AgentService, from registerAgentIpc. */
export function registerProviderSignInIpc(svc: AgentService): void {
  const controller = createProviderSignInController({
    manager: getTerminalManager(),
    svc,
  });

  ipcMain.handle("provider-signin:command", (_event, provider: ProviderKind) => {
    const parsed = ProviderKindSchema.parse(provider);
    return resolveProviderSignInCommand(parsed, svc.getProviderSettings());
  });

  ipcMain.handle("provider-signin:start", (event, raw: ProviderSignInStartInput) =>
    controller.start(raw, event.sender),
  );

  ipcMain.handle("provider-signin:check", (_event, provider: ProviderKind) => {
    const parsed = ProviderKindSchema.parse(provider);
    return svc.checkProvider(parsed);
  });
}

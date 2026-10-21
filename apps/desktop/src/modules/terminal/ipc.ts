import { ipcMain } from "electron";

import { getTerminalManager } from "./TerminalManager.js";
import { createTerminalIpc } from "./ipcHandlers.js";

// IPC wiring for the terminal layer — the direct analogue of agent/ipc.ts.
// Request/ack calls are `ipcMain.handle` (terminal:*); the one runtime event
// stream is pushed on the "terminal:event" side channel to every subscribed
// renderer, except for a sign-in terminal, whose events go only to the window
// that claimed it (see ipcHandlers.ts / ownership.ts).

let registered = false;

/** Register the terminal:* IPC handlers. Call once, before creating the window. */
export function registerTerminalIpc(): void {
  if (registered) return;
  registered = true;

  const { handlers } = createTerminalIpc(getTerminalManager());

  // The renderer names a shell only. Rebuild the input field by field so a
  // stray `command`/`banner` smuggled over IPC is dropped — spawning an
  // arbitrary program is main-process-only (provider sign-in, openCommand).
  ipcMain.handle("terminal:open", (event, input) => handlers.open(event.sender, input));
  ipcMain.handle("terminal:write", (event, input) => handlers.write(event.sender, input));
  ipcMain.handle("terminal:resize", (event, input) => handlers.resize(event.sender, input));
  ipcMain.handle("terminal:close", (event, input) => handlers.close(event.sender, input));
  ipcMain.handle("terminal:restart", (event, input) => handlers.restart(event.sender, input));
  // Renderer flow-control: acked output bytes let the manager pause/resume the
  // PTY when the renderer falls behind (see ACK watermarks in the manager).
  ipcMain.handle("terminal:ack", (event, input) => handlers.ack(event.sender, input));

  // Subscribe/unsubscribe the calling renderer to the event stream.
  ipcMain.handle("terminal:subscribe", (event) => handlers.subscribe(event.sender));
  ipcMain.handle("terminal:unsubscribe", (event) => handlers.unsubscribe(event.sender));
}

/** Stop every terminal PTY. Call from app quit so nothing is orphaned. */
export async function shutdownTerminals(): Promise<void> {
  await getTerminalManager().disposeAll();
}

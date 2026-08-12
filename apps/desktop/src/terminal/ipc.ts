import { ipcMain, type WebContents } from "electron";

import { getTerminalManager } from "./TerminalManager.js";
import type {
  TerminalAckInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "./types.js";

// IPC wiring for the terminal layer — the direct analogue of agent/ipc.ts.
// Request/ack calls are `ipcMain.handle` (terminal:*); the one runtime event
// stream is pushed on the "terminal:event" side channel to every live
// renderer, exactly like "agent:event".

let registered = false;

// Renderers currently subscribed to the terminal event stream.
const subscribers = new Set<WebContents>();

/** Register the terminal:* IPC handlers. Call once, before creating the window. */
export function registerTerminalIpc(): void {
  if (registered) return;
  registered = true;

  const mgr = getTerminalManager();

  // Fan the terminal event stream out to every subscribed renderer.
  mgr.onEvent((event: TerminalEvent) => {
    for (const wc of subscribers) {
      if (!wc.isDestroyed()) wc.send("terminal:event", event);
    }
  });

  ipcMain.handle("terminal:open", (_event, input: TerminalOpenInput) =>
    mgr.open(input),
  );
  ipcMain.handle("terminal:write", (_event, input: TerminalWriteInput) =>
    mgr.write(input),
  );
  ipcMain.handle("terminal:resize", (_event, input: TerminalResizeInput) =>
    mgr.resize(input),
  );
  ipcMain.handle("terminal:clear", (_event, terminalId: string) =>
    mgr.clear(terminalId),
  );
  ipcMain.handle("terminal:close", (_event, input: TerminalCloseInput) =>
    mgr.close(input),
  );
  ipcMain.handle("terminal:restart", (_event, input: TerminalRestartInput) =>
    mgr.restart(input),
  );
  // Renderer flow-control: acked output bytes let the manager pause/resume the
  // PTY when the renderer falls behind (see ACK watermarks in the manager).
  ipcMain.handle("terminal:ack", (_event, input: TerminalAckInput) =>
    mgr.ack(input),
  );

  // Subscribe/unsubscribe the calling renderer to the event stream.
  ipcMain.handle("terminal:subscribe", (event) => {
    const wc = event.sender;
    if (subscribers.has(wc)) return;
    subscribers.add(wc);
    wc.once("destroyed", () => subscribers.delete(wc));
  });
  ipcMain.handle("terminal:unsubscribe", (event) => {
    subscribers.delete(event.sender);
  });
}

/** Stop every terminal PTY. Call from app quit so nothing is orphaned. */
export async function shutdownTerminals(): Promise<void> {
  await getTerminalManager().disposeAll();
}

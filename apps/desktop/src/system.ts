import os from "node:os";

import { ipcMain } from "electron";

// Small host-machine facts the renderer wants but can't read itself (no Node in
// the sandboxed renderer). Kept flat + serializable — everything crosses IPC.
// Mirror any change in apps/web/app/types/desktop.d.ts.

/** The current OS account's short username, or null if it can't be read. */
export function username(): string | null {
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
}

/** Register the system:* IPC handlers. Call once, before creating the window. */
export function registerSystemIpc(): void {
  ipcMain.handle("system:username", () => username());
}

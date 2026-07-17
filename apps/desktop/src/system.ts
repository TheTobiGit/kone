import os from "node:os";

import { ipcMain, shell } from "electron";

// Host facts for the sandboxed renderer. Mirror changes in apps/web/app/types/desktop.d.ts.

export function username(): string | null {
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
}

export function reveal(target: string): void {
  if (target) void shell.openPath(target);
}

export function registerSystemIpc(): void {
  ipcMain.handle("system:username", () => username());
  ipcMain.handle("system:reveal", (_event, target: string) => reveal(target));
}

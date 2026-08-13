import os from "node:os";

import { ipcMain, nativeTheme, shell } from "electron";

// Host facts for the sandboxed renderer. Mirror changes in apps/web/app/types/desktop.d.ts.

export type ThemeMode = "light" | "dark" | "system";

const THEME_MODES = new Set<ThemeMode>(["light", "dark", "system"]);

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && THEME_MODES.has(value as ThemeMode);
}

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

// Apply the renderer's appearance choice. "system" defers to the OS. Values
// outside the known modes are ignored so a stale renderer can't wedge the
// theme into an unknown state.
export function setTheme(mode: unknown): void {
  if (!isThemeMode(mode)) return;
  nativeTheme.themeSource = mode;
}

export function registerSystemIpc(): void {
  ipcMain.handle("system:username", () => username());
  ipcMain.handle("system:reveal", (_event, target: string) => reveal(target));
  ipcMain.handle("theme:set", (_event, mode: unknown) => setTheme(mode));
}

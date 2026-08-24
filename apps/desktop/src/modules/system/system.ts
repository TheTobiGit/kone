import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ipcMain, nativeTheme, shell } from "electron";

// Host facts for the sandboxed renderer. Mirror changes in apps/web/app/types/desktop.d.ts.

export type ThemeMode = "light" | "dark" | "system";

const THEME_MODES = new Set<ThemeMode>(["light", "dark", "system"]);

function isThemeMode(value: string | null | undefined): value is ThemeMode {
  // SAFETY: value is a string here; THEME_MODES membership is itself the runtime check.
  return Boolean(value && THEME_MODES.has(value as ThemeMode));
}

export function username(): string | null {
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
}

/** Reveal `target` in the file manager. Directories are opened as a folder;
 *  files are selected in their parent folder rather than launched with the
 *  default app. A missing path or a non-string IPC payload is a hard error
 *  so the renderer can fall through to its own fallback instead of
 *  swallowing a no-op. */
export async function reveal(target: string): Promise<void> {
  if (!target || !target.trim()) {
    throw new Error("Missing path.");
  }
  const resolved = path.resolve(target);
  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new Error(`Path not found: ${resolved}`);
  }
  if (stats.isDirectory()) {
    const errorMessage = await shell.openPath(resolved);
    if (errorMessage && errorMessage.trim().length > 0) {
      throw new Error(errorMessage);
    }
    return;
  }
  shell.showItemInFolder(resolved);
}

// Apply the renderer's appearance choice. "system" defers to the OS. Values
// outside the known modes are ignored so a stale renderer can't wedge the
// theme into an unknown state.
export function setTheme(mode: ThemeMode | string): void {
  if (!isThemeMode(mode)) return;
  nativeTheme.themeSource = mode;
}

export function registerSystemIpc(): void {
  ipcMain.handle("system:username", () => username());
  ipcMain.handle("system:reveal", (_event, target: string) => reveal(target));
  ipcMain.handle("theme:set", (_event, mode: ThemeMode) => setTheme(mode));
}

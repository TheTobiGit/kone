import { ipcMain } from "electron";

import { jevStatus, route } from "./route.js";
import type { JevRouteInput, JevRouteResult, JevStatus } from "./types.js";

let registered = false;

/**
 * Register the jev:* IPC handlers. Call once, before creating the window.
 *
 * Routing runs here rather than in the renderer for one reason: the API key.
 * It stays in the main process's environment and never crosses the bridge, so
 * a renderer that is one `fetch` away from the open internet never holds it.
 */
export function registerJevIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle("jev:status", (): JevStatus => jevStatus());
  ipcMain.handle("jev:route", (_event, input: JevRouteInput): Promise<JevRouteResult> =>
    route(input),
  );
}

import { BrowserWindow, ipcMain } from "electron";

import { windowChromeState } from "./chrome.js";

const DEFAULT_CHROME_STATE = { isMaximized: false, isFullscreen: false } as const;

function resolveWindow(
  getMainWindow: () => BrowserWindow | null,
  sender: Electron.WebContents,
): BrowserWindow | null {
  const window = BrowserWindow.fromWebContents(sender) ?? getMainWindow();
  if (!window || window.isDestroyed()) return null;
  return window;
}

export function registerWindowControlsIpc(
  getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("window:minimize", (event) => {
    const window = resolveWindow(getMainWindow, event.sender);
    window?.minimize();
  });

  ipcMain.handle("window:close", (event) => {
    const window = resolveWindow(getMainWindow, event.sender);
    window?.close();
  });

  ipcMain.handle("window:get-state", (event) => {
    const window = resolveWindow(getMainWindow, event.sender);
    if (!window) return DEFAULT_CHROME_STATE;
    return windowChromeState(window);
  });

  ipcMain.handle("window:toggle-maximize", (event) => {
    const window = resolveWindow(getMainWindow, event.sender);
    if (!window) return DEFAULT_CHROME_STATE;
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    // The maximize/unmaximize listeners also push, but the state can change
    // between the call and the event; re-report the settled value so a renderer
    // that issued the toggle never waits on a stale snapshot.
    window.webContents.send("window:state", windowChromeState(window));
    return windowChromeState(window);
  });
}

export function bindWindowChromeEvents(win: BrowserWindow): void {
  const sendState = () => {
    if (win.isDestroyed()) return;
    win.webContents.send("window:state", windowChromeState(win));
  };
  win.on("maximize", sendState);
  win.on("unmaximize", sendState);
  win.on("enter-full-screen", sendState);
  win.on("leave-full-screen", sendState);
}

import { ipcMain } from "electron";

import { getConversationStore } from "@kone/agent-core/ConversationStore.js";
import type { StudioSaveInput } from "./types.js";

let registered = false;

/** Register the studio:* IPC handlers. Call once, before creating the window. */
export function registerStudioIpc(): void {
  if (registered) return;
  registered = true;

  const store = getConversationStore();

  ipcMain.handle("studio:load", () => store.loadStudio());
  ipcMain.handle("studio:save", (_event, input: StudioSaveInput) =>
    store.saveStudio(input.layout),
  );
}

import { ipcMain } from "electron";

import { getConversationStore } from "../agent/ConversationStore.js";
import type { BoardLoadInput, BoardSaveInput } from "./types.js";

let registered = false;

/** Register the board:* IPC handlers. Call once, before creating the window. */
export function registerBoardIpc(): void {
  if (registered) return;
  registered = true;

  const store = getConversationStore();

  ipcMain.handle("board:load", (_event, input: BoardLoadInput) =>
    store.loadBoard(input.projectPath),
  );
  ipcMain.handle("board:save", (_event, input: BoardSaveInput) =>
    store.saveBoard(input.projectPath, input.layout),
  );
}

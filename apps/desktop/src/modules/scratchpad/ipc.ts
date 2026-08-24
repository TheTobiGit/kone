import { ipcMain } from "electron";

import { getConversationStore } from "../../agent/ConversationStore.js";
import type {
  ScratchpadDeleteInput,
  ScratchpadListInput,
  ScratchpadSaveInput,
} from "./types.js";

let registered = false;

/** Register the scratchpad:* IPC handlers. Call once, before creating the window. */
export function registerScratchpadIpc(): void {
  if (registered) return;
  registered = true;

  const store = getConversationStore();

  ipcMain.handle("scratchpad:list", (_event, input: ScratchpadListInput) =>
    store.listScratchpads(input.projectPath),
  );
  ipcMain.handle("scratchpad:save", (_event, input: ScratchpadSaveInput) =>
    store.saveScratchpad({
      padId: input.scratchpadId,
      projectPath: input.projectPath,
      title: input.title,
      body: input.body,
      expectedRevision: input.expectedRevision,
    }),
  );
  ipcMain.handle("scratchpad:delete", (_event, input: ScratchpadDeleteInput) => {
    store.deleteScratchpad(input.scratchpadId);
  });
}

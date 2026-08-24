import { ipcMain } from "electron";

import { getConversationStore } from "@kone/agent-core/ConversationStore.js";
import type { PresetCreateInput, PresetDeleteInput, PresetUpdateInput } from "./types.js";

let registered = false;

/** Register the presets:* IPC handlers. Call once, before creating the window. */
export function registerPresetsIpc(): void {
  if (registered) return;
  registered = true;

  const store = getConversationStore();

  ipcMain.handle("presets:list", () => store.listSubagentPresets());
  ipcMain.handle("presets:create", (_event, input: PresetCreateInput) =>
    store.createSubagentPreset(input),
  );
  ipcMain.handle("presets:update", (_event, input: PresetUpdateInput) =>
    store.updateSubagentPreset(input.presetId, input.patch),
  );
  ipcMain.handle("presets:delete", (_event, input: PresetDeleteInput) =>
    store.deleteSubagentPreset(input.presetId),
  );
}

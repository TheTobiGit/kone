import { ipcMain } from "electron";

import { getConversationStore } from "../agent/ConversationStore.js";
import type {
  RosterBindInput,
  RosterCarryInput,
  RosterCreateInput,
  RosterDeleteInput,
  RosterDuplicateInput,
  RosterHydrateInput,
  RosterSelectInput,
  RosterSnapshot,
  RosterTeamInput,
  RosterTeamMemberInput,
  RosterUpdateInput,
} from "./types.js";

let registered = false;

/** Register the roster:* IPC handlers. Call once, before creating the window. */
export function registerRosterIpc(): void {
  if (registered) return;
  registered = true;

  const store = getConversationStore();

  ipcMain.handle("roster:hydrate", (_event, input: RosterHydrateInput): RosterSnapshot => {
    store.ensurePresetAgents(input.presetIds);
    return {
      agents: store.listAgents({ includeDeleted: true }),
      bindings: store.listThreadAgents(),
      selectedAgentId: store.readSelectedAgent(),
    };
  });
  ipcMain.handle("roster:create", (_event, input: RosterCreateInput) => store.createAgent(input));
  ipcMain.handle("roster:update", (_event, input: RosterUpdateInput) =>
    store.updateAgent(input.agentId, input.patch),
  );
  ipcMain.handle("roster:delete", (_event, input: RosterDeleteInput) =>
    store.deleteAgent(input.agentId),
  );
  ipcMain.handle("roster:duplicate", (_event, input: RosterDuplicateInput) =>
    store.duplicateAgent(input),
  );
  ipcMain.handle("roster:team", (_event, input: RosterTeamInput) =>
    store.listProjectAgents(input.projectPath),
  );
  ipcMain.handle("roster:team-add", (_event, input: RosterTeamMemberInput) =>
    store.addAgentToProject(input.projectPath, input.agentId),
  );
  ipcMain.handle("roster:team-remove", (_event, input: RosterTeamMemberInput) => {
    store.removeAgentFromProject(input.projectPath, input.agentId);
  });

  ipcMain.handle("roster:bind", (_event, input: RosterBindInput) =>
    store.bindThreadAgent(input.threadId, input.agentId),
  );
  ipcMain.handle("roster:carry", (_event, input: RosterCarryInput) =>
    store.carryThreadAgent(input.fromThreadId, input.toThreadId),
  );
  ipcMain.handle("roster:select", (_event, input: RosterSelectInput) => {
    store.writeSelectedAgent(input.agentId);
  });
}

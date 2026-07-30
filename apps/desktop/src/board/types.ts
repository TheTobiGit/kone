import type { StoredBoardLayout } from "../agent/ConversationStore.js";

export type BoardLoadInput = {
  projectPath: string;
};

export type BoardSaveInput = {
  projectPath: string;
  layout: StoredBoardLayout;
};

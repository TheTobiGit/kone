import type { StoredStudioLayout } from "@kone/agent-core/ConversationStore.js";

/** The studio is one plane spanning every project, so a load has nothing to
 *  address — the whole document comes back or nothing does. */
export type StudioSaveInput = {
  layout: StoredStudioLayout;
};

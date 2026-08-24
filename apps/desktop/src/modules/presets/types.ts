/**
 * The preset sub-agents' IPC shapes — the reusable, globally-available
 * sub-agent definitions an agent cuts a spawn from (§3.4).
 *
 * Its own module for the same reason `roster/` is: a preset is neither a
 * provider session (`agent:*`) nor a person you hand a thread to (`roster:*`).
 * It is a lightweight, standing definition — name, instructions, an ordered
 * model preference — that any agent can invoke, so it earns its own `presets:*`
 * channel family rather than crowding either of those.
 */
import type {
  SubagentPresetCreateInput,
  SubagentPresetPatch,
} from "../../agent/ConversationStore.js";

export type PresetCreateInput = SubagentPresetCreateInput;

export type PresetUpdateInput = {
  presetId: string;
  patch: SubagentPresetPatch;
};

export type PresetDeleteInput = {
  presetId: string;
};

/**
 * The roster's IPC shapes — the agents you can hand work to, and each project's
 * team.
 *
 * Deliberately its own module rather than another corner of `agent/`: the
 * `agent:*` surface drives provider sessions, and an agent in this sense is a
 * person you work with, not a process. Two channel families one word apart that
 * mean different things is a trap, so these are `roster:*`.
 */
import type {
  AgentCreateInput,
  AgentDuplicateInput,
  AgentPatch,
  AgentRecord,
  ThreadAgentBinding,
} from "../agent/ConversationStore.js";

/**
 * Ensure-and-list, in one round trip.
 *
 * `presetIds` is the built-ins the renderer ships, in the order it wants them:
 * the store gives each one an overlay row if it doesn't have one yet, and never
 * resurrects one the user deleted. Only the renderer knows which presets exist,
 * so hydrating is the moment it says so.
 */
export type RosterHydrateInput = {
  presetIds: string[];
};

/**
 * The whole roster layer in one reply: who exists, who worked what, and who is
 * up next.
 *
 * One round trip rather than three because they are read together, at the one
 * moment a window opens, and a renderer holding two thirds of this is a
 * renderer that draws the wrong name.
 *
 * `agents` includes deleted ones — their names caption threads they worked
 * before they left the roster, and the renderer drops them from anything you can
 * pick from.
 */
export type RosterSnapshot = {
  agents: AgentRecord[];
  bindings: ThreadAgentBinding[];
  /** Who the next turn goes to, or null for a guest. */
  selectedAgentId: string | null;
};

/** Settle who works a thread. Write-once: an already-settled thread keeps what
 *  it settled on, and the reply says what that is. `agentId` null is a guest. */
export type RosterBindInput = {
  threadId: string;
  agentId: string | null;
};

/** Carry a binding onto a thread reborn under a new id. */
export type RosterCarryInput = {
  fromThreadId: string;
  toThreadId: string;
};

/** Point the next turn at an agent, or at a guest with null. */
export type RosterSelectInput = {
  agentId: string | null;
};

export type RosterCreateInput = AgentCreateInput;

export type RosterUpdateInput = {
  agentId: string;
  patch: AgentPatch;
};

export type RosterDeleteInput = {
  agentId: string;
};

export type RosterDuplicateInput = AgentDuplicateInput;

export type RosterTeamInput = {
  projectPath: string;
};

export type RosterTeamMemberInput = {
  projectPath: string;
  agentId: string;
};

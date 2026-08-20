import { computed } from "vue";
import {
  agentById,
  agentRoster,
  renameAgent,
  selectAgent,
  selectedAgent,
  settleThreadAgent,
  type Agent,
} from "~/utils/agents";

// Named for the roster rather than for the agent, and deliberately not
// `useAgents`: `useAgent` next to it is the live provider session, and two
// composables one letter apart that mean different things is a trap.
//
// `Agent` is deliberately NOT re-exported here: the util is auto-imported too,
// so a second path to the same name makes it ambiguous which one a component
// got.

export function useAgentRoster() {
  // Called inside the computed, not hoisted: the read is what subscribes to the
  // stored names and selection, so evaluating it early would freeze both.
  const roster = computed<Agent[]>(() => agentRoster());
  /** Who the next turn goes to, or undefined for a guest. */
  const selected = computed<Agent | undefined>(() => selectedAgent());

  return { roster, selected, agentById, selectAgent, settleThreadAgent, renameAgent };
}

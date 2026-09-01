import { watch } from "vue";
import { agentRoster, agentTeamPaths, isShippedAgent, type Agent } from "~/utils/agents";
import { agentRows, projectTeams, selectedAgentId } from "~/utils/agentStore";
import { CENTER_MODES, LADDER_PX } from "~/utils/stripScroll";
import { useStripPrefs } from "~/composables/useStripPrefs";
import { usePaneWidthPrefs } from "~/composables/usePaneWidthPrefs";
import type { KoneAgentRosterEntry, KoneStripSettings } from "~/types/desktop";

// The other half of the theme plugin's mirror. Two surfaces an agent can now
// steer live entirely on this side — the agent roster and the thread strip's
// settings — and the main process, where the agent gateway runs, has no way to
// read either. The roster's shipped agents are prose in this bundle and a stored
// row is a delta against one, so only here is the *resolved* roster knowable;
// the strip's settings are per-install browser storage. So both are pushed, and
// the gateway reads them back to describe and change what is actually on screen.
//
// Writes come the other way as runtime events, applied by `useAppSteering` —
// which the theme plugin starts, so nothing here subscribes a second time.

/** One agent, flattened for the shell: who they are and what they run on. The
 *  drawn SVG and the roster order stop here — a model has no use for either. */
function rosterEntry(agent: Agent, activeId: string | null): KoneAgentRosterEntry {
  const model = agent.capabilities.model;
  const entry: KoneAgentRosterEntry = {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions ?? "",
    face: { body: agent.hue, ink: agent.ink },
    model: model
      ? model.label !== undefined
        ? { provider: model.provider, model: model.model, label: model.label }
        : { provider: model.provider, model: model.model }
      : null,
    skills: agent.capabilities.skills.map((skill) => skill.name),
    builtIn: isShippedAgent(agent.id),
    active: agent.id === activeId,
    teams: agentTeamPaths(agent.id),
  };
  return entry;
}

export default defineNuxtPlugin(() => {
  const bridge = window.koneDesktop;
  if (!bridge?.setAppState) return;

  const { centerMode } = useStripPrefs();
  const { paneWidths, defaultWidth } = usePaneWidthPrefs();

  const strip = (): KoneStripSettings => ({
    // The stored value is whatever an older build or a hand-edited storage key
    // left behind, so it is checked against the modes that exist rather than
    // trusted — a mode the board doesn't have would have the agent report a
    // scroll rule nothing implements.
    centering:
      CENTER_MODES.find((mode) => mode.value === centerMode.value)?.value ?? "on-overflow",
    defaultWidths: {
      thread: defaultWidth("thread"),
      terminal: defaultWidth("terminal"),
      scratchpad: defaultWidth("scratchpad"),
    },
    ladder: [...LADDER_PX],
  });

  const push = () => {
    const activeId = selectedAgentId.value;
    void bridge.setAppState({
      agents: agentRoster().map((agent) => rosterEntry(agent, activeId)),
      strip: strip(),
    });
  };

  push();
  // Watched at the source rather than through `agentRoster()`: a resolved agent
  // is derived from the stored rows, the selection and the project teams, and
  // watching the derivation would miss a rename — the roster's shape doesn't
  // change, only a field inside it. Deep, because every one of these is a
  // collection edited in place.
  watch([agentRows, selectedAgentId, projectTeams, centerMode, paneWidths], push, {
    deep: true,
  });
});

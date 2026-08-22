import { computed, onMounted, watch } from "vue";
import {
  addAgentToProject,
  agentById,
  agentTeamPaths,
  agentRoster,
  createAgent,
  deleteAgent,
  duplicateAgent,
  hydrateRoster,
  isOnProjectTeam,
  loadProjectTeam,
  projectTeam,
  projectTeamsList,
  removeAgentFromProject,
  renameAgent,
  selectAgent,
  selectedAgent,
  settleThreadAgent,
  updateAgent,
  type Agent,
} from "~/utils/agents";
import { useProject } from "~/composables/useProject";

// Named for the roster rather than for the agent, and deliberately not
// `useAgents`: `useAgent` next to it is the live provider session, and two
// composables one letter apart that mean different things is a trap.
//
// `Agent` is deliberately NOT re-exported here: the util is auto-imported too,
// so a second path to the same name makes it ambiguous which one a component
// got.

export function useAgentRoster() {
  const project = useProject();

  // The roster lives in the store now, so reading it means asking for it. On
  // mount, not at call time: this runs during setup on the server too, where
  // there is no bridge and nothing to read. The first paint shows the warm
  // cache — or the shipped presets on a fresh install — and swaps to the stored
  // rows when they land, which is the same agents either way for anyone who
  // hasn't edited one.
  onMounted(() => {
    void hydrateRoster();
  });

  // Called inside the computed, not hoisted: the read is what subscribes to the
  // stored rows and selection, so evaluating it early would freeze both.
  const roster = computed<Agent[]>(() => agentRoster());
  /** Who the next turn goes to, or undefined for a guest. */
  const selected = computed<Agent | undefined>(() => selectedAgent());

  /** The active project's path, or null on the App Home. */
  const projectPath = computed<string | null>(() => project.value?.path ?? null);
  /** The active project's team — who can work within it. Empty off a project. */
  const team = computed<Agent[]>(() => projectTeam(projectPath.value));
  /** Every project team known to this machine — each a path with its members.
   *  The overview reads from this, not from the active project. */
  const teams = computed(() => projectTeamsList());

  // Read the team back from the store whenever the active project changes. The
  // dev fallback is its own store, so this only does anything with a bridge.
  watch(
    projectPath,
    (path) => {
      if (path) void loadProjectTeam(path);
    },
    { immediate: true },
  );

  /** Whether an agent is on the active project's team. */
  function isOnTeam(id: string): boolean {
    return isOnProjectTeam(projectPath.value, id);
  }
  /** Put an agent on the active project's team; false off a project. */
  function addToTeam(id: string): Promise<boolean> {
    const path = projectPath.value;
    return path ? addAgentToProject(path, id) : Promise.resolve(false);
  }
  /** Take an agent off the active project's team. */
  function removeFromTeam(id: string): Promise<void> {
    const path = projectPath.value;
    return path ? removeAgentFromProject(path, id) : Promise.resolve();
  }

  return {
    roster,
    selected,
    team,
    teams,
    projectPath,
    isOnTeam,
    addToTeam,
    removeFromTeam,
    loadProjectTeam,
    agentTeamPaths,
    agentById,
    selectAgent,
    settleThreadAgent,
    renameAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    duplicateAgent,
  };
}

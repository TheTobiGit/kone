import { computed, onMounted, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
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
  routerSelected,
  selectAgent,
  selectedAgent,
  settleThreadAgent,
  threadSettled,
  updateAgent,
  type Agent,
} from "~/utils/agents";
import { routeRequest } from "~/utils/agentRouting";
import type { JevRouteResult } from "~/types/desktop";
import { useProject } from "~/composables/useProject";

// Named for the roster rather than for the agent, and deliberately not
// `useAgents`: `useAgent` next to it is the live provider session, and two
// composables one letter apart that mean different things is a trap.
//
// `Agent` is deliberately NOT re-exported here: the util is auto-imported too,
// so a second path to the same name makes it ambiguous which one a component
// got.

/** Signals the active board to open/focus a blank thread with this agent. */
export interface PendingThreadAgentRequest {
  id: string;
  projectPath?: string | null;
}
export type PendingThreadAgent = PendingThreadAgentRequest;
const pendingThreadAgent = ref<PendingThreadAgent | null>(null);

export function useAgentRoster(customProjectPath?: MaybeRefOrGetter<string | null | undefined>) {
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
  /** Who the next turn goes to, or undefined for a guest. Also undefined when
   *  the router is selected: nobody is working the turn until it has been read,
   *  and answering with an agent before then would pin a model and gate a team
   *  on a choice that hasn't been made. */
  const selected = computed<Agent | undefined>(() => selectedAgent());

  /** Whether the next turn is Jev's to route. Kept beside `selected` rather
   *  than folded into it, because these are answers to different questions and
   *  a caller that wants one almost never wants the other. */
  const routing = computed<boolean>(() => routerSelected());

  /** The target project's path, or null on the App Home. */
  const projectPath = computed<string | null>(() => {
    if (customProjectPath !== undefined) {
      return toValue(customProjectPath) ?? null;
    }
    return project.value?.path ?? null;
  });
  /** The target project's team — who can work within it. Empty off a project. */
  const team = computed<Agent[]>(() => projectTeam(projectPath.value));
  /** Every project team known to this machine — each a path with its members.
   *  The overview reads from this, not from the active project. */
  const teams = computed(() => projectTeamsList());

  /**
   * The last decision the router made, for the surface that shows a receipt.
   * One value rather than one per thread: it describes the send that just
   * happened, and the thread it settled carries the durable record itself.
   */
  const lastRouted = ref<JevRouteResult | null>(null);

  /**
   * Who should carry this request — the router's answer when it is selected,
   * and the plain selection otherwise.
   *
   * Every send goes through here, routed or not, so that the settle call sites
   * have one shape to write and cannot accidentally skip routing. It resolves
   * to an agent id or null, which is exactly what `settleThreadAgent` takes.
   *
   * The candidates are the project's team, not the whole roster: routing must
   * not hand a thread to somebody who was never added to the repository, which
   * is the same rule `pickedForProject` enforces for a hand-picked agent.
   */
  async function resolveAgentId(request: string): Promise<string | null> {
    if (!routing.value) {
      const picked = selected.value;
      return picked ? picked.id : null;
    }
    routePending.value = true;
    try {
      return await routeNow(request);
    } finally {
      routePending.value = false;
    }
  }

  /** The routed half of `resolveAgentId`, split out only so the pending flag
   *  can wrap it without the early return escaping the `finally`. */
  async function routeNow(request: string): Promise<string | null> {
    // The repository's name, not its path: the leading directories are this
    // machine's filing, and they read to a classifier as words in the request.
    const path = projectPath.value;
    const name = path ? (path.split("/").filter(Boolean).pop() ?? null) : null;
    const result = await routeRequest(request, team.value, name);
    lastRouted.value = result;
    return result.agentId;
  }

  /** A routing round trip is in flight and a send is waiting behind it.
   *
   *  The call goes to a service over the network, so the wait is real and the
   *  composer has to be able to say so. `routing` is not this: it means only
   *  that Jev is the choice in the picker, which is true long before and long
   *  after any request. */
  const routePending = ref(false);

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

  /**
   * Start a thread with an agent: ensures it is on the active project's team,
   * sets the active agent selection, and requests the board to focus a blank thread.
   */
  async function startThreadWithAgent(id: string): Promise<void> {
    const path = projectPath.value;
    if (path && !isOnProjectTeam(path, id)) {
      await addAgentToProject(path, id);
    }
    selectAgent(id);
    pendingThreadAgent.value = { id, projectPath: path };
  }

  return {
    roster,
    selected,
    routing,
    lastRouted,
    routePending,
    resolveAgentId,
    team,
    teams,
    projectPath,
    pendingThreadAgent,
    isOnTeam,
    addToTeam,
    removeFromTeam,
    startThreadWithAgent,
    loadProjectTeam,
    agentTeamPaths,
    agentById,
    selectAgent,
    settleThreadAgent,
    threadSettled,
    renameAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    duplicateAgent,
  };
}

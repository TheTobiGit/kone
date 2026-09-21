import { computed, onMounted, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
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
import {
  isPrefetchableDraft,
  JEV_PREFETCH_DEBOUNCE_MS,
  normalizeRouteText,
  routeForBinding,
  routeRequest,
} from "~/utils/agentRouting";
import { createWarmedRoute } from "~/utils/warmedRoute";
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
   * Settle who works this thread, and why, from the request itself.
   *
   * One call rather than a resolve followed by a settle, and the signature is
   * the whole point of it. The settle is write-once and can be refused, so who
   * and why have to land in the same write — split across two calls, the second
   * would not be refused and the thread would wear a receipt for a decision
   * that never took effect. A pair of calls makes that a rule every future send
   * site has to remember; one call makes it a rule nobody can break.
   *
   * Every send goes through here, routed or not, so that no send site can
   * accidentally skip routing. The whole policy lives in here, including when
   * *not* to route: a thread that has already been decided is never routed
   * again — not merely to save the call, but because the binding would refuse
   * the answer anyway, so a later turn would spend a request to produce a
   * receipt announcing a decision that did not happen, and the session it
   * claimed to describe was spawned with the first turn's persona and cannot
   * become somebody else.
   *
   * The candidates are the project's team, not the whole roster: routing must
   * not hand a thread to somebody who was never added to the repository, which
   * is the same rule `pickedForProject` enforces for a hand-picked agent.
   *
   * Answers with the agent this call put on the thread, because who works a
   * thread also decides what it runs on: an agent with a pinned model expects
   * the thread to open on that model, and only the caller holding the send can
   * put it there. Null means nobody was put there by this call — a guest, a
   * request that went to the default partner, or a thread that was already
   * settled and refused this answer. The refusal answering null is the point:
   * the pins of an agent who is not on this thread must never reach it.
   */
  async function settleAgentFor(
    request: string,
    threadId: string | null | undefined,
  ): Promise<Agent | null> {
    const picked = pickedForProject.value;
    if (!routing.value || threadSettled(threadId)) {
      return settleThreadAgent(threadId, picked?.id ?? null) ? (picked ?? null) : null;
    }
    // A paused draft was routed ahead while it was being typed. When the send
    // carries exactly that text — same words, same team, same project — the
    // warmed decision is the send's decision, and awaiting it is instant
    // rather than a fresh round trip.
    const warmed = warmedRoute.take(normalizeRouteText(request));
    if (warmed) {
      routePending.value = true;
      try {
        return landRoute(await warmed, threadId);
      } finally {
        routePending.value = false;
      }
    }
    routePending.value = true;
    try {
      return await routeAndSettle(request, threadId);
    } finally {
      routePending.value = false;
    }
  }

  /**
   * Write a decision onto the thread, and answer with who it put there.
   *
   * The receipt waits on the decision landing. A round trip is long enough for
   * another window to settle this thread first, and a line reading "Jev → Ada"
   * over a thread Bob is working describes a send, not the conversation the
   * user is looking at. The answer is refused on the same terms, so a caller
   * about to start the thread on an agent's model only ever gets the agent the
   * thread actually has.
   */
  function landRoute(result: JevRouteResult, threadId: string | null | undefined): Agent | null {
    if (!settleThreadAgent(threadId, result.agentId, routeForBinding(result))) return null;
    lastRouted.value = result;
    return result.agentId ? (agentById(result.agentId) ?? null) : null;
  }

  /** The repository's name, not its path: the leading directories are this
   *  machine's filing, and they read to a classifier as words in the request. */
  function currentProjectName(): string | null {
    const path = projectPath.value;
    return path ? (path.split("/").filter(Boolean).pop() ?? null) : null;
  }

  /** The routed half of `settleAgentFor`, split out only so the pending flag
   *  can wrap it without an early return escaping the `finally`. */
  async function routeAndSettle(
    request: string,
    threadId: string | null | undefined,
  ): Promise<Agent | null> {
    const result = await routeRequest(request, team.value, currentProjectName());
    return landRoute(result, threadId);
  }

  /** A routing round trip is in flight and a send is waiting behind it.
   *
   *  The call goes to a service over the network, so the wait is real and the
   *  composer has to be able to say so. `routing` is not this: it means only
   *  that Jev is the choice in the picker, which is true long before and long
   *  after any request. */
  const routePending = ref(false);

  // ── speculative routing: work while the draft is being typed ─────────────
  // With Jev picked, a paused draft is routed ahead so the send finds the
  // decision already made. The warmed slot describes the exact text it was
  // asked about and the team and project it was asked under; a send carrying
  // anything else routes fresh rather than trusting a decision made on
  // different words.

  /** The team and project a routing decision was made under. A decision is
   *  only this send's decision if these still hold: the same words put to a
   *  different team are a different question. */
  function routeContext(): string {
    return `${team.value.map((member) => member.id).sort().join(",")}\0${currentProjectName() ?? ""}`;
  }

  const warmedRoute = createWarmedRoute<JevRouteResult>({
    route: (request) => routeRequest(request, team.value, currentProjectName()),
    context: routeContext,
    debounceMs: JEV_PREFETCH_DEBOUNCE_MS,
    stillWanted: (request) => routing.value && isPrefetchableDraft(request),
  });

  onScopeDispose(() => warmedRoute.clear());

  // Jev unpicked means no draft will ever be sent as a route: drop the pending
  // ask and the warmed decision rather than spending a call whose answer can no
  // longer be used — or worse, letting a later send reuse it.
  watch(routing, (on) => {
    if (!on) warmedRoute.clear();
  });

  /** Route a paused draft ahead of its send. No-op unless Jev is picked and
   *  the draft is worth classifying; debounced so steady typing never fires.
   *  Call it from the composer's draft with the thread still blank — a
   *  settled thread never routes again, so warming for one is a spent call. */
  function prefetchRoute(draft: string): void {
    if (!routing.value || !isPrefetchableDraft(draft)) return;
    warmedRoute.warm(normalizeRouteText(draft));
  }

  // Read the team back from the store whenever the active project changes. The
  // dev fallback is its own store, so this only does anything with a bridge.
  //
  // `teamReady` is what `pickedForProject` waits on. Until the read lands, "not
  // on this team" and "not asked yet" look identical, and demoting the
  // selection to a guest on the second one would announce a decision the user
  // never made and then quietly take it back a moment later.
  const teamReady = ref(false);
  watch(
    projectPath,
    (path) => {
      if (!path) {
        // Off a project there is no team to wait for, and an empty one is the
        // right answer rather than a gap.
        teamReady.value = true;
        return;
      }
      teamReady.value = false;
      void loadProjectTeam(path).finally(() => {
        teamReady.value = true;
      });
    },
    { immediate: true },
  );

  /**
   * The selection as it applies to *this* project.
   *
   * The selection is app-wide, so it can be carrying an agent who is a teammate
   * somewhere else and a stranger here; here that reads as a guest, rather than
   * quietly working a project they were never added to. On-team members pass
   * straight through, so nothing changes for the project they belong to.
   */
  const pickedForProject = computed<Agent | undefined>(() => {
    const picked = selected.value;
    if (!picked) return undefined;
    if (!teamReady.value) return picked;
    return isOnTeam(picked.id) ? picked : undefined;
  });

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
    pickedForProject,
    routing,
    lastRouted,
    routePending,
    prefetchRoute,
    settleAgentFor,
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

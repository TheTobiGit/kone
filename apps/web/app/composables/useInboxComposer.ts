// Everything the inbox's composer needs to be more than a text field.
//
// The board assembles this inline, because it also owns a model picker modal, a
// provider rail, a boot restore and a focus manager. The inbox has one thread on
// screen and no picker modal, so the same wiring reduces to this: which agents
// may work here, which models they may run, and where a pick has to land.
//
// The one rule the whole file exists to keep is ordering. Every commit points
// the registry at the session the composer is editing BEFORE changing anything,
// because a registry is shared with whatever else has that project open — a
// pick that lands on the wrong session is invisible until a thread comes back
// running a model nobody chose.

import { computed, onMounted, ref, toValue, watch } from "vue";
import type { MaybeRefOrGetter } from "vue";
import type { ThreadSession, useAgent } from "~/composables/useAgent";
import { useModelCommit } from "~/composables/useModelCommit";
import {
  buildModelCatalog,
  familyForId,
  type EffortTier,
  type ModelOption,
  type PickerProvider,
} from "~/utils/modelCatalog";
import {
  bootAssistantModel,
  bootAssistantProvider,
  bootAssistantReasoning,
  bootModel,
  bootProvider,
  bootReasoning,
  modeKey,
  PROVIDER_BRAND,
  PROVIDER_VENDOR,
  setAssistantLastUsedModel,
  setLastUsedModel,
} from "~/utils/modelPicker";
import { JEV_ROUTER_ID, routingReceipt } from "~/utils/agentRouting";
import type { Agent } from "~/utils/agents";
import { GLOBAL_ASSISTANT_PROJECT_PATH } from "~/composables/useGlobalAssistant";
import { resolveProviderSendAvailability } from "~/utils/providerAvailability";
import type { ModelPick } from "~/composables/useModelCommit";
import type { ThreadDraft } from "~/composables/useThreadDraft";
import type { AgentModelRef, InteractionMode, ProviderKind } from "~/types/desktop";

export interface UseInboxComposerOptions {
  agent: ReturnType<typeof useAgent>;
  /** The session the composer is editing, or null while one is being claimed. */
  session: () => ThreadSession | null;
  projectPath: MaybeRefOrGetter<string>;
  /** Where the choices live until there is a session to put them in. Given by a
   *  pane that is making a thread; omitted by one showing a thread that already
   *  exists, which has a session from the start and nothing to draft. */
  draft?: ThreadDraft;
}

export function useInboxComposer(o: UseInboxComposerOptions) {
  const { agent } = o;
  const providers = useAgentProviders();
  const providerSettings = useProviderSettings();

  // Scoped to the thread's own project, not to whatever project the app has
  // open — in the inbox those are routinely different, and the team that may
  // work a repository is a fact about the repository.
  const {
    team: agents,
    pickedForProject,
    routing,
    lastRouted,
    routePending,
    prefetchRoute,
    settleAgentFor,
    selectAgent,
    agentById,
  } = useAgentRoster(() => toValue(o.projectPath));

  /** What the composer's agent slot is holding. The router's sentinel is a
   *  real answer here and is never resolved to an agent — nobody is working the
   *  turn until the request has been read. */
  const agentId = computed(() =>
    routing.value ? JEV_ROUTER_ID : (pickedForProject.value?.id ?? null),
  );

  /** The receipt for the last routed send, or null when there is nothing to
   *  report. Derived rather than stored: it is a rendering of the decision,
   *  and the decision is the thing worth keeping. */
  const routingNote = computed<string | null>(() => {
    // In flight first: the send is held behind a network round trip, and the
    // slot that will report the decision is the honest place to say it is
    // still being made. Without this the tray shows the previous send's
    // receipt while the current one waits, which reads as already answered.
    if (routePending.value) return "Choosing who takes this…";

    const result = lastRouted.value;
    if (!result) return null;
    const name = result.agentId ? agentById(result.agentId)?.name : undefined;
    return routingReceipt(result, name);
  });

  // A pinned model is a hard pin: only its provider is offered, and only that
  // one model within it, so the composer can only answer where the agent may.
  const capModel = computed<AgentModelRef | null>(
    () => pickedForProject.value?.capabilities.model ?? null,
  );
  function providerAllowed(p: ProviderKind | null): boolean {
    if (!p) return false;
    return capModel.value === null || capModel.value.provider === p;
  }
  function modelAllowed(provider: ProviderKind, key: string): boolean {
    const pinned = capModel.value;
    return pinned === null || (pinned.provider === provider && pinned.model === key);
  }

  // The disk snapshot paints immediately and the live re-probe corrects it a
  // moment later — a CLI upgrade that added or dropped a model shows up as a
  // rebuilt list rather than a stale one left on screen.
  const catalogs = ref<Partial<Record<ProviderKind, ModelOption[]>>>({});
  watch(
    () => providers.modelCache.value,
    (raw) => {
      const next: Partial<Record<ProviderKind, ModelOption[]>> = {};
      for (const [provider, list] of Object.entries(raw)) {
        if (list?.length) next[toProviderKind(provider)] = buildModelCatalog(list);
      }
      catalogs.value = { ...catalogs.value, ...next };
    },
    { immediate: true },
  );

  const session = computed(() => o.session());
  const draft = o.draft;
  const provider = computed(
    () => session.value?.provider.value ?? draft?.provider.value ?? agent.provider.value,
  );

  // Whether a turn can go to this pane's provider right now, and if not, the
  // sentence to show. Derived from `provider` rather than from the session, so
  // the pane that is still making a thread — which has a draft and no session to
  // ask — is gated on the same terms as one that already has a voice.
  const sendAvailability = computed(() =>
    resolveProviderSendAvailability({ provider: provider.value, statuses: providers.statuses.value }),
  );
  const sendBlockedReason = computed(() =>
    sendAvailability.value.usable ? null : sendAvailability.value.reason,
  );
  const sendBlockedStatus = computed(() => sendAvailability.value.status);
  const recheckingProviders = ref(false);
  /** Re-probe on the banner's own action. Held so the button can read as busy —
   *  `providers.refresh()` dedupes itself, but nothing about that is visible. */
  async function recheckProviders(): Promise<void> {
    if (recheckingProviders.value) return;
    recheckingProviders.value = true;
    try {
      await providers.refresh();
    } finally {
      recheckingProviders.value = false;
    }
  }

  const modelOptions = computed(() => {
    const p = provider.value;
    if (!p) return [];
    return (catalogs.value[p] ?? []).filter((m) => modelAllowed(p, m.key));
  });

  // Providers that are installed, enabled in settings, and open to the selected
  // agent. The enable toggle is a picker filter only — it never tears down a
  // session that is already running on one.
  const enabledReady = computed(() =>
    providers.ready.value.filter(
      (s) => providerSettings.isEnabled(s.provider) && providerAllowed(s.provider),
    ),
  );

  // The rail the picker shows: one row per offered provider, each catalog put
  // through the same visibility rule the providers pane writes, so a model
  // hidden there is hidden here.
  const pickerProviders = computed<PickerProvider[]>(() => {
    const visible = providerSettings.modelVisiblePredicate.value;
    return enabledReady.value.map((s) => {
      const models = (catalogs.value[s.provider] ?? []).filter(
        (m) => visible(s.provider, m.key) && modelAllowed(s.provider, m.key),
      );
      return {
        id: s.provider,
        label: s.label,
        sub: `${PROVIDER_VENDOR[s.provider]} · ${models.length} model${models.length === 1 ? "" : "s"}`,
        brand: PROVIDER_BRAND[s.provider],
        ready: s.readiness === "ready",
        models,
      };
    });
  });

  /** Is there anything to pick? One model across every offered provider is a
   *  dead end, so the composer's model slot becomes a plain label instead. */
  const modelSwitchable = computed(
    () => pickerProviders.value.reduce((n, p) => n + p.models.length, 0) > 1,
  );

  // The picker is a modal the surface hosts, not something the composer opens
  // for itself — it lives outside the composer's dock, which is also why the
  // composer has to be told it is up (`picking`) so a click inside it does not
  // read as a click away.
  const pickerOpen = ref(false);
  function openPicker(): void {
    if (modelSwitchable.value) pickerOpen.value = true;
  }
  function closePicker(): void {
    pickerOpen.value = false;
  }

  /** Point the registry at this pane's session before anything is committed.
   *  No-op until the session has been claimed — a pick made in that window
   *  would land on whichever thread the registry happened to be holding. */
  async function syncTarget(): Promise<void> {
    const s = session.value;
    if (s) agent.focusThread(s.key);
  }

  const isAssistant = computed(() => toValue(o.projectPath) === GLOBAL_ASSISTANT_PROJECT_PATH);
  const persistLastUsed = (pick: { provider: ProviderKind; modelId?: string; tier?: EffortTier }): void => {
    if (isAssistant.value) setAssistantLastUsedModel(pick);
    else setLastUsedModel(pick);
  };
  const commit = useModelCommit({
    agent,
    catalogs,
    modelOptions,
    syncTarget,
    isAssistant: isAssistant.value,
  });

  // A drafted model has to be a model this provider actually has. The draft is
  // seeded from storage before any catalog is loaded, so it can be carrying an
  // id left behind by another provider — which would reach the CLI as a model it
  // has never heard of. Once the catalog lands, an id it does not own is
  // replaced by that provider's own default rather than left to fail at send.
  watch([modelOptions, () => draft?.model.value], ([options]) => {
    if (!draft || session.value || options.length === 0) return;

    const wanted = draft.model.value;
    const owned =
      wanted !== undefined &&
      options.some((m) => m.key === wanted || m.efforts.some((e) => e.modelId === wanted));
    if (!owned) {
      const first = options[0];
      draft.model.value = (first?.efforts[first.defaultEffortIndex] ?? first?.efforts[0])?.modelId;
      return;
    }

    // The effort has to be one the model offers, for the same reason. An empty
    // slot is not a neutral state here: the composer would show no effort at all
    // where every other surface shows the model's own default.
    const fam = familyForId(options, draft.model.value);
    if (!fam) return;
    const tier = draft.reasoning.value;
    if (tier !== undefined && fam.efforts.some((e) => e.tier === tier)) return;
    draft.reasoning.value = (fam.efforts[fam.defaultEffortIndex] ?? fam.efforts[0])?.tier;
  });

  /**
   * Put the draft into a session, in the order the session needs it.
   *
   * Provider first: setting it clears the model, because an id from the old
   * provider's catalog means nothing to the new one. Everything else follows.
   * Called once, by the pane, at the moment a thread is actually being made.
   */
  async function applyDraft(): Promise<void> {
    if (!draft) return;
    await syncTarget();
    if (draft.provider.value !== agent.provider.value) agent.setProvider(draft.provider.value);
    agent.setModel(draft.model.value);
    if (draft.reasoning.value) agent.setReasoning(draft.reasoning.value);
    agent.setServiceTier(draft.serviceTier.value);
    if (draft.contextWindow.value) agent.setContextWindow(draft.contextWindow.value);
    agent.setMode(draft.mode.value);
  }

  /**
   * Record an agent's pinned model wherever this pane's next turn will read it.
   *
   * The same is-there-a-session-yet question every commit path below asks: with
   * no session the draft is the only place a pick can live, and `applyDraft`
   * carries it in later; with one, the draft has been spent and the pick goes
   * straight to the session it would have reached. An agent with no pin says
   * nothing about the model, so nothing is written.
   */
  async function landAgentPin(settled: Agent | null): Promise<void> {
    const pinned = settled?.capabilities.model ?? null;
    if (!pinned) return;
    if (draft && !session.value) {
      draft.provider.value = pinned.provider;
      draft.model.value = pinned.model;
      return;
    }
    await commit.applyAgentPin(settled);
  }

  /**
   * Settle who works this thread, then start it on the model they run on.
   *
   * The two belong in one call. A hand-picked agent's pinned model reaches the
   * composer the moment it is picked — the watcher below lands it in the draft,
   * and the user sees what will run before they send. A routed one is named by
   * the send itself, after every pick the composer could make, so its pin has
   * nowhere else to land: without this, a thread handed to an agent that runs
   * on one model would open on whatever the composer was showing.
   *
   * Only the agent this call actually put on the thread is applied. A later
   * turn settles nothing, and its model stays the thread's own.
   */
  async function settleAndPin(
    text: string,
    threadId: string | null | undefined,
  ): Promise<Agent | null> {
    const settled = await settleAgentFor(text, threadId);
    await landAgentPin(settled);
    return settled;
  }

  // ── the branch ───────────────────────────────────────────────────────────
  // Which branch the work would land on. The read follows the path: no status
  // watcher stands on the repository, because these surfaces hold no project
  // open and watching one for a single word would be a lot of machinery. So the
  // label is re-read when the project changes underneath, and after a checkout,
  // which is the only change these surfaces can cause themselves.

  const git = useGit();
  const branch = ref<string | null>(null);

  async function refreshBranch(): Promise<void> {
    // No project means no branch. Asking git about an empty path is not a
    // narrower question — the process answers for whatever directory it happens
    // to be sitting in, which is a real branch of a repository the user never
    // chose, printed in a slot that claims to describe their work.
    const path = toValue(o.projectPath);
    if (!path) {
      branch.value = null;
      return;
    }
    try {
      const status = await git.status(path);

      // The project can change while git is answering, and two reads in flight
      // settle in whatever order the calls happen to return. The path this one
      // asked about is its own generation token: if it is no longer the project
      // on screen, a later read owns the label and this answer is dropped
      // rather than printed against work it does not describe.
      if (toValue(o.projectPath) !== path) return;
      branch.value = status?.branch ?? null;
    } catch {
      // Not a repository, or git is unavailable. The slot empties rather than
      // keeping the previous project's branch, which would be a real branch
      // name sitting under the wrong project.
      if (toValue(o.projectPath) === path) branch.value = null;
    }
  }

  // A surface that starts with no project and acquires one — the bench, filing
  // a job — changes the answer after mount, so this follows the path rather than
  // reading once beside it. Immediate, so a surface that knew its project all
  // along still reads on mount exactly as before.
  watch(() => toValue(o.projectPath), () => void refreshBranch(), { immediate: true });

  // When the selected agent changes before a session is claimed, update the draft:
  // a pinned agent immediately sets its required provider and model. Switching
  // back to an unpinned agent restores the general last-used / default selection.
  watch(pickedForProject, (nextAgent, prevAgent) => {
    if (!draft || session.value) return;
    if (nextAgent?.capabilities?.model) {
      void landAgentPin(nextAgent);
    } else if (prevAgent?.capabilities?.model) {
      if (isAssistant.value) {
        draft.provider.value = bootAssistantProvider();
        draft.model.value = bootAssistantModel();
        draft.reasoning.value = bootAssistantReasoning();
      } else {
        draft.provider.value = bootProvider();
        draft.model.value = bootModel();
        draft.reasoning.value = bootReasoning();
      }
    }
  });

  // ── committing a pick ────────────────────────────────────────────────────
  // Each of these answers the same question first: is there a session yet? With
  // one, the pick goes through the shared commit path, which points the registry
  // at the right thread, persists the selection against its id, and restarts the
  // CLI when the provider bakes the model in at spawn. Without one there is
  // nothing to point at, nothing to persist against and nothing to restart — the
  // pick is simply recorded, and `applyDraft` performs all of that once, later,
  // against the session the send creates.

  function onModelId(id: string): void {
    if (draft && !session.value) {
      draft.model.value = id;
      if (!capModel.value && draft.provider.value) {
        persistLastUsed({ provider: draft.provider.value, modelId: id, tier: draft.reasoning.value });
      }
      return;
    }
    commit.onComposerModelId(id);
  }

  function onReasoning(tier: EffortTier): void {
    if (draft && !session.value) {
      draft.reasoning.value = tier;
      if (!capModel.value && draft.provider.value) {
        persistLastUsed({ provider: draft.provider.value, modelId: draft.model.value, tier });
      }
      return;
    }
    commit.onComposerReasoning(tier);
  }

  function onContextWindow(id: string): void {
    if (draft && !session.value) {
      draft.contextWindow.value = id;
      return;
    }
    commit.onComposerContextWindow(id);
  }

  function onFastMode(on: boolean): void {
    if (draft && !session.value) {
      const fam = familyForId(modelOptions.value, draft.model.value);
      draft.serviceTier.value = on ? fam?.fastTier?.id : undefined;
      return;
    }
    commit.onUpdateFastMode(on);
  }

  /** A pick from the full picker, which may change the provider as well as the
   *  model — the one commit that can rebuild the session it lands on. */
  async function onApply(picked: ModelPick): Promise<void> {
    if (draft && !session.value) {
      draft.provider.value = picked.provider;
      draft.model.value = picked.modelId;
      draft.reasoning.value = picked.tier;
      const fam = familyForId(catalogs.value[picked.provider] ?? [], picked.modelId);
      draft.serviceTier.value = picked.fastMode ? fam?.fastTier?.id : undefined;
      draft.contextWindow.value =
        picked.contextWindow ?? fam?.contextWindows?.find((w) => w.isDefault)?.id;
      if (!capModel.value) {
        persistLastUsed({
          provider: picked.provider,
          modelId: picked.modelId,
          tier: picked.tier,
        });
      }
      return;
    }
    await commit.applyModelEffort(picked);
  }

  /** The permission mode is a per-repository trust decision, so it is written
   *  under this project's key rather than the app's — and written only when a
   *  person changes it, so a boot seed cannot read its own default back as if
   *  the project had already made a choice. */
  function onMode(next: InteractionMode): void {
    if (draft && !session.value) draft.mode.value = next;
    else commit.onComposerMode(next);
    if (import.meta.client) localStorage.setItem(modeKey(toValue(o.projectPath)), next);
  }

  // A lazy, per-surface load: nothing in the app has probed the machine's CLIs
  // on the inbox's behalf, and an unasked-for list is indistinguishable from an
  // empty one — the model slot would flatten to a label, which looks like a
  // decision rather than a gap. (The project's team is read by the roster,
  // which follows the path this composable hands it.)
  onMounted(async () => {
    // Neither rejects — each swallows its own failure and resolves to a
    // fallback — so awaiting them together cannot strand a rejection.
    await Promise.all([providers.prepare(), providerSettings.load()]);
    await Promise.all(
      enabledReady.value.map(async (s) => {
        const raw = await providers.models(s.provider);
        catalogs.value = { ...catalogs.value, [s.provider]: buildModelCatalog(raw) };
      }),
    );
  });

  return {
    branch,
    refreshBranch,
    // The send gate, shared by every inbox surface so none of them can offer a
    // send another one would refuse. `sendBlockedReason` drives both the banner
    // and the composer's own refusal.
    sendBlockedReason,
    sendBlockedStatus,
    recheckingProviders,
    recheckProviders,
    applyDraft,
    provider,
    pickerProviders,
    pickerOpen,
    openPicker,
    closePicker,
    /** A pick from the full picker: commit it, then get out of the way. */
    onPick: (picked: ModelPick) => {
      void onApply(picked);
      pickerOpen.value = false;
    },
    onApply,
    agents,
    agentId,
    settleAndPin,
    prefetchRoute,
    routing,
    lastRouted,
    routingNote,
    onAgentPick: (id: string | null) => selectAgent(id),
    modelOptions,
    modelSwitchable,
    // Read off the session rather than the registry's active-thread projection:
    // the projection follows whatever was focused last, and this pane's answer
    // must not depend on that having already happened.
    // Each of these reads the session when there is one and the draft when
    // there is not, so a slot shows the same answer either side of the send.
    modelId: computed(() => session.value?.model.value ?? draft?.model.value),
    reasoning: computed(() => session.value?.reasoning.value ?? draft?.reasoning.value),
    mode: computed(() => session.value?.mode.value ?? draft?.mode.value),
    contextWindow: computed(() => session.value?.contextWindow.value ?? draft?.contextWindow.value),
    fastMode: computed(() =>
      session.value ? commit.fastActive.value : Boolean(draft?.serviceTier.value),
    ),
    onModelId,
    onReasoning,
    onContextWindow,
    onFastMode,
    onMode,
    persistThreadSelection: commit.persistThreadSelection,
    syncTarget,
  };
}

/** `Object.entries` over a Partial<Record<ProviderKind, …>> yields keys that are
 *  ProviderKind by construction; this only carries that across. */
function toProviderKind(key: string): ProviderKind {
  // SAFETY: the source object is keyed by ProviderKind, so every key it
  // enumerates is one.
  return key as ProviderKind;
}

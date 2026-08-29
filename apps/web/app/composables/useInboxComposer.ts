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
import { modeKey, PROVIDER_BRAND, PROVIDER_VENDOR } from "~/utils/modelPicker";
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
    selected: pickedAgent,
    selectAgent,
    settleThreadAgent,
    isOnTeam,
    loadProjectTeam,
  } = useAgentRoster(() => toValue(o.projectPath));

  // An agent selected somewhere else may not be on this project's team, and a
  // guest is the honest answer when it is not — better than quietly working a
  // project it was never added to.
  //
  // But only once there is an answer to give. Nothing in the app has read this
  // project's team on the inbox's behalf, so until that read lands "not on the
  // team" and "not asked yet" look identical, and demoting the selection to a
  // guest on the second one would announce a decision the user never made and
  // then quietly take it back a moment later.
  const teamReady = ref(false);
  const pickedForProject = computed(() => {
    const picked = pickedAgent.value;
    if (!picked) return undefined;
    if (!teamReady.value) return picked;
    return isOnTeam(picked.id) ? picked : undefined;
  });
  const agentId = computed(() => pickedForProject.value?.id ?? null);

  // A pinned model is a hard pin: only its provider is offered, and only that
  // one model within it, so the composer can only answer where the agent may.
  const capModel = computed<AgentModelRef | null>(
    () => pickedForProject.value?.capabilities.model ?? null,
  );
  function providerAllowed(p: ProviderKind): boolean {
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

  const modelOptions = computed(() =>
    (catalogs.value[provider.value] ?? []).filter((m) => modelAllowed(provider.value, m.key)),
  );

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

  const commit = useModelCommit({ agent, catalogs, modelOptions, syncTarget });

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

  // ── the branch ───────────────────────────────────────────────────────────
  // Which branch the work would land on. Read once rather than watched: the
  // inbox holds no project open, so there is no status watcher on this
  // repository and standing one up for a label would be a lot of machinery for
  // a word. Re-read after a checkout, which is the only change this surface can
  // cause and the only one it has to notice.

  const git = useGit();
  const branch = ref<string | null>(null);

  async function refreshBranch(): Promise<void> {
    try {
      branch.value = (await git.status(toValue(o.projectPath)))?.branch ?? null;
    } catch {
      /* not a repository, or git is unavailable — the slot simply stays empty */
    }
  }

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
      return;
    }
    commit.onComposerModelId(id);
  }

  function onReasoning(tier: EffortTier): void {
    if (draft && !session.value) {
      draft.reasoning.value = tier;
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

  // Both of these are lazy, per-surface loads: nothing in the app has read this
  // project's team or probed the machine's CLIs on the inbox's behalf, and an
  // unasked-for list is indistinguishable from an empty one — the agent menu
  // would offer only a guest and the model slot would flatten to a label, both
  // of which look like a decision rather than a gap. Which project is fixed for
  // this pane's lifetime, so asking once on mount is the whole story.
  onMounted(async () => {
    void loadProjectTeam(toValue(o.projectPath)).finally(() => (teamReady.value = true));
    void refreshBranch();
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
    onAgentPick: (id: string | null) => selectAgent(id),
    settleThreadAgent,
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

// Committing a picker choice to the session that will run the next turn.
//
// Every one of these paths does the same three things in the same order: point
// at the session the composer is editing, change it, then persist what was
// picked. They live together because getting that order wrong is invisible until
// a reopened thread comes back with the wrong model — and because "which model
// will actually run" is one question, whether it was answered by the full
// picker, the composer's inline slots, or the fast-mode toggle.
//
// What this deliberately does NOT own: the picker modal's open/closed state, and
// the boot restore. Both belong to the surface — one is a piece of UI, the other
// runs once at mount and reads the same keys from `utils/modelPicker`.

import { computed } from "vue";
import type { ComputedRef, Ref } from "vue";
import type { InteractionMode, ProviderKind } from "~/types/desktop";
import type { Agent } from "~/utils/agents";
import type { EffortTier, ModelOption } from "~/utils/modelCatalog";
import { familyForId } from "~/utils/modelCatalog";
import { setAssistantLastUsedModel, setLastUsedModel } from "~/utils/modelPicker";
import type { useAgent } from "~/composables/useAgent";

export type ModelPick = {
  provider: ProviderKind;
  modelId: string;
  tier: EffortTier;
  fastMode: boolean;
  contextWindow?: string;
};

export interface UseModelCommitOptions {
  agent: ReturnType<typeof useAgent>;
  /** Per-provider model catalogs, for resolving a pick's family (its fast tier
   *  and context windows). */
  catalogs: Ref<Partial<Record<ProviderKind, ModelOption[]>>>;
  /** The catalog of the CURRENT provider — what the composer's inline slots and
   *  the fast-mode toggle resolve against. */
  modelOptions: ComputedRef<ModelOption[]>;
  /** Point `agent.activeKey` at the session the composer is editing. Every path
   *  awaits this first: without it a pick can land on a background thread, or on
   *  a boot session the mount is about to evict. */
  syncTarget: () => Promise<void>;
  /** When true, persist picks to the assistant's isolated last-used keys instead
   *  of the global board keys. */
  isAssistant?: boolean;
}

export function useModelCommit(o: UseModelCommitOptions) {
  const { agent, catalogs, modelOptions, syncTarget } = o;
  const persistLastUsed = (pick: { provider: ProviderKind; modelId?: string; tier?: EffortTier }): void => {
    if (o.isAssistant) setAssistantLastUsedModel(pick);
    else setLastUsedModel(pick);
  };

  /** Persist the active thread's committed selection — model, effort, service
   *  tier, context window — so a reopened thread restores exactly what the
   *  picker showed (useAgent's adoptStoredThread reads it back). Fire-and-forget;
   *  the store no-ops when the thread row doesn't exist yet (a blank thread mints
   *  its conversation id on first send; its selection lands then). */
  function persistThreadSelection(): void {
    if (!import.meta.client) return;
    const threadId = agent.threadId.value;
    if (!threadId) return;
    // The bridge is store-owned; guarded at runtime for browser dev (no bridge).
    void window.koneDesktop?.agent
      ?.setThreadSelection?.(threadId, {
        model: agent.model.value,
        effort: agent.reasoning.value,
        serviceTier: agent.serviceTier.value,
        contextWindow: agent.contextWindow.value,
        mode: agent.mode.value,
      })
      .catch(() => {
        // best-effort persistence — a failed write never disturbs the picker.
      });
  }

  async function applyModelEffort(picked: ModelPick): Promise<void> {
    await syncTarget();
    const providerChanged = picked.provider !== agent.provider.value;
    if (providerChanged) agent.setProvider(picked.provider);
    agent.setModel(picked.modelId);
    agent.setReasoning(picked.tier);
    const fam = familyForId(catalogs.value[picked.provider] ?? [], picked.modelId);
    agent.setServiceTier(picked.fastMode ? fam?.fastTier?.id : undefined);
    // Honor the picker's context-window choice when the family offers one (it's
    // the auto-compact window, applied per turn — no restart). setModel above may
    // have re-seeded it via the model watcher; this pins the user's explicit pick.
    if (fam?.contextWindows?.length) {
      agent.setContextWindow(
        picked.contextWindow ??
          fam.contextWindows.find((w) => w.isDefault)?.id ??
          fam.contextWindows[0]!.id,
      );
    }

    // Persist the choice so subsequent sessions open with whatever ran last.
    if (import.meta.client) {
      persistLastUsed({
        provider: picked.provider,
        modelId: picked.modelId,
        tier: picked.tier,
      });
    }

    // Only a provider switch needs a new session: every adapter takes a model
    // change on the turn that carries it, so a pick reaches the running
    // conversation without costing it.
    if (providerChanged) {
      // A turn in flight is torn down by the restart — stop it cleanly first.
      if (agent.busy.value) await agent.interrupt();
      await agent.restart();
    }
    // Persist after any restart: a provider switch re-mints the thread id, and
    // the selection must be recorded against the id the thread now carries.
    persistThreadSelection();
  }

  /**
   * Start the thread on its agent's own model.
   *
   * Takes the agent rather than the pin so that every caller asks the same
   * question — "who is working this thread?" — and none of them has to know
   * that an agent without a pin answers it by doing nothing. An agent with a
   * pinned model is a statement about what it runs on, so a thread handed to
   * one opens on that model rather than on whatever the composer happened to be
   * showing when the message was typed. No agent, or one without a pin, leaves
   * the composer's choice standing: no preference is not a preference for
   * something else.
   *
   * Nothing is written to the last-used keys, unlike every other path here.
   * This is not the user choosing a model, and recording it as one would let an
   * agent's pin quietly become the default the next blank thread opens on.
   */
  async function applyAgentPin(settled: Agent | null): Promise<void> {
    const pinned = settled?.capabilities.model ?? null;
    if (!pinned) return;
    await syncTarget();
    const providerChanged = pinned.provider !== agent.provider.value;
    const modelChanged = pinned.model !== agent.model.value;
    if (!providerChanged && !modelChanged) return;
    if (providerChanged) agent.setProvider(pinned.provider);
    agent.setModel(pinned.model);
    // Only a different CLI needs a new session, and only if one is actually
    // running. The common case here is a thread whose first turn is still being
    // sent: nothing has spawned yet, so the pin simply rides out with it, and
    // tearing a session down at that moment would be a teardown of nothing in
    // the middle of a send.
    if (providerChanged && agent.session.value) {
      if (agent.busy.value) await agent.interrupt();
      await agent.restart();
    }
    persistThreadSelection();
  }

  // The composer's inline fast-mode toggle acts on the CURRENT model only — it
  // doesn't change modelId/tier, just whether that model's real "fast" tier is
  // applied on the next turn.
  const fastActive = computed(() => Boolean(agent.serviceTier.value));

  function onUpdateFastMode(on: boolean): void {
    void syncTarget().then(() => {
      const fam = familyForId(modelOptions.value, agent.model.value);
      agent.setServiceTier(on ? fam?.fastTier?.id : undefined);
      persistThreadSelection();
    });
  }
  function onComposerModelId(id: string): void {
    void syncTarget().then(() => {
      agent.setModel(id);
      if (import.meta.client) {
        persistLastUsed({
          provider: agent.provider.value,
          modelId: id,
          tier: agent.reasoning.value,
        });
      }
      persistThreadSelection();
    });
  }
  function onComposerReasoning(tier: EffortTier): void {
    void syncTarget().then(() => {
      agent.setReasoning(tier);
      if (import.meta.client) {
        persistLastUsed({
          provider: agent.provider.value,
          modelId: agent.model.value,
          tier,
        });
      }
      persistThreadSelection();
    });
  }
  function onComposerContextWindow(id: string): void {
    void syncTarget().then(() => agent.setContextWindow(id));
  }
  function onComposerMode(next: InteractionMode): void {
    void syncTarget().then(() => {
      agent.setMode(next);
      persistThreadSelection();
    });
  }

  return {
    persistThreadSelection,
    applyModelEffort,
    applyAgentPin,
    fastActive,
    onUpdateFastMode,
    onComposerModelId,
    onComposerReasoning,
    onComposerContextWindow,
    onComposerMode,
  };
}

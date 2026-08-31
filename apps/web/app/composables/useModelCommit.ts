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
import type { EffortTier, ModelOption } from "~/utils/modelCatalog";
import { familyForId } from "~/utils/modelCatalog";
import { RESTART_ON_MODEL_CHANGE, setLastUsedModel } from "~/utils/modelPicker";
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
}

export function useModelCommit(o: UseModelCommitOptions) {
  const { agent, catalogs, modelOptions, syncTarget } = o;

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
    const modelChanged = picked.modelId !== agent.model.value;
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

    // Persist the choice globally so subsequent sessions open with whatever ran last.
    if (import.meta.client) {
      setLastUsedModel({
        provider: picked.provider,
        modelId: picked.modelId,
        tier: picked.tier,
      });
    }

    const needsRestart =
      providerChanged || (RESTART_ON_MODEL_CHANGE.has(picked.provider) && modelChanged);
    if (needsRestart) {
      // A turn in flight is torn down by the restart — stop it cleanly first.
      if (agent.busy.value) await agent.interrupt();
      await agent.restart();
    }
    // Persist after any restart: a provider switch re-mints the thread id, and
    // the selection must be recorded against the id the thread now carries.
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
        setLastUsedModel({
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
        setLastUsedModel({
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
    fastActive,
    onUpdateFastMode,
    onComposerModelId,
    onComposerReasoning,
    onComposerContextWindow,
    onComposerMode,
  };
}

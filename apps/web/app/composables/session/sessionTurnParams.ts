import { ref } from "vue";
import type { InteractionMode, ProviderKind } from "~/types/desktop";
import { bootMode } from "~/utils/modelPicker";
import type { ReasoningTier, UseAgentOptions } from "../agentTypes";

/** The per-turn provider/model picker state. The staged provider resume id
 *  stays in the session that creates this unit — switching engines drops it,
 *  since a resume id means nothing to another CLI — so it arrives as the
 *  `clearStagedResume` callback below. */
export type SessionTurnParamsDeps = {
  options: UseAgentOptions;
  resolveCwd: () => string;
  clearStagedResume: () => void;
};

/** Provider, model, interaction mode, reasoning effort, service tier and
 *  context window for one thread. Mutable so a thread can switch engines or
 *  models mid-life; a switch the running session cannot absorb is applied by
 *  tearing the session down and starting anew (see restart). */
export function useSessionTurnParams(deps: SessionTurnParamsDeps) {
  const { options, resolveCwd, clearStagedResume } = deps;

  // Nullable: no active provider means no model — send/start stay blocked until
  // a ready provider is picked. A switch onto a real provider clears the model
  // because an id from the old catalog is meaningless to the new CLI.
  const provider = ref<ProviderKind | null>(options.provider);
  const model = ref(options.model);
  const mode = ref<InteractionMode>(
    options.mode ?? bootMode(resolveCwd() ?? "") ?? "accept-edits",
  );
  const reasoning = ref<ReasoningTier>(options.reasoning ?? "medium");
  const serviceTier = ref<string | undefined>(options.serviceTier);
  const contextWindow = ref<string | undefined>(options.contextWindow);

  function setProvider(next: ProviderKind | null): void {
    if (next === provider.value) return;
    provider.value = next;
    // Resume ids are provider-native. Handing one minted by the previous CLI to
    // the new one either hard-fails ("conversation id does not exist" — Claude
    // rethrows on a bad resume) or is silently swallowed into a fresh thread.
    // Switching engines means this conversation can't be continued in-place.
    clearStagedResume();
    // A model id from the old provider's catalog is meaningless to the new one
    // (a Cursor `composer-*` id sent to Codex draws a 400 from the upstream API).
    // Drop it so start() falls back to the new provider's default.
    model.value = undefined;
  }
  function setModel(id: string | undefined): void {
    model.value = id;
  }
  function setMode(next: InteractionMode): void {
    mode.value = next;
  }
  function setReasoning(next: ReasoningTier): void {
    reasoning.value = next;
  }
  function setServiceTier(id: string | undefined): void {
    serviceTier.value = id;
  }
  function setContextWindow(id: string | undefined): void {
    contextWindow.value = id;
  }

  return {
    provider,
    model,
    mode,
    reasoning,
    serviceTier,
    contextWindow,
    setProvider,
    setModel,
    setMode,
    setReasoning,
    setServiceTier,
    setContextWindow,
  };
}

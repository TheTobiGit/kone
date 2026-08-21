import type { AgentModelRef } from "./ConversationStore.js";
import type { ProviderKind } from "./types.js";

// The model an agent (or preset sub-agent) runs on: one model, or none at all.
// An agent names the single model it should use; when it names none it has no
// preference and rides the caller's own. This module is only that choice, kept
// pure so the spawn path can hand it a snapshot of what is available and get a
// decision back with nothing to mock.

/**
 * What one provider can run at this moment, as the spawn path reads it from the
 * cached provider surface. Deliberately flattened to plain data so the resolver
 * has no dependency on the store or the live provider layer.
 */
export type ProviderAvailability = {
  provider: ProviderKind;
  /** Installed, logged in, and runnable. A `false` here skips every model the
   *  provider offers, however good the model would otherwise be. */
  available: boolean;
  /** The model ids the provider's discovered catalogue offers right now. A
   *  chosen model that isn't in here can't be selected — the runtime never
   *  invents a model the provider didn't report. */
  models: readonly string[];
  /** Model ids known to be spent — usage-exhausted or rate-limited — which the
   *  resolver skips even when the provider is otherwise available. Optional
   *  because the availability signal that carries it is separate from the model
   *  catalogue; absent means nothing is known to be spent. */
  exhausted?: readonly string[];
};

/**
 * The outcome of checking an agent's chosen model against what's available.
 *
 *  - `resolved` — the model can run right now; use it.
 *  - `no-preference` — no model was named. Not a failure: the caller should
 *    fall back to its own default model, exactly as a spawn with no model named
 *    does today.
 *  - `unavailable` — a model was named but can't run right now (provider down,
 *    not in the catalogue, or spent). The real failure this guard exists to
 *    surface, kept distinct from the empty case so the caller doesn't treat "no
 *    preference" as an error nor a genuine dead end as "use the default".
 */
export type ModelResolution =
  | { outcome: "resolved"; ref: AgentModelRef }
  | { outcome: "no-preference" }
  | { outcome: "unavailable"; tried: AgentModelRef };

/** Check an agent's chosen model against a snapshot of what's available and
 *  return whether it can run, the empty verdict, or the dead end. Pure: the
 *  same inputs always give the same answer. */
export function resolveAgentModel(
  chosen: AgentModelRef | null | undefined,
  availability: readonly ProviderAvailability[],
): ModelResolution {
  if (!chosen) return { outcome: "no-preference" };

  const provider = availability.find((entry) => entry.provider === chosen.provider);
  const runnable =
    provider?.available &&
    provider.models.includes(chosen.model) &&
    !provider.exhausted?.includes(chosen.model);

  return runnable ? { outcome: "resolved", ref: chosen } : { outcome: "unavailable", tried: chosen };
}

import type { AgentModelRef } from "./ConversationStore.js";
import type { ProviderKind } from "./types.js";

// The models an agent (or preset worker) runs on, and how the spawn path picks
// one of them. Two arrangements exist and the difference is the whole module:
//
//   - INHERIT — the entity names no model of its own. It rides whatever the
//     caller is running, unless the caller asks for a specific model when it
//     hands over the work.
//   - ASSIGNED — the entity names an ordered chain: a primary, then each
//     fallback in the order it should be tried. The first candidate that can
//     run right now wins, and everything after it stays on the table as the
//     runtime's failover list if the chosen one 429s mid-turn.
//
// Kept pure so the spawn path can hand it a snapshot of what is available and
// get a decision back with nothing to mock.

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

/** One rung of a fallback chain as the runtime carries it: a provider, and
 *  optionally the model within it. A rung with no model means "this provider,
 *  whatever it picks" — the shape the turn dispatcher already fails over to. */
export type ModelCandidate = { provider: ProviderKind; model?: string };

/**
 * How an entity's models are arranged, derived from its stored fields rather
 * than stored as a flag of its own. Deriving it is deliberate: a stored
 * `mode: "assigned"` next to an empty chain would be a state with two readings,
 * and nothing would stop the two drifting apart. A chain with entries IS the
 * assignment; no chain IS inheritance.
 */
export type ModelAssignment =
  | { mode: "inherit" }
  | { mode: "assigned"; primary: AgentModelRef; fallbacks: readonly AgentModelRef[] };

/** Read an entity's stored primary + fallbacks as an assignment. A null primary
 *  is inheritance whatever the fallback column says — a chain with no head has
 *  no primary to fall back FROM, so the tail is ignored rather than silently
 *  promoted. */
export function modelAssignmentOf(
  primary: AgentModelRef | null | undefined,
  fallbacks: readonly AgentModelRef[] | null | undefined,
): ModelAssignment {
  if (!primary) return { mode: "inherit" };
  return { mode: "assigned", primary, fallbacks: fallbacks ?? [] };
}

/** The whole chain, primary first, as one ordered list — the form the resolver
 *  and the runtime's failover list both want. Empty for an inheriting entity. */
export function modelChainOf(
  primary: AgentModelRef | null | undefined,
  fallbacks: readonly AgentModelRef[] | null | undefined,
): readonly AgentModelRef[] {
  const assignment = modelAssignmentOf(primary, fallbacks);
  return assignment.mode === "inherit" ? [] : [assignment.primary, ...assignment.fallbacks];
}

/**
 * The outcome of checking an entity's chosen models against what's available.
 *
 *  - `resolved` — a candidate can run right now; use it. `remaining` is what
 *    sits below it in the chain, untried and still viable, so the caller can
 *    hand it to the runtime as the failover list for a mid-turn 429.
 *  - `no-preference` — no model was named. Not a failure: the caller should
 *    fall back to its own model, exactly as a spawn with no model named does.
 *  - `unavailable` — models were named and none can run right now (provider
 *    down, not in the catalogue, or spent). The real failure this guard exists
 *    to surface, kept distinct from the empty case so the caller doesn't treat
 *    "no preference" as an error nor a genuine dead end as "use the default".
 */
export type ModelResolution =
  | { outcome: "resolved"; ref: AgentModelRef; remaining: readonly AgentModelRef[] }
  | { outcome: "no-preference" }
  | { outcome: "unavailable"; tried: readonly AgentModelRef[] };

/** Can this exact provider/model run right now? A candidate with no model named
 *  asks the weaker question — is the provider up with anything left to run —
 *  because the runtime, not the chain, picks the model in that case. */
function isRunnable(
  candidate: { provider: ProviderKind; model?: string },
  availability: readonly ProviderAvailability[],
): boolean {
  const provider = availability.find((entry) => entry.provider === candidate.provider);
  if (!provider?.available) return false;
  if (candidate.model !== undefined) {
    return (
      provider.models.includes(candidate.model) && !provider.exhausted?.includes(candidate.model)
    );
  }
  if (provider.models.length === 0) return true;
  return provider.models.some((model) => !provider.exhausted?.includes(model));
}

/** Walk an ordered chain and take the first candidate that can run, keeping the
 *  untried tail as the failover list. Pure: the same inputs always give the same
 *  answer. An empty chain is `no-preference`, not a dead end — an entity that
 *  names no model is inheriting, not stuck. */
export function resolveAgentModelChain(
  chain: readonly AgentModelRef[],
  availability: readonly ProviderAvailability[],
): ModelResolution {
  if (chain.length === 0) return { outcome: "no-preference" };
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    if (!candidate) continue;
    if (isRunnable(candidate, availability)) {
      return { outcome: "resolved", ref: candidate, remaining: chain.slice(i + 1) };
    }
  }
  return { outcome: "unavailable", tried: chain };
}

/** Check a single chosen model against what's available — the one-rung case of
 *  `resolveAgentModelChain`, kept as its own name because most callers pin one
 *  model and reading `resolveAgentModel(ref, …)` is clearer than a one-element
 *  array. */
export function resolveAgentModel(
  chosen: AgentModelRef | null | undefined,
  availability: readonly ProviderAvailability[],
): ModelResolution {
  return resolveAgentModelChain(chosen ? [chosen] : [], availability);
}

export type FallbackResolution =
  | { outcome: "resolved"; ref: ModelCandidate; remaining: readonly ModelCandidate[] }
  | { outcome: "unavailable"; tried: readonly ModelCandidate[] };

/**
 * Walk candidate providers/models in order (primary first, then fallbacks)
 * until the first available candidate is found. The looser sibling of
 * `resolveAgentModelChain`: its rungs may name a provider without a model,
 * which is how the turn dispatcher's own failover list is written.
 */
export function resolveModelWithFallback(
  primary: ModelCandidate,
  fallbacks: readonly ModelCandidate[],
  available: readonly ProviderAvailability[],
): FallbackResolution {
  const candidates = [primary, ...fallbacks];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    if (isRunnable(candidate, available)) {
      return { outcome: "resolved", ref: candidate, remaining: candidates.slice(i + 1) };
    }
  }
  return { outcome: "unavailable", tried: candidates };
}

// ── choosing the model a dispatched child runs on ───────────────────────────

/** Where the child's model came from, reported back so the dispatching agent
 *  knows whether its worker ran where it was told to.
 *   - `requested` — the caller named a model when it handed over the work, and
 *     that beats both the entity's own assignment and plain inheritance. The
 *     most specific instruction wins: it is the one the user just gave.
 *   - `assigned` — the entity's own chain supplied it.
 *   - `inherited` — the entity names no model, so the child rides the caller's
 *     own provider and model, exactly as an unspecified spawn does. */
export type ModelSelection = "requested" | "assigned" | "inherited";

export type ModelPlan =
  | {
      ok: true;
      target: ModelCandidate;
      /** What is left of the chain below the chosen model. Handed to the
       *  runtime as the child's failover list, so a 429 mid-turn moves it down
       *  the chain instead of failing the work. Empty for a requested or
       *  inherited model — neither carries a chain of its own. */
      fallbacks: readonly ModelCandidate[];
      selection: ModelSelection;
    }
  | { ok: false; tried: readonly AgentModelRef[] };

/** Decide which model a dispatched child runs on, from the three inputs that
 *  can name one: what the caller asked for, what the entity is assigned, and
 *  what the caller itself is running. Pure. */
export function planSpawnModel(input: {
  /** The model named in the dispatch call itself, if any. */
  requested?: AgentModelRef | null;
  /** The entity's assigned chain, primary first. Empty means it inherits. */
  chain: readonly AgentModelRef[];
  /** The dispatching thread's own provider and model. */
  caller: { provider: ProviderKind; model?: string };
  availability: readonly ProviderAvailability[];
}): ModelPlan {
  if (input.requested) {
    const resolution = resolveAgentModel(input.requested, input.availability);
    if (resolution.outcome !== "resolved") return { ok: false, tried: [input.requested] };
    return {
      ok: true,
      target: { provider: resolution.ref.provider, model: resolution.ref.model },
      fallbacks: [],
      selection: "requested",
    };
  }

  const resolution = resolveAgentModelChain(input.chain, input.availability);
  if (resolution.outcome === "resolved") {
    return {
      ok: true,
      target: { provider: resolution.ref.provider, model: resolution.ref.model },
      fallbacks: resolution.remaining.map((ref) => ({ provider: ref.provider, model: ref.model })),
      selection: "assigned",
    };
  }
  if (resolution.outcome === "unavailable") return { ok: false, tried: resolution.tried };

  const target: ModelCandidate = { provider: input.caller.provider };
  if (input.caller.model) target.model = input.caller.model;
  return { ok: true, target, fallbacks: [], selection: "inherited" };
}

/** Name a chain the way a refusal should read: `provider/model`, in the order
 *  it was tried. */
export function describeChain(chain: readonly AgentModelRef[]): string[] {
  return chain.map((ref) => `${ref.provider}/${ref.model}`);
}

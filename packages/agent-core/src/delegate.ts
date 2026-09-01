// Delegation planning (docs/agent-system-v1.md §4). Delegation is one
// persistent agent asking another persistent agent — a member of the same
// project team — to do a piece of work. The child thread runs AS that agent:
// its identity, its standing instructions, and its model
// preference. This module is the pure step that turns "delegate this task to
// that agent" into the concrete spawn the engine can carry out — who the child
// answers as, which model it runs on, and the brief it wakes up with.
//
// Kept pure and side-effect-free (the same inputs always give the same plan) so
// it is trivial to test and can't touch the store, the providers, or the clock.
// The gateway tool resolves the live inputs; this decides the plan.
//
// Two things it deliberately does NOT do, and why:
//   - It does not prepend the agent's instructions to the task the way a preset
//     spawn does. A delegated child is BOUND to its agent, so the identity
//     channel (gateway/appContext renderAgentIdentity) delivers the name and
//     instructions to the model. Prepending them to the prompt too would hand
//     the agent its own standing orders twice.
//   - It does not resolve a built-in agent's inherited fields. Those live only
//     in the renderer's preset catalogue; the main process sees the stored row
//     as it stands. An agent with no name of its own therefore can't be
//     delegated to — resolveDelegation refuses it rather than dispatching a
//     nameless child, and the tool surfaces that as a clear "no identity" no.

import type { AgentModelRef, AgentRecord } from "./ConversationStore.js";
import {
  modelChainOf,
  planSpawnModel,
  type ModelCandidate,
  type ModelSelection,
  type ProviderAvailability,
} from "./agentModel.js";
import type { AgentPersona, ProviderKind, SpawnTarget } from "./types.js";

/** Where the delegated child's model came from — a signal the tool relays so
 *  the delegating agent knows whether its teammate ran on its own model. See
 *  `ModelSelection` for what each value means. */
export type DelegationSelection = ModelSelection;

export type DelegationPlan =
  | {
      ok: true;
      /** Who the child answers as — set on its session and bound to its thread. */
      persona: AgentPersona;
      /** The provider/model the child spawns on. Effort is left to the engine's
       *  parent-inheritance, exactly as a plain spawn's is. */
      target: SpawnTarget;
      /** What is left of the teammate's chain below the chosen model — the
       *  child's failover list for a mid-turn rate limit. */
      fallbacks: readonly ModelCandidate[];
      /** The child's opening brief: the task alone. The agent's instructions
       *  reach the model through the identity channel, not the prompt. */
      prompt: string;
      selection: DelegationSelection;
    }
  | {
      ok: false;
      /** `no_identity` — the agent has no resolvable name (an uncustomised
       *  built-in, whose text lives only in the renderer); `none_available` —
       *  the model the agent runs on is unavailable right now. */
      code: "no_identity" | "none_available";
      reason: string;
      /** The models tried, in order, for `none_available` — so the tool can
       *  report everything it looked for, not just the primary. */
      tried?: readonly AgentModelRef[];
    };

/** Trim to a real value, or undefined for null/blank — the store keeps a
 *  built-in's inherited fields as null, and "  " is not a name. */
function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Plan a delegation: resolve who the child answers as, which model it runs on,
 *  and the brief it wakes up with — or refuse with a reason the tool can relay.
 *  Pure. */
export function resolveDelegation(input: {
  agent: AgentRecord;
  task: string;
  availability: readonly ProviderAvailability[];
  caller: { provider: ProviderKind; model?: string };
  /** A model named in the delegation call itself — the user asking for this
   *  piece of work to run somewhere specific. Overrides the teammate's own
   *  chain: it is the more recent and more specific instruction. */
  requestedModel?: AgentModelRef | null;
}): DelegationPlan {
  const name = text(input.agent.name);
  if (!name) {
    return {
      ok: false,
      code: "no_identity",
      reason:
        "This agent has no instructions of its own to delegate to yet — customise it (give it a name and a brief) before handing it work.",
    };
  }
  const persona: AgentPersona = { name };
  const instructions = text(input.agent.instructions);
  if (instructions) persona.instructions = instructions;

  // The model the child runs on: what the caller asked for, else the agent's
  // own chain walked down to the first rung that can run, else — for an agent
  // that names none — the delegating agent's own model.
  const plan = planSpawnModel({
    requested: input.requestedModel,
    chain: modelChainOf(input.agent.model, input.agent.modelFallbacks),
    caller: input.caller,
    availability: input.availability,
  });

  const prompt = input.task;

  if (plan.ok) {
    const target: SpawnTarget = { provider: plan.target.provider };
    if (plan.target.model) target.model = plan.target.model;
    return { ok: true, persona, target, fallbacks: plan.fallbacks, prompt, selection: plan.selection };
  }

  return {
    ok: false,
    code: "none_available",
    reason:
      plan.tried.length > 1
        ? `None of ${name}'s models can run right now — every fallback was tried, and the delegation was refused rather than run on a model the agent isn't set up for.`
        : `${name}'s model can't run right now — the delegation was refused rather than run on a model the agent isn't set up for.`,
    tried: plan.tried,
  };
}

import { BUILTIN_SUBAGENT_PRESETS } from "@kone/protocol/subagent-presets";
import type { AgentModelRef, SubagentPresetRecord } from "./ConversationStore.js";
import type { ProviderKind, SpawnTarget } from "./types.js";
import {
  describeChain,
  modelChainOf,
  planSpawnModel,
  type ModelCandidate,
  type ModelSelection,
  type ProviderAvailability,
} from "./agentModel.js";

// §3.4/§3.5 wiring: turning a preset worker plus a piece of work into a
// concrete spawn. Two things have to be resolved — the prompt the child wakes
// up to (the preset's standing instructions in front of the specific task) and
// the model it runs on (the caller's request, else the preset's assigned chain,
// else the caller's own model). Kept pure and apart from the gateway so the
// resolution is unit-testable with plain data: the tool layer feeds it the
// preset, the task, and a snapshot of what's available, and gets back a plan or
// a refusal.

/** The caller's own provider/model, used as the default when a preset states no
 *  model preference — the spawn then runs where the parent runs. */
export type PresetSpawnCaller = { provider: ProviderKind; model?: string };

export type PresetSpawnPlan =
  | {
      ok: true;
      prompt: string;
      target: SpawnTarget;
      /** What is left of the preset's chain below the chosen model — the
       *  child's failover list for a mid-turn rate limit. */
      fallbacks: readonly ModelCandidate[];
      selection: ModelSelection;
    }
  | {
      ok: false;
      reason: string;
      /** The `provider/model` strings that were tried and couldn't run — so the
       *  refusal names exactly what was unavailable, in the order it was tried. */
      tried: readonly string[];
    };

/** The child's opening brief: the preset's standing instructions, then the
 *  specific task under them. Either half may be empty — a preset with no
 *  instructions is just the task, and a spawn with no extra task is just the
 *  standing brief. */
function composePrompt(instructions: string | null, task: string): string {
  const brief = instructions?.trim() ?? "";
  const work = task.trim();
  if (!brief) return work;
  if (!work) return brief;
  return `${brief}\n\nYour task:\n${work}`;
}

/** Plan a spawn from a preset: choose the model and compose the prompt.
 *  Returns a refusal only when a model was actually named — by the caller, or
 *  by the preset's own chain — and none of the named models can run. A preset
 *  with no chain always plans, inheriting the caller's own provider. */
export function planPresetSpawn(
  preset: SubagentPresetRecord,
  task: string,
  availability: readonly ProviderAvailability[],
  caller: PresetSpawnCaller,
  /** A model named in the dispatch call itself — the user asking for this piece
   *  of work to run somewhere specific. Overrides the preset's own chain. */
  requested?: AgentModelRef | null,
): PresetSpawnPlan {
  const prompt = composePrompt(preset.instructions, task);
  const chain = modelChainOf(preset.model, preset.modelFallbacks);
  const plan = planSpawnModel({ requested, chain, caller, availability });

  if (!plan.ok) {
    const tried = describeChain(plan.tried);
    return {
      ok: false,
      reason:
        plan.tried.length > 1
          ? `None of ${preset.name}'s models can run right now — every fallback was tried.`
          : `${preset.name}'s model can't run right now.`,
      tried,
    };
  }

  const target: SpawnTarget = { provider: plan.target.provider };
  if (plan.target.model) target.model = plan.target.model;
  return { ok: true, prompt, target, fallbacks: plan.fallbacks, selection: plan.selection };
}

// ── Built-in Swarm Presets ──────────────────────────────────────────────────

// The shipped presets as full records, projected from the one shared list the
// settings pane seeds from too. They carry no row of their own, so their
// timestamps are zero and their order is the list's order; a stored preset of
// the same name always shadows them.
export const BUILTIN_SWARM_PRESETS: readonly SubagentPresetRecord[] =
  BUILTIN_SUBAGENT_PRESETS.map((preset, index) => ({
    presetId: preset.presetId,
    name: preset.name,
    instructions: preset.instructions,
    model: null,
    modelFallbacks: null,
    sortOrder: index,
    createdAt: 0,
    updatedAt: 0,
  }));

export function findBuiltinPreset(nameOrId: string): SubagentPresetRecord | null {
  const query = nameOrId.trim().toLowerCase();
  for (const p of BUILTIN_SWARM_PRESETS) {
    if (
      p.presetId.toLowerCase() === query ||
      p.name.toLowerCase() === query ||
      p.name.toLowerCase().replace(/\s+/g, "-") === query ||
      p.presetId.toLowerCase().replace("builtin-", "") === query
    ) {
      return p;
    }
  }
  return null;
}

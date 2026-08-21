import type { SubagentPresetRecord } from "./ConversationStore.js";
import type { ProviderKind, SpawnTarget } from "./types.js";
import { resolveAgentModel, type ProviderAvailability } from "./agentModel.js";

// §3.4/§3.5 wiring: turning a preset sub-agent plus a piece of work into a
// concrete spawn. Two things have to be resolved — the prompt the child wakes
// up to (the preset's standing instructions in front of the specific task) and
// the model it runs on (the preset's chosen model, when it can run). Kept pure
// and apart from the gateway so the resolution is unit-testable with plain
// data: the tool layer feeds it the preset, the task, and a snapshot of what's
// available, and gets back a plan or a refusal.

/** The caller's own provider/model, used as the default when a preset states no
 *  model preference — the spawn then runs where the parent runs. */
export type PresetSpawnCaller = { provider: ProviderKind; model?: string };

export type PresetSpawnPlan =
  | {
      ok: true;
      prompt: string;
      target: SpawnTarget;
      /** How the model was chosen — the preset's own model, or the caller's own
       *  when the preset named none. Carried so the tool can tell the agent
       *  whether its teammate ran on the preset's model. */
      selection: "preferred" | "caller-default";
    }
  | {
      ok: false;
      reason: string;
      /** The `provider/model` string that was tried and couldn't run — so the
       *  refusal names exactly what was unavailable. */
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

/** Plan a spawn from a preset: check its chosen model against what's available
 *  and compose the prompt. Returns a refusal only when the preset names a model
 *  and it can't run — a preset with no model always plans, falling back to the
 *  caller's own provider. */
export function planPresetSpawn(
  preset: SubagentPresetRecord,
  task: string,
  availability: readonly ProviderAvailability[],
  caller: PresetSpawnCaller,
): PresetSpawnPlan {
  const prompt = composePrompt(preset.instructions, task);
  const resolution = resolveAgentModel(preset.model, availability);

  if (resolution.outcome === "resolved") {
    return {
      ok: true,
      prompt,
      target: { provider: resolution.ref.provider, model: resolution.ref.model },
      selection: "preferred",
    };
  }

  if (resolution.outcome === "no-preference") {
    return {
      ok: true,
      prompt,
      // No model named: run where the parent runs, leaving the model for the
      // engine's own default when the caller's is unknown.
      target: { provider: caller.provider, model: caller.model },
      selection: "caller-default",
    };
  }

  return {
    ok: false,
    reason: `${preset.name}'s model can't run right now.`,
    tried: [`${resolution.tried.provider}/${resolution.tried.model}`],
  };
}

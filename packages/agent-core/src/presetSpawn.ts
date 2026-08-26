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

// ── Built-in Swarm Presets ──────────────────────────────────────────────────

export const BUILTIN_SWARM_PRESETS: readonly SubagentPresetRecord[] = [
  {
    presetId: "builtin-fast-scout",
    name: "Fast Scout",
    instructions:
      "You are the Fast Scout subagent. Your focus is lightning-fast codebase exploration, repository mapping, symbol discovery, and targeted test execution. " +
      "Do not make speculative code edits. Report findings directly with exact file paths, line numbers, and concrete code evidence to the orchestrator.",
    model: null,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    presetId: "builtin-reviewer",
    name: "Reviewer",
    instructions:
      "You are the Reviewer subagent. Your focus is reviewing changes for architectural soundness, invariant safety, performance regressions, and logic bugs. " +
      "Inspect proposed implementations thoroughly, check error paths, verify edge cases, and deliver concise, actionable verdicts grounded in evidence.",
    model: null,
    sortOrder: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    presetId: "builtin-refactorer",
    name: "Refactorer",
    instructions:
      "You are the Refactorer subagent. Execute assigned code transformations, migrations, and surgical edits with precision. " +
      "Preserve existing conventions, remove obsolete code and dead branches, verify correctness locally, and report your completed diff back to the coordinator.",
    model: null,
    sortOrder: 2,
    createdAt: 0,
    updatedAt: 0,
  },
];

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

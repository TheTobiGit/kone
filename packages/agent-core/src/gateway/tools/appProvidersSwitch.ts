// app_switch_provider — an agent changing the provider/model its own thread
// runs on, for the next turn only.

import type { ProviderAvailability } from "../../agentModel.js";
import type { AgentModelRef } from "../../rosterRecord.js";
import type { TurnSelection } from "../../selection.js";
import type { InteractionMode, ProviderKind, StoredThreadMeta } from "../../types.js";
import {
  SWITCH_PROVIDER_JSON_SCHEMA,
  SwitchProviderInputSchema,
  type GatewayRecord,
  type SwitchProviderInput,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";

/** The narrow store read the clamp needs: the thread's own pick and the model
 *  chain of the agent it is running as, if any. */
export type AppSwitchStore = {
  threadMeta(threadId: string): Pick<StoredThreadMeta, "provider" | "model"> | null;
  getThreadAgent(threadId: string): { agentId: string | null } | null;
  getAgent(agentId: string): { model: AgentModelRef | null; modelFallbacks: AgentModelRef[] | null } | null;
};

/** A partial pick the tool hands the service. Optional fields stay omitted
 *  rather than undefined so the service's read-through (remembered knobs, then
 *  the thread's) is not defeated by an explicit empty value. */
export type AppSwitchSelection = {
  provider?: ProviderKind;
  model?: string;
  effort?: string;
  serviceTier?: string;
  contextWindow?: string;
  mode?: InteractionMode;
};

export type AppSwitchOutcome =
  | { applied: "direct" | "pending"; selection: TurnSelection }
  | { refused: string };

export type AppProviderSwitchControls = {
  switchOwnSelection(threadId: string, selection: AppSwitchSelection): Promise<AppSwitchOutcome>;
};

export interface AppProvidersSwitchToolOptions {
  store: AppSwitchStore;
  /** What providers and models can run now — the same availability the thread
   *  tools use. Absent, availability is not clamped (a test host without one). */
  availability?: () => Promise<readonly ProviderAvailability[]>;
  /** Applies the switch. Absent, the tool refuses rather than reporting a
   *  selection nothing will run on. */
  controls?: AppProviderSwitchControls;
}

function errorResult(text: string): GatewayToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function selectionWords(selection: TurnSelection): string {
  const parts = [`provider \`${selection.provider}\``];
  if (selection.model) parts.push(`model \`${selection.model}\``);
  if (selection.effort) parts.push(`effort \`${selection.effort}\``);
  if (selection.serviceTier) parts.push(`service tier \`${selection.serviceTier}\``);
  if (selection.contextWindow) parts.push(`context window \`${selection.contextWindow}\``);
  if (selection.mode) parts.push(`mode \`${selection.mode}\``);
  return parts.join(", ");
}

/** The agent's pinned model chain for this thread, or empty when it runs
 *  unpinned (a guest, or an agent with no model of its own). */
function pinnedChain(store: AppSwitchStore, threadId: string): readonly AgentModelRef[] {
  const binding = store.getThreadAgent(threadId);
  if (!binding?.agentId) return [];
  const agent = store.getAgent(binding.agentId);
  if (!agent?.model) return [];
  return [agent.model, ...(agent.modelFallbacks ?? [])];
}

/** Whether a requested provider+model is one the chain allows. A rung with no
 *  model allows any model on its provider; a request with no model allows any
 *  model on the rung's provider. */
function chainAllows(chain: readonly AgentModelRef[], provider: ProviderKind, model: string | undefined): boolean {
  return chain.some(
    (ref) => ref.provider === provider && (!model || !ref.model || ref.model === model),
  );
}

export function createAppProviderSwitchTools(options: AppProvidersSwitchToolOptions): ToolEntry[] {
  const handler = async (ctx: GatewayToolContext, rawInput: GatewayRecord): Promise<GatewayToolResult> => {
    const parsed = SwitchProviderInputSchema.safeParse(rawInput);
    if (!parsed.success) return errorResult(`Invalid input: ${parsed.error.message}`);
    const request: SwitchProviderInput = parsed.data;
    if (!options.controls) {
      return errorResult("Cannot switch providers in this environment (dispatcher hook not wired).");
    }
    const meta = options.store.threadMeta(ctx.threadId);
    if (!meta) return errorResult(`Thread not found: ${ctx.threadId}`);

    // (a) The pin: an agent pinned to a model runs only on that model or its
    // fallbacks. Resolve the full provider AND model first, then clamp the
    // resolved pair against the chain, so a provider-only request can never
    // settle on a provider default (or a stale current model) outside it.
    const chain = pinnedChain(options.store, ctx.threadId);
    let targetProvider = request.provider ?? (chain[0]?.provider ?? meta.provider);
    let targetModel = request.model;
    if (chain.length > 0) {
      if (!targetModel) {
        const rungs = chain.filter((ref) => ref.provider === targetProvider);
        if (rungs.length === 1) {
          targetModel = rungs[0]?.model;
        } else if (rungs.length > 1) {
          const names = rungs.map((ref) => ref.model ?? "the provider default").join(", ");
          return errorResult(
            `This agent is pinned to several models on \`${targetProvider}\` (${names}). Name the model you want to switch to.`,
          );
        }
      }
      if (!chainAllows(chain, targetProvider, targetModel)) {
        const names = chain.map((ref) => `${ref.provider}${ref.model ? `/${ref.model}` : ""}`).join(", ");
        return errorResult(
          `This agent is pinned to ${names}. A self-switch outside that pin and its fallbacks is refused; the user can change the pin or the thread's model directly.`,
        );
      }
    }

    // (b) Availability: never switch to what the install cannot reach. Only a
    // provider the app has probed and found unusable refuses; an unknown one
    // does not.
    if (options.availability) {
      const rows = await options.availability();
      const row = rows.find((entry) => entry.provider === targetProvider);
      if (row) {
        if (!row.available) {
          return errorResult(`\`${targetProvider}\` is not available right now, so the switch was refused.`);
        }
        if (targetModel && row.models.length > 0 && !row.models.includes(targetModel)) {
          return errorResult(
            `\`${targetModel}\` is not in \`${targetProvider}\`'s available models, so the switch was refused.`,
          );
        }
      }
    }

    // (c) The no-op rule: naming nothing, or the selection the thread is
    // already on with no knob change, is refused rather than reported as
    // applied.
    const noKnobs =
      request.effort === undefined &&
      request.serviceTier === undefined &&
      request.contextWindow === undefined &&
      request.mode === undefined;
    const sameProvider = targetProvider === meta.provider;
    const sameModel = (targetModel ?? meta.model) === meta.model;
    if (sameProvider && sameModel && noKnobs) {
      return errorResult("This thread already runs on that provider and model; nothing changed.");
    }

    const selection: AppSwitchSelection = { provider: targetProvider };
    if (targetModel) selection.model = targetModel;
    if (request.effort !== undefined) selection.effort = request.effort;
    if (request.serviceTier !== undefined) selection.serviceTier = request.serviceTier;
    if (request.contextWindow !== undefined) selection.contextWindow = request.contextWindow;
    if (request.mode !== undefined) selection.mode = request.mode;

    const outcome = await options.controls.switchOwnSelection(ctx.threadId, selection);
    if ("refused" in outcome) return errorResult(outcome.refused);

    const when =
      outcome.applied === "pending"
        ? "It applies once the queue drains and the current turn ends; this turn is untouched."
        : "It applies from this thread's next turn.";
    return {
      content: [
        {
          type: "text",
          text: `Switched this thread to ${selectionWords(outcome.selection)}. ${when}`,
        },
      ],
      structuredContent: { applied: outcome.applied, selection: { ...outcome.selection } },
    };
  };

  return [
    {
      name: "app_switch_provider",
      description:
        "Change which provider and/or model runs this agent's own thread, for the next turn onward. Applies at the next turn only and never interrupts a running turn; clamped to the agent's pinned model and its fallbacks, to what the install can reach, and to a real change.",
      inputSchema: SwitchProviderInputSchema,
      jsonSchema: SWITCH_PROVIDER_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      target: "assistant",
      promptSnippet: "Switch this thread's own provider/model for the next turn (clamped to the agent's pin).",
      promptGuidelines: [
        "Call app_switch_provider only when the user asks you to move this conversation to a different provider or model; it changes where your own future turns run.",
        "It never stops the running turn: a pick made mid-turn applies when that turn ends. A pinned agent can only switch within its pin and fallbacks.",
      ],
      handler,
    },
  ];
}

// Worker- and teammate-dispatching gateway tools (docs/thread-spawning-design.md
// §5.1, §6 Wave 2).
//
// Eight tools that let a running agent dispatch workers and teammates, follow
// them, read the responses they come back with, and post follow-up turns into
// the threads it already opened — each one a kone thread. The
// engine (../../threadSpawn.ts) holds ALL the state — depth/breadth guards,
// lineage, status projection, waiting — this module is the thin boundary:
// validate, resolve the engine, call it, shape the result, map its errors. The
// store is injected structurally so unit tests can fake it; the real
// ConversationStore satisfies it.
//
// The three read tools are deliberately turn-less, and that is load-bearing:
// gateway write authority retires at `turn.completed`, so if reads required a
// live turn an orchestrator could never check on the workers it dispatched in
// an earlier turn — the single most important thing it does. Only the dispatch
// itself, which creates state, is bound to a running turn (the registry
// refuses it without one, before this handler runs).
//
// The engine is resolved LAZILY inside each handler (getSpawnEngine), never at
// module load, so import order between this module and the engine can never
// matter. SpawnError is the engine's refusal vocabulary — its codes are the
// gateway's GatewayErrorCode values by construction, so they pass straight
// through; anything else falls through to the registry's internal handling.

import { getSpawnEngine, SpawnError } from "../../threadSpawn.js";
import type {
  SpawnCaller,
  SpawnEngine,
  SpawnRequest,
  SpawnTargetsReport,
} from "../../threadSpawn.js";
import type {
  InteractionMode,
  ProviderKind,
  SpawnedThread,
  SpawnTarget,
  SpawnThreadResult,
  StoredBlock,
  StoredThread,
} from "../../types.js";
import type { AgentModelRef, AgentRecord, SubagentPresetRecord } from "../../ConversationStore.js";
import { BUILTIN_SWARM_PRESETS, findBuiltinPreset, planPresetSpawn } from "../../presetSpawn.js";
import { resolveDelegation } from "../../delegate.js";
import type { ModelCandidate, ProviderAvailability } from "../../agentModel.js";
import type {
  GatewayRecord,
  GatewayToolContext,
  GatewayToolResult,
  GatewayValue,
  ToolEntry,
} from "../schemas.js";
import {
  ContinueThreadInputSchema,
  CONTINUE_THREAD_JSON_SCHEMA,
  DelegateToTeammateInputSchema,
  DELEGATE_TO_TEAMMATE_JSON_SCHEMA,
  GatewayToolError,
  ReadResponseInputSchema,
  READ_RESPONSE_JSON_SCHEMA,
  SpawnWorkerPresetInputSchema,
  SPAWN_WORKER_PRESET_JSON_SCHEMA,
  SPAWN_WORKER_JSON_SCHEMA,
  SPAWN_TARGETS_JSON_SCHEMA,
  SpawnTargetsInputSchema,
  SpawnWorkerInputSchema,
  SpawnBatchInputSchema,
  SPAWN_BATCH_JSON_SCHEMA,
  WaitForResponsesInputSchema,
  WAIT_FOR_RESPONSES_JSON_SCHEMA,
} from "../schemas.js";
import { gatewayToolErrorResult } from "../registry.js";

/** The store surface the spawn tools need — structural, so unit tests can
 *  substitute an in-memory fake. The real ConversationStore satisfies it. */
export interface SpawnToolStore {
  loadThread(threadId: string): StoredThread | null;
  /** Every preset sub-agent, so a spawn can be cut from one by name. */
  listSubagentPresets(): SubagentPresetRecord[];
  /** One preset by id — tried before the name scan, since an id is exact. */
  getSubagentPreset(presetId: string): SubagentPresetRecord | null;
  /** The project's team — the agents this project can delegate to, in roster
   *  order. Delegation resolves its target from this list ONLY, so an agent the
   *  user hasn't put on the team can't be handed work. */
  listProjectAgents(projectPath: string): AgentRecord[];
}

export interface SpawnToolInput {
  store: SpawnToolStore;
}

/** The engine, or the gateway-equivalent internal error when it is not running
 *  in this session. */
function requiredEngine(): SpawnEngine {
  const engine = getSpawnEngine();
  if (!engine) {
    throw new GatewayToolError("internal", "kone's thread engine is not running in this session.");
  }
  return engine;
}

/** Build the engine's caller identity from the gateway's bound authority
 *  context ONLY — never from agent-supplied arguments, so a child's parentage
 *  cannot be forged (design property 1). Read tools run turn-less; their
 *  callers get an empty turn id, which nothing the engine does with the caller
 *  cares about without a live turn. */
function callerOf(ctx: GatewayToolContext): SpawnCaller {
  return {
    threadId: ctx.threadId,
    turnId: ctx.turnId ?? "",
    provider: ctx.provider,
    model: ctx.model,
    cwd: ctx.cwd,
  };
}

/** Map an engine refusal onto the gateway's error vocabulary — the code
 *  strings are identical by construction, so they cross unchanged. Anything
 *  that is not a SpawnError is rethrown for the registry's internal handling. */
function mapSpawnError(cause: unknown): GatewayToolError {
  if (cause instanceof SpawnError) {
    // SAFETY: engine refusals carry plain-JSON detail bags that are embedded
    // verbatim into the tool result without further interpretation.
    return new GatewayToolError(cause.code, cause.message, cause.details as GatewayValue);
  }
  throw cause;
}

/** Find a preset by the agent's reference: an exact id first, then a
 *  case-insensitive name match. Names aren't unique, so the name path takes the
 *  first in roster order — the same one at the top of the user's list. */
function findPreset(store: SpawnToolStore, ref: string): SubagentPresetRecord | null {
  const byId = store.getSubagentPreset(ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const fromStore = store.listSubagentPresets().find((p) => p.name.trim().toLowerCase() === wanted);
  if (fromStore) return fromStore;
  return findBuiltinPreset(ref);
}

/** Find a delegation target in the caller's OWN project team: an exact agent id
 *  first, then a case-insensitive name match, both scanned over
 *  `listProjectAgents(cwd)` only. Scoping to the team is the whole gate — an
 *  agent the user hasn't put on this project's team is not a name the delegating
 *  agent can reach, so it reads exactly like a nonexistent one. Names aren't
 *  unique, so the name path takes the first in team order. */
function findTeamAgent(store: SpawnToolStore, cwd: string, ref: string): AgentRecord | null {
  const team = store.listProjectAgents(cwd);
  const byId = team.find((a) => a.agentId === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  return team.find((a) => (a.name ?? "").trim().toLowerCase() === wanted) ?? null;
}

/** A one-line gist of a prose field for the discovery report — collapsed onto
 *  a single line and capped, or undefined when there is nothing to show. Lets an
 *  agent choose between presets and teammates without pulling each one's full
 *  instructions into the turn. */
function gist(text: string | null | undefined, max = 140): string | undefined {
  if (!text) return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The preset sub-agents an agent can invoke, shaped for the targets report and
 *  kept in the user's saved order — the same order `findPreset` resolves a name
 *  against, so the first of a duplicated name is the one named here too. */
function presetTargets(store: SpawnToolStore): NonNullable<SpawnTargetsReport["presets"]> {
  const storePresets = store.listSubagentPresets();
  const seenNames = new Set(storePresets.map((p) => p.name.trim().toLowerCase()));
  const all = [...storePresets];

  for (const builtin of BUILTIN_SWARM_PRESETS) {
    if (!seenNames.has(builtin.name.trim().toLowerCase())) {
      all.push(builtin);
    }
  }

  return all.map((preset) => {
    const entry: NonNullable<SpawnTargetsReport["presets"]>[number] = {
      name: preset.name,
    };
    if (preset.model) entry.model = { provider: preset.model.provider, model: preset.model.model };
    const summary = gist(preset.instructions);
    if (summary) entry.summary = summary;
    return entry;
  });
}

/** The teammates an agent can delegate to on its own project's roster, shaped
 *  for the report and in roster order. A nameless agent drops out:
 *  `kone_delegate_to_teammate` resolves by name, so listing one with no name
 *  would only offer a target the agent could never actually reach. */
function teammateTargets(
  store: SpawnToolStore,
  cwd: string,
): NonNullable<SpawnTargetsReport["teammates"]> {
  const out: NonNullable<SpawnTargetsReport["teammates"]> = [];
  for (const agent of store.listProjectAgents(cwd)) {
    const name = (agent.name ?? "").trim();
    if (!name) continue;
    const entry: NonNullable<SpawnTargetsReport["teammates"]>[number] = {
      id: agent.agentId,
      name,
    };
    const role = (agent.role ?? "").trim();
    if (role) entry.role = role;
    const summary = gist(agent.instructions);
    if (summary) entry.summary = summary;
    out.push(entry);
  }
  return out;
}

/** Flatten the engine's spawn-targets report into the snapshot the model
 *  resolver reads: one entry per installed provider with its live model ids.
 *  The report carries no per-model usage signal, so nothing is marked
 *  exhausted — an unreachable model is one its provider stopped offering. */
function availabilityFromReport(
  providers: SpawnTargetsReport["providers"],
): ProviderAvailability[] {
  return providers.map((p) => ({
    provider: p.provider,
    available: p.available,
    models: p.models.map((m) => m.id),
  }));
}

/** Fill a spawn target from the caller when the agent named no model of its
 *  own. A named provider without a model still inherits the caller's model
 *  when it is the same provider — a foreign provider without a model keeps
 *  that provider's own default, because the caller's model id is not a model
 *  on a different CLI. */
function inheritSpawnTarget(
  caller: SpawnCaller,
  requested?: { provider: ProviderKind; model?: string; effort?: string },
): SpawnTarget {
  if (!requested) {
    const target: SpawnTarget = { provider: caller.provider };
    if (caller.model) target.model = caller.model;
    return target;
  }
  const target: SpawnTarget = { provider: requested.provider };
  if (requested.model) target.model = requested.model;
  else if (caller.model && requested.provider === caller.provider) target.model = caller.model;
  if (requested.effort) target.effort = requested.effort;
  return target;
}

/** Attach a plan's remaining chain only when there is one — an empty list is
 *  the inherit/requested case, and sending it would make the engine walk a
 *  chain that was never assigned. */
function withPlanFallbacks(
  request: SpawnRequest,
  fallbacks: readonly ModelCandidate[],
): SpawnRequest {
  if (fallbacks.length === 0) return request;
  return { ...request, fallbacks };
}

/** A note about the model the child actually ended up on, when it is not the
 *  one it was planned for — the engine walked the fallback chain because the
 *  first choice was rate limited or out of quota. Empty when nothing moved, so
 *  the ordinary spawn line stays as short as it always was. An agent that reads
 *  only `content` would otherwise never learn its worker changed model. */
function failoverNote(result: SpawnThreadResult): string {
  const from = result.failedOverFrom;
  if (!from) return "";
  const named = `${from.provider}${from.model ? `/${from.model}` : ""}`;
  return ` Fell back from ${named}, which could not take the work: ${from.reason}`;
}

const TRUNCATION_MARKER = "\n…[truncated]";

/** Truncate a message's text to `maxChars`, appending a visible marker so the
 *  reader knows the tail was cut rather than the model stopping mid-sentence. */
function truncateTo(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return `${text.slice(0, budget).trimEnd()}${TRUNCATION_MARKER}`;
}

/** A block's model-readable narrative: the prompt for user blocks, the ordered
 *  assistant_text items for assistant blocks. Tool calls and their payloads are
 *  deliberately excluded — the child's raw tool use stays in its own thread. */
function blockText(block: StoredBlock): string {
  if (block.role === "user") return block.text;
  return block.items
    .filter((item) => item.kind === "assistant_text")
    .map((item) => item.text)
    .join("\n");
}

/** One child's outcome as prose. The summary is the whole point of the wait —
 *  a caller that only reads `content` (structuredContent is advisory, and a
 *  client is free to ignore it) would otherwise collect a receipt saying the
 *  child replied and never learn what it said. */
function waitThreadText(thread: SpawnedThread): string {
  const took =
    thread.elapsedMs !== undefined ? ` in ${Math.round(thread.elapsedMs / 1000)}s` : "";
  const head = `[${thread.title}] ${thread.status}${took} (${thread.threadId}):`;
  const body = thread.summary?.trim() || thread.detail?.trim();
  if (body) return `${head}\n${body}`;
  return `${head}\n(no reply text — read the full transcript with kone_read_response)`;
}

/** One transcript message as prose, for the same reason. */
function messageText(message: { role: string; text: string }): string {
  return `[${message.role}] ${message.text.trim() || "(no text — tool calls only)"}`;
}

export function createSpawnTools(input: SpawnToolInput): ToolEntry[] {
  const targetsHandler = async (ctx: GatewayToolContext): Promise<GatewayToolResult> => {
    const engine = requiredEngine();
    const caller = callerOf(ctx);
    try {
      const base = await engine.targets(caller);
      // The engine reports providers/models/limits — all it knows. Presets and
      const presets = presetTargets(input.store);
      const report: SpawnTargetsReport = { ...base, presets, teammates: [] };
      const ready = report.providers.filter((p) => p.available).map((p) => p.provider);
      const parts = [
        ready.length > 0
          ? `${ready.length} provider${ready.length === 1 ? "" : "s"} ready (${ready.join(", ")}) with ${report.providers.reduce((n, p) => n + p.models.length, 0)} models across ${report.providers.length} installed provider${report.providers.length === 1 ? "" : "s"}.`
          : "No provider is currently available to spawn on.",
      ];
      if (presets.length > 0) {
        parts.push(
          `${presets.length} preset sub-agent${presets.length === 1 ? "" : "s"} (${presets.map((p) => p.name).join(", ")}) available to kone_spawn_worker_preset.`,
        );
      }
      return { content: [{ type: "text", text: parts.join(" ") }], structuredContent: { report } };
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  const spawnWorkerHandler = async (
    ctx: GatewayToolContext,
    args: {
      prompt: string;
      requestId: string;
      title?: string;
      target?: SpawnTarget;
      mode?: InteractionMode;
    },
  ): Promise<GatewayToolResult> => {
    // The registry already refuses turn-less writes; this guard keeps a direct
    // handler call honest and never lets an empty turn id bind idempotency.
    if (!ctx.turnId) {
      return gatewayToolErrorResult(
        new GatewayToolError("capability_denied", "This tool requires an active agent turn."),
      );
    }
    const engine = requiredEngine();
    const caller = callerOf(ctx);
    const request: SpawnRequest = {
      requestId: args.requestId,
      prompt: args.prompt,
      title: args.title,
      target: inheritSpawnTarget(caller, args.target),
      mode: args.mode,
    };
    try {
      const result = await engine.spawn(caller, request);
      return {
        content: [
          {
            type: "text",
            text: `Spawned "${result.title}" on ${result.provider}${result.model ? `/${result.model}` : ""} as ${result.threadId}.${failoverNote(result)}`,
          },
        ],
        structuredContent: { spawn: result },
      };
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  const spawnWorkerPresetHandler = async (
    ctx: GatewayToolContext,
    args: {
      preset: string;
      task: string;
      requestId: string;
      title?: string;
      mode?: InteractionMode;
      model?: AgentModelRef;
    },
  ): Promise<GatewayToolResult> => {
    if (!ctx.turnId) {
      return gatewayToolErrorResult(
        new GatewayToolError("capability_denied", "This tool requires an active agent turn."),
      );
    }
    const preset = findPreset(input.store, args.preset);
    if (!preset) {
      return gatewayToolErrorResult(
        new GatewayToolError("not_found", `No preset sub-agent "${args.preset}".`),
      );
    }
    const engine = requiredEngine();
    const caller = callerOf(ctx);
    let availability: ProviderAvailability[];
    try {
      const report = await engine.targets(caller);
      availability = availabilityFromReport(report.providers);
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
    // The preset's model preference is walked down to the first that can run;
    // its instructions go in front of the task as the child's opening brief.
    const plan = planPresetSpawn(
      preset,
      args.task,
      availability,
      {
        provider: caller.provider,
        model: caller.model,
      },
      args.model,
    );
    if (!plan.ok) {
      return gatewayToolErrorResult(
        new GatewayToolError("provider_unavailable", plan.reason, { tried: plan.tried }),
      );
    }
    const request = withPlanFallbacks(
      {
        requestId: args.requestId,
        prompt: plan.prompt,
        title: args.title,
        target: plan.target,
        mode: args.mode,
      },
      plan.fallbacks,
    );
    try {
      const result = await engine.spawn(caller, request);
      return {
        content: [
          {
            type: "text",
            text: `Spawned "${result.title}" from preset ${preset.name} on ${result.provider}${result.model ? `/${result.model}` : ""} as ${result.threadId}.${failoverNote(result)}`,
          },
        ],
        structuredContent: { spawn: result, preset: preset.name, selection: plan.selection },
      };
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  const delegateToTeammateHandler = async (
    ctx: GatewayToolContext,
    args: {
      agent: string;
      task: string;
      requestId: string;
      title?: string;
      mode?: InteractionMode;
      model?: AgentModelRef;
    },
  ): Promise<GatewayToolResult> => {
    if (!ctx.turnId) {
      return gatewayToolErrorResult(
        new GatewayToolError("capability_denied", "This tool requires an active agent turn."),
      );
    }
    const caller = callerOf(ctx);
    // Delegation only reaches the caller's OWN project team — an agent the user
    // hasn't put on this project's team is not a teammate to hand work to.
    const agent = findTeamAgent(input.store, caller.cwd, args.agent);
    if (!agent) {
      return gatewayToolErrorResult(
        new GatewayToolError(
          "not_found",
          `No agent "${args.agent}" on this project's team — you can only delegate to a teammate the user has added to this project.`,
        ),
      );
    }
    const engine = requiredEngine();
    let availability: ProviderAvailability[];
    try {
      const report = await engine.targets(caller);
      availability = availabilityFromReport(report.providers);
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
    const plan = resolveDelegation({
      agent,
      task: args.task,
      availability,
      caller: { provider: caller.provider, model: caller.model },
      requestedModel: args.model,
    });
    if (!plan.ok) {
      // A nameless agent is a bad target (invalid_input); an unavailable pinned
      // model is a real dead end (provider_unavailable) — kept distinct so the
      // delegating agent can tell "fix the team" from "try again later".
      const code = plan.code === "no_identity" ? "invalid_input" : "provider_unavailable";
      return gatewayToolErrorResult(
        new GatewayToolError(code, plan.reason, plan.tried ? { tried: plan.tried } : undefined),
      );
    }
    try {
      const result = await engine.spawn(
        caller,
        withPlanFallbacks(
          {
            requestId: args.requestId,
            prompt: plan.prompt,
            title: args.title,
            target: plan.target,
            mode: args.mode,
            delegateToAgentId: agent.agentId,
            persona: plan.persona,
          },
          plan.fallbacks,
        ),
      );
      return {
        content: [
          {
            type: "text",
            text: `Delegated "${result.title}" to ${plan.persona.name} on ${result.provider}${result.model ? `/${result.model}` : ""} as ${result.threadId}.${failoverNote(result)} Collect its response with kone_wait_for_responses.`,
          },
        ],
        structuredContent: {
          delegation: result,
          agent: plan.persona.name,
          selection: plan.selection,
        },
      };
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  const continueThreadHandler = async (
    ctx: GatewayToolContext,
    args: {
      threadId: string;
      message: string;
      requestId?: string;
    },
  ): Promise<GatewayToolResult> => {
    // The registry already refuses turn-less writes; this guard keeps a direct
    // handler call honest and never lets an empty turn id bind idempotency.
    if (!ctx.turnId) {
      return gatewayToolErrorResult(
        new GatewayToolError("capability_denied", "This tool requires an active agent turn."),
      );
    }
    const engine = requiredEngine();
    const caller = callerOf(ctx);
    try {
      const result = await engine.continueThread(caller, {
        threadId: args.threadId,
        message: args.message,
        requestId: args.requestId,
      });
      const resumed = result.resumed
        ? " (its session had settled and was brought back up with its full context)"
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Follow-up sent to ${result.threadId} as turn ${result.turnId}${resumed}. Collect the response with kone_wait_for_responses, passing threadIds ["${result.threadId}"] and turnIds ["${result.turnId}"] to pin it to this turn.`,
          },
        ],
        structuredContent: { continuation: result },
      };
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };
  const spawnBatchHandler = async (
    ctx: GatewayToolContext,
    args: {
      items: Array<{
        requestId: string;
        prompt: string;
        title?: string;
        target?: { provider: ProviderKind; model?: string; effort?: string };
        preset?: string;
        agent?: string;
        mode?: InteractionMode;
        model?: AgentModelRef;
      }>;
    },
  ): Promise<GatewayToolResult> => {
    if (!ctx.turnId) {
      return gatewayToolErrorResult(
        new GatewayToolError("capability_denied", "This tool requires an active agent turn."),
      );
    }
    const engine = requiredEngine();
    const caller = callerOf(ctx);

    let availability: ProviderAvailability[] | null = null;
    const getAvailability = async (): Promise<ProviderAvailability[]> => {
      if (availability) return availability;
      const report = await engine.targets(caller);
      availability = availabilityFromReport(report.providers);
      return availability;
    };

    const spawnPromises = args.items.map(async (item, index) => {
      try {
        if (item.agent) {
          const agent = findTeamAgent(input.store, caller.cwd, item.agent);
          if (!agent) {
            return {
              index,
              ok: false,
              error: `No agent "${item.agent}" on this project's team.`,
            };
          }
          const avail = await getAvailability();
          const plan = resolveDelegation({
            agent,
            task: item.prompt,
            availability: avail,
            caller: { provider: caller.provider, model: caller.model },
            requestedModel: item.model,
          });
          if (!plan.ok) {
            return { index, ok: false, error: plan.reason };
          }
          const result = await engine.spawn(
            caller,
            withPlanFallbacks(
              {
                requestId: item.requestId,
                prompt: plan.prompt,
                title: item.title,
                target: plan.target,
                mode: item.mode,
                delegateToAgentId: agent.agentId,
                persona: plan.persona,
              },
              plan.fallbacks,
            ),
          );
          return {
            index,
            ok: true,
            threadId: result.threadId,
            title: result.title,
            provider: result.provider,
            model: result.model,
            agent: plan.persona.name,
            kind: "delegation" as const,
          };
        } else if (item.preset) {
          const preset = findPreset(input.store, item.preset);
          if (!preset) {
            return {
              index,
              ok: false,
              error: `No preset sub-agent "${item.preset}".`,
            };
          }
          const avail = await getAvailability();
          const plan = planPresetSpawn(
            preset,
            item.prompt,
            avail,
            {
              provider: caller.provider,
              model: caller.model,
            },
            item.model,
          );
          if (!plan.ok) {
            return { index, ok: false, error: plan.reason };
          }
          const result = await engine.spawn(
            caller,
            withPlanFallbacks(
              {
                requestId: item.requestId,
                prompt: plan.prompt,
                title: item.title,
                target: plan.target,
                mode: item.mode,
              },
              plan.fallbacks,
            ),
          );
          return {
            index,
            ok: true,
            threadId: result.threadId,
            title: result.title,
            provider: result.provider,
            model: result.model,
            preset: preset.name,
            kind: "preset" as const,
          };
        } else if (item.target) {
          const result = await engine.spawn(caller, {
            requestId: item.requestId,
            prompt: item.prompt,
            title: item.title,
            target: inheritSpawnTarget(caller, item.target),
            mode: item.mode,
          });
          return {
            index,
            ok: true,
            threadId: result.threadId,
            title: result.title,
            provider: result.provider,
            model: result.model,
            kind: "spawn" as const,
          };
        } else {
          const result = await engine.spawn(caller, {
            requestId: item.requestId,
            prompt: item.prompt,
            title: item.title,
            target: inheritSpawnTarget(caller),
            mode: item.mode,
          });
          return {
            index,
            ok: true,
            threadId: result.threadId,
            title: result.title,
            provider: result.provider,
            model: result.model,
            kind: "spawn" as const,
          };
        }
      } catch (error) {
        const mapped = mapSpawnError(error);
        return { index, ok: false, error: mapped.message };
      }
    });

    const results = await Promise.all(spawnPromises);
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    const summaryParts: string[] = [];
    if (succeeded.length > 0) {
      summaryParts.push(
        `Spawned ${succeeded.length} thread${succeeded.length === 1 ? "" : "s"}: ${succeeded
          .map((s) => `"${s.title}" (${s.threadId})`)
          .join(", ")}.`,
      );
    }
    if (failed.length > 0) {
      const errList = failed
        .map((f) => `item ${f.index}: ${f.error?.endsWith(".") ? f.error.slice(0, -1) : f.error}`)
        .join("; ");
      summaryParts.push(`${failed.length} spawn failed: ${errList}.`);
    }

    return {
      content: [{ type: "text", text: summaryParts.join(" ") }],
      isError: succeeded.length === 0 && failed.length > 0,
      structuredContent: {
        batch: {
          total: args.items.length,
          succeeded: succeeded.length,
          failed: failed.length,
          threads: results.map((r) => {
            const entry: GatewayRecord = {
              index: r.index,
              ok: r.ok,
            };
            if (r.threadId !== undefined) entry.threadId = r.threadId;
            if (r.title !== undefined) entry.title = r.title;
            if (r.provider !== undefined) entry.provider = r.provider;
            if (r.model !== undefined) entry.model = r.model;
            if (r.agent !== undefined) entry.agent = r.agent;
            if (r.preset !== undefined) entry.preset = r.preset;
            if (r.kind !== undefined) entry.kind = r.kind;
            if (r.error !== undefined) entry.error = r.error;
            return entry;
          }),
        },
      },
    };
  };


  const waitForResponsesHandler = async (
    ctx: GatewayToolContext,
    args: { threadIds: string[]; turnIds?: string[]; timeoutMs?: number },
  ): Promise<GatewayToolResult> => {
    const engine = requiredEngine();
    try {
      const outcome = await engine.waitFor({
        threadIds: args.threadIds,
        turnIds: args.turnIds,
        timeoutMs: args.timeoutMs,
        scopeThreadId: ctx.threadId,
        signal: ctx.signal,
      });
      const running = outcome.threads.filter((t) => !t.terminal).length;
      const parked = outcome.threads.filter(
        (t) => t.status === "waiting-for-approval" || t.status === "waiting-for-user-input",
      ).length;
      const count = outcome.threads.length;
      const headline = outcome.allTerminal
        ? `All ${count} thread${count === 1 ? "" : "s"} settled.`
        : outcome.timedOut
          ? `Timed out with ${running} thread${running === 1 ? "" : "s"} still running — call again to keep waiting.`
          : parked > 0
            ? `${parked} thread${parked === 1 ? "" : "s"} parked on a human response — get the user's answer, then wait again.`
            : `${count} thread${count === 1 ? "" : "s"} reported; ${running} still running.`;
      const text = [headline, ...outcome.threads.map(waitThreadText)].join("\n\n");
      return { content: [{ type: "text", text }], structuredContent: outcome };
    } catch (error) {
      // An aborted wait is the caller cancelling — the transport turns it into
      // a 202 with no body. Mapping it to a tool error would report a failure
      // to a client that already gave up on the call.
      if (error instanceof Error && error.name === "AbortError") throw error;
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  const readResponseHandler = async (
    ctx: GatewayToolContext,
    args: { threadId: string; limit?: number; maxTextChars?: number },
  ): Promise<GatewayToolResult> => {
    const engine = requiredEngine();
    // Scoped to the caller's subtree, and the same answer a nonexistent thread
    // gets — the tool never confirms the existence of a thread the caller may
    // not read.
    if (!engine.isInSubtree(ctx.threadId, args.threadId)) {
      return gatewayToolErrorResult(
        new GatewayToolError("not_found", `No readable thread "${args.threadId}".`),
      );
    }
    const thread = input.store.loadThread(args.threadId);
    if (!thread) {
      return gatewayToolErrorResult(
        new GatewayToolError("not_found", `No readable thread "${args.threadId}".`),
      );
    }
    const limit = args.limit ?? 20;
    const maxTextChars = args.maxTextChars ?? 1500;
    const messages = thread.blocks.slice(-limit).map((block) => ({
      role: block.role,
      text: truncateTo(blockText(block), maxTextChars),
    }));
    const heading =
      messages.length === 0
        ? `"${thread.title ?? args.threadId}" has no messages yet.`
        : `Read ${messages.length} message${messages.length === 1 ? "" : "s"} from "${thread.title ?? args.threadId}", oldest first:`;
    return {
      content: [
        {
          type: "text",
          text: [heading, ...messages.map(messageText)].join("\n\n"),
        },
      ],
      structuredContent: {
        thread: {
          threadId: thread.threadId,
          title: thread.title ?? null,
          provider: thread.provider,
          model: thread.model ?? null,
        },
        messages,
      },
    };
  };


  return [
    {
      name: "kone_spawn_targets",
      description:
        "List the providers/models and preset specialist subagents you can spawn right now. Providers: the installed providers and their real model ids, which is what kone_spawn_worker names when you pick a model yourself. Presets: the saved subagent templates you can start a specialist worker from by name with kone_spawn_worker_preset, each with a one-line gist of what it is for and its preferred models. Call this before you spawn when you are not certain what is available. The report also tells you which model you are yourself running on, how many more workers you may open, and how deep in the spawn tree you already are.",
      inputSchema: SpawnTargetsInputSchema,
      jsonSchema: SPAWN_TARGETS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "List the providers and models, and the preset specialist templates you can start a worker from right now.",
      handler: targetsHandler,
    },
    {
      name: "kone_spawn_worker",
      description:
        "Spawn a worker: open a new kone thread and set an agent working in it on a task you write. This is not a nested subagent inside your turn — it is a second, first-class conversation that appears in the user's sidebar, persists, and keeps running after your turn ends. Use it to hand a self-contained unit of work to another model, or to fan several independent units out at once, when doing the work inline would crowd out your own context. Write prompt as a complete standing brief: the worker wakes up with no memory of this conversation and cannot ask you anything, so state the goal, the paths involved, the constraints, and what done looks like. Omit target to run the worker on your own provider and model (and reasoning effort). Pass target.provider and target.model only when you mean a different one — a cheap fast model for mechanical work, a stronger one for work that needs judgement; call kone_spawn_targets if you need the real list. mode is what the worker may do without stopping to ask, and it can never exceed yours — request a wider one and the spawn is refused rather than quietly downgraded. Leave it unset to inherit yours. Choose it by what the worker needs to finish unattended, because nobody is sitting in its thread: a worker that stops for permission stays stopped until the user notices. full-access lets it edit files and run commands on its own. accept-edits lets it edit, but it will park the first time it needs to run a command. ask parks on nearly everything, so use it only for a worker that reads and reports. If the work needs more than your own thread is allowed, say so and let the user raise your mode — do not spawn a worker that cannot finish. Pass a stable requestId so a retry after a network hiccup returns the same worker instead of opening a second one. This returns as soon as the worker starts, not when it finishes — collect its response with kone_wait_for_responses; the result also carries the worker's first turn id, pass it back as turnIds to pin the wait to the turn you actually spawned. When you need to ask this worker something again later, continue its existing thread with kone_continue_thread — spawning again would open a second worker with no memory of the first.",
      inputSchema: SpawnWorkerInputSchema,
      jsonSchema: SPAWN_WORKER_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Spawn a worker on any installed provider — a second conversation the user watches in the sidebar, not a nested subagent inside your turn.",
      promptGuidelines: [
        "Reach for a worker when a piece of work is self-contained and large enough that doing it inline would crowd out your context, or when several independent pieces can run at once.",
        "A worker's mode can never exceed yours, and asking for a wider one refuses the spawn rather than quietly downgrading it. Nobody sits in a worker's thread: a worker that stops for permission stays stopped until the user notices. If the work needs more than your own thread is allowed, ask the user to raise your mode instead of spawning a worker that cannot finish.",
        "Spawned work is the user's work too — they see these threads run. Give every worker a brief you would be willing to have read back to you, and keep the number of workers proportionate to the task.",
      ],
      handler: spawnWorkerHandler,
    },
    {
      name: "kone_spawn_worker_preset",
      description:
        "Spawn a specialist worker from a preset — a reusable subagent template the user has saved, carrying its own standing instructions and a model chain (or none). Give the preset by name (e.g. \"Explorer\", \"Code Reviewer\") and a task describing the specific work; kone lays the task under the preset's instructions to form the worker's opening brief, so write task as a complete standing ask the way you would prompt for kone_spawn_worker — the worker cannot ask you anything. You do not choose a model by default: kone runs the preset's assigned chain when it names one (falling to the next on a 429 or spent quota), or the worker runs on your own provider and model when it names none. Pass model only when the user asked for this piece of work to run somewhere specific — that override beats the preset's chain. If every named model can't run it refuses rather than substituting one you didn't ask for. mode works exactly as in kone_spawn_worker — clamped to yours, chosen for what the worker needs to finish unattended. Use this when the work matches a preset the user has set up, and kone_spawn_worker when you need to pick the provider and model yourself. Pass a stable requestId so a retry returns the same worker. Returns as soon as the worker starts — collect its response with kone_wait_for_responses. To ask this worker something again later, continue its existing thread with kone_continue_thread.",
      inputSchema: SpawnWorkerPresetInputSchema,
      jsonSchema: SPAWN_WORKER_PRESET_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Spawn a specialist worker from a preset the user has saved, running under the preset's own standing instructions.",
      handler: spawnWorkerPresetHandler,
    },
    {
      name: "kone_spawn_batch",
      description:
        "Dispatch several workers concurrently in a single tool call. Each item in items is either a direct provider/model worker (target) or a specialist worker from a preset (preset). Use it instead of repeated single calls when the pieces are independent and can run at once. Returns an array of the threads it opened, with threadIds ready for kone_wait_for_responses. Later follow-ups to any of those threads go through kone_continue_thread on the returned threadId.",
      inputSchema: SpawnBatchInputSchema,
      jsonSchema: SPAWN_BATCH_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Dispatch several workers at once in a single call.",
      handler: spawnBatchHandler,
    },
    {
      name: "kone_continue_thread",
      description:
        "Send a follow-up turn to a thread you (or a descendant of yours) already spawned — the second question to a worker — without opening a new thread. This is the only way to add a turn to an existing child: kone_spawn_worker, kone_spawn_worker_preset and kone_spawn_batch always open a NEW thread, so reaching for them to ask a spawned thread something again fragments the work across two conversations. Name the thread with threadId — an id an earlier spawn or batch returned — and write message as a complete, self-contained ask that continues that thread's existing conversation: the child still has everything it did, so reference its prior work instead of restating it. The follow-up runs on the child's own provider and mode; you do not pick either. A child that is mid-turn runs the follow-up right after its current turn; a child that already settled is brought back up with its full context before the follow-up dispatches. Pass a stable requestId so a retry returns the same result instead of running the child twice. Returns the new turn id — collect the response with kone_wait_for_responses, passing threadIds [threadId] and turnIds [that turn id] to pin the wait to this exact turn, and kone_read_response to read the thread's full transcript when the summary is not enough.",
      inputSchema: ContinueThreadInputSchema,
      jsonSchema: CONTINUE_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Post a follow-up turn into a thread you already spawned, continuing that same conversation instead of opening a new one.",
      promptGuidelines: [
        "When the user asks you to ask a worker something again, use kone_continue_thread on the thread you already opened for them — a second spawn is a second stranger, not a follow-up.",
      ],
      handler: continueThreadHandler,
    },
    {
      name: "kone_wait_for_responses",
      description:
        "Wait for the workers you dispatched and collect each one's response. Returns as soon as every named thread has settled, or as soon as any one of them parks on a question or an approval that needs a human — a blocked worker is surfaced immediately rather than silently eating your timeout, because nothing moves until someone answers it. A timeout reports progress and nothing else: it never cancels, retries or re-spawns anything, so calling again simply keeps waiting. Each response carries that thread's final message, capped; its reasoning, tool calls and intermediate output stay in its own thread. Use kone_read_response when the summary is not enough to act on. Pass turnIds (the turn id kone_spawn_worker returned) positionally paired with threadIds to pin the wait to that exact turn — otherwise a newer turn in the thread can swap which response you collect; the result echoes the turnIds it resolved to, so re-pass them to keep waiting on the same turn.",
      inputSchema: WaitForResponsesInputSchema,
      jsonSchema: WAIT_FOR_RESPONSES_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "Collect the responses from the workers you dispatched, and surface any that have parked on a question.",
      promptGuidelines: [
        "Pin a wait to the exact turn you spawned by passing the worker's first turn id as turnIds, so a newer turn in that thread cannot swap which response you collect.",
      ],
      handler: waitForResponsesHandler,
    },
    {
      name: "kone_read_response",
      description:
        "Read the full transcript behind a response — every message in a worker's thread, or one it spawned in turn, in order, newest last. Use it when a response summary is too thin to act on, when the work failed and you need to see where, or when you need the details it worked out rather than its conclusion. Scoped to your own subtree: threads you did not dispatch are not readable, and neither are the user's other conversations.",
      inputSchema: ReadResponseInputSchema,
      jsonSchema: READ_RESPONSE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "Open the full transcript behind a worker response when its summary is not enough.",
      handler: readResponseHandler,
    },
  ];
}

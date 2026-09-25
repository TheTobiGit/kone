// One dispatch, however it was asked for. kone_spawn_worker,
// kone_spawn_worker_preset, kone_delegate_to_teammate and each item of
// kone_spawn_batch all come down to the same steps — resolve what the item
// names into an engine request, open the thread, and record it — so those steps
// live here once and each tool only maps its own arguments onto an item.

import type { SpawnCaller, SpawnEngine, SpawnRequest, SpawnTargetsReport } from "../../threadSpawn.js";
import type {
  InteractionMode,
  ProviderKind,
  SpawnTarget,
  SpawnThreadResult,
  StoredThread,
} from "../../types.js";
import type {
  AgentModelRef,
  AgentRecord,
  NativeSubagentConfig,
  SubagentPresetRecord,
} from "../../ConversationStore.js";
import { spawnWhy, type SpawnRecord } from "@kone/protocol/spawn-record";
import { resolveLegacyPresetId } from "@kone/protocol/subagent-presets";
import { presetNameKey } from "../../rosterRecord.js";
import { planPresetSpawn } from "../../presetSpawn.js";
import { resolveDelegation } from "../../delegate.js";
import type { ModelCandidate, ModelSelection, ProviderAvailability } from "../../agentModel.js";
import { GatewayToolError, type GatewayRecord } from "../schemas.js";

/** The store surface the spawn tools need — structural, so unit tests can
 *  substitute an in-memory fake. The real ConversationStore satisfies it. */
export interface SpawnToolStore {
  loadThread(threadId: string): StoredThread | null;
  /** Every preset sub-agent, so a spawn can be cut from one by name. */
  listSubagentPresets(): SubagentPresetRecord[];
  /** One preset by id — tried before the name scan, since an id is exact. */
  getSubagentPreset(presetId: string): SubagentPresetRecord | null;
  /** The native presets' user config — the enabled flags and pinned model
   *  chains that decide which shipped definitions an agent can reach. */
  listNativeSubagentConfigs(): NativeSubagentConfig[];
  /** Every preset sub-agent an agent can name, stored first: the user's own
   *  rows, then the configured natives no stored row shadows by name. */
  listVisiblePresets(): SubagentPresetRecord[];
  /** The project's team — the agents this project can delegate to, in roster
   *  order. Delegation resolves its target from this list ONLY, so an agent the
   *  user hasn't put on the team can't be handed work. */
  listProjectAgents(projectPath: string): AgentRecord[];
}

/** One thing to dispatch. At most one of preset / agent is set; neither is a
 *  worker the caller briefed itself, on `target` or its own model. */
export type DispatchItem = {
  requestId: string;
  prompt: string;
  title?: string;
  /** For the thread's record only — never handed on to the child. */
  why?: string;
  target?: { provider: ProviderKind; model?: string; effort?: string };
  preset?: string;
  agent?: string;
  mode?: InteractionMode;
  model?: AgentModelRef;
};

/** What an item resolved to — the preset or teammate it named, and the model
 *  selection that placed it. */
export type DispatchMeta =
  | { kind: "spawn" }
  | { kind: "preset"; preset: string; selection: ModelSelection }
  | { kind: "delegation"; agent: string; agentId: string; selection: ModelSelection };

type PreparedDispatch =
  | { ok: true; request: SpawnRequest; meta: DispatchMeta }
  | { ok: false; error: GatewayToolError };

export type Dispatched =
  | { ok: true; result: SpawnThreadResult; meta: DispatchMeta; record: SpawnRecord }
  | { ok: false; error: GatewayToolError };

/** Find a preset by the agent's reference: an exact id first, then a
 *  punctuation-blind name match over everything visible — stored rows first,
 *  so a stored preset shadows a native of the same name. A native the user
 *  turned off reads as absent, exactly as though kone had never shipped it. A
 *  name only an earlier build shipped (Explorer, Code Reviewer) falls through
 *  to the successor native, unless a stored row claims the name. */
function findPreset(store: SpawnToolStore, ref: string): SubagentPresetRecord | null {
  const byId = store.getSubagentPreset(ref);
  if (byId) return byId;
  const wanted = presetNameKey(ref);
  if (!wanted) return null;
  const visible = store.listVisiblePresets();
  const direct =
    visible.find((p) => presetNameKey(p.presetId) === wanted) ??
    visible.find((p) => presetNameKey(p.name) === wanted);
  if (direct) return direct;
  const legacy = resolveLegacyPresetId(ref);
  if (!legacy) return null;
  return visible.find((p) => p.presetId === legacy) ?? null;
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

/** The providers a dispatch can place work on, asked of the engine at most once
 *  per tool call and only when an item needs it — a worker the caller briefed
 *  itself never does. */
export function availabilityOnce(
  engine: SpawnEngine,
  caller: SpawnCaller,
): () => Promise<ProviderAvailability[]> {
  let pending: Promise<ProviderAvailability[]> | null = null;
  return () => {
    pending ??= engine.targets(caller).then((report) => availabilityFromReport(report.providers));
    return pending;
  };
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

async function prepareDispatch(
  store: SpawnToolStore,
  caller: SpawnCaller,
  item: DispatchItem,
  getAvailability: () => Promise<ProviderAvailability[]>,
): Promise<PreparedDispatch> {
  if (item.agent) {
    const agent = findTeamAgent(store, caller.cwd, item.agent);
    if (!agent) {
      return {
        ok: false,
        error: new GatewayToolError("not_found", `No agent "${item.agent}" on this project's team.`),
      };
    }
    const plan = resolveDelegation({
      agent,
      task: item.prompt,
      availability: await getAvailability(),
      caller: { provider: caller.provider, model: caller.model },
      requestedModel: item.model,
    });
    if (!plan.ok) {
      return {
        ok: false,
        error: new GatewayToolError(
          plan.code === "no_identity" ? "invalid_input" : "provider_unavailable",
          plan.reason,
          plan.tried ? { tried: plan.tried } : undefined,
        ),
      };
    }
    return {
      ok: true,
      request: withPlanFallbacks(
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
      meta: {
        kind: "delegation",
        agent: plan.persona.name,
        agentId: agent.agentId,
        selection: plan.selection,
      },
    };
  }

  if (item.preset) {
    const preset = findPreset(store, item.preset);
    if (!preset) {
      return {
        ok: false,
        error: new GatewayToolError("not_found", `No preset sub-agent "${item.preset}".`),
      };
    }
    const plan = planPresetSpawn(
      preset,
      item.prompt,
      await getAvailability(),
      { provider: caller.provider, model: caller.model },
      item.model,
    );
    if (!plan.ok) {
      return {
        ok: false,
        error: new GatewayToolError("provider_unavailable", plan.reason, { tried: plan.tried }),
      };
    }
    return {
      ok: true,
      request: withPlanFallbacks(
        {
          requestId: item.requestId,
          prompt: plan.prompt,
          title: item.title,
          target: plan.target,
          mode: item.mode,
        },
        plan.fallbacks,
      ),
      meta: { kind: "preset", preset: preset.name, selection: plan.selection },
    };
  }

  return {
    ok: true,
    request: {
      requestId: item.requestId,
      prompt: item.prompt,
      title: item.title,
      target: inheritSpawnTarget(caller, item.target),
      mode: item.mode,
    },
    meta: { kind: "spawn" },
  };
}

/** The record a dispatch leaves in the parent's transcript — what the thread
 *  reads back to say, in the reply, who was handed what and why. */
function spawnRecordFor(
  result: SpawnThreadResult,
  meta: DispatchMeta,
  why: string | undefined,
): SpawnRecord {
  const record: SpawnRecord = {
    threadId: result.threadId,
    title: result.title,
    provider: result.provider,
    why: spawnWhy(why),
  };
  if (result.model) record.model = result.model;
  if (meta.kind === "preset") record.preset = meta.preset;
  if (meta.kind === "delegation") {
    record.agent = meta.agent;
    record.agentId = meta.agentId;
  }
  return record;
}

/** Resolve one item and open its thread. A refusal the item earns on its own —
 *  an unknown preset or teammate, no model that can run it — comes back as a
 *  value; an engine refusal throws, for the caller to map. */
export async function dispatchOne(
  store: SpawnToolStore,
  engine: SpawnEngine,
  caller: SpawnCaller,
  item: DispatchItem,
  getAvailability: () => Promise<ProviderAvailability[]>,
): Promise<Dispatched> {
  const prepared = await prepareDispatch(store, caller, item, getAvailability);
  if (!prepared.ok) return prepared;
  const result = await engine.spawn(caller, prepared.request);
  return { ok: true, result, meta: prepared.meta, record: spawnRecordFor(result, prepared.meta, item.why) };
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

/** The sentence the model reads for one dispatch: what opened, from what, where
 *  it runs, and how to collect it. */
export function spawnSentence(result: SpawnThreadResult, meta: DispatchMeta): string {
  const handed =
    meta.kind === "delegation"
      ? `Delegated "${result.title}" to ${meta.agent}`
      : meta.kind === "preset"
        ? `Spawned "${result.title}" from preset ${meta.preset}`
        : `Spawned "${result.title}"`;
  const place = `${result.provider}${result.model ? `/${result.model}` : ""}`;
  return `${handed} on ${place} as ${result.threadId}.${failoverNote(result)} Collect its response with kone_wait_for_responses.`;
}

/** The single tools' structured result: the thread, plus the preset or teammate
 *  it came from and the selection that placed it. A delegation keys its thread
 *  as `delegation` — a teammate is asked, not spawned. */
export function structuredDispatch(result: SpawnThreadResult, meta: DispatchMeta): GatewayRecord {
  switch (meta.kind) {
    case "spawn":
      return { spawn: result };
    case "preset":
      return { spawn: result, preset: meta.preset, selection: meta.selection };
    case "delegation":
      return { delegation: result, agent: meta.agent, selection: meta.selection };
  }
}

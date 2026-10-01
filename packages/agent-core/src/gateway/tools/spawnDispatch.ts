// One dispatch, however it was asked for. worker_start, agent_delegate,
// agent_contract and each item of worker_start_batch all come down to the same
// steps — resolve what the item names into an engine request, open the thread,
// and record it — so those steps live here once and each tool only maps its own
// arguments onto an item.

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
import { lookupModelPreference, type ModelPreference } from "../../modelPreference.js";
import { resolveDelegation } from "../../delegate.js";
import { contractPersona } from "../../contractPersona.js";
import { renderContractBrief, type ContractTerms } from "@kone/protocol/contract";
import {
  planSpawnModel,
  type ModelCandidate,
  type ModelSelection,
  type ProviderAvailability,
} from "../../agentModel.js";
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
  /** The user's model preferences by kind of work — what a spawn that names a
   *  `kind` runs on when nothing more specific places it. */
  listModelPreferences(): ModelPreference[];
}

/** A target an agent named: its effort is a tier or nothing. `null` (the
 *  provider's default) is what dispatch itself may decide, never an agent. */
export type RequestedTarget = { provider: ProviderKind; model?: string; effort?: string };

/** One thing to dispatch. At most one of preset / agent is set; neither is a
 *  worker the caller briefed itself, on `target` or its own model. */
export type DispatchItem = {
  requestId: string;
  prompt: string;
  title?: string;
  /** For the thread's record only — never handed on to the child. */
  why?: string;
  target?: RequestedTarget;
  preset?: string;
  agent?: string;
  /** An agent made up for this job — its identity and the job's terms. */
  contract?: ContractTerms;
  mode?: InteractionMode;
  model?: AgentModelRef;
  /** The kind of work, as the user's model preferences name it. */
  kind?: string;
};

/** What became of a `kind` the item named: `applied` — the thread runs on the
 *  user's model for it; `failed_over` — it was placed there but the model could
 *  not start the work and the thread runs on the caller's; `overridden` — something more specific placed it (a
 *  target, a named model, a preset's or teammate's own chain); `unavailable` —
 *  the kind's model can't run right now; `unknown` — there is no such kind
 *  (one the user never set a model for is no kind at all), and either way the
 *  thread runs on the caller's. */
export type PreferenceNote = {
  kind: string;
  label: string;
  outcome: "applied" | "failed_over" | "overridden" | "unavailable" | "unknown";
};

/** What an item resolved to — the preset or teammate it named, and the model
 *  selection that placed it. */
export type DispatchMeta = (
  | { kind: "spawn" }
  | { kind: "preset"; preset: string; selection: ModelSelection }
  | { kind: "delegation"; agent: string; agentId: string; selection: ModelSelection }
  | { kind: "contract"; contractor: string; role: string }
) & { preference?: PreferenceNote };

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
 *  itself does only when it names a kind the user set a model for. */
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
  requested?: RequestedTarget,
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

/** The item's `kind` looked up in the user's preferences, or null when it named
 *  none. A kind that isn't there — or that has no model, which to an agent is
 *  the same thing — still resolves, to a record with no model, so the dispatch
 *  goes ahead on the caller's model and says why. */
function kindPreference(store: SpawnToolStore, ref: string | undefined): ModelPreference | null {
  if (ref === undefined) return null;
  return (
    lookupModelPreference(store.listModelPreferences(), ref) ?? {
      kind: ref,
      label: ref,
      hint: "",
      model: null,
      effort: null,
    }
  );
}

/** Say what became of the kind, from the selection that placed the thread. */
function preferenceNote(pref: ModelPreference, selection: ModelSelection): PreferenceNote {
  const note = { kind: pref.kind, label: pref.label };
  if (selection === "preferred") return { ...note, outcome: "applied" };
  if (selection !== "inherited") return { ...note, outcome: "overridden" };
  return { ...note, outcome: pref.model ? "unavailable" : "unknown" };
}

/** A planned target with the preference's effort laid on, when the preference
 *  is what placed it. Effort belongs to the model it was chosen for, so a
 *  thread placed any other way keeps the engine's own rule (inherit the
 *  caller's). A preference with no effort says the other thing explicitly —
 *  `null`, the provider's default — because the caller's effort was tuned for
 *  the caller's model, not this one. */
function withPreferredEffort(
  target: SpawnTarget,
  pref: ModelPreference | null,
  selection: ModelSelection,
): SpawnTarget {
  if (selection !== "preferred" || !pref) return target;
  return { ...target, effort: pref.effort ?? null };
}

/** Place a thread the caller briefed itself — a worker or a contractor. A
 *  target it named wins; otherwise the user's model for the kind, else the
 *  caller's own. Availability is asked for only when a kind has a model to
 *  check, so a plain worker never pays for the lookup. */
async function placeBriefed(
  caller: SpawnCaller,
  item: DispatchItem,
  pref: ModelPreference | null,
  getAvailability: () => Promise<ProviderAvailability[]>,
): Promise<{
  target: SpawnTarget;
  selection: ModelSelection;
  fallbacks: readonly ModelCandidate[];
}> {
  if (item.target) {
    return { target: inheritSpawnTarget(caller, item.target), selection: "requested", fallbacks: [] };
  }
  if (!pref?.model) {
    return { target: inheritSpawnTarget(caller), selection: "inherited", fallbacks: [] };
  }
  const plan = planSpawnModel({
    chain: [],
    preferred: pref.model,
    caller: { provider: caller.provider, model: caller.model },
    availability: await getAvailability(),
  });
  if (!plan.ok || plan.selection !== "preferred") {
    return { target: inheritSpawnTarget(caller), selection: "inherited", fallbacks: [] };
  }
  const target: SpawnTarget = { provider: plan.target.provider };
  if (plan.target.model) target.model = plan.target.model;
  return {
    target: withPreferredEffort(target, pref, plan.selection),
    selection: plan.selection,
    fallbacks: plan.fallbacks,
  };
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
  const pref = kindPreference(store, item.kind);
  const noted = (selection: ModelSelection): { preference?: PreferenceNote } =>
    pref ? { preference: preferenceNote(pref, selection) } : {};

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
      preferredModel: pref?.model,
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
          target: withPreferredEffort(plan.target, pref, plan.selection),
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
        ...noted(plan.selection),
      },
    };
  }

  if (item.contract) {
    const placed = await placeBriefed(caller, item, pref, getAvailability);
    return {
      ok: true,
      request: withPlanFallbacks(
        {
          requestId: item.requestId,
          prompt: renderContractBrief(item.prompt, item.contract),
          title: item.title,
          target: placed.target,
          mode: item.mode,
          contract: item.contract,
          persona: contractPersona(item.contract),
        },
        placed.fallbacks,
      ),
      meta: {
        kind: "contract",
        contractor: item.contract.name,
        role: item.contract.role,
        ...noted(placed.selection),
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
      pref?.model,
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
          target: withPreferredEffort(plan.target, pref, plan.selection),
          mode: item.mode,
        },
        plan.fallbacks,
      ),
      meta: { kind: "preset", preset: preset.name, selection: plan.selection, ...noted(plan.selection) },
    };
  }

  const placed = await placeBriefed(caller, item, pref, getAvailability);
  return {
    ok: true,
    request: withPlanFallbacks(
      {
        requestId: item.requestId,
        prompt: item.prompt,
        title: item.title,
        target: placed.target,
        mode: item.mode,
      },
      placed.fallbacks,
    ),
    meta: { kind: "spawn", ...noted(placed.selection) },
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
  if (meta.kind === "contract") {
    record.contractor = meta.contractor;
    record.contractorRole = meta.role;
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
  const meta = reconcileMeta(prepared.meta, result);
  return { ok: true, result, meta, record: spawnRecordFor(result, meta, item.why) };
}

/** What preparation planned, corrected by what the engine did. The plan says
 *  where the thread was meant to run; a start that failed over did not run
 *  there, and a result that claimed it had would put the user's model on a
 *  thread that is on the caller's. A preferred model's only fallback rung is the
 *  caller's own, so that is where a thread that left it now is. */
function reconcileMeta(meta: DispatchMeta, result: SpawnThreadResult): DispatchMeta {
  if (!result.failedOverFrom) return meta;
  let out = meta;
  if ((out.kind === "preset" || out.kind === "delegation") && out.selection === "preferred") {
    out = { ...out, selection: "inherited" };
  }
  if (out.preference?.outcome === "applied") {
    out = { ...out, preference: { ...out.preference, outcome: "failed_over" } };
  }
  return out;
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

/** A note about the kind the caller named, when it did not decide the model
 *  the way the caller may have expected. Applied, it names the kind so the
 *  caller knows whose choice the model was; overridden, it says nothing — the
 *  more specific placement is what the caller asked for. */
function preferenceSentence(note: PreferenceNote | undefined): string {
  if (!note) return "";
  switch (note.outcome) {
    case "applied":
      return ` That is the user's model for ${note.label}.`;
    case "failed_over":
      return ` It was meant to run on the user's model for ${note.label}.`;
    case "overridden":
      return "";
    case "unavailable":
      return ` The user's model for ${note.label} can't run right now, so it runs on your own.`;
    case "unknown":
      return ` There is no "${note.kind}" in the user's model preferences (agent_directory lists them), so it runs on your own.`;
  }
}

/** The sentence the model reads for one dispatch: what opened, from what, where
 *  it runs, and how to collect it. */
export function spawnSentence(result: SpawnThreadResult, meta: DispatchMeta): string {
  const handed =
    meta.kind === "delegation"
      ? `Delegated "${result.title}" to ${meta.agent}`
      : meta.kind === "contract"
        ? `Contracted ${meta.contractor} (${meta.role}) for "${result.title}"`
        : meta.kind === "preset"
          ? `Started worker "${result.title}" from preset ${meta.preset}`
          : `Started worker "${result.title}"`;
  const place = `${result.provider}${result.model ? `/${result.model}` : ""}`;
  return `${handed} on ${place} as ${result.threadId}.${preferenceSentence(meta.preference)}${failoverNote(result)} Collect its response with agent_wait.`;
}

/** The single tools' structured result: the thread, plus the preset or teammate
 *  it came from and the selection that placed it. A delegation keys its thread
 *  as `delegation` — a teammate is asked, not spawned. */
export function structuredDispatch(result: SpawnThreadResult, meta: DispatchMeta): GatewayRecord {
  const base = structuredPlacement(result, meta);
  return meta.preference ? { ...base, preference: meta.preference } : base;
}

function structuredPlacement(result: SpawnThreadResult, meta: DispatchMeta): GatewayRecord {
  switch (meta.kind) {
    case "spawn":
      return { spawn: result };
    case "preset":
      return { spawn: result, preset: meta.preset, selection: meta.selection };
    case "delegation":
      return { delegation: result, agent: meta.agent, selection: meta.selection };
    case "contract":
      return { contract: result, contractor: meta.contractor, role: meta.role };
  }
}

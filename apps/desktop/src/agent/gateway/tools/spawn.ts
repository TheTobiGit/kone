// Thread-spawning gateway tools (docs/thread-spawning-design.md §5.1, §6 Wave 2).
//
// Four tools that let a running agent open, follow and read kone threads. The
// engine (../../threadSpawn.ts) holds ALL the state — depth/breadth guards,
// lineage, status projection, waiting — this module is the thin boundary:
// validate, resolve the engine, call it, shape the result, map its errors. The
// store is injected structurally so unit tests can fake it; the real
// ConversationStore satisfies it.
//
// The three read tools are deliberately turn-less, and that is load-bearing:
// gateway write authority retires at `turn.completed`, so if reads required a
// live turn an orchestrator could never check on children it spawned in an
// earlier turn — the single most important thing it does. Only the spawn
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
import type { InteractionMode, SpawnTarget, StoredBlock, StoredThread } from "../../types.js";
import type { AgentRecord, SubagentPresetRecord } from "../../ConversationStore.js";
import { planPresetSpawn } from "../../presetSpawn.js";
import { resolveDelegation } from "../../delegate.js";
import type { ProviderAvailability } from "../../agentModel.js";
import type {
  GatewayToolContext,
  GatewayToolResult,
  GatewayValue,
  ToolEntry,
} from "../schemas.js";
import {
  DelegateInputSchema,
  DELEGATE_JSON_SCHEMA,
  GatewayToolError,
  ReadThreadInputSchema,
  READ_THREAD_JSON_SCHEMA,
  SpawnFromPresetInputSchema,
  SPAWN_FROM_PRESET_JSON_SCHEMA,
  SPAWN_THREAD_JSON_SCHEMA,
  SPAWN_TARGETS_JSON_SCHEMA,
  SpawnTargetsInputSchema,
  SpawnThreadInputSchema,
  WaitForThreadsInputSchema,
  WAIT_FOR_THREADS_JSON_SCHEMA,
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
function mapSpawnError(error: unknown): GatewayToolError {
  if (error instanceof SpawnError) {
    // SAFETY: engine refusals carry plain-JSON detail bags that are embedded
    // verbatim into the tool result without further interpretation.
    return new GatewayToolError(error.code, error.message, error.details as GatewayValue);
  }
  throw error;
}

/** Find a preset by the agent's reference: an exact id first, then a
 *  case-insensitive name match. Names aren't unique, so the name path takes the
 *  first in roster order — the same one at the top of the user's list. */
function findPreset(store: SpawnToolStore, ref: string): SubagentPresetRecord | null {
  const byId = store.getSubagentPreset(ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  return store.listSubagentPresets().find((p) => p.name.trim().toLowerCase() === wanted) ?? null;
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
  return store.listSubagentPresets().map((preset) => {
    const entry: NonNullable<SpawnTargetsReport["presets"]>[number] = {
      name: preset.name,
    };
    if (preset.model) entry.model = { provider: preset.model.provider, model: preset.model.model };
    const summary = gist(preset.instructions);
    if (summary) entry.summary = summary;
    return entry;
  });
}

/** The teammates an agent can delegate to on its own project, shaped for the
 *  report and in team order. A nameless agent drops out: `kone_delegate`
 *  resolves by name, so listing one with no name would only offer a target the
 *  agent could never actually reach. */
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

export function createSpawnTools(input: SpawnToolInput): ToolEntry[] {
  const targetsHandler = async (ctx: GatewayToolContext): Promise<GatewayToolResult> => {
    const engine = requiredEngine();
    const caller = callerOf(ctx);
    try {
      const base = await engine.targets(caller);
      // The engine reports providers/models/limits — all it knows. Presets and
      // teammates live in the tool's own store, so they are folded in here; this
      // one call answers all three questions an agent has before it spawns.
      const presets = presetTargets(input.store);
      const teammates = teammateTargets(input.store, caller.cwd);
      const report: SpawnTargetsReport = { ...base, presets, teammates };
      const ready = report.providers.filter((p) => p.available).map((p) => p.provider);
      const parts = [
        ready.length > 0
          ? `${ready.length} provider${ready.length === 1 ? "" : "s"} ready (${ready.join(", ")}) with ${report.providers.reduce((n, p) => n + p.models.length, 0)} models across ${report.providers.length} installed provider${report.providers.length === 1 ? "" : "s"}.`
          : "No provider is currently available to spawn on.",
      ];
      if (presets.length > 0) {
        parts.push(
          `${presets.length} preset sub-agent${presets.length === 1 ? "" : "s"} (${presets.map((p) => p.name).join(", ")}) available to kone_spawn_from_preset.`,
        );
      }
      if (teammates.length > 0) {
        parts.push(
          `${teammates.length} teammate${teammates.length === 1 ? "" : "s"} on this project (${teammates.map((t) => t.name).join(", ")}) available to kone_delegate.`,
        );
      }
      return { content: [{ type: "text", text: parts.join(" ") }], structuredContent: { report } };
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  const spawnHandler = async (
    ctx: GatewayToolContext,
    args: {
      prompt: string;
      requestId: string;
      title?: string;
      target: SpawnTarget;
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
    const request: SpawnRequest = {
      requestId: args.requestId,
      prompt: args.prompt,
      title: args.title,
      target: args.target,
      mode: args.mode,
    };
    try {
      const result = await engine.spawn(callerOf(ctx), request);
      return {
        content: [
          {
            type: "text",
            text: `Spawned "${result.title}" on ${result.provider}${result.model ? `/${result.model}` : ""} as ${result.threadId}.`,
          },
        ],
        structuredContent: { spawn: result },
      };
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  const spawnFromPresetHandler = async (
    ctx: GatewayToolContext,
    args: {
      preset: string;
      task: string;
      requestId: string;
      title?: string;
      mode?: InteractionMode;
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
    const plan = planPresetSpawn(preset, args.task, availability, {
      provider: caller.provider,
      model: caller.model,
    });
    if (!plan.ok) {
      return gatewayToolErrorResult(
        new GatewayToolError("provider_unavailable", plan.reason, { tried: plan.tried }),
      );
    }
    const request: SpawnRequest = {
      requestId: args.requestId,
      prompt: plan.prompt,
      title: args.title,
      target: plan.target,
      mode: args.mode,
    };
    try {
      const result = await engine.spawn(caller, request);
      return {
        content: [
          {
            type: "text",
            text: `Spawned "${result.title}" from preset ${preset.name} on ${result.provider}${result.model ? `/${result.model}` : ""} as ${result.threadId}.`,
          },
        ],
        structuredContent: { spawn: result, preset: preset.name, selection: plan.selection },
      };
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  const delegateHandler = async (
    ctx: GatewayToolContext,
    args: {
      agent: string;
      task: string;
      requestId: string;
      title?: string;
      mode?: InteractionMode;
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
      const result = await engine.spawn(caller, {
        requestId: args.requestId,
        prompt: plan.prompt,
        title: args.title,
        target: plan.target,
        mode: args.mode,
        delegateToAgentId: agent.agentId,
        persona: plan.persona,
      });
      return {
        content: [
          {
            type: "text",
            text: `Delegated "${result.title}" to ${plan.persona.name} on ${result.provider}${result.model ? `/${result.model}` : ""} as ${result.threadId}. Collect the result with kone_wait_for_threads.`,
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

  const waitHandler = async (
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
      const text = outcome.allTerminal
        ? `All ${count} thread${count === 1 ? "" : "s"} settled.`
        : outcome.timedOut
          ? `Timed out with ${running} thread${running === 1 ? "" : "s"} still running — call again to keep waiting.`
          : parked > 0
            ? `${parked} thread${parked === 1 ? "" : "s"} parked on a human response — get the user's answer, then wait again.`
            : `${count} thread${count === 1 ? "" : "s"} reported; ${running} still running.`;
      return { content: [{ type: "text", text }], structuredContent: outcome };
    } catch (error) {
      // An aborted wait is the caller cancelling — the transport turns it into
      // a 202 with no body. Mapping it to a tool error would report a failure
      // to a client that already gave up on the call.
      if (error instanceof Error && error.name === "AbortError") throw error;
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  const readHandler = async (
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
    return {
      content: [
        {
          type: "text",
          text: `Read ${messages.length} message${messages.length === 1 ? "" : "s"} from "${thread.title ?? args.threadId}".`,
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
        "List everyone and everything you can hand work to right now: the installed providers and their real model ids for kone_spawn_thread, the preset sub-agents you can invoke by name with kone_spawn_from_preset, and the teammates on this project you can hand work to with kone_delegate. Call this before you spawn or delegate when you are not certain what is available — a spawn names an exact model and a delegation names an exact teammate, and kone refuses one it does not recognise rather than quietly substituting another. Each preset comes with a one-line gist of what it is for and its preferred models; each teammate with its role and a gist of how it works, so you can choose the right one. The report also tells you which model you are yourself running on, how many more children you may open, and how deep in the spawn tree you already are.",
      inputSchema: SpawnTargetsInputSchema,
      jsonSchema: SPAWN_TARGETS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      handler: targetsHandler,
    },
    {
      name: "kone_spawn_thread",
      description:
        "Open a new kone thread and set an agent working in it. This is not a nested subagent inside your turn — it is a second, first-class conversation that appears in the user's sidebar, persists, and keeps running after your turn ends. Use it to hand a self-contained unit of work to another model, or to fan several independent units out at once, when doing the work inline would crowd out your own context. Write prompt as a complete standing brief: the child wakes up with no memory of this conversation and cannot ask you anything, so state the goal, the paths involved, the constraints, and what done looks like. Choose target.provider and target.model deliberately — a cheap fast model for mechanical work, a stronger one for work that needs judgement; call kone_spawn_targets if you need the real list. mode is what the child may do without stopping to ask, and it can never exceed yours — request a wider one and the spawn is refused rather than quietly downgraded. Leave it unset to inherit yours. Choose it by what the child needs to finish unattended, because nobody is sitting in its thread: a child that stops for permission stays stopped until the user notices. full-access lets it edit files and run commands on its own. accept-edits lets it edit, but it will park the first time it needs to run a command. ask parks on nearly everything, so use it only for a child that reads and reports. If the work needs more than your own thread is allowed, say so and let the user raise your mode — do not spawn a child that cannot finish. Pass a stable requestId so a retry after a network hiccup returns the same child instead of opening a second one. This returns as soon as the child starts, not when it finishes — collect the result with kone_wait_for_threads; the result also carries the child's first turn id, pass it back as turnIds to pin the wait to the turn you actually spawned.",
      inputSchema: SpawnThreadInputSchema,
      jsonSchema: SPAWN_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      handler: spawnHandler,
    },
    {
      name: "kone_spawn_from_preset",
      description:
        "Open a new kone thread from a preset sub-agent — a reusable definition the user has saved, carrying its own standing instructions and one model (or none). Give the preset by name (e.g. \"Explorer\", \"Code Reviewer\") and a task describing the specific work; kone lays the task under the preset's instructions to form the child's opening brief, so write task as a complete standing ask the way you would prompt for kone_spawn_thread — the child cannot ask you anything. You do not choose a model here: kone runs the preset's model when it names one, or the child runs on your own provider and model when it names none. If the preset's model can't run it refuses rather than substituting one you didn't ask for. mode works exactly as in kone_spawn_thread — clamped to yours, chosen for what the child needs to finish unattended. Use this when the work matches a preset the user has set up; use kone_spawn_thread when you need to pick the provider and model yourself. Pass a stable requestId so a retry returns the same child. Returns as soon as the child starts — collect the result with kone_wait_for_threads.",
      inputSchema: SpawnFromPresetInputSchema,
      jsonSchema: SPAWN_FROM_PRESET_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      handler: spawnFromPresetHandler,
    },
    {
      name: "kone_delegate",
      description:
        "Hand a piece of work to another agent on this project's team and let it do the work as itself. This is agent-to-agent delegation, not a throwaway worker: the teammate is a persistent agent the user set up — it runs under its own name, its own standing instructions and its own model preference, in a new first-class thread that appears in the sidebar. Use it when the work belongs to a specialist the user has put on the team (\"the backend agent should build this endpoint\", \"ask the reviewer to look this over\") rather than to a model you pick yourself. Name the teammate with agent — its name or id; it must be on THIS project's team or the delegation is refused. Write task as a complete standing brief for that teammate: it wakes with no memory of this conversation and cannot ask you anything, so state the goal, the paths, the constraints and what done looks like — but do NOT restate who it is or how it should work, because it already runs as itself. You do not choose a model: the teammate runs on its own preferred model (falling to the next if the first is unavailable, and telling you if it did), or on your model when it has no preference. mode is clamped to yours exactly as in kone_spawn_thread. Pass a stable requestId so a retry returns the same delegation. Returns as soon as the teammate starts — collect its result with kone_wait_for_threads.",
      inputSchema: DelegateInputSchema,
      jsonSchema: DELEGATE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      handler: delegateHandler,
    },
    {
      name: "kone_wait_for_threads",
      description:
        "Wait for threads you spawned and collect each one's outcome. Returns as soon as every named thread has settled, or as soon as any one of them parks on a question or an approval that needs a human — a blocked child is surfaced immediately rather than silently eating your timeout, because nothing moves until someone answers it. A timeout reports progress and nothing else: it never cancels, retries or re-spawns anything, so calling again simply keeps waiting. Each result carries the child's final message, capped; its reasoning, tool calls and intermediate output stay in the child's own thread. Use kone_read_thread when the summary is not enough to act on. Pass turnIds (the turn id kone_spawn_thread returned) positionally paired with threadIds to pin the wait to that exact turn — otherwise a newer turn in the child can swap which outcome you collect; the result echoes the turnIds it resolved to, so re-pass them to keep waiting on the same turn.",
      inputSchema: WaitForThreadsInputSchema,
      jsonSchema: WAIT_FOR_THREADS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      handler: waitHandler,
    },
    {
      name: "kone_read_thread",
      description:
        "Read the transcript of a thread you spawned, or one that it spawned in turn — its messages in order, newest last. Use it when a child's summary is too thin to act on, when it failed and you need to see where, or when you need the details it worked out rather than its conclusion. Scoped to your own subtree: threads you did not spawn are not readable, and neither are the user's other conversations.",
      inputSchema: ReadThreadInputSchema,
      jsonSchema: READ_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      handler: readHandler,
    },
  ];
}

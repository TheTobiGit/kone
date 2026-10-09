// Worker- and teammate-dispatching gateway tools (docs/thread-spawning-design.md
// §5.1, §6 Wave 2; docs/agent-roles-design.md §9).
//
// The tools that let an agent start workers and hand work to other agents,
// follow them, read the responses they come back with, and post follow-up
// turns into the threads it already opened — each one a kone thread. Every one
// is `agentsOnly`: a worker is started for one task and directs nobody. The
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

import { SPAWN_WAIT_MAX_MS, type SpawnTargetsReport } from "../../threadSpawn.js";
import type { InteractionMode, SpawnedThread, StoredBlock } from "../../types.js";
import type { AgentModelRef } from "../../ConversationStore.js";
import type { ContractTerms } from "@kone/protocol/contract";
import {
  formatSpawnResult,
  type SpawnRecord,
  type SpawnToolName,
} from "@kone/protocol/spawn-record";
import type { GatewayRecord, GatewayToolContext, GatewayToolResult, ToolEntry } from "../schemas.js";
import {
  ContractAgentInputSchema,
  CONTRACT_AGENT_JSON_SCHEMA,
  ContinueThreadInputSchema,
  CONTINUE_THREAD_JSON_SCHEMA,
  DelegateToTeammateInputSchema,
  DELEGATE_TO_TEAMMATE_JSON_SCHEMA,
  GatewayToolError,
  ReadResponseInputSchema,
  READ_RESPONSE_JSON_SCHEMA,
  SPAWN_TARGETS_JSON_SCHEMA,
  SpawnTargetsInputSchema,
  WaitForResponsesInputSchema,
  WAIT_FOR_RESPONSES_JSON_SCHEMA,
  WorkerStartBatchInputSchema,
  WorkerStartInputSchema,
  WORKER_START_BATCH_JSON_SCHEMA,
  WORKER_START_JSON_SCHEMA,
} from "../schemas.js";
import { gatewayToolErrorResult } from "../registry.js";
import {
  createAnswerChildInputTool,
  createCancelWorkerTool,
  createDeclineChildGateTool,
  createKeepOrStopTool,
} from "./spawnChildControls.js";
import {
  availabilityOnce,
  dispatchOne,
  spawnSentence,
  structuredDispatch,
  type DispatchItem,
  type Dispatched,
  type DispatchMeta,
  type RequestedTarget,
  type SpawnToolStore,
} from "./spawnDispatch.js";
import { mapSpawnError, requiredEngine, callerOf, withActiveTurn } from "./spawnToolContext.js";
import {
  AGENT_READ_RESPONSE_CHAR_CAP,
  latestTurn,
  renderFinal,
  renderResponse,
  type AgentReadScope,
} from "../../agentRead.js";
import { activeModelPreferences } from "../../modelPreference.js";

export type { SpawnToolStore } from "./spawnDispatch.js";

export interface SpawnToolInput {
  store: SpawnToolStore;
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
 *  against, so the first of a duplicated name is the one named here too. The
 *  natives fold in only as configured: a disabled one is not offered, and an
 *  enabled one carries the model chain the user pinned on it. */
function presetTargets(store: SpawnToolStore): NonNullable<SpawnTargetsReport["presets"]> {
  const all = store.listVisiblePresets();

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
 *  `agent_delegate` resolves by name, so listing one with no name
 *  would only offer a target the agent could never actually reach. */
export function teammateTargets(
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

/** The kinds of work the user switched on with a model, shaped for the report
 *  in the user's order. Any other kind is left out: naming it would place
 *  nothing, so it is not something an agent can choose. */
function modelPreferenceTargets(
  store: SpawnToolStore,
): NonNullable<SpawnTargetsReport["modelPreferences"]> {
  return activeModelPreferences(store.listModelPreferences()).map((pref) => {
    const entry: NonNullable<SpawnTargetsReport["modelPreferences"]>[number] = {
      kind: pref.kind,
      label: pref.label,
      model: { provider: pref.model.provider, model: pref.model.model },
    };
    if (pref.hint) entry.hint = pref.hint;
    if (pref.effort) entry.effort = pref.effort;
    return entry;
  });
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
  const parkedGateId =
    (thread.status === "waiting-for-approval" || thread.status === "waiting-for-user-input") &&
    thread.gate?.requestId
      ? ` (gate: ${thread.gate.requestId})`
      : "";
  const head = `[${thread.title}] ${thread.status}${took} (${thread.threadId})${parkedGateId}:`;
  const body = thread.summary?.trim() || thread.detail?.trim();
  if (body) return `${head}\n${body}`;
  return `${head}\n(no reply text — read the full transcript with agent_read)`;
}

/** One transcript message as prose, for the same reason. */
function messageText(message: { role: string; text: string }): string {
  return `[${message.role}] ${message.text.trim() || "(no text — tool calls only)"}`;
}

/** A single dispatch's tool result. The text is a record, not a sentence: the
 *  thread that dispatched reads it back to say who was handed what, and why.
 *  The sentence the model reads rides inside it as `summary`. */
function singleResult(dispatched: Dispatched): GatewayToolResult {
  if (!dispatched.ok) return gatewayToolErrorResult(dispatched.error);
  const { result, meta, record } = dispatched;
  const spawn = { spawns: [record], summary: spawnSentence(result, meta) };
  return {
    content: [{ type: "text", text: formatSpawnResult(spawn) }],
    // The record rides in the structured result too: a provider that stores
    // the structured result in place of the text (Claude's does) still leaves
    // the thread a record to read back.
    structuredContent: { ...structuredDispatch(result, meta), ...spawn },
  };
}

type BatchItemResult =
  | { index: number; ok: true; kind: DispatchMeta["kind"]; record: SpawnRecord }
  | { index: number; ok: false; error: string };

type BatchSpawnSuccess = Extract<BatchItemResult, { ok: true }>;

/** The sentence for a whole batch: every thread it opened, then every item it
 *  refused, by index. */
function batchSentence(results: BatchItemResult[]): string {
  const succeeded = results.filter((r): r is BatchSpawnSuccess => r.ok);
  const failed = results.filter((r): r is Extract<BatchItemResult, { ok: false }> => !r.ok);
  const parts: string[] = [];
  if (succeeded.length > 0) {
    parts.push(
      `Spawned ${succeeded.length} thread${succeeded.length === 1 ? "" : "s"}: ${succeeded
        .map((s) => `"${s.record.title}" (${s.record.threadId})`)
        .join(", ")}.`,
    );
  }
  if (failed.length > 0) {
    const errList = failed
      .map((f) => `item ${f.index}: ${f.error.endsWith(".") ? f.error.slice(0, -1) : f.error}`)
      .join("; ");
    parts.push(`${failed.length} spawn failed: ${errList}.`);
  }
  return parts.join(" ");
}

/** One batch item as the structured result lists it. */
function batchThreadEntry(r: BatchItemResult): GatewayRecord {
  if (!r.ok) return { index: r.index, ok: false, error: r.error };
  const entry: GatewayRecord = {
    index: r.index,
    ok: true,
    threadId: r.record.threadId,
    title: r.record.title,
    provider: r.record.provider,
    model: r.record.model ?? null,
    kind: r.kind,
  };
  if (r.record.agent !== undefined) entry.agent = r.record.agent;
  if (r.record.preset !== undefined) entry.preset = r.record.preset;
  return entry;
}

export function createSpawnTools(input: SpawnToolInput): ToolEntry[] {
  const targetsHandler = async (ctx: GatewayToolContext): Promise<GatewayToolResult> => {
    const engine = requiredEngine();
    const caller = callerOf(ctx);
    try {
      const base = await engine.targets(caller);
      // The engine reports providers/models/limits — all it knows. Presets and
      // teammates are the store's, so they join the report here.
      const presets = presetTargets(input.store);
      const modelPreferences = modelPreferenceTargets(input.store);
      const report: SpawnTargetsReport = {
        ...base,
        presets,
        teammates: teammateTargets(input.store, caller.cwd),
        modelPreferences,
      };
      const ready = report.providers.filter((p) => p.available).map((p) => p.provider);
      const parts = [
        ready.length > 0
          ? `${ready.length} provider${ready.length === 1 ? "" : "s"} ready (${ready.join(", ")}) with ${report.providers.reduce((n, p) => n + p.models.length, 0)} models across ${report.providers.length} installed provider${report.providers.length === 1 ? "" : "s"}.`
          : "No provider is currently available to spawn on.",
      ];
      if (presets.length > 0) {
        parts.push(
          `${presets.length} worker preset${presets.length === 1 ? "" : "s"} (${presets.map((p) => p.name).join(", ")}) available to worker_start as preset.`,
        );
      }
      const teammates = report.teammates ?? [];
      if (teammates.length > 0) {
        parts.push(
          `${teammates.length} teammate${teammates.length === 1 ? "" : "s"} on this project (${teammates.map((t) => (t.role ? `${t.name}, ${t.role}` : t.name)).join("; ")}) available to agent_delegate.`,
        );
      }
      if (modelPreferences.length > 0) {
        parts.push(
          `The user's model preferences by kind of work — pass the kind as kind to worker_start, agent_contract or agent_delegate when the work fits one and you were not told a model: ${modelPreferences
            .map(
              (p) =>
                `${p.kind} (${p.label}${p.hint ? `: ${p.hint.replace(/\.$/, "")}` : ""}) → ${p.model.provider}/${p.model.model}${p.effort ? ` at ${p.effort} effort` : ""}`,
            )
            .join("; ")}.`,
        );
      }
      return { content: [{ type: "text", text: parts.join(" ") }], structuredContent: { report } };
    } catch (error) {
      return gatewayToolErrorResult(mapSpawnError(error));
    }
  };

  /** A tool that dispatches one thing: it only maps its arguments onto an
   *  item. */
  const singleDispatchHandler =
    <Args>(toItem: (args: Args) => DispatchItem) =>
    (ctx: GatewayToolContext, args: Args): Promise<GatewayToolResult> =>
      withActiveTurn(ctx, async (engine, caller) =>
        singleResult(
          await dispatchOne(input.store, engine, caller, toItem(args), availabilityOnce(engine, caller)),
        ),
      );

  type WorkerArgs = {
    task: string;
    requestId: string;
    title?: string;
    why?: string;
    preset?: string;
    target?: RequestedTarget;
    model?: AgentModelRef;
    kind?: string;
    mode?: InteractionMode;
  };

  const workerStartHandler = singleDispatchHandler(
    ({ task, ...args }: WorkerArgs): DispatchItem => ({ ...args, prompt: task }),
  );

  const delegateToTeammateHandler = singleDispatchHandler(
    ({
      task,
      ...args
    }: {
      agent: string;
      task: string;
      requestId: string;
      title?: string;
      why?: string;
      mode?: InteractionMode;
      model?: AgentModelRef;
      kind?: string;
    }): DispatchItem => ({ ...args, prompt: task }),
  );

  const contractAgentHandler = singleDispatchHandler(
    ({
      task,
      name,
      role,
      instructions,
      scope,
      deliverable,
      doneCriteria,
      ...args
    }: ContractTerms & {
      task: string;
      requestId: string;
      title?: string;
      why?: string;
      target?: RequestedTarget;
      kind?: string;
      mode?: InteractionMode;
    }): DispatchItem => ({
      ...args,
      prompt: task,
      contract: { name, role, instructions, scope, deliverable, doneCriteria },
    }),
  );

  const continueThreadHandler = (
    ctx: GatewayToolContext,
    args: {
      threadId: string;
      message: string;
      requestId?: string;
    },
  ): Promise<GatewayToolResult> => {
    // The registry already refuses turn-less writes; this guard keeps a direct
    // handler call honest and never lets an empty turn id bind idempotency.
    return withActiveTurn(ctx, async (engine, caller) => {
      const result = await engine.continueThread(caller, {
        threadId: args.threadId,
        message: args.message,
        requestId: args.requestId,
      });
      const resumed = result.resumed
        ? " (its session had settled and was brought back up with its full context)"
        : "";
      const text = result.job
        ? `Follow-up left in ${result.threadId}'s inbox as job ${result.turnId}${resumed}. It runs as a turn of its own — now if the thread is idle, or once its running turn ends. Its response comes to you when it settles; to wait for it before going on, agent_wait with threadIds ["${result.threadId}"] and turnIds ["${result.turnId}"]: the job's id stands for the turn that carries it.`
        : `Follow-up sent to ${result.threadId} as turn ${result.turnId}${resumed}. Its response comes to you when it settles; to wait for it before going on, agent_wait with threadIds ["${result.threadId}"] and turnIds ["${result.turnId}"] to pin it to this turn.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { continuation: result },
      };
    });
  };

  const workerBatchHandler = (
    ctx: GatewayToolContext,
    args: { items: Array<WorkerArgs & { agent?: string }> },
  ): Promise<GatewayToolResult> => {
    return withActiveTurn(ctx, async (engine, caller) => {
      const getAvailability = availabilityOnce(engine, caller);
      const results = await Promise.all(
        args.items.map(async ({ task, ...rest }, index): Promise<BatchItemResult> => {
          // A teammate is an agent, not a worker: it takes a hand-off of its
          // own, one at a time. Refused per item so the rest still start.
          if (rest.agent !== undefined) {
            return {
              index,
              ok: false,
              error: `"${rest.agent}" is a teammate, not a worker — hand it work with agent_delegate`,
            };
          }
          const item: DispatchItem = { ...rest, prompt: task };
          try {
            const dispatched = await dispatchOne(input.store, engine, caller, item, getAvailability);
            if (!dispatched.ok) return { index, ok: false, error: dispatched.error.message };
            return { index, ok: true, kind: dispatched.meta.kind, record: dispatched.record };
          } catch (error) {
            return { index, ok: false, error: mapSpawnError(error).message };
          }
        }),
      );
      const spawns = results.filter((r): r is BatchSpawnSuccess => r.ok).map((r) => r.record);
      const summary = batchSentence(results);
      // What opened is a record, as a single spawn's is; a batch where nothing
      // opened has nothing to record and stays the plain refusal sentence.
      const text = spawns.length > 0 ? formatSpawnResult({ spawns, summary }) : summary;
      const structuredContent: GatewayRecord = {
        batch: {
          total: args.items.length,
          succeeded: spawns.length,
          failed: args.items.length - spawns.length,
          threads: results.map(batchThreadEntry),
        },
      };
      // As in a single dispatch: the record survives a provider that stores
      // this in place of the text.
      if (spawns.length > 0) {
        structuredContent.spawns = spawns;
        structuredContent.summary = summary;
      }
      return {
        content: [{ type: "text", text }],
        isError: spawns.length === 0,
        structuredContent,
      };
    });
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
    args: { threadId: string; scope?: AgentReadScope; limit?: number; maxTextChars?: number },
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
    const threadInfo = {
      threadId: thread.threadId,
      title: thread.title ?? null,
      provider: thread.provider,
      model: thread.model ?? null,
    };
    const scope = args.scope ?? "final";
    if (scope !== "transcript") {
      const turn = latestTurn(thread.blocks);
      const name = `"${thread.title ?? args.threadId}"`;
      const cap = args.maxTextChars ?? AGENT_READ_RESPONSE_CHAR_CAP;
      const text = scope === "final" ? renderFinal(turn, name, cap) : renderResponse(turn, name, cap);
      // The reply rides in both halves: a provider that reads the structured
      // half in place of the text would otherwise see no reply at all.
      const structured: GatewayRecord = { thread: threadInfo, scope, text };
      if (turn) structured.turn = { turnId: turn.turnId, state: turn.state };
      return { content: [{ type: "text", text }], structuredContent: structured };
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
        thread: threadInfo,
        scope,
        messages,
      },
    };
  };


  return [
    {
      name: "agent_directory",
      description:
        "List who and what you can hand work to: this project's teammates with their roles (agent_delegate; agent_contract makes up an agent when none fits), saved worker presets with what each is for (worker_start with preset), the user's model preferences by kind of work (kind on any start or delegation), and the installed providers with their real model ids (worker_start with target). Also reports the model you run on, how many more threads you may start, and how long your delegation chain already is.",
      inputSchema: SpawnTargetsInputSchema,
      jsonSchema: SPAWN_TARGETS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      agentsOnly: true,
      promptSnippet:
        "List the teammates, worker presets, model preferences and models you can hand work to, and how many more threads you may start.",
      promptGuidelines: [
        "Before handing work off, decide who should carry it. A large piece with parts of its own — a whole feature, a layer of the stack — goes to an agent, since an agent can plan it and start workers of its own: a teammate (agent_delegate) whose role fits, or, when none does, one you contract for the job (agent_contract). A short, bounded task — find something, run something, make one scoped edit — goes to a worker (worker_start), which does exactly that and reports back. Keep what you can do quickly yourself.",
      ],
      handler: targetsHandler,
    },
    {
      name: "worker_start" satisfies SpawnToolName,
      description:
        "Start a worker: a kone thread that does one short, bounded task and reports back. It has no name or role of its own, cannot start agents or workers itself, and shows under your conversation rather than as a thread of its own. It starts with no memory of this conversation, so write task as a complete brief: the goal, the paths, the constraints, and what done looks like. Name a saved preset (agent_directory lists them) to lay its standing instructions and model chain under the task. Name the kind of work (agent_directory lists the user's model preferences) to run it on the model and effort the user chose for that kind; otherwise it runs on your own provider and model. Use target only when the user asked for a specific model. why is one short clause, in your own voice, that the user reads where you started it. mode is what it may do unattended and is clamped to yours (a wider request is refused, not downgraded). Pass a stable requestId so a retry returns the same worker. Returns once it starts, with its threadId and first turn id. Its result comes to you when it settles, so keep working meanwhile; agent_wait (pass that id as turnIds) only when you need it before going on, and ask it again with agent_followup, never a second start.",
      inputSchema: WorkerStartInputSchema,
      jsonSchema: WORKER_START_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      agentsOnly: true,
      promptSnippet:
        "Start a worker on one short, bounded task with a brief you write, optionally from a saved preset.",
      promptGuidelines: [
        "Nobody sits in a worker you start: one that stops for permission stays stopped until the user notices. If the work needs a wider mode than yours, ask the user to raise your mode instead of starting a worker that cannot finish.",
      ],
      handler: workerStartHandler,
    },
    {
      name: "agent_delegate" satisfies SpawnToolName,
      description:
        "Delegate a large piece of work to a teammate: a named kone agent on this project's team (agent_directory lists them with their roles). It runs as that agent — under its name, instructions and model chain (when it names none, the user's model for kind, else yours) — in a thread of its own the user can open, and it can plan the work and start workers of its own. It starts with no memory of this conversation, so write task as the whole ask. It reads your brief as yours, not the user's, and may come back with a question or disagree: answer from what you know of the user's intent, or ask the user. Pass model only when the user asked for a specific one. why, mode and requestId work as in worker_start. Its result comes to you when it settles; agent_wait only when you need it before going on; follow up with agent_followup.",
      inputSchema: DelegateToTeammateInputSchema,
      jsonSchema: DELEGATE_TO_TEAMMATE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      agentsOnly: true,
      promptSnippet:
        "Delegate a large piece of work to a teammate, who runs under its own name and can start workers of its own.",
      handler: delegateToTeammateHandler,
    },
    {
      name: "agent_contract" satisfies SpawnToolName,
      description:
        "Contract a new agent for a large piece of work when no teammate fits: you write who it is — a person's first name (never a job title; the role says what it does), a one-line role, and standing instructions, the way the user would set up an agent — and the terms of the job: the task, its scope, the deliverable, and what done means. It runs as that agent in a thread of its own the user can open, can plan the work and start workers of its own, and reads your brief as yours, not the user's, so it may come back with a question or disagree. The contract lasts the job, not one turn: between turns it is idle and messages still reach it, and it ends when the contractor reports its deliverable (a report marked final) or you withdraw it. It is not saved to the team; only the user can hire it on. Prefer a teammate (agent_delegate) when one's role fits; contract when the work needs a specialist the team does not have. why, mode, kind, target and requestId work as in worker_start. The deliverable comes to you when it settles; agent_wait only when you need it before going on; follow up with agent_followup.",
      inputSchema: ContractAgentInputSchema,
      jsonSchema: CONTRACT_AGENT_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      agentsOnly: true,
      promptSnippet:
        "Contract a new agent for one large job: you write its identity and the job's terms; it is not saved to the team.",
      handler: contractAgentHandler,
    },
    {
      name: "worker_start_batch" satisfies SpawnToolName,
      description:
        "Start several independent workers in one call. Each item is a worker_start: a complete task, its own why, and optionally a preset, a kind or a target. Teammates are not workers — delegate to them with agent_delegate. Returns each worker's threadId; their results come to you as each settles (agent_wait when you need them before going on), and agent_followup asks any of them again.",
      inputSchema: WorkerStartBatchInputSchema,
      jsonSchema: WORKER_START_BATCH_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      agentsOnly: true,
      promptSnippet: "Start several independent workers in one call.",
      handler: workerBatchHandler,
    },
    {
      name: "agent_followup",
      description:
        "Queue a follow-up turn on a worker or agent you handed work to (or one started under it). This is the only way to ask it again: every start tool opens a new thread. It keeps its full context, so reference its earlier work rather than restating it; it runs on its own provider and mode, and reads the follow-up as yours, not the user's. A busy one takes it after its current turn; a settled one is brought back up first. Pass a stable requestId so a retry does not run it twice. Returns the new turn id; the response comes to you when it settles, or pass the id with the threadId to agent_wait when you need it before going on.",
      inputSchema: ContinueThreadInputSchema,
      jsonSchema: CONTINUE_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      agentsOnly: true,
      promptSnippet:
        "Queue a follow-up turn on a worker or agent you handed work to; returns a turn id to agent_wait on.",
      promptGuidelines: [
        "agent_followup queues a turn on a thread you handed work to and returns a turn id you can agent_wait on; use it whenever you or the user want that thread asked again, since a second start is a stranger, not a follow-up.",
      ],
      handler: continueThreadHandler,
    },
    createCancelWorkerTool(),
    createKeepOrStopTool(),
    createDeclineChildGateTool(),
    createAnswerChildInputTool(),
    {
      name: "agent_wait",
      agentsOnly: true,
      description:
        `Wait for workers and agents you handed work to and collect each one's final message (capped). Returns when every named agent has settled, or as soon as one parks on a question or approval that needs a human. The wait caps at ${SPAWN_WAIT_MAX_MS / 1000}s — pass timeoutMs below the cap and loop until all settle; if the call itself times out at the transport, lower timeoutMs and call again. A timeout only reports progress and cancels nothing. Pair turnIds with threadIds to pin each wait to a specific turn, so a newer turn cannot swap the response you collect. agent_read opens the full transcript when the summary is not enough. Waiting is optional, and it holds you while it lasts. A result nobody is waiting for comes to you on its own: put into your turn if you are still working, waking you if you have stopped. So after handing work off, do whatever does not depend on it first; agent_wait only when your next step cannot start without the result, and end your turn only when nothing is left that you can do without it.`,
      inputSchema: WaitForResponsesInputSchema,
      jsonSchema: WAIT_FOR_RESPONSES_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "Collect the replies of workers and agents you handed work to; returns early when one parks on a question or approval.",
      promptGuidelines: [
        "Handing work off returns at once, and its result comes back on its own — into your turn while you work, or as a wake once you stop. Keep doing whatever does not depend on it; agent_wait only when your next step needs the result, and end your turn only when nothing else is left.",
      ],
      handler: waitForResponsesHandler,
    },
    {
      name: "agent_read",
      agentsOnly: true,
      description:
        "Read a worker or agent you handed work to, or one it started in turn, at the depth you need. scope final (the default) is the reply its latest turn ended on — the text after its last step, where it puts its report; read this first. scope response is the latest request and everything it wrote answering it, with any messages that arrived mid-turn in their place and one line naming what it did — for when the final reply is too thin to act on. scope transcript is the conversation itself, newest last, limit messages at a time — for when the work failed and you need to see where, or you need what it worked out earlier. None of them carry tool payloads. Scoped to your own subtree: threads you did not hand work to are not readable, and neither are the user's other conversations.",
      inputSchema: ReadResponseInputSchema,
      jsonSchema: READ_RESPONSE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      onDemand: true,
      promptSnippet:
        "Read a worker or agent you handed work to: its final reply (default), its whole latest response, or its transcript.",
      handler: readResponseHandler,
    },
  ];
}

// Worker- and teammate-dispatching gateway tools (docs/thread-spawning-design.md
// §5.1, §6 Wave 2).
//
// Eleven tools that let a running agent dispatch workers and teammates, follow
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

import type { SpawnTargetsReport } from "../../threadSpawn.js";
import type { InteractionMode, SpawnedThread, SpawnTarget, StoredBlock } from "../../types.js";
import type { AgentModelRef } from "../../ConversationStore.js";
import {
  formatSpawnResult,
  type SpawnRecord,
  type SpawnToolName,
} from "@kone/protocol/spawn-record";
import type { GatewayRecord, GatewayToolContext, GatewayToolResult, ToolEntry } from "../schemas.js";
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
import {
  createAnswerChildInputTool,
  createCancelWorkerTool,
  createDeclineChildGateTool,
} from "./spawnChildControls.js";
import {
  availabilityOnce,
  dispatchOne,
  spawnSentence,
  structuredDispatch,
  type DispatchItem,
  type Dispatched,
  type DispatchMeta,
  type SpawnToolStore,
} from "./spawnDispatch.js";
import { mapSpawnError, requiredEngine, callerOf, withActiveTurn } from "./spawnToolContext.js";

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
 *  `kone_delegate_to_teammate` resolves by name, so listing one with no name
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
  return `${head}\n(no reply text — read the full transcript with kone_read_response)`;
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
  return {
    content: [
      {
        type: "text",
        text: formatSpawnResult({ spawns: [record], summary: spawnSentence(result, meta) }),
      },
    ],
    structuredContent: structuredDispatch(result, meta),
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
      const report: SpawnTargetsReport = { ...base, presets, teammates: teammateTargets(input.store, caller.cwd) };
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
      const teammates = report.teammates ?? [];
      if (teammates.length > 0) {
        parts.push(
          `${teammates.length} teammate${teammates.length === 1 ? "" : "s"} on this project (${teammates.map((t) => (t.role ? `${t.name}, ${t.role}` : t.name)).join("; ")}) available to kone_delegate_to_teammate.`,
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

  const spawnWorkerHandler = singleDispatchHandler(
    (args: {
      prompt: string;
      requestId: string;
      title?: string;
      why?: string;
      target?: SpawnTarget;
      mode?: InteractionMode;
    }): DispatchItem => args,
  );

  type HandOffArgs = {
    task: string;
    requestId: string;
    title?: string;
    why?: string;
    mode?: InteractionMode;
    model?: AgentModelRef;
  };

  const spawnWorkerPresetHandler = singleDispatchHandler(
    ({ task, ...args }: HandOffArgs & { preset: string }): DispatchItem => ({ ...args, prompt: task }),
  );

  const delegateToTeammateHandler = singleDispatchHandler(
    ({ task, ...args }: HandOffArgs & { agent: string }): DispatchItem => ({ ...args, prompt: task }),
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
      return {
        content: [
          {
            type: "text",
            text: `Follow-up sent to ${result.threadId} as turn ${result.turnId}${resumed}. Collect the response with kone_wait_for_responses, passing threadIds ["${result.threadId}"] and turnIds ["${result.turnId}"] to pin it to this turn.`,
          },
        ],
        structuredContent: { continuation: result },
      };
    });
  };

  const spawnBatchHandler = (
    ctx: GatewayToolContext,
    args: { items: DispatchItem[] },
  ): Promise<GatewayToolResult> => {
    return withActiveTurn(ctx, async (engine, caller) => {
      const getAvailability = availabilityOnce(engine, caller);
      const results = await Promise.all(
        args.items.map(async (item, index): Promise<BatchItemResult> => {
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
      return {
        content: [{ type: "text", text }],
        isError: spawns.length === 0,
        structuredContent: {
          batch: {
            total: args.items.length,
            succeeded: spawns.length,
            failed: args.items.length - spawns.length,
            threads: results.map(batchThreadEntry),
          },
        },
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
        "List the providers/models and preset specialist subagents you can spawn right now. Providers: the installed providers and their real model ids, which is what kone_spawn_worker names when you pick a model yourself. Presets: the saved subagent templates you can start a specialist worker from by name with kone_spawn_worker_preset, each with a one-line gist of what it is for and its preferred models. Teammates: the named agents on this project's team you can hand work to with kone_delegate_to_teammate, with their roles. Call this before you spawn when you are not certain what is available. The report also tells you which model you are yourself running on, how many more workers you may open, and how deep in the spawn tree you already are.",
      inputSchema: SpawnTargetsInputSchema,
      jsonSchema: SPAWN_TARGETS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "List the providers and models, and the preset specialist templates you can start a worker from right now.",
      handler: targetsHandler,
    },
    {
      name: "kone_spawn_worker" satisfies SpawnToolName,
      description:
        "Spawn a worker: open a new kone thread and set an agent working in it on a task you write. This is not a nested subagent inside your turn — it is a second, first-class conversation that appears in the user's sidebar, persists, and keeps running after your turn ends. Use it to hand a self-contained unit of work to another model, or to fan several independent units out at once, when doing the work inline would crowd out your own context. Write prompt as a complete standing brief: the worker wakes up with no memory of this conversation and cannot ask you anything, so state the goal, the paths involved, the constraints, and what done looks like. Say in why, briefly and in your own voice, why you are handing this off — the user reads it in the thread at the point you spawned the worker. Omit target to run the worker on your own provider and model (and reasoning effort). Pass target.provider and target.model only when you mean a different one — a cheap fast model for mechanical work, a stronger one for work that needs judgement; call kone_spawn_targets if you need the real list. mode is what the worker may do without stopping to ask, and it can never exceed yours — request a wider one and the spawn is refused rather than quietly downgraded. Leave it unset to inherit yours. Choose it by what the worker needs to finish unattended, because nobody is sitting in its thread: a worker that stops for permission stays stopped until the user notices. full-access lets it edit files and run commands on its own. accept-edits lets it edit, but it will park the first time it needs to run a command. ask parks on nearly everything, so use it only for a worker that reads and reports. If the work needs more than your own thread is allowed, say so and let the user raise your mode — do not spawn a worker that cannot finish. Pass a stable requestId so a retry after a network hiccup returns the same worker instead of opening a second one. This returns as soon as the worker starts, not when it finishes — collect its response with kone_wait_for_responses; the result also carries the worker's first turn id, pass it back as turnIds to pin the wait to the turn you actually spawned. When you need to ask this worker something again later, continue its existing thread with kone_continue_thread — spawning again would open a second worker with no memory of the first.",
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
      name: "kone_spawn_worker_preset" satisfies SpawnToolName,
      description:
        "Spawn a specialist worker from a preset — a reusable subagent template the user has saved, carrying its own standing instructions and a model chain (or none). Give the preset by name (e.g. \"Explorer\", \"Code Reviewer\") and a task describing the specific work; kone lays the task under the preset's instructions to form the worker's opening brief, so write task as a complete standing ask the way you would prompt for kone_spawn_worker — the worker cannot ask you anything. Say in why, briefly and in your own voice, why you are handing this off — the user reads it in the thread at the point you spawned the worker. You do not choose a model by default: kone runs the preset's assigned chain when it names one (falling to the next on a 429 or spent quota), or the worker runs on your own provider and model when it names none. Pass model only when the user asked for this piece of work to run somewhere specific — that override beats the preset's chain. If every named model can't run it refuses rather than substituting one you didn't ask for. mode works exactly as in kone_spawn_worker — clamped to yours, chosen for what the worker needs to finish unattended. Use this when the work matches a preset the user has set up, and kone_spawn_worker when you need to pick the provider and model yourself. Pass a stable requestId so a retry returns the same worker. Returns as soon as the worker starts — collect its response with kone_wait_for_responses. To ask this worker something again later, continue its existing thread with kone_continue_thread.",
      inputSchema: SpawnWorkerPresetInputSchema,
      jsonSchema: SPAWN_WORKER_PRESET_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Spawn a specialist worker from a preset the user has saved, running under the preset's own standing instructions.",
      handler: spawnWorkerPresetHandler,
    },
    {
      name: "kone_delegate_to_teammate" satisfies SpawnToolName,
      description:
        "Delegate a piece of work to a teammate — a named agent on this project's team, with its own identity, standing instructions and model preference. The child thread runs AS that agent: it answers under the teammate's name and brings the teammate's own instructions, so write task as just the ask — a complete, standing brief, since the teammate wakes up with no memory of this conversation and cannot ask you anything. Name the teammate by name or id with agent; only teammates on this project's team can be reached (kone_spawn_targets lists them with their roles). You do not choose a model by default: the teammate runs its own model chain, or yours when it names none. Pass model only when the user asked for this piece of work to run somewhere specific. Say in why, briefly and in your own voice, why you are handing this to them — the user reads it in the thread at the point you delegated. mode works exactly as in kone_spawn_worker — clamped to yours, chosen for what the teammate needs to finish unattended. Use this when the work fits a teammate's role; kone_spawn_worker_preset for a reusable specialist template, kone_spawn_worker to brief an anonymous worker yourself. Pass a stable requestId so a retry returns the same thread. Returns as soon as the teammate starts — collect its response with kone_wait_for_responses, and ask it something again with kone_continue_thread.",
      inputSchema: DelegateToTeammateInputSchema,
      jsonSchema: DELEGATE_TO_TEAMMATE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Hand a piece of work to a named teammate on this project's team, running as that agent under its own instructions.",
      handler: delegateToTeammateHandler,
    },
    {
      name: "kone_spawn_batch" satisfies SpawnToolName,
      description:
        "Dispatch several workers concurrently in a single tool call. Each item in items is a direct provider/model worker (target), a specialist worker from a preset (preset), or a delegation to a teammate on this project's team (agent) — set exactly one. Give each item its own why, as for the single tools. Use it instead of repeated single calls when the pieces are independent and can run at once. Returns an array of the threads it opened, with threadIds ready for kone_wait_for_responses. Later follow-ups to any of those threads go through kone_continue_thread on the returned threadId.",
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
    createCancelWorkerTool(),
    createDeclineChildGateTool(),
    createAnswerChildInputTool(),
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

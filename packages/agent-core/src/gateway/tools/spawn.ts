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

import { SPAWN_WAIT_MAX_MS, type SpawnTargetsReport } from "../../threadSpawn.js";
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
          `${presets.length} preset sub-agent${presets.length === 1 ? "" : "s"} (${presets.map((p) => p.name).join(", ")}) available to agent_spawn_preset.`,
        );
      }
      const teammates = report.teammates ?? [];
      if (teammates.length > 0) {
        parts.push(
          `${teammates.length} teammate${teammates.length === 1 ? "" : "s"} on this project (${teammates.map((t) => (t.role ? `${t.name}, ${t.role}` : t.name)).join("; ")}) available to agent_delegate.`,
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
            text: `Follow-up sent to ${result.threadId} as turn ${result.turnId}${resumed}. Collect the response with agent_wait, passing threadIds ["${result.threadId}"] and turnIds ["${result.turnId}"] to pin it to this turn.`,
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
      name: "agent_targets",
      description:
        "List what you can start kone agents from: installed providers with their real model ids (for agent_spawn), saved presets with what each is for (agent_spawn_preset), and this project's teammates with their roles (agent_delegate). Also reports the model you run on, how many more agents you may start, and how deep in the spawn tree you are.",
      inputSchema: SpawnTargetsInputSchema,
      jsonSchema: SPAWN_TARGETS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "List the providers and models, saved presets and project teammates you can start a kone agent from, and how many more you may start.",
      handler: targetsHandler,
    },
    {
      name: "agent_spawn" satisfies SpawnToolName,
      description:
        "Start a new kone agent on a task you write: a real conversation the user can see and open, which keeps running after your turn ends (not a hidden subagent inside your turn). It starts with no memory of this conversation and cannot ask you anything, so write prompt as a complete brief: the goal, the paths, the constraints, and what done looks like. why is one short clause, in your own voice, that the user reads where you started it. Omit target to run on your own provider, model and effort; set it for a cheaper or stronger model (agent_targets lists them). mode is what the agent may do unattended and is clamped to yours (a wider request is refused, not downgraded): full-access edits and runs commands, accept-edits parks on its first command, ask parks on nearly everything. Pass a stable requestId so a retry returns the same agent. Returns once the agent starts, with its threadId and first turn id: collect the result with agent_wait (pass that id as turnIds), and ask it again with agent_ask, never a second spawn.",
      inputSchema: SpawnWorkerInputSchema,
      jsonSchema: SPAWN_WORKER_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Start a kone agent on any installed provider with a brief you write; it keeps running after your turn ends.",
      promptGuidelines: [
        "Start a kone agent when a piece of work is self-contained and large enough to crowd out your context inline, or when independent pieces can run at once. The user sees every agent you start, so keep the number proportionate to the task and give each a brief you would be willing to have read back to you.",
        "Nobody sits in a kone agent you start: one that stops for permission stays stopped until the user notices. If the work needs a wider mode than yours, ask the user to raise your mode instead of starting an agent that cannot finish.",
      ],
      handler: spawnWorkerHandler,
    },
    {
      name: "agent_spawn_preset" satisfies SpawnToolName,
      description:
        "Start a kone agent from a preset: a template the user saved, with its own standing instructions and model chain. Name the preset (e.g. \"Code Reviewer\") and write task as a complete brief; kone lays it under the preset's instructions. The preset's chain picks the model, falling through on a 429 or spent quota, or yours when it names none. Pass model only when the user asked for a specific one; if nothing named can run, the spawn is refused rather than substituted. why, mode and requestId work as in agent_spawn. Collect the result with agent_wait; follow up with agent_ask.",
      inputSchema: SpawnWorkerPresetInputSchema,
      jsonSchema: SPAWN_WORKER_PRESET_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Start a kone agent from a preset the user saved, under the preset's own instructions and models.",
      handler: spawnWorkerPresetHandler,
    },
    {
      name: "agent_delegate" satisfies SpawnToolName,
      description:
        "Hand work to a teammate: a named kone agent on this project's team (agent_targets lists them with their roles). The conversation runs as that agent, under its name, instructions and model chain (yours when it names none). It starts with no memory of this conversation, so write task as just the ask, complete. Pass model only when the user asked for a specific one. why, mode and requestId work as in agent_spawn. Collect the result with agent_wait; follow up with agent_ask.",
      inputSchema: DelegateToTeammateInputSchema,
      jsonSchema: DELEGATE_TO_TEAMMATE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Hand work to a teammate on this project's team; it runs under that agent's own name and instructions.",
      handler: delegateToTeammateHandler,
    },
    {
      name: "agent_spawn_batch" satisfies SpawnToolName,
      description:
        "Start several independent kone agents in one call. Each item sets exactly one of target (a provider and model), preset, or agent (a teammate), plus its own why. Returns each agent's threadId for agent_wait; follow up on any of them with agent_ask.",
      inputSchema: SpawnBatchInputSchema,
      jsonSchema: SPAWN_BATCH_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Start several independent kone agents in one call.",
      handler: spawnBatchHandler,
    },
    {
      name: "agent_ask",
      description:
        "Queue a follow-up turn on a kone agent in your subtree (one you started, or one started under it). This is the only way to ask that agent again: every spawn tool starts a new one. It keeps its full context, so reference its earlier work rather than restating it; it runs on its own provider and mode. A busy agent takes the follow-up after its current turn; a settled one is brought back up first. Pass a stable requestId so a retry does not run it twice. Returns the new turn id: pass it with the threadId to agent_wait. To reach an agent you did not start, or to tell one something without expecting a reply, use agent_notify.",
      inputSchema: ContinueThreadInputSchema,
      jsonSchema: CONTINUE_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Queue a follow-up turn on a kone agent you started; returns a turn id to agent_wait on.",
      promptGuidelines: [
        "agent_ask queues a turn on a kone agent you started and returns a turn id you can agent_wait on; use it whenever you or the user want that agent asked again, since a second spawn is a stranger, not a follow-up. agent_notify reaches any agent on the project right now (steered mid-turn if running, woken if idle) with no reply built in.",
      ],
      handler: continueThreadHandler,
    },
    createCancelWorkerTool(),
    createDeclineChildGateTool(),
    createAnswerChildInputTool(),
    {
      name: "agent_wait",
      description:
        `Wait for kone agents you started and collect each one's final message (capped). Returns when every named agent has settled, or as soon as one parks on a question or approval that needs a human. The wait caps at ${SPAWN_WAIT_MAX_MS / 1000}s — pass timeoutMs below the cap and loop until all settle; if the call itself times out at the transport, lower timeoutMs and call again. A timeout only reports progress and cancels nothing. Pair turnIds with threadIds to pin each wait to a specific turn, so a newer turn cannot swap the response you collect. agent_read opens the full transcript when the summary is not enough.`,
      inputSchema: WaitForResponsesInputSchema,
      jsonSchema: WAIT_FOR_RESPONSES_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "Collect the replies of kone agents you started; returns early when one parks on a question or approval.",
      handler: waitForResponsesHandler,
    },
    {
      name: "agent_read",
      description:
        "Read the full transcript of a kone agent you started, or one it started in turn: every message, in order, newest last. Use it when a reply is too thin to act on, when the work failed and you need to see where, or when you need the details it worked out rather than its conclusion. Scoped to your own subtree: agents you did not start are not readable, and neither are the user's other conversations.",
      inputSchema: ReadResponseInputSchema,
      jsonSchema: READ_RESPONSE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      onDemand: true,
      promptSnippet:
        "Read the full transcript of a kone agent you started when its reply is not enough.",
      handler: readResponseHandler,
    },
  ];
}

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
import type { SpawnCaller, SpawnEngine, SpawnRequest } from "../../threadSpawn.js";
import type { InteractionMode, SpawnTarget, StoredBlock, StoredThread } from "../../types.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../schemas.js";
import {
  GatewayToolError,
  ReadThreadInputSchema,
  READ_THREAD_JSON_SCHEMA,
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
    return new GatewayToolError(error.code, error.message, error.details);
  }
  throw error;
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
    try {
      const report = await engine.targets(callerOf(ctx));
      const ready = report.providers.filter((p) => p.available).map((p) => p.provider);
      const text =
        ready.length > 0
          ? `${ready.length} provider${ready.length === 1 ? "" : "s"} ready (${ready.join(", ")}) with ${report.providers.reduce((n, p) => n + p.models.length, 0)} models across ${report.providers.length} installed provider${report.providers.length === 1 ? "" : "s"}.`
          : "No provider is currently available to spawn on.";
      return { content: [{ type: "text", text }], structuredContent: { report } };
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
        "List the providers, models and limits available to kone_spawn_thread right now. Call this when you are not certain a provider is installed or a model id is real: a spawn names an exact model, and kone refuses one it does not recognise rather than quietly substituting another. The report also tells you which model you are yourself running on, how many more children you may open, and how deep in the spawn tree you already are.",
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

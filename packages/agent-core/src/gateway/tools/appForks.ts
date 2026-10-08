import { randomUUID } from "node:crypto";

import { getConversationStore } from "../../ConversationStore.js";
import { mergeBackFork } from "../../mergeBack.js";
import { forkThreadAtTurn } from "../../threadFork.js";
import type { EmitEvent, ForkThreadAtTurnInput, MergeBackInput, ProviderKind } from "../../types.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";
import {
  ForkAppThreadInputSchema,
  FORK_APP_THREAD_JSON_SCHEMA,
  GatewayToolError,
  MergeBackAppThreadInputSchema,
  MERGE_BACK_APP_THREAD_JSON_SCHEMA,
  type ForkAppThreadInput,
  type MergeBackAppThreadInput,
} from "../schemas.js";

// The two fork gateway tools: fork a finished run at a chosen turn, and deliver
// a fork's outcome back into its source. Both are thin over threadFork.ts and
// mergeBack.ts; the tool layer only resolves the new thread id, maps the
// provider's native-fork capability, and announces the merge-back block.

export interface AppForkToolOptions {
  /** Pushes the merge-back block onto the source's timeline. Absent, the write
   *  still lands and the renderer picks it up on its next reload. */
  emit?: EmitEvent;
  /** Mints the fork's thread id. Injected so a test can name it. */
  newThreadId?: () => string;
  /** Whether a provider can fork natively (its adapter's supportsFork).
   *  Absent reads as false — the portable branch import. */
  supportsFork?: (provider: ProviderKind) => boolean;
}

function errorMessage(error: Error, fallback: string): string {
  return error.message.trim() || fallback;
}

export function createAppForkTools(options: AppForkToolOptions): ToolEntry[] {
  const forkHandler = async (
    _ctx: GatewayToolContext,
    params: ForkAppThreadInput,
  ): Promise<GatewayToolResult> => {
    const sourceProvider = getConversationStore().threadMeta(params.sourceThreadId)?.provider;
    const input: ForkThreadAtTurnInput = {
      requestId: params.requestId,
      threadId: params.threadId ?? (options.newThreadId ?? randomUUID)(),
      sourceThreadId: params.sourceThreadId,
      turnId: params.turnId,
      userBlockId: params.userBlockId ?? null,
      supportsFork: sourceProvider ? (options.supportsFork?.(sourceProvider) ?? false) : false,
    };
    if (params.target) input.target = params.target;
    if (params.title) input.title = params.title;
    let result: ReturnType<typeof forkThreadAtTurn>;
    try {
      result = forkThreadAtTurn(input);
    } catch (error) {
      throw new GatewayToolError(
        "invalid_input",
        error instanceof Error ? errorMessage(error, "Fork failed.") : "Fork failed.",
      );
    }
    return {
      content: [
        {
          type: "text",
          text: `Forked thread ${result.sourceThreadId} at turn ${params.turnId} into ${result.threadId} (${result.status}).`,
        },
      ],
      structuredContent: {
        ok: true,
        threadId: result.threadId,
        sourceThreadId: result.sourceThreadId,
        provider: result.provider,
        model: result.model ?? null,
        status: result.status,
      },
    };
  };

  const mergeHandler = async (
    _ctx: GatewayToolContext,
    params: MergeBackAppThreadInput,
  ): Promise<GatewayToolResult> => {
    let result: ReturnType<typeof mergeBackFork>;
    try {
      const mergeInput: MergeBackInput = {
        sourceThreadId: params.sourceThreadId,
        forkThreadId: params.forkThreadId,
      };
      if (params.summary) mergeInput.summaryText = params.summary;
      result = mergeBackFork(mergeInput);
    } catch (error) {
      throw new GatewayToolError(
        "invalid_input",
        error instanceof Error ? errorMessage(error, "Merge-back failed.") : "Merge-back failed.",
      );
    }
    if (options.emit) {
      const provider =
        getConversationStore().threadMeta(params.sourceThreadId)?.provider ?? "opencode";
      options.emit({
        type: "thread.message-journaled",
        threadId: params.sourceThreadId,
        provider,
        at: Date.now(),
        source: "kone.store",
        block: result.block,
      });
    }
    return {
      content: [
        {
          type: "text",
          text: `Merged fork ${params.forkThreadId} into ${params.sourceThreadId}.`,
        },
      ],
      structuredContent: {
        ok: true,
        sourceThreadId: params.sourceThreadId,
        forkThreadId: params.forkThreadId,
        blockId: result.block.id,
      },
    };
  };

  return [
    {
      name: "app_fork_thread",
      description:
        "Fork one of the app's threads from a finished run at a chosen turn: a new thread continues the conversation from that turn's end. Accepts the same target a conversation-only rewind names (sourceThreadId, turnId, userBlockId). Refuses a running thread or a turn that was rolled back. The new thread starts no provider session until its first message.",
      inputSchema: ForkAppThreadInputSchema,
      jsonSchema: FORK_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "Fork a thread from a finished turn into a new conversation that continues from there.",
      handler: forkHandler,
    },
    {
      name: "app_merge_back",
      description:
        "Deliver a fork's (or side chat's) outcome back into the thread it came from, as a summary recorded on that thread's timeline. Use it when a fork reached a conclusion the source thread needs.",
      inputSchema: MergeBackAppThreadInputSchema,
      jsonSchema: MERGE_BACK_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "Deliver a fork's outcome back into its source thread as a summary.",
      handler: mergeHandler,
    },
  ];
}

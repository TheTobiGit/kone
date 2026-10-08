import type { StoredThreadMeta } from "../../types.js";
import {
  GatewayToolError,
  RESUME_APP_THREAD_JSON_SCHEMA,
  ResumeAppThreadInputSchema,
  SNOOZE_APP_THREAD_JSON_SCHEMA,
  SnoozeAppThreadInputSchema,
  type GatewayRecord,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";

// Snooze and manual resume, as gateway tools. Kept in their own module (rather
// than appThreads.ts) so this phase's hunks stay clear of the thread-tool work
// other phases are doing.

/** The slice these tools read and drive. */
export interface AppSnoozeToolOptions {
  store: {
    threadMeta(threadId: string): StoredThreadMeta | null;
  };
  /** Set or clear a thread's snooze (null clears). */
  setSnooze(threadId: string, until: number | null): void;
  /** The thread's usage-limit reset when it is still in the future, else null. */
  snoozeUntilReset(threadId: string): number | null;
  /** Clear a usage limit and wake the thread now. */
  resumeLimited(threadId: string): Promise<void>;
}

export function createAppSnoozeTools(options: AppSnoozeToolOptions): ToolEntry[] {
  const requireThread = (threadId: string): StoredThreadMeta => {
    const meta = options.store.threadMeta(threadId);
    if (!meta) throw new GatewayToolError("not_found", `Unknown thread id: "${threadId}".`);
    return meta;
  };

  return [
    {
      name: "app_snooze_thread",
      description:
        "Snooze a conversation until a time, or until its usage limit resets, so it leaves the inbox until then; clear a snooze with until: null. It wakes early on a pending approval or question, a fresh failure, or completed work.",
      inputSchema: SnoozeAppThreadInputSchema,
      jsonSchema: SNOOZE_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_snooze_thread`: snooze a conversation until a time or its limit reset.",
      promptGuidelines: [
        "Use `app_snooze_thread` when the user wants a conversation put aside until later, not archived.",
        "Pass `untilReset: true` to snooze until the thread's usage limit resets; if it has no reset the snooze is not set and the reply says so.",
      ],
      handler: async (_ctx: GatewayToolContext, rawInput: GatewayRecord): Promise<GatewayToolResult> => {
        const input = SnoozeAppThreadInputSchema.parse(rawInput);
        requireThread(input.threadId);
        const until =
          input.untilReset === true ? options.snoozeUntilReset(input.threadId) : (input.until ?? null);
        options.setSnooze(input.threadId, until);
        const summary =
          until === null
            ? `Cleared the snooze on thread "${input.threadId}".`
            : `Snoozed thread "${input.threadId}" until ${new Date(until).toISOString()}.`;
        return {
          content: [{ type: "text", text: summary }],
          structuredContent: { threadId: input.threadId, snoozedUntil: until, summary },
        };
      },
    },
    {
      name: "app_resume_thread",
      description:
        "Resume a conversation that is waiting out a provider usage limit: clear the limit and wake it now, cancelling its scheduled resume. Refused for a thread that is not limited.",
      inputSchema: ResumeAppThreadInputSchema,
      jsonSchema: RESUME_APP_THREAD_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_resume_thread`: resume a thread waiting out a usage limit, now.",
      promptGuidelines: [
        "Use `app_resume_thread` when the user wants a limited conversation to try again before its reset.",
      ],
      handler: async (_ctx: GatewayToolContext, rawInput: GatewayRecord): Promise<GatewayToolResult> => {
        const input = ResumeAppThreadInputSchema.parse(rawInput);
        const meta = requireThread(input.threadId);
        if ((meta.limitedAt ?? null) === null) {
          throw new GatewayToolError(
            "invalid_input",
            `Thread "${input.threadId}" is not waiting on a usage limit.`,
          );
        }
        await options.resumeLimited(input.threadId);
        const summary = `Resumed thread "${input.threadId}".`;
        return {
          content: [{ type: "text", text: summary }],
          structuredContent: { threadId: input.threadId, resumed: true, summary },
        };
      },
    },
  ];
}

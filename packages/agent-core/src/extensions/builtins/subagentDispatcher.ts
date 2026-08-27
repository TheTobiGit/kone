/**
 * Built-in Subagent Dispatcher Extension for Kone.
 *
 * Provides a dynamic extension tool `delegate_subagent` allowing agents
 * to delegate tasks and coordinate child workflows with specialized roles.
 */

import { randomUUID } from "node:crypto";
import type {
  CustomToolDefinition,
  ExtensionAPI,
  ExtensionContext,
  ExtensionModule,
} from "../types.js";

export const SUBAGENT_DISPATCHER_EXTENSION_NAME = "subagent_dispatcher";

export interface SubagentDispatchArgs {
  agentRole: string;
  task: string;
  context?: Record<string, unknown> | string;
  [key: string]: unknown;
}

export type SubagentDispatchStatus =
  | "dispatched"
  | "pending"
  | "completed"
  | "failed";

export interface SubagentDispatchRecord {
  dispatchId: string;
  agentRole: string;
  task: string;
  context?: Record<string, unknown> | string;
  status: SubagentDispatchStatus;
  result?: unknown;
  error?: string;
  dispatchedAt: number;
  completedAt?: number;
  threadId?: string;
  sessionId?: string;
}

export interface SubagentDispatchResult {
  success: boolean;
  dispatchId: string;
  agentRole: string;
  task: string;
  context?: Record<string, unknown> | string;
  status: SubagentDispatchStatus;
  result?: unknown;
  message: string;
  dispatchedAt: number;
}

export type SubagentDispatcherHandler = (
  args: SubagentDispatchArgs,
  context: ExtensionContext,
) => Promise<SubagentDispatchResult | unknown> | SubagentDispatchResult | unknown;

export interface SubagentDispatcherOptions {
  dispatcher?: SubagentDispatcherHandler;
}

/**
 * Creates the delegate_subagent tool definition with an optional custom dispatcher hook.
 */
export function createDelegateSubagentTool(
  options?: SubagentDispatcherOptions,
): CustomToolDefinition {
  return {
    name: "delegate_subagent",
    description:
      "Delegate a specific task to a specialized child subagent and coordinate child workflows.",
    parameters: {
      type: "object",
      properties: {
        agentRole: {
          type: "string",
          description:
            "The role or specialization of the child subagent (e.g. 'researcher', 'reviewer', 'coder', 'debugger').",
        },
        task: {
          type: "string",
          description:
            "The specific goal, instructions, and prompt for the child subagent to perform.",
        },
        context: {
          type: "object",
          description:
            "Optional structured context, background data, or parameters to provide to the child subagent.",
        },
      },
      required: ["agentRole", "task"],
    },
    execute: async (
      rawArgs: Record<string, unknown>,
      context: ExtensionContext,
    ): Promise<unknown> => {
      const agentRole =
        typeof rawArgs.agentRole === "string" ? rawArgs.agentRole.trim() : "";
      const task =
        typeof rawArgs.task === "string" ? rawArgs.task.trim() : "";

      if (!agentRole) {
        throw new Error(
          "delegate_subagent requires a non-empty 'agentRole' string parameter",
        );
      }
      if (!task) {
        throw new Error(
          "delegate_subagent requires a non-empty 'task' string parameter",
        );
      }

      let subagentContext: Record<string, unknown> | string | undefined;
      if (
        typeof rawArgs.context === "object" &&
        rawArgs.context !== null &&
        !Array.isArray(rawArgs.context)
      ) {
        // SAFETY: Verified rawArgs.context is a non-null object and not an array
        subagentContext = rawArgs.context as Record<string, unknown>;
      } else if (typeof rawArgs.context === "string") {
        subagentContext = rawArgs.context;
      }

      const dispatchArgs: SubagentDispatchArgs = {
        agentRole,
        task,
        context: subagentContext,
      };

      const dispatchId = `sub_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const now = Date.now();

      // Check for custom dispatcher via options or context metadata
      // SAFETY: Verified context.metadata.subagentDispatcher is a function before casting to handler
      const customDispatcher: SubagentDispatcherHandler | undefined =
        options?.dispatcher ??
        (typeof context.metadata?.subagentDispatcher === "function"
          ? (context.metadata.subagentDispatcher as SubagentDispatcherHandler)
          : undefined);

      if (customDispatcher) {
        try {
          const outcome = await customDispatcher(dispatchArgs, context);

          const record: SubagentDispatchRecord = {
            dispatchId,
            agentRole,
            task,
            context: subagentContext,
            status: "completed",
            result: outcome,
            dispatchedAt: now,
            completedAt: Date.now(),
            threadId: context.threadId,
            sessionId: context.sessionId,
          };

          saveDispatchRecord(context, record);

          return (
            outcome ?? {
              success: true,
              dispatchId,
              agentRole,
              task,
              context: subagentContext,
              status: "completed",
              result: outcome,
              message: `Subagent '${agentRole}' completed task successfully.`,
              dispatchedAt: now,
            }
          );
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : String(err);

          const record: SubagentDispatchRecord = {
            dispatchId,
            agentRole,
            task,
            context: subagentContext,
            status: "failed",
            error: errorMessage,
            dispatchedAt: now,
            completedAt: Date.now(),
            threadId: context.threadId,
            sessionId: context.sessionId,
          };

          saveDispatchRecord(context, record);
          throw err;
        }
      }

      // Default dispatch recording when running standalone or in-memory
      const record: SubagentDispatchRecord = {
        dispatchId,
        agentRole,
        task,
        context: subagentContext,
        status: "dispatched",
        dispatchedAt: now,
        threadId: context.threadId,
        sessionId: context.sessionId,
      };

      saveDispatchRecord(context, record);

      const result: SubagentDispatchResult = {
        success: true,
        dispatchId,
        agentRole,
        task,
        context: subagentContext,
        status: "dispatched",
        message: `Task successfully delegated to child subagent with role '${agentRole}' (dispatchId: ${dispatchId}).`,
        dispatchedAt: now,
      };

      return result;
    },
  };
}

function saveDispatchRecord(
  context: ExtensionContext,
  record: SubagentDispatchRecord,
): void {
  const existingDispatches =
    context.storage.get<SubagentDispatchRecord[]>("dispatches") ?? [];
  existingDispatches.push(record);
  context.storage.set("dispatches", existingDispatches);
  context.storage.set(`dispatch:${record.dispatchId}`, record);
}

/**
 * Creates a Subagent Dispatcher extension module.
 */
export function createSubagentDispatcherExtension(
  options?: SubagentDispatcherOptions,
): ExtensionModule {
  return {
    name: SUBAGENT_DISPATCHER_EXTENSION_NAME,
    version: "1.0.0",
    activate(api: ExtensionAPI): void {
      const tool = createDelegateSubagentTool(options);
      api.registerTool(tool);
    },
  };
}

export const subagentDispatcherExtension: ExtensionModule =
  createSubagentDispatcherExtension();

export default subagentDispatcherExtension;

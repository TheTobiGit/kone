import type { CancelChildResult } from "../../threadSpawn.js";
import type { UserInputAnswers } from "../../types.js";
import type {
  GatewayToolContext,
  GatewayToolResult,
  ToolEntry,
} from "../schemas.js";
import {
  AnswerChildInputSchema,
  ANSWER_CHILD_INPUT_JSON_SCHEMA,
  CancelWorkerInputSchema,
  CANCEL_WORKER_JSON_SCHEMA,
  DeclineChildGateInputSchema,
  DECLINE_CHILD_GATE_JSON_SCHEMA,
} from "../schemas.js";
import { withActiveTurn } from "./spawnToolContext.js";

export function createCancelWorkerTool(): ToolEntry {
  return {
    name: "agent_withdraw",
    description:
      "Cancel a kone agent in your subtree (one you started, or one started under it): stop its running turn and release its session, without starting anything new. Name it with threadId, as an earlier spawn, delegation or batch returned it. Use it when the work is no longer needed, is going wrong, or a newer ask supersedes it; its transcript stays readable with agent_read. This never approves or answers anything parked on the agent; it stops the work as-is.",
    inputSchema: CancelWorkerInputSchema,
    jsonSchema: CANCEL_WORKER_JSON_SCHEMA,
    permission: "allow",
    requiresActiveTurn: true,
    agentsOnly: true,
    onDemand: true,
    promptSnippet:
      "Stop a kone agent you started whose work is no longer needed.",
    handler: async (
      ctx: GatewayToolContext,
      args: {
        threadId: string;
      },
    ): Promise<GatewayToolResult> => {
      return withActiveTurn(ctx, async (engine, caller) => {
        const result: CancelChildResult = await engine.cancelChild(caller, args.threadId);
        return {
          content: [
            {
              type: "text",
              text: `Cancelled agent ${result.threadId}. Its transcript stays readable with agent_read.`,
            },
          ],
          structuredContent: { cancellation: result },
        };
      });
    },
  };
}

export function createDeclineChildGateTool(): ToolEntry {
  return {
    name: "agent_decline",
    description:
      "Decline a parked approval on a kone agent in your subtree (one you started, or one started under it): answer its approval request with a rejection, so it unparks and tries an alternative. Name the agent with threadId and the parked approval with requestId, as its approval.requested event reported it. This only declines, never approves: there is no path through this tool to grant the agent a capability, and it stays running unless you stop it separately with agent_withdraw.",
    inputSchema: DeclineChildGateInputSchema,
    jsonSchema: DECLINE_CHILD_GATE_JSON_SCHEMA,
    permission: "allow",
    requiresActiveTurn: true,
    agentsOnly: true,
    onDemand: true,
    promptSnippet:
      "Decline a parked approval on a kone agent you started, so it tries another way.",
    handler: async (
      ctx: GatewayToolContext,
      args: {
        threadId: string;
        requestId: string;
      },
    ): Promise<GatewayToolResult> => {
      return withActiveTurn(ctx, async (engine, caller) => {
        const result = await engine.declineChildGate(caller, {
          threadId: args.threadId,
          requestId: args.requestId,
        });
        return {
          content: [
            {
              type: "text",
              text: `Declined the parked approval ${result.requestId} on agent ${result.threadId}. It stays running and tries an alternative — collect its next response with agent_wait.`,
            },
          ],
          structuredContent: { decline: result },
        };
      });
    },
  };
}

export function createAnswerChildInputTool(): ToolEntry {
  return {
    name: "agent_answer",
    description:
      "Answer a parked question on a kone agent in your subtree (one you started, or one started under it): supply the domain clarification its user-input request asked for, so its turn continues. Name the agent with threadId and the parked question with requestId, with answers keyed by question id (a string, a string array, or null to skip). This supplies information only, never capability: it cannot approve an action or widen what the agent may do.",
    inputSchema: AnswerChildInputSchema,
    jsonSchema: ANSWER_CHILD_INPUT_JSON_SCHEMA,
    permission: "allow",
    requiresActiveTurn: true,
    agentsOnly: true,
    onDemand: true,
    promptSnippet:
      "Answer a parked question from a kone agent you started, so its turn continues.",
    handler: async (
      ctx: GatewayToolContext,
      args: {
        threadId: string;
        requestId: string;
        answers: UserInputAnswers;
      },
    ): Promise<GatewayToolResult> => {
      return withActiveTurn(ctx, async (engine, caller) => {
        const result = await engine.answerChildInput(caller, {
          threadId: args.threadId,
          requestId: args.requestId,
          answers: args.answers,
        });
        const baseText = `Answered the parked question ${result.requestId} on agent ${result.threadId}. Its turn continues — collect its response with agent_wait.`;
        const text =
          result.followUp !== undefined ? `${baseText}\nFollow-up: ${result.followUp}` : baseText;
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
          structuredContent: { answer: result },
        };
      });
    },
  };
}

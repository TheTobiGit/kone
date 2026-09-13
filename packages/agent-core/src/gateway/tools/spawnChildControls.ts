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
    name: "kone_cancel_worker",
    description:
      "Cancel a worker you (or a descendant of yours) already spawned — stop its running turn and release its session, without opening anything new. Name the thread with threadId — an id an earlier spawn, delegation or batch returned. Use it when the work is no longer needed, is going wrong, or a newer ask supersedes it; the child's transcript stays readable with kone_read_response. This never approves or answers anything parked on the child — it stops the work as-is.",
    inputSchema: CancelWorkerInputSchema,
    jsonSchema: CANCEL_WORKER_JSON_SCHEMA,
    permission: "allow",
    requiresActiveTurn: true,
    promptSnippet:
      "Stop a worker you already spawned when its work is no longer needed, instead of leaving it running.",
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
              text: `Cancelled worker ${result.threadId}. Its transcript stays readable with kone_read_response.`,
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
    name: "kone_decline_child_gate",
    description:
      "Decline a parked approval on a worker you (or a descendant of yours) already spawned — answer the child's approval request with a rejection, so it unparks and tries an alternative. Name the thread with threadId and the parked approval with requestId, as the child's approval.requested event reported it. This only declines, never approves: there is no path through this tool to grant the child a capability, and the child stays running unless you stop it separately with kone_cancel_worker.",
    inputSchema: DeclineChildGateInputSchema,
    jsonSchema: DECLINE_CHILD_GATE_JSON_SCHEMA,
    permission: "allow",
    requiresActiveTurn: true,
    promptSnippet:
      "Decline a worker's parked approval so it tries an alternative, when its proposed action is wrong.",
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
              text: `Declined the parked approval ${result.requestId} on worker ${result.threadId}. The child stays running and tries an alternative — collect its next response with kone_wait_for_responses.`,
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
    name: "kone_answer_child_input",
    description:
      "Answer a parked question on a worker you (or a descendant of yours) already spawned — supply the domain clarification its user-input request asked for, so its turn continues. Name the thread with threadId and the parked question with requestId, with answers keyed by question id (a string, a string array, or null to skip). This supplies information only, never capability: it cannot approve an action or widen what the child may do.",
    inputSchema: AnswerChildInputSchema,
    jsonSchema: ANSWER_CHILD_INPUT_JSON_SCHEMA,
    permission: "allow",
    requiresActiveTurn: true,
    promptSnippet:
      "Answer a worker's parked question with the domain detail it asked for, so its turn continues.",
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
        const baseText = `Answered the parked question ${result.requestId} on worker ${result.threadId}. The child's turn continues — collect its response with kone_wait_for_responses.`;
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

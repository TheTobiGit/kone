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
import { z } from "zod";
import { getHandOffLifecycle, type HandOffDecision, type HandOffDecisionOutcome } from "../../handOffLifecycle.js";
import { GatewayToolError, type GatewayRecord } from "../schemas.js";
import { gatewayToolErrorResult } from "../registry.js";

export function createCancelWorkerTool(): ToolEntry {
  return {
    name: "agent_withdraw",
    description:
      "Take back work you handed off, when it is no longer needed, is going wrong, or a newer ask supersedes it. Name the thread with threadId, as an earlier start, delegation or contract returned it. A worker stops on the spot. A delegate or contractor is a co-worker, so it is told instead: it stops, starts nothing new, and replies with a short note of what it did and what is left — collect that with agent_wait. Either way its transcript stays readable with agent_read. This never approves or answers anything parked on it.",
    inputSchema: CancelWorkerInputSchema,
    jsonSchema: CANCEL_WORKER_JSON_SCHEMA,
    permission: "allow",
    requiresActiveTurn: true,
    agentsOnly: true,
    onDemand: true,
    promptSnippet: "Take back work you handed off that is no longer needed: a worker stops, an agent is told to wrap up.",
    handler: async (
      ctx: GatewayToolContext,
      args: {
        threadId: string;
      },
    ): Promise<GatewayToolResult> => {
      return withActiveTurn(ctx, async (engine, caller): Promise<GatewayToolResult> => {
        const lifecycle = getHandOffLifecycle();
        if (lifecycle && engine.isInSubtree(caller.threadId, args.threadId) && args.threadId !== caller.threadId) {
          const outcome = await lifecycle.withdraw(caller.threadId, args.threadId);
          return {
            content: [
              {
                type: "text",
                text:
                  outcome === "stopped"
                    ? `Stopped worker ${args.threadId}. Its transcript stays readable with agent_read.`
                    : `Told ${args.threadId} the task is withdrawn; it is wrapping up and will reply with what it did, which comes to you when it settles (agent_wait if you need it before going on).`,
              },
            ],
            structuredContent: { withdrawal: { threadId: args.threadId, outcome } },
          };
        }
        const result: CancelChildResult = await engine.cancelChild(caller, args.threadId);
        return {
          content: [
            {
              type: "text",
              text: `Stopped ${result.threadId}. Its transcript stays readable with agent_read.`,
            },
          ],
          structuredContent: { cancellation: result },
        };
      });
    },
  };
}

const HANDOFF_DECISIONS = ["continue", "stop", "ask_user"] as const;

export const KeepOrStopInputSchema = z.object({
  decisions: z
    .array(
      z.object({
        threadId: z.string().min(1),
        decision: z.enum(HANDOFF_DECISIONS),
      }),
    )
    .min(1)
    .max(12),
});

export const KEEP_OR_STOP_JSON_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "An agent the stop notice listed." },
          decision: {
            type: "string",
            enum: [...HANDOFF_DECISIONS],
            description:
              "continue: still worth finishing. stop: no longer wanted — it stops, and decides for its own agents in turn. ask_user: you cannot tell; ask the user in your reply.",
          },
        },
        required: ["threadId", "decision"],
      },
    },
  },
  required: ["decisions"],
} satisfies GatewayRecord;

/** How a decision reads in the summary line. */
function decisionPhrase(outcome: HandOffDecisionOutcome): string {
  switch (outcome.decision) {
    case "continue":
      return `kept ${outcome.name} running`;
    case "stop":
      return `stopped ${outcome.name}`;
    case "ask_user":
      return `left ${outcome.name} running until the user decides`;
  }
}

export function createKeepOrStopTool(): ToolEntry {
  return {
    name: "agent_keep_or_stop",
    description:
      "After the user stops you, decide what happens to the agents still working because of you — the delegates and contractors the stop notice listed. For each: continue, stop, or ask_user. A stopped one decides for its own agents the same way. Your workers already stopped with you. Use it only in the turn that follows a stop.",
    inputSchema: KeepOrStopInputSchema,
    jsonSchema: KEEP_OR_STOP_JSON_SCHEMA,
    permission: "allow",
    requiresActiveTurn: true,
    agentsOnly: true,
    onDemand: true,
    promptSnippet: "After a stop, decide for each agent still working because of you: continue, stop, or ask the user.",
    handler: async (
      ctx: GatewayToolContext,
      args: { decisions: Array<{ threadId: string; decision: HandOffDecision }> },
    ): Promise<GatewayToolResult> => {
      const lifecycle = getHandOffLifecycle();
      if (!lifecycle) {
        return gatewayToolErrorResult(new GatewayToolError("internal", "Hand-off decisions are not available."));
      }
      return withActiveTurn(ctx, async () => {
        const outcomes = await lifecycle.decide(ctx.threadId, args.decisions);
        const summary = outcomes.map(decisionPhrase).join(" · ");
        return {
          content: [{ type: "text", text: `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.` }],
          structuredContent: {
            decisions: outcomes.map((o) => ({ threadId: o.threadId, name: o.name, decision: o.decision })),
          },
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
              text: `Declined the parked approval ${result.requestId} on agent ${result.threadId}. It stays running and tries an alternative; its next response comes to you when it settles (agent_wait if you need it before going on).`,
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
        const text = `Answered the parked question ${result.requestId} on agent ${result.threadId}. Its turn continues; its response comes to you when it settles (agent_wait if you need it before going on).`;
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

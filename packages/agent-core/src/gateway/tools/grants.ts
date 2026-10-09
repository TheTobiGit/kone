import { z } from "zod";

import { GRANT_ACCESS, describeGrantAccess, type AgentGrant, type GrantAccess } from "../../agentAccess.js";
import { threadAgentName } from "../../senderHeader.js";
import type { StoredThreadMeta, ThreadLineage } from "../../types.js";
import { GatewayToolError, type GatewayRecord, type GatewayToolContext, type GatewayToolResult, type GrantSpec, type ToolEntry } from "../schemas.js";
import { isUpChain } from "./irc.js";

// Grants: an agent up a hand-off's chain shares some of its reach on the
// agent it handed work to with a named peer — "Iris may follow up with Rowan".
// Given when the work is handed off (`grants` on agent_contract and
// agent_delegate) or later, and taken back, with agent_grant.

/** What the grant tools need of the store. */
export interface GrantToolStore {
  threadMeta(threadId: string): StoredThreadMeta | null;
  threadLineage(threadId: string): ThreadLineage | null;
  listThreads(projectPath: string): StoredThreadMeta[];
  getThreadAgent?(threadId: string): { agentId: string | null } | null;
  getAgent?(agentId: string): { name: string | null } | null;
  setAgentGrant(grant: AgentGrant): boolean;
  revokeAgentGrant(granteeThreadId: string, targetThreadId: string): boolean;
  agentGrantsOn(targetThreadId: string): AgentGrant[];
}

/** The thread an agent is known by in this project: its id, or the name it
 *  runs under. Workers are no one to grant to. */
export function resolveAgentThread(store: GrantToolStore, projectPath: string, nameOrId: string): string {
  const named = nameOrId.trim();
  const direct = store.threadMeta(named);
  const isWorker = (id: string) => store.threadLineage(id)?.relationshipToParent === "subagent";
  if (direct && direct.projectPath === projectPath) {
    if (isWorker(named)) throw new GatewayToolError("invalid_input", `${named} is a worker: grants are for agents.`);
    return named;
  }
  const wanted = named.toLowerCase();
  const matches = store
    .listThreads(projectPath)
    .filter((meta) => !isWorker(meta.threadId) && threadAgentName(store, meta.threadId).toLowerCase() === wanted);
  if (matches.length === 1) return matches[0]!.threadId;
  if (matches.length === 0) {
    throw new GatewayToolError("not_found", `No agent "${named}" on this project. Name it as agent_list shows it.`);
  }
  throw new GatewayToolError(
    "invalid_input",
    `Several agents on this project are called "${named}" (${matches.map((m) => m.threadId).join(", ")}). Name the one you mean by thread id.`,
  );
}

/** Give `granteeThreadId` this access to `targetThreadId`, on behalf of an
 *  agent up the target's chain. Throws what refuses it. */
export function grantAccessOn(
  store: GrantToolStore,
  input: { grantedBy: string; target: string; grantee: string; access: GrantAccess },
): AgentGrant {
  if (!isUpChain(store, input.grantedBy, input.target)) {
    throw new GatewayToolError(
      "permission_denied",
      `You did not hand ${threadAgentName(store, input.target)} its work, so its access is not yours to share. Ask the agent that did.`,
    );
  }
  if (input.grantee === input.target) {
    throw new GatewayToolError("invalid_input", "An agent needs no grant on itself.");
  }
  if (input.grantee === input.grantedBy || isUpChain(store, input.grantee, input.target)) {
    throw new GatewayToolError(
      "invalid_input",
      `${threadAgentName(store, input.grantee)} is already up ${threadAgentName(store, input.target)}'s chain and reaches it without a grant.`,
    );
  }
  const grant: AgentGrant = {
    granteeThreadId: input.grantee,
    targetThreadId: input.target,
    access: input.access,
    grantedByThreadId: input.grantedBy,
    createdAt: Date.now(),
  };
  if (!store.setAgentGrant(grant)) throw new GatewayToolError("internal", "kone could not store the grant.");
  return grant;
}

/** The line a grant reads as, from the granting agent's side. */
function grantLine(store: GrantToolStore, grant: AgentGrant): string {
  return `${threadAgentName(store, grant.granteeThreadId)} (\`${grant.granteeThreadId}\`): ${grant.access}`;
}

/** Apply the grants a hand-off named on the agent it just started. Each is
 *  applied or refused on its own: a peer named wrong never undoes the
 *  hand-off. Returns one line saying what came of them. */
export function applyHandOffGrants(store: GrantToolStore, ctx: GatewayToolContext, target: string, specs: readonly GrantSpec[]): string {
  const given: string[] = [];
  const refused: string[] = [];
  for (const spec of specs) {
    try {
      const grantee = resolveAgentThread(store, ctx.cwd, spec.agent);
      given.push(grantLine(store, grantAccessOn(store, { grantedBy: ctx.threadId, target, grantee, access: spec.access })));
    } catch (err) {
      refused.push(`${spec.agent}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const parts: string[] = [];
  if (given.length > 0) parts.push(`Granted on it: ${given.join("; ")}.`);
  if (refused.length > 0) parts.push(`Not granted: ${refused.join("; ")}`);
  return parts.join(" ");
}

const AgentGrantInputSchema = z
  .object({
    threadId: z.string().trim().min(1),
    agent: z.string().trim().min(1).max(200),
    access: z.enum(GRANT_ACCESS).optional(),
    revoke: z.boolean().optional(),
  })
  .refine((v) => v.revoke === true || v.access !== undefined, {
    message: "Say what access to grant (read, message or followup), or set revoke to take a grant back.",
  });

const AGENT_GRANT_JSON_SCHEMA = {
  type: "object",
  properties: {
    threadId: { type: "string", description: "The agent you handed work to, as the hand-off returned it." },
    agent: { type: "string", description: "The peer the grant is for: its name or thread id, as agent_list shows it." },
    access: {
      type: "string",
      enum: [...GRANT_ACCESS],
      description:
        "read: agent_read. message: also message it as its chain does (notes ring, urgent allowed). followup: also agent_followup and agent_wait. A new grant replaces the old one.",
    },
    revoke: { type: "boolean", description: "Take the peer's grant on this agent back." },
  },
  required: ["threadId", "agent"],
} satisfies GatewayRecord;

/** agent_grant: share, change or take back a peer's reach on an agent you
 *  handed work to. */
export function createGrantTools(input: { store: GrantToolStore }): ToolEntry[] {
  const { store } = input;
  const handler = async (ctx: GatewayToolContext, args: GatewayRecord): Promise<GatewayToolResult> => {
    const parsed = AgentGrantInputSchema.parse(args);
    const grantee = resolveAgentThread(store, ctx.cwd, parsed.agent);
    const target = parsed.threadId;
    const targetName = threadAgentName(store, target);
    if (parsed.revoke === true) {
      if (!isUpChain(store, ctx.threadId, target)) {
        throw new GatewayToolError("permission_denied", `You did not hand ${targetName} its work; its grants are not yours to change.`);
      }
      const revoked = store.revokeAgentGrant(grantee, target);
      const text = revoked
        ? `${threadAgentName(store, grantee)} no longer has a grant on ${targetName}.`
        : `${threadAgentName(store, grantee)} had no grant on ${targetName}.`;
      return { content: [{ type: "text", text }], structuredContent: { revoked, grantee, target } };
    }
    // SAFETY: the schema's refine guarantees access when revoke is not set.
    const access = parsed.access as GrantAccess;
    const grant = grantAccessOn(store, { grantedBy: ctx.threadId, target, grantee, access });
    const others = store
      .agentGrantsOn(target)
      .filter((g) => g.granteeThreadId !== grantee)
      .map((g) => grantLine(store, g));
    const text =
      `${threadAgentName(store, grantee)} now has ${access} on ${targetName}: ${describeGrantAccess(access).replace(/^you /, "it ")}.` +
      (others.length > 0 ? ` Other grants on ${targetName}: ${others.join("; ")}.` : "");
    return { content: [{ type: "text", text }], structuredContent: { grant: { ...grant } } };
  };
  return [
    {
      name: "agent_grant",
      description:
        "Share your reach on an agent you handed work to with a peer, change it, or take it back (revoke). read lets the peer agent_read it; message also lets the peer message it as its chain does (its notes ring, urgent is allowed); followup also lets the peer agent_followup and agent_wait on it, and the result of a follow-up it sends goes to that peer. Use it so a lead can coordinate the agents you contracted without relaying through you. Withdrawing, answering and declining stay with you.",
      inputSchema: AgentGrantInputSchema,
      jsonSchema: AGENT_GRANT_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      agentsOnly: true,
      onDemand: true,
      promptSnippet: "Let a peer read, message or follow up an agent you handed work to, or take that back.",
      handler,
    },
  ];
}

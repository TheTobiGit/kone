// Access shared through the contract tree.
//
// The agents up a hand-off's chain reach it: they follow it up, read it, wait
// on it and withdraw it. Nobody else does, which made the orchestrator the
// only one able to reach anyone — the lead could not read the reviewer it
// coordinated. A grant lets the agent that handed work off share some of that
// reach with a named peer: to read the agent, to message it as if it were up
// its chain (its notes ring, urgent is allowed), or to follow it up and wait
// on what it does. Withdrawing, answering and declining stay with the chain.

/** What a grant lets its holder do, each level including the ones before it. */
export const GRANT_ACCESS = ["read", "message", "followup"] as const;
export type GrantAccess = (typeof GRANT_ACCESS)[number];

/** One grant: `grantee` may act on `target` at `access`, as `grantedBy` gave. */
export interface AgentGrant {
  granteeThreadId: string;
  targetThreadId: string;
  access: GrantAccess;
  grantedByThreadId: string;
  createdAt: number;
}

/** Whether holding `held` covers what `need` asks for. */
export function grantCovers(held: GrantAccess | null | undefined, need: GrantAccess): boolean {
  if (!held) return false;
  return GRANT_ACCESS.indexOf(held) >= GRANT_ACCESS.indexOf(need);
}

/** How a grant reads in a roster line or a tool result. */
export function describeGrantAccess(access: GrantAccess): string {
  switch (access) {
    case "read":
      return "you may read it (agent_read)";
    case "message":
      return "you may read it and message it as its chain does: your notes ring and urgent is allowed";
    case "followup":
      return "you may read, message, follow up (agent_followup) and wait on it (agent_wait)";
  }
}

import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentGrant } from "../../agentAccess.js";
import type { ContractTerms, StoredThreadMeta, ThreadLineage } from "../../types.js";
import { createRegistry } from "../registry.js";
import type { GatewayRecord, GatewayToolContext } from "../schemas.js";
import { applyHandOffGrants, createGrantTools, type GrantToolStore } from "./grants.js";
import { createIrcTools, IrcMailbox } from "./irc.js";

// The run this was built for, as a tree:
//
//   chalk ─┬─ iris    (contract: the lead)
//          ├─ rowan   (contract: the reviewer)
//          └─ dara    (contract: an implementer) ─── lint (dara's worker)
//   peer             (an unrelated agent on the project)

const PROJECT = "/workspace/app";

const terms = (name: string): ContractTerms => ({
  name,
  role: "r",
  instructions: "i",
  scope: "s",
  deliverable: "d",
  doneCriteria: "c",
});

class GrantStore implements GrantToolStore {
  metas = new Map<string, StoredThreadMeta>();
  grants: AgentGrant[] = [];

  add(threadId: string, parent?: { id: string; relationship: "delegation" | "subagent" }, contract?: ContractTerms): void {
    const meta: StoredThreadMeta = { threadId, projectPath: PROJECT, provider: "claudeAgent", createdAt: 1, updatedAt: 1 };
    if (parent) meta.lineage = { parentThreadId: parent.id, relationshipToParent: parent.relationship, rootThreadId: "chalk" };
    if (contract) meta.contract = contract;
    this.metas.set(threadId, meta);
  }
  threadMeta(threadId: string): StoredThreadMeta | null {
    return this.metas.get(threadId) ?? null;
  }
  threadLineage(threadId: string): ThreadLineage | null {
    return this.metas.get(threadId)?.lineage ?? null;
  }
  listThreads(): StoredThreadMeta[] {
    return [...this.metas.values()];
  }
  spawnedChildren(parentThreadId: string): StoredThreadMeta[] {
    return [...this.metas.values()].filter((m) => m.lineage?.parentThreadId === parentThreadId);
  }
  setAgentGrant(grant: AgentGrant): boolean {
    this.revokeAgentGrant(grant.granteeThreadId, grant.targetThreadId);
    this.grants.push(grant);
    return true;
  }
  revokeAgentGrant(granteeThreadId: string, targetThreadId: string): boolean {
    const before = this.grants.length;
    this.grants = this.grants.filter((g) => !(g.granteeThreadId === granteeThreadId && g.targetThreadId === targetThreadId));
    return this.grants.length < before;
  }
  agentGrant(granteeThreadId: string, targetThreadId: string): AgentGrant | null {
    return this.grants.find((g) => g.granteeThreadId === granteeThreadId && g.targetThreadId === targetThreadId) ?? null;
  }
  agentGrantsOn(targetThreadId: string): AgentGrant[] {
    return this.grants.filter((g) => g.targetThreadId === targetThreadId);
  }
}

const ctxFor = (threadId: string): GatewayToolContext => ({
  threadId,
  turnId: "turn-1",
  provider: "claudeAgent",
  cwd: PROJECT,
  requestId: 1,
});

let store: GrantStore;
let mailbox: IrcMailbox;
let registry: ReturnType<typeof createRegistry>;

beforeEach(() => {
  store = new GrantStore();
  store.add("chalk");
  store.add("iris", { id: "chalk", relationship: "delegation" }, terms("Iris"));
  store.add("rowan", { id: "chalk", relationship: "delegation" }, terms("Rowan"));
  store.add("dara", { id: "chalk", relationship: "delegation" }, terms("Dara"));
  store.add("lint", { id: "dara", relationship: "subagent" });
  store.add("peer");
  mailbox = new IrcMailbox();
  registry = createRegistry([...createGrantTools({ store }), ...createIrcTools({ store, mailbox })]);
});

const call = (from: string, tool: string, args: GatewayRecord) => registry.call(ctxFor(from), tool, args);
const textOf = (result: Awaited<ReturnType<typeof call>>) =>
  result.content.map((c) => ("text" in c ? c.text : "")).join("\n");

describe("agent_grant", () => {
  test("the agent that handed the work off shares it with a peer by name, and can take it back", async () => {
    const granted = await call("chalk", "agent_grant", { threadId: "rowan", agent: "Iris", access: "followup" });
    expect(granted.isError).toBeUndefined();
    expect(textOf(granted)).toContain("Iris now has followup on Rowan");
    expect(store.agentGrant("iris", "rowan")?.access).toBe("followup");

    const revoked = await call("chalk", "agent_grant", { threadId: "rowan", agent: "iris", revoke: true });
    expect(revoked.structuredContent).toMatchObject({ revoked: true });
    expect(store.agentGrant("iris", "rowan")).toBeNull();
  });

  test("refused from anyone not up the agent's chain, to a worker, or to one already up it", async () => {
    expect(textOf(await call("iris", "agent_grant", { threadId: "rowan", agent: "dara", access: "read" }))).toContain(
      "not yours to share",
    );
    expect(textOf(await call("chalk", "agent_grant", { threadId: "rowan", agent: "lint", access: "read" }))).toContain(
      "grants are for agents",
    );
    expect(textOf(await call("dara", "agent_grant", { threadId: "lint", agent: "chalk", access: "read" }))).toContain(
      "already up",
    );
  });

  test("a hand-off applies each grant on its own and says what came of it", () => {
    const line = applyHandOffGrants(store, ctxFor("chalk"), "dara", [
      { agent: "Iris", access: "followup" },
      { agent: "Nobody", access: "read" },
    ]);
    expect(line).toContain("Granted on it: Iris (`iris`): followup.");
    expect(line).toContain('Not granted: Nobody: No agent "Nobody" on this project.');
    expect(store.agentGrant("iris", "dara")?.access).toBe("followup");
  });
});

describe("messaging with a grant", () => {
  test("a peer granted message may send urgent, and its note to an open contractor rings", async () => {
    expect(textOf(await call("iris", "agent_message", { to: "rowan", message: "Stop.", urgent: true }))).toContain(
      "cannot send it urgent",
    );
    store.setAgentGrant({ granteeThreadId: "iris", targetThreadId: "rowan", access: "message", grantedByThreadId: "chalk", createdAt: 1 });
    const urgent = await call("iris", "agent_message", { to: "rowan", message: "Stop.", urgent: true });
    expect(urgent.isError).toBeUndefined();

    await call("iris", "agent_message", { to: "rowan", message: "Review p3 next." });
    expect(mailbox.ringingCount("rowan")).toBe(2);
  });

  test("read only is not enough to ring", async () => {
    store.setAgentGrant({ granteeThreadId: "iris", targetThreadId: "rowan", access: "read", grantedByThreadId: "chalk", createdAt: 1 });
    await call("iris", "agent_message", { to: "rowan", message: "fyi" });
    expect(mailbox.ringingCount("rowan")).toBe(0);
  });

  test("a grant lingering on a closed contract reaches nothing: no urgent, no message", async () => {
    // Dara holds followup on Iris; Iris delivers, closing its contract. The
    // grant row lingers the way a write that landed apart from the close
    // would — the reach checks still ignore it.
    store.setAgentGrant({ granteeThreadId: "dara", targetThreadId: "iris", access: "followup", grantedByThreadId: "chalk", createdAt: 1 });
    store.metas.get("iris")!.contractClosed = { at: 2, reason: "delivered" };
    const scoped = createRegistry([
      ...createGrantTools({ store }),
      ...createIrcTools({ store, mailbox, spawnedStatus: (id) => (id === "iris" ? "completed" : null) }),
    ]);
    const scopedCall = (from: string, tool: string, args: GatewayRecord) => scoped.call(ctxFor(from), tool, args);
    const urgent = await scopedCall("dara", "agent_message", { to: "iris", message: "One more thing.", urgent: true });
    expect(urgent.isError).toBe(true);
    expect(textOf(urgent)).toContain("cannot send it urgent");
    const note = await scopedCall("dara", "agent_message", { to: "iris", message: "One more thing." });
    expect(note.isError).toBe(true);
    expect(textOf(note)).toContain("contract is over");
    expect(mailbox.ringingCount("iris")).toBe(0);
  });

  test("agent_list says what the reader was granted", async () => {
    store.setAgentGrant({ granteeThreadId: "iris", targetThreadId: "rowan", access: "followup", grantedByThreadId: "chalk", createdAt: 1 });
    const list = textOf(await call("iris", "agent_list", {}));
    expect(list).toMatch(/`rowan`.*Granted to you: you may read, message, follow up/);
    expect(list).not.toMatch(/`dara`.*Granted to you/);
  });
});

describe("the crew", () => {
  test("the orchestrator's crew is its agents; a member's is its delegator and the others, never workers", async () => {
    const fromChalk = await call("chalk", "agent_message", { to: "crew", message: "Gate lock is mandatory." });
    expect(fromChalk.structuredContent).toMatchObject({ recipients: ["iris", "rowan", "dara"], outcome: "broadcast" });

    const fromIris = await call("iris", "agent_message", { to: "crew", message: "Reviews go to Rowan." });
    expect(fromIris.structuredContent).toMatchObject({ recipients: ["chalk", "rowan", "dara"] });
    // A note to everyone wakes nobody, open contract or not.
    expect(mailbox.ringingCount("rowan")).toBe(0);
  });

  test("a crew message is a note, and a worker has no crew to address", async () => {
    expect(textOf(await call("iris", "agent_message", { to: "crew", kind: "question", message: "Who has p3?" }))).toContain(
      "A broadcast is a note",
    );
    expect(textOf(await call("lint", "agent_message", { to: "crew", message: "Done." }))).toContain(
      "You are a worker",
    );
  });
});

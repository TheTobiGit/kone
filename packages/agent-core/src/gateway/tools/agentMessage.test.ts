import { beforeEach, describe, expect, test } from "bun:test";

import type { ContractTerms, StoredThreadMeta, ThreadLineage } from "../../types.js";
import { createRegistry } from "../registry.js";
import type { GatewayToolContext } from "../schemas.js";
import { createIrcTools, IrcMailbox, relationshipOf, type IrcToolStore } from "./irc.js";
import { renderIncoming } from "../../ircDelivery.js";

// agent_message: one channel across every hand-off. A tree for the whole file:
//
//   main ─┬─ backend      (delegation to a teammate)
//         ├─ frontend     (a contract)
//         │    └─ lint    (frontend's worker)
//         └─ search       (main's worker)
//   peer               (an unrelated agent on the project)

const PROJECT = "/workspace/app";

const CONTRACT: ContractTerms = {
  name: "Frontend Auth",
  role: "Frontend auth specialist",
  instructions: "Keep it small.",
  scope: "Screens.",
  deliverable: "Screens.",
  doneCriteria: "Tests pass.",
};

class TreeStore implements IrcToolStore {
  metas = new Map<string, StoredThreadMeta>();
  lineages = new Map<string, ThreadLineage>();

  add(threadId: string, parent?: { id: string; relationship: "delegation" | "subagent" }, contract?: ContractTerms): void {
    const meta: StoredThreadMeta = {
      threadId,
      projectPath: PROJECT,
      provider: "claudeAgent",
      createdAt: 1,
      updatedAt: 1,
    };
    if (parent) {
      const lineage: ThreadLineage = {
        parentThreadId: parent.id,
        relationshipToParent: parent.relationship,
        rootThreadId: "main",
      };
      meta.lineage = lineage;
      this.lineages.set(threadId, lineage);
    }
    if (contract) meta.contract = contract;
    this.metas.set(threadId, meta);
  }

  threadMeta(threadId: string): StoredThreadMeta | null {
    return this.metas.get(threadId) ?? null;
  }
  threadLineage(threadId: string): ThreadLineage | null {
    return this.lineages.get(threadId) ?? null;
  }
  spawnedChildren(parentThreadId: string): StoredThreadMeta[] {
    return [...this.metas.values()].filter((m) => m.lineage?.parentThreadId === parentThreadId);
  }
}

function ctxFor(threadId: string): GatewayToolContext {
  return { threadId, turnId: "turn-1", provider: "claudeAgent", cwd: PROJECT, requestId: 1 };
}

let store: TreeStore;
let mailbox: IrcMailbox;
let registry: ReturnType<typeof createRegistry>;

beforeEach(() => {
  store = new TreeStore();
  store.add("main");
  store.add("backend", { id: "main", relationship: "delegation" });
  store.add("frontend", { id: "main", relationship: "delegation" }, CONTRACT);
  store.add("lint", { id: "frontend", relationship: "subagent" });
  store.add("search", { id: "main", relationship: "subagent" });
  store.add("peer");
  mailbox = new IrcMailbox();
  registry = createRegistry(createIrcTools({ store, mailbox }));
});

function inbox(threadId: string) {
  return mailbox.getInbox(threadId, { peek: true }).messages;
}

describe("relationships, from the reader's side", () => {
  test("each hand-off edge reads right both ways, and anything else is a peer", () => {
    expect(relationshipOf(store, "main", "backend")).toBe("delegator");
    expect(relationshipOf(store, "backend", "main")).toBe("delegate");
    expect(relationshipOf(store, "main", "frontend")).toBe("contracting");
    expect(relationshipOf(store, "frontend", "main")).toBe("contractor");
    expect(relationshipOf(store, "main", "search")).toBe("parent");
    expect(relationshipOf(store, "search", "main")).toBe("child");
    expect(relationshipOf(store, "backend", "frontend")).toBe("peer");
    expect(relationshipOf(store, "lint", "main")).toBe("peer");
  });

  test("every recipient's copy is headed with its own relationship", async () => {
    await registry.call(ctxFor("main"), "agent_message", { to: "delegates", message: "API shape changed." });
    expect(inbox("backend")[0]?.sender).toMatchObject({ threadId: "main", relationship: "delegator", messageKind: "note" });
    expect(inbox("frontend")[0]?.sender).toMatchObject({ threadId: "main", relationship: "contracting" });
  });
});

describe("addresses", () => {
  test("delegates and children split the threads an agent handed work to", async () => {
    await registry.call(ctxFor("main"), "agent_message", { to: "children", message: "Stop at the first hit." });
    expect(inbox("search")).toHaveLength(1);
    expect(inbox("backend")).toHaveLength(0);
    await registry.call(ctxFor("main"), "agent_message", { to: "delegates", message: "Heads up." });
    expect(inbox("backend")).toHaveLength(1);
    expect(inbox("frontend")).toHaveLength(1);
    expect(inbox("search")).toHaveLength(1);
  });

  test("delegator reaches whoever handed the work over", async () => {
    await registry.call(ctxFor("frontend"), "agent_message", {
      to: "delegator",
      kind: "question",
      message: "Is OAuth in scope?",
    });
    expect(inbox("main")[0]).toMatchObject({ kind: "question", sender: { relationship: "contractor" } });
  });

  test("only the main agent may broadcast", async () => {
    const refused = await registry.call(ctxFor("backend"), "agent_message", { to: "all", message: "Hi all." });
    expect(refused.structuredContent).toMatchObject({ error: { code: "permission_denied" } });
    const sent = await registry.call(ctxFor("main"), "agent_message", { to: "all", message: "Freeze main." });
    expect(sent.isError).toBeUndefined();
  });
});

describe("workers", () => {
  test("a worker may report or ask its parent, and nothing else", async () => {
    const report = await registry.call(ctxFor("lint"), "agent_message", {
      to: "parent",
      kind: "report",
      message: "12 lint errors, all in auth/.",
    });
    expect(report.isError).toBeUndefined();
    expect(inbox("frontend")[0]?.sender).toMatchObject({ relationship: "child" });

    for (const args of [
      { to: "parent", kind: "note", message: "fyi" },
      { to: "main", kind: "report", message: "done" },
      { to: "peer", kind: "question", message: "?" },
    ]) {
      const refused = await registry.call(ctxFor("lint"), "agent_message", args);
      expect(refused.structuredContent).toMatchObject({ error: { code: "permission_denied" } });
    }
  });
});

describe("questions and answers", () => {
  test("an answer must name the question it answers", async () => {
    const res = await registry.call(ctxFor("main"), "agent_message", { to: "frontend", kind: "answer", message: "Yes." });
    expect(res.structuredContent).toMatchObject({ error: { code: "invalid_input" } });
  });

  test("a waiting question gets its answer back as the call's result", async () => {
    const asking = registry.call(ctxFor("frontend"), "agent_message", {
      to: "delegator",
      kind: "question",
      message: "OAuth too?",
      wait: true,
      timeoutMs: 5_000,
    });
    // Let the question land, then answer it the way the delegator would.
    await Promise.resolve();
    const questionId = inbox("main")[0]!.id;
    await registry.call(ctxFor("main"), "agent_message", {
      to: "frontend",
      kind: "answer",
      replyTo: questionId,
      message: "Email and password only.",
    });
    const res = await asking;
    expect(res.content[0]?.text).toContain("Email and password only.");
    // Consumed as the result: nothing left to deliver into the same turn.
    expect(mailbox.getUnreadCount("frontend")).toBe(0);
  });

  test("a hand-off's questions and answers never trip the ping-pong cap; peers' notes do", async () => {
    for (let i = 0; i < 20; i++) {
      const q = await registry.call(ctxFor("backend"), "agent_message", {
        to: "delegator",
        kind: "question",
        message: `q${i}`,
      });
      expect(q.isError).toBeUndefined();
      const a = await registry.call(ctxFor("main"), "agent_message", {
        to: "backend",
        kind: "answer",
        replyTo: "x",
        message: `a${i}`,
      });
      expect(a.isError).toBeUndefined();
    }
    let refused = false;
    for (let i = 0; i < 20 && !refused; i++) {
      const res = await registry.call(ctxFor(i % 2 ? "peer" : "backend"), "agent_message", {
        to: i % 2 ? "backend" : "peer",
        message: `chat ${i}`,
      });
      refused = res.isError === true;
    }
    expect(refused).toBe(true);
  });
});

describe("how a delivery reads", () => {
  test("each message names its sender, the relationship and the kind", () => {
    const text = renderIncoming([
      {
        id: "m1",
        from: "frontend",
        to: "delegator",
        message: "Is OAuth in scope?",
        kind: "question",
        createdAt: 1,
        read: false,
        sender: { kind: "agent", threadId: "frontend", name: "Frontend Auth", relationship: "contractor", messageKind: "question" },
      },
    ]);
    expect(text).toContain("From `Frontend Auth` (your contractor), question:");
    expect(text).toContain("waiting on you");
    expect(text).toContain('kind "answer"');
  });
});

describe("names", () => {
  /** The store with the project's thread list, which name routing reads. */
  function withThreadList(): void {
    const listed = Object.assign(store, {
      listThreads: (projectPath: string) => [...store.metas.values()].filter((m) => m.projectPath === projectPath),
    });
    registry = createRegistry(createIrcTools({ store: listed, mailbox }));
  }

  test("an agent bound to no teammate is reached by the name rolled from its thread id", async () => {
    withThreadList();
    // "backend" rolls Heron, the name the renderer shows on that thread.
    await registry.call(ctxFor("frontend"), "agent_message", { to: "heron", message: "Schema is final." });
    expect(inbox("backend")).toHaveLength(1);
    expect(inbox("backend")[0]?.sender?.name).toBe("Frontend Auth");
  });

  test("a contractor is reached by its contract name", async () => {
    withThreadList();
    await registry.call(ctxFor("backend"), "agent_message", { to: "Frontend Auth", message: "Endpoint is up." });
    expect(inbox("frontend")).toHaveLength(1);
    // And the guest it heard from is named, not described.
    expect(inbox("frontend")[0]?.sender?.name).toBe("Heron");
  });

  test("agent_list names every peer the way the user sees it", async () => {
    await registry.call(ctxFor("backend"), "agent_message", { to: "delegator", message: "Started." });
    const result = await registry.call(ctxFor("main"), "agent_list", {});
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain("Heron `backend`");
  });
});

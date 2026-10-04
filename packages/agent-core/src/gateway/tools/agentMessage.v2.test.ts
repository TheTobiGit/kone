import { beforeEach, describe, expect, test } from "bun:test";

import type { ContractTerms, SpawnedThreadStatus, StoredThreadMeta, ThreadLineage } from "../../types.js";
import type { ThreadRuntime } from "../../recipientState.js";
import { createRegistry } from "../registry.js";
import { IRC_SEND_JSON_SCHEMA, type GatewayToolContext } from "../schemas.js";
import { createIrcTools, INBOX_FULL, IrcMailbox, type IrcToolStore } from "./irc.js";

// agent_message under the ringer: what it refuses, what rings, and what the
// sender is told happened. The same tree as agentMessage.test.ts:
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

function runtime(over: Partial<ThreadRuntime> = {}): ThreadRuntime {
  return {
    live: true,
    starting: false,
    busy: false,
    turnStartedAt: null,
    parked: null,
    parkedSince: null,
    compacting: false,
    steers: true,
    activeTool: null,
    lastActivityAt: null,
    ...over,
  };
}

let store: TreeStore;
let mailbox: IrcMailbox;
let runtimes: Map<string, ThreadRuntime | null>;
let spawned: Map<string, SpawnedThreadStatus>;
let waits: Map<string, { threadIds: string[]; since: number }>;

function registryFor(deliveryV2: boolean) {
  return createRegistry(
    createIrcTools({
      store,
      mailbox,
      deliveryV2,
      threadRuntime: (id) => (runtimes.has(id) ? (runtimes.get(id) ?? null) : runtime()),
      spawnedStatus: (id) => spawned.get(id) ?? null,
      waitingOn: (id) => waits.get(id) ?? null,
    }),
  );
}

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
  runtimes = new Map();
  spawned = new Map();
  waits = new Map();
  registry = registryFor(true);
});

const send = (from: string, args: Record<string, string | boolean>) =>
  registry.call(ctxFor(from), "agent_message", args);

function refusal(result: Awaited<ReturnType<typeof send>>) {
  expect(result.isError).toBe(true);
  return JSON.stringify(result.structuredContent);
}

describe("what rings", () => {
  test("a note to a working agent waits in its inbox and rings nothing", async () => {
    runtimes.set("backend", runtime({ busy: true }));
    const sent = await send("main", { to: "backend", message: "API shape changed." });
    expect(sent.structuredContent).toMatchObject({ outcome: "inbox", urgent: false });
    expect(mailbox.ringingCount("backend")).toBe(0);
    expect(mailbox.getUnreadCount("backend")).toBe(1);
  });

  test("a question to a working agent is next, and rings", async () => {
    runtimes.set("backend", runtime({ busy: true, activeTool: { name: "Bash", text: "bun test", startedAt: 1 } }));
    const sent = await send("main", { to: "backend", kind: "question", message: "Which base?" });
    expect(sent.structuredContent).toMatchObject({ outcome: "next" });
    expect(String(sent.structuredContent?.text)).toContain("takes it when that turn ends");
    expect(mailbox.ringingCount("backend")).toBe(1);
  });

  test("urgent along a hand-off goes into the running turn", async () => {
    runtimes.set("backend", runtime({ busy: true }));
    const sent = await send("main", { to: "backend", message: "Stop: main is frozen.", urgent: true });
    expect(sent.structuredContent).toMatchObject({ outcome: "delivered", urgent: true });
    expect(mailbox.urgentCount("backend")).toBe(1);
  });

  test("urgent on a provider that cannot steer says the turn is interrupted", async () => {
    runtimes.set("backend", runtime({ busy: true, steers: false }));
    const sent = await send("main", { to: "backend", message: "Stop.", urgent: true });
    expect(sent.structuredContent).toMatchObject({ outcome: "interrupts" });
  });

  test("an idle agent is woken by what rings", async () => {
    const sent = await send("main", { to: "backend", kind: "question", message: "Done?" });
    expect(sent.structuredContent).toMatchObject({ outcome: "waking" });
  });

  test("a parked agent holds it", async () => {
    runtimes.set("backend", runtime({ busy: true, parked: "approval", parkedSince: 1 }));
    const sent = await send("main", { to: "backend", message: "Stop.", urgent: true });
    expect(sent.structuredContent).toMatchObject({ outcome: "held" });
  });

  test("starting or compacting takes it shortly", async () => {
    runtimes.set("backend", runtime({ compacting: true }));
    const sent = await send("main", { to: "backend", kind: "question", message: "Done?" });
    expect(sent.structuredContent).toMatchObject({ outcome: "soon" });
  });

  test("a closed session is brought back for a question, not for a note", async () => {
    runtimes.set("backend", null);
    const question = await send("main", { to: "backend", kind: "question", message: "Done?" });
    expect(question.structuredContent).toMatchObject({ outcome: "restarting" });
    const note = await send("main", { to: "backend", message: "fyi" });
    expect(note.structuredContent).toMatchObject({ outcome: "inbox" });
  });

  test("a broadcast is a note: it rings nobody", async () => {
    mailbox.registerThread({ threadId: "backend", projectPath: PROJECT });
    const sent = await send("main", { to: "all", message: "Freeze main." });
    expect(sent.structuredContent).toMatchObject({ outcome: "broadcast" });
    expect(mailbox.ringingCount("backend")).toBe(0);
    expect(mailbox.getUnreadCount("backend")).toBe(1);
  });
});

describe("refusals", () => {
  test("urgent from a worker", async () => {
    expect(refusal(await send("search", { to: "parent", kind: "report", message: "Found it.", urgent: true }))).toContain(
      "cannot send urgent",
    );
  });

  test("urgent to a peer, unless the main agent sends it", async () => {
    expect(refusal(await send("backend", { to: "frontend", message: "Stop.", urgent: true }))).toContain(
      "cannot send it urgent",
    );
    const fromMain = await send("main", { to: "peer", message: "Stop.", urgent: true });
    expect(fromMain.isError).toBeUndefined();
  });

  test("urgent on a broadcast", async () => {
    expect(refusal(await send("main", { to: "all", message: "Freeze.", urgent: true }))).toContain("A broadcast is a note");
  });

  test("a broadcast that asks something", async () => {
    expect(refusal(await send("main", { to: "all", kind: "question", message: "Who has auth?" }))).toContain(
      "Ask the agent you need an answer from by name",
    );
  });

  test("a message to an agent whose work is over", async () => {
    runtimes.set("backend", null);
    spawned.set("backend", "completed");
    expect(refusal(await send("main", { to: "backend", message: "One more thing." }))).toContain("agent_followup");
  });

  test("waiting on an agent that is already waiting on you", async () => {
    waits.set("backend", { threadIds: ["main"], since: 1 });
    expect(
      refusal(await send("main", { to: "backend", kind: "question", message: "Which base?", wait: true })),
    ).toContain("already waiting on you");
  });

  test("another note to an inbox that is full", async () => {
    for (let i = 0; i < INBOX_FULL; i++) {
      mailbox.sendNotice({ to: "backend", projectPath: PROJECT, message: `notice ${i}`, rings: false });
    }
    expect(refusal(await send("main", { to: "backend", message: "fyi" }))).toContain("inbox is full");
    const question = await send("main", { to: "backend", kind: "question", message: "Done?" });
    expect(question.isError).toBeUndefined();
  });
});

describe("answers", () => {
  test("an answer to something never asked goes as a note", async () => {
    const sent = await send("backend", { to: "delegator", kind: "answer", replyTo: "msg_made_up", message: "Yes." });
    expect(sent.structuredContent).toMatchObject({ kind: "note", replyTo: null });
    expect(String(sent.structuredContent?.text)).toContain("Sent as a note");
  });

  test("an answer to a question the recipient asked stays an answer", async () => {
    const asked = await send("main", { to: "backend", kind: "question", message: "Which base?" });
    const sent = await send("backend", {
      to: "delegator",
      kind: "answer",
      replyTo: String(asked.structuredContent?.messageId),
      message: "main.",
    });
    expect(sent.structuredContent).toMatchObject({ kind: "answer" });
  });
});

describe("today's routing, with the ringer off", () => {
  beforeEach(() => {
    registry = registryFor(false);
  });

  test("a note steers a working agent, and says so", async () => {
    runtimes.set("backend", runtime({ busy: true }));
    const sent = await send("main", { to: "backend", message: "API shape changed." });
    expect(sent.structuredContent).toMatchObject({ outcome: "delivered" });
    expect(mailbox.ringingCount("backend")).toBe(1);
  });

  test("urgent's rules hold either way", async () => {
    expect(refusal(await send("backend", { to: "frontend", message: "Stop.", urgent: true }))).toContain(
      "cannot send it urgent",
    );
  });

  test("an unasked answer is still sent as an answer", async () => {
    const sent = await send("backend", { to: "delegator", kind: "answer", replyTo: "msg_made_up", message: "Yes." });
    expect(sent.structuredContent).toMatchObject({ kind: "answer" });
  });
});

test("urgent is in the tool's schema", () => {
  expect(IRC_SEND_JSON_SCHEMA.properties).toHaveProperty("urgent");
});

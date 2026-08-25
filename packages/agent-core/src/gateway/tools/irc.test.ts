import { beforeEach, describe, expect, test } from "bun:test";

import type { StoredThreadMeta, ThreadLineage } from "../../types.js";
import { createRegistry } from "../registry.js";
import type { GatewayToolContext } from "../schemas.js";
import {
  GatewayToolError,
  IRC_INBOX_JSON_SCHEMA,
  IRC_MESSAGE_JSON_SCHEMA,
  IRC_SEND_JSON_SCHEMA,
  IRC_SEND_MESSAGE_JSON_SCHEMA,
  IrcInboxInputSchema,
  IrcMessageInputSchema,
  IrcSendInputSchema,
  IrcSendMessageInputSchema,
} from "../schemas.js";
import {
  createIrcTools,
  getIrcMailbox,
  IrcMailbox,
  type IrcToolStore,
  resetIrcMailbox,
} from "./irc.js";

const PROJECT_A = "/workspace/project-alpha";
const PROJECT_B = "/workspace/project-beta";

function makeCtx(overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "thread-sender",
    turnId: "turn-1",
    provider: "claudeAgent",
    model: "claude-3-7-sonnet",
    cwd: PROJECT_A,
    requestId: 1,
    ...overrides,
  };
}

class FakeIrcStore implements IrcToolStore {
  threads = new Map<string, StoredThreadMeta>();
  lineages = new Map<string, ThreadLineage>();
  agents = new Map<string, AgentRecord[]>();

  threadMeta(threadId: string): StoredThreadMeta | null {
    return this.threads.get(threadId) ?? null;
  }

  threadLineage(threadId: string): ThreadLineage | null {
    return this.lineages.get(threadId) ?? null;
  }

  listThreads(projectPath: string): StoredThreadMeta[] {
    return [...this.threads.values()].filter((t) => t.projectPath === projectPath);
  }

  listProjectAgents(projectPath: string): AgentRecord[] {
    return this.agents.get(projectPath) ?? [];
  }

  addThread(meta: Partial<StoredThreadMeta> & { threadId: string; projectPath: string }): void {
    const fullMeta: StoredThreadMeta = {
      provider: "claudeAgent",
      model: "claude-3-7-sonnet",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...meta,
      threadId: meta.threadId,
      projectPath: meta.projectPath,
    };
    this.threads.set(meta.threadId, fullMeta);
  }

  setLineage(threadId: string, lineage: ThreadLineage): void {
    this.lineages.set(threadId, lineage);
  }

  setAgents(projectPath: string, agents: AgentRecord[]): void {
    this.agents.set(projectPath, agents);
  }
}

describe("IRC Schema validation", () => {
  test("IrcSendMessageInputSchema validates valid send inputs", () => {
    const valid = IrcSendMessageInputSchema.parse({
      to: "thread-target",
      message: "Hello peer!",
    });
    expect(valid.to).toBe("thread-target");
    expect(valid.message).toBe("Hello peer!");
    expect(valid.replyTo).toBeUndefined();

    const withReply = IrcSendMessageInputSchema.parse({
      to: "thread-target",
      message: "Here is the result",
      replyTo: "msg_12345",
    });
    expect(withReply.replyTo).toBe("msg_12345");
  });

  test("IrcSendMessageInputSchema rejects invalid or empty fields", () => {
    expect(() => IrcSendMessageInputSchema.parse({ to: "", message: "Hello" })).toThrow();
    expect(() => IrcSendMessageInputSchema.parse({ to: "thread-target", message: "" })).toThrow();
    expect(() => IrcSendMessageInputSchema.parse({ message: "Hello" })).toThrow();
    expect(() => IrcSendMessageInputSchema.parse({ to: "thread-target" })).toThrow();
    expect(() =>
      IrcSendMessageInputSchema.parse({ to: "thread-target", message: "Hi", replyTo: "" }),
    ).toThrow();
  });

  test("Schema aliases match each other", () => {
    expect(IrcSendInputSchema).toBe(IrcSendMessageInputSchema);
    expect(IrcMessageInputSchema).toBe(IrcSendMessageInputSchema);
    expect(IRC_SEND_JSON_SCHEMA).toBe(IRC_SEND_MESSAGE_JSON_SCHEMA);
    expect(IRC_MESSAGE_JSON_SCHEMA).toBe(IRC_SEND_MESSAGE_JSON_SCHEMA);
  });

  test("IrcInboxInputSchema validates peek and limit options", () => {
    expect(IrcInboxInputSchema.parse({})).toEqual({});
    expect(IrcInboxInputSchema.parse({ peek: true })).toEqual({ peek: true });
    expect(IrcInboxInputSchema.parse({ limit: 5 })).toEqual({ limit: 5 });
    expect(IrcInboxInputSchema.parse({ peek: false, limit: 10 })).toEqual({
      peek: false,
      limit: 10,
    });

    expect(() => IrcInboxInputSchema.parse({ limit: 0 })).toThrow();
    expect(() => IrcInboxInputSchema.parse({ limit: -1 })).toThrow();
    expect(() => IrcInboxInputSchema.parse({ limit: 1.5 })).toThrow();
  });

  test("JSON schemas define appropriate metadata", () => {
    expect(IRC_SEND_MESSAGE_JSON_SCHEMA.type).toBe("object");
    expect(IRC_SEND_MESSAGE_JSON_SCHEMA.required).toEqual(["to", "message"]);
    expect(IRC_INBOX_JSON_SCHEMA.type).toBe("object");
  });
});

describe("IrcMailbox core engine", () => {
  let mailbox: IrcMailbox;

  beforeEach(() => {
    mailbox = new IrcMailbox();
  });

  test("Sending a message from thread A to thread B delivers it to thread B's inbox", () => {
    const sender = {
      threadId: "thread-a",
      projectPath: PROJECT_A,
    };

    const sendResult = mailbox.sendMessage(sender, {
      to: "thread-b",
      message: "Need assistance with testing task.",
    });

    expect(sendResult.delivered).toBe(true);
    expect(sendResult.recipients).toEqual(["thread-b"]);
    expect(sendResult.messageId).toMatch(/^msg_[0-9a-f-]+$/);
    expect(sendResult.message.from).toBe("thread-a");
    expect(sendResult.message.to).toBe("thread-b");
    expect(sendResult.message.message).toBe("Need assistance with testing task.");
    expect(sendResult.message.read).toBe(false);
    expect(sendResult.message.projectPath).toBe(PROJECT_A);

    // Thread A inbox should be empty
    expect(mailbox.getInbox("thread-a").messages).toEqual([]);
    expect(mailbox.getUnreadCount("thread-a")).toBe(0);

    // Thread B inbox should contain the message
    const inboxB = mailbox.getInbox("thread-b");
    expect(inboxB.messages).toHaveLength(1);
    expect(inboxB.messages[0]!.id).toBe(sendResult.messageId);
    expect(inboxB.messages[0]!.from).toBe("thread-a");
    expect(inboxB.messages[0]!.message).toBe("Need assistance with testing task.");
  });

  test("Inbox retrieval: peek: true preserves messages, normal drain consumes them", () => {
    const sender = { threadId: "thread-sender", projectPath: PROJECT_A };
    mailbox.sendMessage(sender, { to: "thread-receiver", message: "First message" });
    mailbox.sendMessage(sender, { to: "thread-receiver", message: "Second message" });

    // Initial unread count
    expect(mailbox.getUnreadCount("thread-receiver")).toBe(2);

    // 1st Peek: should retrieve all 2 unread messages without marking them as read
    const peek1 = mailbox.getInbox("thread-receiver", { peek: true });
    expect(peek1.messages).toHaveLength(2);
    expect(peek1.messages[0]!.message).toBe("First message");
    expect(peek1.messages[1]!.message).toBe("Second message");
    expect(peek1.unreadCount).toBe(2);
    expect(mailbox.getUnreadCount("thread-receiver")).toBe(2);

    // 2nd Peek: messages must still be preserved
    const peek2 = mailbox.getInbox("thread-receiver", { peek: true });
    expect(peek2.messages).toHaveLength(2);
    expect(peek2.unreadCount).toBe(2);
    expect(mailbox.getUnreadCount("thread-receiver")).toBe(2);

    // Normal drain (peek omitted / false): consumes messages and marks them as read
    const drained = mailbox.getInbox("thread-receiver");
    expect(drained.messages).toHaveLength(2);
    expect(drained.unreadCount).toBe(0);
    expect(mailbox.getUnreadCount("thread-receiver")).toBe(0);

    // Subsequent retrieval returns 0 messages
    const empty = mailbox.getInbox("thread-receiver");
    expect(empty.messages).toHaveLength(0);
    expect(empty.unreadCount).toBe(0);
  });

  test("Inbox retrieval with limit: paginates unread messages correctly", () => {
    const sender = { threadId: "thread-sender", projectPath: PROJECT_A };
    mailbox.sendMessage(sender, { to: "thread-receiver", message: "Msg 1" });
    mailbox.sendMessage(sender, { to: "thread-receiver", message: "Msg 2" });
    mailbox.sendMessage(sender, { to: "thread-receiver", message: "Msg 3" });

    expect(mailbox.getUnreadCount("thread-receiver")).toBe(3);

    // Read 1 message with peek
    const peekLimit = mailbox.getInbox("thread-receiver", { peek: true, limit: 1 });
    expect(peekLimit.messages).toHaveLength(1);
    expect(peekLimit.messages[0]!.message).toBe("Msg 1");
    expect(peekLimit.unreadCount).toBe(3);
    expect(mailbox.getUnreadCount("thread-receiver")).toBe(3);

    // Consume 1 message
    const drain1 = mailbox.getInbox("thread-receiver", { limit: 1 });
    expect(drain1.messages).toHaveLength(1);
    expect(drain1.messages[0]!.message).toBe("Msg 1");
    expect(drain1.unreadCount).toBe(2);
    expect(mailbox.getUnreadCount("thread-receiver")).toBe(2);

    // Consume next 2 messages
    const drainRest = mailbox.getInbox("thread-receiver", { limit: 5 });
    expect(drainRest.messages).toHaveLength(2);
    expect(drainRest.messages[0]!.message).toBe("Msg 2");
    expect(drainRest.messages[1]!.message).toBe("Msg 3");
    expect(drainRest.unreadCount).toBe(0);
    expect(mailbox.getUnreadCount("thread-receiver")).toBe(0);
  });

  test("replyTo message correlation across multi-turn conversation", () => {
    const threadA = { threadId: "thread-a", projectPath: PROJECT_A };
    const threadB = { threadId: "thread-b", projectPath: PROJECT_A };

    // Turn 1: A sends initial question to B
    const send1 = mailbox.sendMessage(threadA, {
      to: "thread-b",
      message: "What is the status of the database migration?",
    });
    expect(send1.message.replyTo).toBeUndefined();

    // B reads message
    const bInbox1 = mailbox.getInbox("thread-b");
    expect(bInbox1.messages).toHaveLength(1);
    const msg1 = bInbox1.messages[0]!;
    expect(msg1.id).toBe(send1.messageId);

    // Turn 2: B replies to A referencing msg1
    const send2 = mailbox.sendMessage(threadB, {
      to: "thread-a",
      message: "Migration completed successfully.",
      replyTo: msg1.id,
    });
    expect(send2.message.replyTo).toBe(msg1.id);

    // A reads B's reply and verifies replyTo correlation
    const aInbox1 = mailbox.getInbox("thread-a");
    expect(aInbox1.messages).toHaveLength(1);
    const msg2 = aInbox1.messages[0]!;
    expect(msg2.id).toBe(send2.messageId);
    expect(msg2.replyTo).toBe(msg1.id);
    expect(msg2.from).toBe("thread-b");

    // Turn 3: A replies to B acknowledging msg2
    const send3 = mailbox.sendMessage(threadA, {
      to: "thread-b",
      message: "Acknowledged and verified.",
      replyTo: msg2.id,
    });

    const bInbox2 = mailbox.getInbox("thread-b");
    expect(bInbox2.messages).toHaveLength(1);
    expect(bInbox2.messages[0]!.id).toBe(send3.messageId);
    expect(bInbox2.messages[0]!.replyTo).toBe(msg2.id);
  });

  test("Refusing messages to threads outside the project / lineage tree", () => {
    const store = new FakeIrcStore();

    store.addThread({ threadId: "thread-a1", projectPath: PROJECT_A });
    store.addThread({ threadId: "thread-a2", projectPath: PROJECT_A });
    store.addThread({ threadId: "thread-b1", projectPath: PROJECT_B });
    store.addThread({ threadId: "thread-cross-lineage", projectPath: PROJECT_B });

    // Same root thread for cross-project lineage test
    const SHARED_ROOT = "thread-root-tree";
    store.addThread({ threadId: "thread-child-a", projectPath: PROJECT_A });
    store.setLineage("thread-child-a", {
      parentThreadId: SHARED_ROOT,
      relationshipToParent: "subagent",
      rootThreadId: SHARED_ROOT,
    });

    store.addThread({ threadId: "thread-child-b", projectPath: PROJECT_B });
    store.setLineage("thread-child-b", {
      parentThreadId: SHARED_ROOT,
      relationshipToParent: "subagent",
      rootThreadId: SHARED_ROOT,
    });

    // Allowed: within same project (PROJECT_A -> PROJECT_A)
    const allowedSameProject = mailbox.sendMessage(
      { threadId: "thread-a1", projectPath: PROJECT_A },
      { to: "thread-a2", message: "Hello colleague" },
      store,
    );
    expect(allowedSameProject.delivered).toBe(true);

    // Refused: different project without common lineage (PROJECT_A -> PROJECT_B)
    expect(() =>
      mailbox.sendMessage(
        { threadId: "thread-a1", projectPath: PROJECT_A },
        { to: "thread-b1", message: "Cross-project intrusion" },
        store,
      ),
    ).toThrow(
      new GatewayToolError(
        "permission_denied",
        "Recipient is not in the same project or thread tree.",
      ),
    );

    // Allowed: different project but sharing same rootThreadId lineage
    const allowedCrossProjectSharedLineage = mailbox.sendMessage(
      { threadId: "thread-child-a", projectPath: PROJECT_A, rootThreadId: SHARED_ROOT },
      { to: "thread-child-b", message: "Cross-project collaboration in same lineage" },
      store,
    );
    expect(allowedCrossProjectSharedLineage.delivered).toBe(true);

    // Refused: in-memory registered thread in different project without lineage
    mailbox.registerThread({
      threadId: "reg-thread-b",
      projectPath: PROJECT_B,
    });

    expect(() =>
      mailbox.sendMessage(
        { threadId: "thread-a1", projectPath: PROJECT_A },
        { to: "reg-thread-b", message: "Unauthorized ping" },
      ),
    ).toThrow(
      new GatewayToolError(
        "permission_denied",
        "Recipient is not in the same project or thread tree.",
      ),
    );

    // Refused: recipient not found when store is provided
    expect(() =>
      mailbox.sendMessage(
        { threadId: "thread-a1", projectPath: PROJECT_A },
        { to: "non-existent-thread", message: "Hello phantom" },
        store,
      ),
    ).toThrow(new GatewayToolError("not_found", 'Recipient "non-existent-thread" not found.'));
  });

  test("Special recipient routing: 'parent'", () => {
    const store = new FakeIrcStore();
    store.addThread({ threadId: "parent-1", projectPath: PROJECT_A });
    store.addThread({ threadId: "child-1", projectPath: PROJECT_A });
    store.setLineage("child-1", {
      parentThreadId: "parent-1",
      relationshipToParent: "subagent",
      rootThreadId: "parent-1",
    });

    // Send to parent via sender.parentThreadId
    const res1 = mailbox.sendMessage(
      { threadId: "child-1", projectPath: PROJECT_A, parentThreadId: "parent-1" },
      { to: "parent", message: "Task update for parent" },
    );
    expect(res1.recipients).toEqual(["parent-1"]);

    // Send to parent via store lineage lookup
    const res2 = mailbox.sendMessage(
      { threadId: "child-1", projectPath: PROJECT_A },
      { to: "parent", message: "Update via store lineage" },
      store,
    );
    expect(res2.recipients).toEqual(["parent-1"]);

    // Throws not_found if thread has no parent
    expect(() =>
      mailbox.sendMessage(
        { threadId: "parent-1", projectPath: PROJECT_A },
        { to: "parent", message: "I am orphan" },
        store,
      ),
    ).toThrow(new GatewayToolError("not_found", "Thread has no parent."));
  });

  test("Special recipient routing: 'main'", () => {
    const store = new FakeIrcStore();
    store.addThread({ threadId: "root-thread", projectPath: PROJECT_A });
    store.addThread({ threadId: "sub-thread", projectPath: PROJECT_A });
    store.setLineage("sub-thread", {
      parentThreadId: "root-thread",
      relationshipToParent: "subagent",
      rootThreadId: "root-thread",
    });

    // Send to main using sender.rootThreadId
    const res1 = mailbox.sendMessage(
      { threadId: "sub-thread", projectPath: PROJECT_A, rootThreadId: "root-thread" },
      { to: "main", message: "Reporting to orchestrator" },
    );
    expect(res1.recipients).toEqual(["root-thread"]);

    // Send to main using registered 'main' agent name
    mailbox.registerThread({
      threadId: "orchestrator-thread",
      projectPath: PROJECT_A,
      agentName: "main",
    });

    const res2 = mailbox.sendMessage(
      { threadId: "worker-thread", projectPath: PROJECT_A },
      { to: "main", message: "Reporting to registered main" },
    );
    expect(res2.recipients).toEqual(["orchestrator-thread"]);
  });

  test("Special recipient routing: 'all' and '*' broadcast", () => {
    const store = new FakeIrcStore();
    store.addThread({ threadId: "sender-thread", projectPath: PROJECT_A });
    store.addThread({ threadId: "peer-1", projectPath: PROJECT_A });
    store.addThread({ threadId: "peer-2", projectPath: PROJECT_A });
    store.addThread({ threadId: "other-project-thread", projectPath: PROJECT_B });

    mailbox.registerThread({
      threadId: "reg-peer-3",
      projectPath: PROJECT_A,
    });

    const broadcastRes = mailbox.sendMessage(
      { threadId: "sender-thread", projectPath: PROJECT_A },
      { to: "all", message: "Attention team" },
      store,
    );

    expect(broadcastRes.delivered).toBe(true);
    expect(broadcastRes.recipients.sort()).toEqual(["peer-1", "peer-2", "reg-peer-3"].sort());

    // Verify inboxes of all recipients received the message
    expect(mailbox.getInbox("peer-1").messages).toHaveLength(1);
    expect(mailbox.getInbox("peer-2").messages).toHaveLength(1);
    expect(mailbox.getInbox("reg-peer-3").messages).toHaveLength(1);
    expect(mailbox.getInbox("sender-thread").messages).toHaveLength(0);
    expect(mailbox.getInbox("other-project-thread").messages).toHaveLength(0);

    // Test wildcard '*'
    const starRes = mailbox.sendMessage(
      { threadId: "sender-thread", projectPath: PROJECT_A },
      { to: "*", message: "Wildcard broadcast" },
      store,
    );
    expect(starRes.delivered).toBe(true);
    expect(starRes.recipients.sort()).toEqual(["peer-1", "peer-2", "reg-peer-3"].sort());
  });

  test("Agent name resolution routes to registered thread or store agent", () => {
    // 1. Registered thread with agent name in mailbox
    mailbox.registerThread({
      threadId: "thread-coder-id",
      projectPath: PROJECT_A,
      agentName: "Coder",
    });

    const res1 = mailbox.sendMessage(
      { threadId: "thread-sender", projectPath: PROJECT_A },
      { to: "coder", message: "Please review PR" },
    );
    expect(res1.recipients).toEqual(["thread-coder-id"]);

    // 2. Team agent from store
    const store = new FakeIrcStore();
    store.setAgents(PROJECT_A, [
      {
        agentId: "agent-architect",
        presetId: null,
        name: "Architect",
        role: "Architecture reviewer",
        instructions: "Review designs",
        faceBody: null,
        faceInk: null,
        skills: null,
        model: null,
        avatar: null,
        bot: null,
        sortOrder: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const res2 = mailbox.sendMessage(
      { threadId: "thread-sender", projectPath: PROJECT_A },
      { to: "architect", message: "Need design advice" },
      store,
    );
    expect(res2.recipients).toEqual(["agent-architect"]);
  });

  test("Clearing inboxes and thread state", () => {
    const sender = { threadId: "thread-1", projectPath: PROJECT_A };
    mailbox.sendMessage(sender, { to: "thread-2", message: "Hello 2" });
    mailbox.sendMessage(sender, { to: "thread-3", message: "Hello 3" });

    expect(mailbox.getUnreadCount("thread-2")).toBe(1);
    expect(mailbox.getUnreadCount("thread-3")).toBe(1);

    // Clear specific thread
    mailbox.clear("thread-2");
    expect(mailbox.getUnreadCount("thread-2")).toBe(0);
    expect(mailbox.getThread("thread-2")).toBeUndefined();
    expect(mailbox.getThread("thread-1")).toBeDefined();

    // Clear all
    mailbox.clear();
    expect(mailbox.getUnreadCount("thread-3")).toBe(0);
  });
});

describe("createIrcTools gateway registration and execution", () => {
  beforeEach(() => {
    resetIrcMailbox();
  });

  test("Tools export proper schemas, names, and permissions", () => {
    const tools = createIrcTools();
    expect(tools).toHaveLength(2);

    const [msgTool, inboxTool] = tools;
    expect(msgTool!.name).toBe("kone_irc_send");
    expect(msgTool!.permission).toBe("allow");
    expect(msgTool!.requiresActiveTurn).toBe(true);
    expect(msgTool!.jsonSchema).toBe(IRC_SEND_JSON_SCHEMA);

    expect(inboxTool!.name).toBe("kone_irc_inbox");
    expect(inboxTool!.permission).toBe("allow");
    expect(inboxTool!.requiresActiveTurn).toBe(false);
    expect(inboxTool!.jsonSchema).toBe(IRC_INBOX_JSON_SCHEMA);
  });

  test("kone_irc_send requires an active turn", async () => {
    const registry = createRegistry(createIrcTools());
    const ctxNoTurn = makeCtx({ turnId: null });

    const result = await registry.call(
      ctxNoTurn,
      "kone_irc_send",
      { to: "thread-target", message: "Turnless attempt" },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      code: "capability_denied",
    });
  });

  test("kone_irc_inbox does NOT require an active turn", async () => {
    const registry = createRegistry(createIrcTools());
    const ctxNoTurn = makeCtx({ threadId: "thread-reader", turnId: null });

    const result = await registry.call(ctxNoTurn, "kone_irc_inbox", {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.count).toBe(0);
    expect(result.content[0]!.text).toBe("Inbox is empty (0 unread messages).");
  });

  test("Calling kone_irc_send with invalid inputs returns invalid_input", async () => {
    const registry = createRegistry(createIrcTools());
    const ctx = makeCtx();

    const result = await registry.call(ctx, "kone_irc_send", { to: "" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      code: "invalid_input",
    });
  });

  test("Calling kone_irc_inbox with invalid inputs returns invalid_input", async () => {
    const registry = createRegistry(createIrcTools());
    const ctx = makeCtx();

    const result = await registry.call(ctx, "kone_irc_inbox", { limit: -5 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      code: "invalid_input",
    });
  });

  test("Full tool workflow: send, peek, reply, and drain via registry", async () => {
    const store = new FakeIrcStore();
    store.addThread({ threadId: "agent-alice", projectPath: PROJECT_A });
    store.addThread({ threadId: "agent-bob", projectPath: PROJECT_A });

    const registry = createRegistry(createIrcTools({ store }));

    const aliceCtx = makeCtx({ threadId: "agent-alice", turnId: "turn-a1" });
    const bobCtx = makeCtx({ threadId: "agent-bob", turnId: "turn-b1" });

    // Alice sends message to Bob
    const sendResult1 = await registry.call(
      aliceCtx,
      "kone_irc_send",
      { to: "agent-bob", message: "Could you check the logs for errors?" },
    );

    expect(sendResult1.isError).toBeUndefined();
    expect(sendResult1.structuredContent?.delivered).toBe(true);
    expect(sendResult1.structuredContent?.from).toBe("agent-alice");
    expect(sendResult1.structuredContent?.to).toBe("agent-bob");
    const aliceMsgId = String(sendResult1.structuredContent?.messageId);
    expect(aliceMsgId).toMatch(/^msg_/);

    // Bob peeks inbox (does not consume)
    const bobPeek = await registry.call(bobCtx, "kone_irc_inbox", { peek: true });
    expect(bobPeek.isError).toBeUndefined();
    expect(bobPeek.structuredContent?.count).toBe(1);
    expect(bobPeek.structuredContent?.unreadRemaining).toBe(1);
    expect(bobPeek.content[0]!.text).toContain("Could you check the logs for errors?");
    expect(bobPeek.content[0]!.text).toContain("From: agent-alice");

    // Bob drains inbox (consumes)
    const bobDrain = await registry.call(bobCtx, "kone_irc_inbox", {});
    expect(bobDrain.structuredContent?.count).toBe(1);
    expect(bobDrain.structuredContent?.unreadRemaining).toBe(0);

    // Bob replies to Alice with replyTo
    const sendResult2 = await registry.call(
      bobCtx,
      "kone_irc_send",
      {
        to: "agent-alice",
        message: "Found 2 timeout errors in worker.ts",
        replyTo: aliceMsgId,
      },
    );

    expect(sendResult2.isError).toBeUndefined();
    expect(sendResult2.structuredContent?.replyTo).toBe(aliceMsgId);

    // Alice reads Bob's reply
    const aliceDrain = await registry.call(aliceCtx, "kone_irc_inbox", {});
    expect(aliceDrain.structuredContent?.count).toBe(1);
    const messagesList = Array.isArray(aliceDrain.structuredContent?.messages)
      ? aliceDrain.structuredContent.messages
      : [];
    // SAFETY: messagesList contains parsed GatewayRecord elements.
    const receivedReply = messagesList[0] as { replyTo?: string; message?: string };
    expect(receivedReply.replyTo).toBe(aliceMsgId);
    expect(receivedReply.message).toBe("Found 2 timeout errors in worker.ts");
  });

  test("Registry handles permission_denied error for cross-project send", async () => {
    const store = new FakeIrcStore();
    store.addThread({ threadId: "agent-local", projectPath: PROJECT_A });
    store.addThread({ threadId: "agent-foreign", projectPath: PROJECT_B });

    const registry = createRegistry(createIrcTools({ store }));
    const localCtx = makeCtx({ threadId: "agent-local", turnId: "turn-l1", cwd: PROJECT_A });

    const result = await registry.call(
      localCtx,
      "kone_irc_send",
      { to: "agent-foreign", message: "Unauthorized message" },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      code: "permission_denied",
    });
    expect(result.content[0]!.text).toContain("Recipient is not in the same project or thread tree.");
  });

  test("Custom mailbox injection isolates state", async () => {
    const customMailbox = new IrcMailbox();
    const registry = createRegistry(createIrcTools({ mailbox: customMailbox }));

    const ctxA = makeCtx({ threadId: "agent-1", turnId: "turn-1" });

    await registry.call(ctxA, "kone_irc_send", { to: "agent-2", message: "Isolated message" });

    // Message is present in customMailbox
    expect(customMailbox.getUnreadCount("agent-2")).toBe(1);

    // Global default mailbox is untouched
    expect(getIrcMailbox().getUnreadCount("agent-2")).toBe(0);
  });
});

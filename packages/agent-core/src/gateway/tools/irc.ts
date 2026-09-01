import { randomUUID } from "node:crypto";

import type { ProviderKind, StoredThreadMeta, ThreadLineage } from "../../types.js";
import type { AgentRecord } from "../../ConversationStore.js";
import type {
  GatewayRecord,
  GatewayToolContext,
  GatewayToolResult,
  IrcSendInput,
  ToolEntry,
} from "../schemas.js";
import {
  GatewayToolError,
  IrcInboxInputSchema,
  IrcListInputSchema,
  IrcSendInputSchema,
  IRC_INBOX_JSON_SCHEMA,
  IRC_LIST_JSON_SCHEMA,
  IRC_SEND_JSON_SCHEMA,
} from "../schemas.js";

/** How many messages one inbox holds before the oldest is dropped.
 *
 *  A mailbox nobody drains is a leak, and a thread that has been away long
 *  enough to bank fifty messages is not going to be helped by the first one.
 *  The newest are the ones still worth acting on. */
const MAX_INBOX_MESSAGES = 50;

/** How many messages one pair may trade with nobody else involved before the
 *  bus refuses the next.
 *
 *  Two agents answering only each other never converge — each message looks
 *  like traffic deserving a reply, and the loop is self-feeding and paid for by
 *  the turn. The cap is deliberately generous: a real back-and-forth that needs
 *  more rounds than this is a decision one of them should be escalating, not a
 *  conversation. Any message involving a third party resets it, so a working
 *  fleet never trips it. */
const MAX_PAIR_EXCHANGES = 16;

/** In-memory representation of a queued inter-agent message. */
export interface IrcMessageRecord {
  id: string;
  from: string;
  to: string;
  message: string;
  replyTo?: string;
  createdAt: number;
  read: boolean;
  projectPath?: string;
}

/** Who is asking for a roster, and the scope they may see. */
export interface IrcPeerScope {
  threadId: string;
  projectPath: string;
  rootThreadId?: string;
}

/** One addressable peer, as the roster reports it. */
export interface IrcPeer {
  id: string;
  agentName?: string;
  /** The peer's OWN unread count, not the caller's: a peer with a pile of
   *  unread messages is one that has not been reading, which is worth knowing
   *  before adding to it. */
  unread: number;
  /** Whether the mailbox has seen this thread — a peer that has never sent or
   *  received is known only from the store. */
  registered: boolean;
}

export interface ThreadRegistration {
  threadId: string;
  projectPath: string;
  parentThreadId?: string | null;
  rootThreadId?: string;
  agentName?: string;
}

/** Structural store interface needed for thread resolution and project/lineage validation. */
export interface IrcToolStore {
  threadMeta?(threadId: string): StoredThreadMeta | null;
  threadLineage?(threadId: string): ThreadLineage | null;
  listThreads?(projectPath: string): StoredThreadMeta[];
  listProjectAgents?(projectPath: string): AgentRecord[];
}

export interface IrcToolInput {
  store?: IrcToolStore;
  mailbox?: IrcMailbox;
  /** Whether a peer has a live session right now. A message to a live peer
   *  interrupts it and costs it a turn; one to a peer that is away costs
   *  nothing until it returns. The roster says which, because that difference
   *  is the whole economics of sending. */
  isThreadLive?: (threadId: string) => boolean;
}

/**
 * In-memory thread mailbox allowing agents in the same project/parent tree
 * to send direct messages and check their inboxes.
 */
export class IrcMailbox {
  private inboxes = new Map<string, IrcMessageRecord[]>();
  private threads = new Map<string, ThreadRegistration>();
  private agentToThread = new Map<string, string>();
  private deliveryListeners = new Set<(recipientThreadId: string, message: Readonly<IrcMessageRecord>) => void>();
  /** Consecutive messages traded between a pair with nobody else involved —
   *  the ping-pong counter MAX_PAIR_EXCHANGES cuts off. Keyed by unordered
   *  pair; an exchange involving anyone else resets it (see recordExchange). */
  private pairExchanges = new Map<string, number>();

  private agentKey(projectPath: string, agentName: string): string {
    return `${projectPath}::${agentName.toLowerCase()}`;
  }

  /** Register or update a thread's metadata in the mailbox. */
  registerThread(info: ThreadRegistration): void {
    this.threads.set(info.threadId, info);
    if (info.agentName) {
      this.agentToThread.set(this.agentKey(info.projectPath, info.agentName), info.threadId);
    }
  }

  /** Retrieve registered thread info. */
  getThread(threadId: string): ThreadRegistration | undefined {
    return this.threads.get(threadId);
  }

  /**
   * Register a message delivery notification handler.
   * Invoked synchronously with an immutable copy whenever a message is delivered to any thread inbox.
   */
  onMessageDelivered(listener: (recipientThreadId: string, message: Readonly<IrcMessageRecord>) => void): () => void {
    this.deliveryListeners.add(listener);
    return () => {
      this.deliveryListeners.delete(listener);
    };
  }

  /**
   * Resolve recipient identifier to one or more thread IDs within the sender's scope.
   */
  resolveRecipients(
    sender: {
      threadId: string;
      projectPath: string;
      rootThreadId?: string;
      parentThreadId?: string | null;
    },
    to: string,
    store?: IrcToolStore,
  ): string[] {
    const trimmed = to.trim();
    if (!trimmed) {
      throw new GatewayToolError("invalid_input", "Recipient cannot be empty.");
    }

    // 1. Direct parent routing
    if (trimmed.toLowerCase() === "parent") {
      let parentId = sender.parentThreadId;
      if (!parentId && store?.threadLineage) {
        parentId = store.threadLineage(sender.threadId)?.parentThreadId ?? undefined;
      }
      if (!parentId) {
        const reg = this.threads.get(sender.threadId);
        parentId = reg?.parentThreadId ?? undefined;
      }
      if (!parentId) {
        throw new GatewayToolError("not_found", "Thread has no parent.");
      }
      return [parentId];
    }

    // 2. Broadcast to all peers in the project / tree
    if (trimmed.toLowerCase() === "all" || trimmed === "*") {
      const recipientSet = new Set<string>();

      // From mailbox registrations
      for (const [id, reg] of this.threads.entries()) {
        if (id === sender.threadId) continue;
        if (
          reg.projectPath === sender.projectPath ||
          (sender.rootThreadId && reg.rootThreadId === sender.rootThreadId)
        ) {
          recipientSet.add(id);
        }
      }

      // From store
      if (store?.listThreads) {
        const stored = store.listThreads(sender.projectPath);
        for (const meta of stored) {
          if (meta.threadId !== sender.threadId) {
            recipientSet.add(meta.threadId);
          }
        }
      }

      return Array.from(recipientSet);
    }

    // 3. Main / root orchestrator routing
    if (trimmed.toLowerCase() === "main") {
      let rootId = sender.rootThreadId;
      if (!rootId && store?.threadLineage) {
        rootId = store.threadLineage(sender.threadId)?.rootThreadId ?? undefined;
      }
      if (!rootId) {
        const reg = this.threads.get(sender.threadId);
        rootId = reg?.rootThreadId ?? undefined;
      }
      if (rootId && rootId !== sender.threadId) {
        return [rootId];
      }
      const scopedMain = this.agentToThread.get(this.agentKey(sender.projectPath, "main"));
      if (scopedMain && scopedMain !== sender.threadId) {
        return [scopedMain];
      }
      for (const [id, reg] of this.threads.entries()) {
        if (
          id !== sender.threadId &&
          reg.agentName?.toLowerCase() === "main" &&
          (reg.projectPath === sender.projectPath ||
            (Boolean(sender.rootThreadId) && reg.rootThreadId === sender.rootThreadId))
        ) {
          return [id];
        }
      }
    }

    // 4. Check registered agent name mapping (project-scoped)
    const scopedAgent = this.agentToThread.get(this.agentKey(sender.projectPath, trimmed));
    if (scopedAgent) {
      return [scopedAgent];
    }

    // Check by iterating threads in same project or lineage
    for (const [id, reg] of this.threads.entries()) {
      if (
        id !== sender.threadId &&
        reg.agentName?.toLowerCase() === trimmed.toLowerCase() &&
        (reg.projectPath === sender.projectPath ||
          (Boolean(sender.rootThreadId) && reg.rootThreadId === sender.rootThreadId))
      ) {
        return [id];
      }
    }

    // 5. Store lookup for target thread
    if (store?.threadMeta) {
      const meta = store.threadMeta(trimmed);
      if (meta) {
        // Validate project or lineage scope
        const sameProject = meta.projectPath === sender.projectPath;
        let sameLineage = false;
        if (!sameProject && store.threadLineage) {
          const targetLineage = store.threadLineage(trimmed);
          const senderLineage = store.threadLineage(sender.threadId);
          const targetRoot = targetLineage?.rootThreadId ?? trimmed;
          const senderRoot = senderLineage?.rootThreadId ?? sender.rootThreadId ?? sender.threadId;
          if (targetRoot && senderRoot && targetRoot === senderRoot) {
            sameLineage = true;
          }
        }

        if (!sameProject && !sameLineage) {
          throw new GatewayToolError(
            "permission_denied",
            "Recipient is not in the same project or thread tree.",
          );
        }

        return [trimmed];
      }

      // Check team agents
      if (store.listProjectAgents) {
        const agents = store.listProjectAgents(sender.projectPath);
        const match = agents.find(
          (a) =>
            (a.name !== null && a.name.toLowerCase() === trimmed.toLowerCase()) ||
            a.agentId.toLowerCase() === trimmed.toLowerCase(),
        );
        if (match) {
          const matchName = match.name ?? match.agentId;
          const scoped = this.agentToThread.get(this.agentKey(sender.projectPath, matchName));
          if (scoped) return [scoped];
          for (const [id, reg] of this.threads.entries()) {
            if (
              (reg.agentName?.toLowerCase() === matchName.toLowerCase() || reg.threadId === match.agentId) &&
              (reg.projectPath === sender.projectPath ||
                (Boolean(sender.rootThreadId) && reg.rootThreadId === sender.rootThreadId))
            ) {
              return [id];
            }
          }
          return [match.agentId];
        }
      }
    }

    // 6. Registered thread in mailbox lookup
    const registeredTarget = this.threads.get(trimmed);
    if (registeredTarget) {
      const sameProject = registeredTarget.projectPath === sender.projectPath;
      const targetRoot = registeredTarget.rootThreadId ?? registeredTarget.threadId;
      const senderRoot = sender.rootThreadId ?? sender.threadId;
      const sameLineage = Boolean(targetRoot) && Boolean(senderRoot) && targetRoot === senderRoot;
      if (!sameProject && !sameLineage) {
        throw new GatewayToolError(
          "permission_denied",
          "Recipient is not in the same project or thread tree.",
        );
      }
      return [trimmed];
    }

    // 7. If store was provided and thread wasn't found, reject
    if (store?.threadMeta) {
      throw new GatewayToolError("not_found", `Recipient "${trimmed}" not found.`);
    }

    // 8. In-memory standalone mode fallback: route directly to target threadId
    return [trimmed];
  }

  /**
   * Send a direct message to one or more recipient threads.
   */
  sendMessage(
    sender: {
      threadId: string;
      projectPath: string;
      rootThreadId?: string;
      parentThreadId?: string | null;
      model?: string;
      provider?: ProviderKind;
    },
    input: IrcSendInput,
    store?: IrcToolStore,
  ) {
    // Ensure sender is registered in memory
    if (!this.threads.has(sender.threadId)) {
      this.registerThread({
        threadId: sender.threadId,
        projectPath: sender.projectPath,
        parentThreadId: sender.parentThreadId,
        rootThreadId: sender.rootThreadId,
      });
    }

    const recipients = this.resolveRecipients(sender, input.to, store);
    this.guardPingPong(sender.threadId, recipients);
    const messageId = `msg_${randomUUID()}`;
    const createdAt = Date.now();

    const record: IrcMessageRecord = {
      id: messageId,
      from: sender.threadId,
      to: input.to,
      message: input.message,
      createdAt,
      read: false,
      projectPath: sender.projectPath,
    };
    if (input.replyTo !== undefined) {
      record.replyTo = input.replyTo;
    }

    for (const recipientId of recipients) {
      let queue = this.inboxes.get(recipientId);
      if (!queue) {
        queue = [];
        this.inboxes.set(recipientId, queue);
      }
      const messageCopy = { ...record };
      // Push a distinct record copy for independent read tracking if needed
      queue.push(messageCopy);
      // Oldest first: a backlog this deep means nobody has been reading, and the
      // newest messages are the ones still worth acting on.
      if (queue.length > MAX_INBOX_MESSAGES) queue.splice(0, queue.length - MAX_INBOX_MESSAGES);

      // Auto-register recipient if not present and no external store was given
      if (!this.threads.has(recipientId) && !store) {
        this.registerThread({
          threadId: recipientId,
          projectPath: sender.projectPath,
        });
      }

      // Notify delivery listeners with an immutable copy
      const readOnlyCopy = Object.freeze({ ...messageCopy });
      for (const listener of this.deliveryListeners) {
        try {
          listener(recipientId, readOnlyCopy);
        } catch {
          // Guard against listener failure
        }
      }
    }

    return {
      messageId,
      delivered: recipients.length > 0,
      recipients,
      message: record,
    };
  }

  /**
   * Refuse a message that would extend a two-agent ping-pong past the cap, and
   * otherwise record the exchange.
   *
   * The refusal is thrown at the SENDER, in its own turn, where it can still do
   * something about it — the alternative is delivering the message and hoping
   * the recipient breaks the loop, which is the same hope that made the loop.
   * Anything involving a third party resets the pair, so this only ever catches
   * a genuinely closed conversation.
   */
  private guardPingPong(from: string, recipients: string[]): void {
    // A broadcast is by definition not a two-agent loop, and counting it would
    // punish the one message shape that involves everybody.
    if (recipients.length !== 1) {
      this.pairExchanges.clear();
      return;
    }
    const to = recipients[0]!;
    const key = this.pairKey(from, to);
    const count = this.pairExchanges.get(key) ?? 0;
    if (count >= MAX_PAIR_EXCHANGES) {
      throw new GatewayToolError(
        "permission_denied",
        `You and "${to}" have traded ${MAX_PAIR_EXCHANGES} messages with nobody else involved. Decide with what you have, or tell your spawner the exact decision you are stuck on.`,
      );
    }
    // Any other pair either agent belongs to is no longer a closed loop. Split
    // rather than substring-match: one thread id can contain another.
    for (const other of this.pairExchanges.keys()) {
      if (other === key) continue;
      const [a, b] = other.split("\u0000");
      if (a === from || b === from || a === to || b === to) this.pairExchanges.delete(other);
    }
    this.pairExchanges.set(key, count + 1);
  }

  /** Unordered pair key — a loop is a loop whichever way the last message went. */
  private pairKey(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  }

  /**
   * The peers this thread may address, with the state a sender needs to decide
   * whether a message is worth it.
   *
   * Addressing is the half agents get wrong on their own: without a roster they
   * invent plausible names, the send fails, and the failure reads as "messaging
   * is broken" rather than "that agent does not exist".
   */
  listPeers(sender: IrcPeerScope, store?: IrcToolStore): IrcPeer[] {
    const ids = new Set<string>();
    for (const [id, reg] of this.threads.entries()) {
      if (id === sender.threadId) continue;
      const sameProject = reg.projectPath === sender.projectPath;
      const sameLineage = Boolean(sender.rootThreadId) && reg.rootThreadId === sender.rootThreadId;
      if (sameProject || sameLineage) ids.add(id);
    }
    if (store?.listThreads) {
      for (const meta of store.listThreads(sender.projectPath)) {
        if (meta.threadId !== sender.threadId) ids.add(meta.threadId);
      }
    }
    return Array.from(ids).map((id) => {
      const reg = this.threads.get(id);
      const peer: IrcPeer = { id, unread: this.getUnreadCount(id), registered: reg !== undefined };
      if (reg?.agentName) peer.agentName = reg.agentName;
      return peer;
    });
  }

  /**
   * Read incoming messages from the thread's inbox.
   */
  getInbox(
    threadId: string,
    options?: { peek?: boolean; limit?: number },
  ) {
    const queue = this.inboxes.get(threadId) ?? [];
    const peek = options?.peek === true;
    const limit = options?.limit && options.limit > 0 ? options.limit : undefined;

    // Filter unread messages
    const unreadIndices: number[] = [];
    const unreadMessages: IrcMessageRecord[] = [];

    for (let i = 0; i < queue.length; i++) {
      if (!queue[i]!.read) {
        unreadIndices.push(i);
        unreadMessages.push(queue[i]!);
      }
    }

    const countToTake = limit !== undefined ? Math.min(limit, unreadMessages.length) : unreadMessages.length;
    const selectedMessages = unreadMessages.slice(0, countToTake);

    if (!peek) {
      // Mark selected messages as read
      for (let i = 0; i < countToTake; i++) {
        const idx = unreadIndices[i]!;
        queue[idx]!.read = true;
      }
    }

    const remainingUnread = unreadMessages.length - (peek ? 0 : countToTake);

    return {
      messages: selectedMessages,
      unreadCount: remainingUnread,
    };
  }

  /**
   * Get the count of unread messages for a thread.
   */
  getUnreadCount(threadId: string): number {
    const queue = this.inboxes.get(threadId) ?? [];
    return queue.filter((m) => !m.read).length;
  }

  /**
   * Clear inbox or all state.
   */
  clear(threadId?: string): void {
    if (threadId) {
      const reg = this.threads.get(threadId);
      if (reg?.agentName) {
        this.agentToThread.delete(this.agentKey(reg.projectPath, reg.agentName));
      }
      this.inboxes.delete(threadId);
      this.threads.delete(threadId);
    } else {
      this.inboxes.clear();
      this.threads.clear();
      this.agentToThread.clear();
      this.pairExchanges.clear();
    }
  }
}

// Global default instance
let defaultMailbox: IrcMailbox | null = null;

export function getIrcMailbox(): IrcMailbox {
  if (!defaultMailbox) {
    defaultMailbox = new IrcMailbox();
  }
  return defaultMailbox;
}

export function resetIrcMailbox(): void {
  if (defaultMailbox) {
    defaultMailbox.clear();
  }
  defaultMailbox = null;
}

// ── what the agent is told ───────────────────────────────────────────────────
// These descriptions are the only place an agent learns the economics, and the
// economics are the whole design. A message is not a notification: it interrupts
// a running peer or wakes an idle one, and either way somebody pays for a turn
// they did not plan. An agent that does not know that treats messaging like
// chat, and two agents treating it like chat is a loop that bills.
//
// So each one leads with the cost, then with the test — does this change what
// somebody DOES — then with the list of things never worth sending. The refusals
// are spelled out because the failure mode is not one bad message, it is the
// reflex to acknowledge, which manufactures the next message from the other side.

const IRC_SEND_DESCRIPTION = [
  "Send a short text message to another agent working on this project — whether that peer is running right now or idle. Both are reachable: a running peer has your message steered into its active turn, and an idle peer is woken with a new turn on its existing thread, keeping whatever it was doing. There is no such thing as a peer that has gone unreachable by settling — idle means waiting, not closed.",
  "",
  "A message is not free. It interrupts a peer that is running, or wakes one that is idle, and costs it a whole turn to read. `to: \"all\"` charges that to every peer at once. Call `kone_irc_list` first to see who exists and whether they are running; address peers by their exact id and never invent one.",
  "",
  "`to` also takes `parent` (the thread that spawned you), `main` (the root of your tree), or `all`. Set `replyTo` when you are answering, so the sender can correlate it. Lead with the answer; never quote the question back. Plain prose only — no JSON status objects, no pasted file contents, reference files by path instead.",
  "",
  "Send when the message changes what somebody DOES:",
  "- You are about to edit a file another agent may be holding, or you need one they hold. Say so before editing, not after.",
  "- You hit a decision that is not yours, or a state that contradicts your brief. Name the decision to whoever spawned you.",
  "- You found something that makes a peer's current work wrong, so they can stop rather than finish it.",
  "- A peer asked you something they cannot proceed without.",
  "",
  "Never send:",
  "- A bare acknowledgement. \"Got it\", \"will do\", \"thanks\", \"noted\" cost the reader a turn and tell them nothing, and each one looks like traffic that deserves a reply — which is what a two-agent loop is made of. Silence is the acknowledgement.",
  "- A progress report, a plan, or an announcement that you are starting. Whoever spawned you reads your result when you finish.",
  "- Anything a tool would answer for you: a grep, a build, a file read, or what a peer is currently doing.",
  "- The next line of a back-and-forth. Two agents that only answer each other never converge. The bus refuses the message once a pair has traded 16 with nobody else involved — long before that, decide with what you have or escalate the exact decision.",
].join("\n");

const IRC_LIST_DESCRIPTION = [
  "List the agents you can message on this project: their ids, whether each is running right now, and how many messages each has unread.",
  "",
  "Read it before sending. A peer that is running will be interrupted; one that is away will not see you until it returns; one with a pile of unread messages is not reading, and adding to the pile will not change that.",
].join("\n");

const IRC_INBOX_DESCRIPTION = [
  "Read messages other agents sent you.",
  "",
  "You do not need to poll this. A message delivered while you are running is folded into your turn, and one that arrives while you are idle wakes you with it. This is for catching up deliberately — what came in while you could not be reached, or a second look at something already delivered.",
].join("\n");

/**
 * Creates the IRC gateway tools: `kone_irc_send`, `kone_irc_list` and
 * `kone_irc_inbox`.
 */
export function createIrcTools(input: IrcToolInput = {}): ToolEntry[] {
  const mailbox = input.mailbox ?? getIrcMailbox();

  const sendHandler = async (
    ctx: GatewayToolContext,
    args: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const parsed = IrcSendInputSchema.parse(args);

    let parentThreadId: string | null | undefined;
    let rootThreadId: string | undefined;

    if (input.store?.threadLineage) {
      const lineage = input.store.threadLineage(ctx.threadId);
      parentThreadId = lineage?.parentThreadId;
      rootThreadId = lineage?.rootThreadId;
    }

    const result = mailbox.sendMessage(
      {
        threadId: ctx.threadId,
        projectPath: ctx.cwd,
        parentThreadId,
        rootThreadId,
        model: ctx.model,
        provider: ctx.provider,
      },
      parsed,
      input.store,
    );

    const recipientDesc =
      result.recipients.length === 1
        ? result.recipients[0]
        : `${result.recipients.length} recipients (${result.recipients.join(", ")})`;

    return {
      content: [
        {
          type: "text",
          text: `Message ${result.messageId} sent to ${parsed.to} [${recipientDesc}].`,
        },
      ],
      structuredContent: {
        messageId: result.messageId,
        from: ctx.threadId,
        to: parsed.to,
        delivered: result.delivered,
        recipients: result.recipients,
        replyTo: parsed.replyTo ?? null,
        createdAt: result.message.createdAt,
      },
    };
  };

  const inboxHandler = async (
    ctx: GatewayToolContext,
    args: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const parsed = IrcInboxInputSchema.parse(args);
    const result = mailbox.getInbox(ctx.threadId, {
      peek: parsed.peek,
      limit: parsed.limit,
    });

    const text =
      result.messages.length === 0
        ? "Inbox is empty (0 unread messages)."
        : `Retrieved ${result.messages.length} message${
            result.messages.length === 1 ? "" : "s"
          } (unread remaining: ${result.unreadCount}):\n` +
          result.messages
            .map(
              (m) =>
                `[${m.id}] From: ${m.from}${
                  m.replyTo ? ` (replyTo: ${m.replyTo})` : ""
                } at ${new Date(m.createdAt).toISOString()}:\n${m.message}`,
            )
            .join("\n\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: {
        messages: result.messages.map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          message: m.message,
          replyTo: m.replyTo ?? null,
          createdAt: m.createdAt,
        })),
        count: result.messages.length,
        unreadRemaining: result.unreadCount,
      },
    };
  };

  const listHandler = async (ctx: GatewayToolContext): Promise<GatewayToolResult> => {
    let rootThreadId: string | undefined;
    if (input.store?.threadLineage) {
      rootThreadId = input.store.threadLineage(ctx.threadId)?.rootThreadId;
    }
    const sender: IrcPeerScope = { threadId: ctx.threadId, projectPath: ctx.cwd };
    if (rootThreadId) sender.rootThreadId = rootThreadId;
    const peers = input.store
      ? mailbox.listPeers(sender, input.store)
      : mailbox.listPeers(sender);
    const rows = peers.map((peer) => ({
      ...peer,
      live: input.isThreadLive?.(peer.id) ?? false,
    }));

    const text =
      rows.length === 0
        ? "No peers — you are the only agent in this project right now."
        : rows
            .map(
              (p) =>
                `${p.agentName ? `${p.agentName} ` : ""}\`${p.id}\` — ${
                  p.live ? "running (a message interrupts it)" : "away (a message waits)"
                }, ${p.unread} unread`,
            )
            .join("\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: { peers: rows, count: rows.length },
    };
  };

  return [
    {
      name: "kone_irc_send",
      description: IRC_SEND_DESCRIPTION,
      inputSchema: IrcSendInputSchema,
      jsonSchema: IRC_SEND_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Reach another agent working this project — running or idle, both are reachable: a running peer is steered mid-turn, an idle one wakes with a new turn on its existing thread. Waiting only collects outcomes at the end; messaging changes what somebody does.",
      promptGuidelines: [
        "Use a message to claim a file before you edit it, to name a decision that is not yours, or to stop a peer whose work you have just made pointless.",
        "A message costs the agent that receives it a full turn, so send only what changes what somebody does. Never send an acknowledgement, a progress report, or a plan: silence is the acknowledgement, and two agents answering only each other is a loop that bills the user for both sides.",
        "An idle peer is not a closed one — it is woken with a new turn on its own thread. Do not re-spawn or re-delegate to reach someone who has merely settled.",
      ],
      handler: sendHandler,
    },
    {
      name: "kone_irc_list",
      description: IRC_LIST_DESCRIPTION,
      inputSchema: IrcListInputSchema,
      jsonSchema: IRC_LIST_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "See who else exists on this project and who is running.",
      handler: listHandler,
    },
    {
      name: "kone_irc_inbox",
      description: IRC_INBOX_DESCRIPTION,
      inputSchema: IrcInboxInputSchema,
      jsonSchema: IRC_INBOX_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "Catch up on messages that arrived while you were away — you never need to poll it, because a message delivered to you arrives in your turn on its own.",
      handler: inboxHandler,
    },
  ];
}

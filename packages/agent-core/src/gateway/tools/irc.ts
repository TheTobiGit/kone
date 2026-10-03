import { randomUUID } from "node:crypto";

import { COURIER_AGENT_ID, type CourierSender } from "@kone/protocol/message-sender";
import type { AgentSender, ProviderKind, SenderRelationship, StoredThreadMeta, ThreadLineage } from "../../types.js";
import { agentSenderFor, threadAgentName } from "../../senderHeader.js";
import type { AgentRecord } from "../../ConversationStore.js";
import type {
  GatewayRecord,
  GatewayToolContext,
  GatewayToolResult,
  IrcSendInput,
  ToolEntry,
} from "../schemas.js";
import {
  AGENT_MESSAGE_WAIT_MAX_MS,
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

/** What an agent_message is for. */
export type AgentMessageKind = "note" | "question" | "pushback" | "report" | "answer";

/** In-memory representation of a queued inter-agent message. */
export interface IrcMessageRecord {
  id: string;
  from: string;
  to: string;
  message: string;
  /** Absent on a message from before kinds existed; reads as a note. */
  kind?: AgentMessageKind;
  replyTo?: string;
  createdAt: number;
  read: boolean;
  projectPath?: string;
  /** Who sent it, as THIS copy's recipient relates to them — each recipient
   *  gets its own copy, so a broadcast reads "your worker" to one agent and
   *  "teammate" to another. Absent when no store could say. A courier sender is
   *  kone's own agent carrying something, never another agent speaking. */
  sender?: AgentSender | CourierSender;
  /** The transcript block it was written as, set once it is on the
   *  recipient's transcript — so a delivery retried after a failed send does
   *  not write it twice, and the turn that delivers it can name its block. */
  blockId?: string;
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

/** One agent_list row: a peer and whether it is running. A type alias rather
 *  than an interface extending IrcPeer, because it has to pass as a gateway
 *  value and only an alias carries the implicit index signature. */
type PeerRow = { id: string; agentName?: string; unread: number; registered: boolean; live: boolean };

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
  /** The threads a parent handed work to — what `delegates` and `children`
   *  resolve against. */
  spawnedChildren?(parentThreadId: string): StoredThreadMeta[];
  /** Who a thread runs as, for the sender's name. */
  getThreadAgent?(threadId: string): { agentId: string | null } | null;
  getAgent?(agentId: string): { name: string | null } | null;
}

/**
 * How the sender relates to one recipient, from the recipient's side — the
 * relationship its copy of the message is headed with. Only a direct hand-off
 * edge counts: a thread's own parent and its own children. Everyone else on
 * the project is a peer.
 */
export function relationshipOf(store: IrcToolStore | undefined, fromThreadId: string, toThreadId: string): SenderRelationship {
  const fromLineage = store?.threadLineage?.(fromThreadId);
  if (fromLineage?.parentThreadId === toThreadId) {
    // The sender works for the recipient.
    if (fromLineage.relationshipToParent === "subagent") return "child";
    return store?.threadMeta?.(fromThreadId)?.contract ? "contractor" : "delegate";
  }
  const toLineage = store?.threadLineage?.(toThreadId);
  if (toLineage?.parentThreadId === fromThreadId) {
    // The recipient works for the sender.
    if (toLineage.relationshipToParent === "subagent") return "parent";
    return store?.threadMeta?.(toThreadId)?.contract ? "contracting" : "delegator";
  }
  return "peer";
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

    // 0. The agents or workers this thread handed work to.
    const lowered = trimmed.toLowerCase();
    if (lowered === "delegates" || lowered === "children") {
      const wanted = lowered === "delegates" ? "delegation" : "subagent";
      const ids = (store?.spawnedChildren?.(sender.threadId) ?? [])
        .filter((child) => child.lineage?.relationshipToParent === wanted)
        .map((child) => child.threadId);
      if (ids.length === 0) {
        throw new GatewayToolError(
          "not_found",
          lowered === "delegates"
            ? "You have not delegated to or contracted any agent."
            : "You have not started any workers.",
        );
      }
      return ids;
    }

    // 1. Direct parent routing. `delegator` is the same edge named from a
    //    delegate's or contractor's side.
    if (lowered === "parent" || lowered === "delegator") {
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

      // A thread bound to no teammate answers to the name the user sees on
      // it — its contract name, or the call sign rolled from its id.
      if (store.listThreads) {
        const named = store
          .listThreads(sender.projectPath)
          .filter((t) => t.threadId !== sender.threadId && threadAgentName(store, t.threadId).toLowerCase() === lowered);
        if (named.length === 1) return [named[0]!.threadId];
        if (named.length > 1) {
          throw new GatewayToolError(
            "invalid_input",
            `More than one agent on this project goes by "${trimmed}": ${named.map((t) => t.threadId).join(", ")}. Address the one you mean by its thread id.`,
          );
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
    const kind: AgentMessageKind = input.kind ?? "note";
    // A question and its answer between a hand-off's two ends is the
    // conversation this bus exists for — a delegate asking what the user
    // meant — so it never counts toward the ping-pong cap. Peers chatting do.
    const handOffExchange =
      (kind === "question" || kind === "answer") &&
      recipients.length === 1 &&
      relationshipOf(store, sender.threadId, recipients[0]!) !== "peer";
    if (!handOffExchange) this.guardPingPong(sender.threadId, recipients);
    const messageId = `msg_${randomUUID()}`;
    const createdAt = Date.now();

    const record: IrcMessageRecord = {
      id: messageId,
      from: sender.threadId,
      to: input.to,
      message: input.message,
      kind,
      createdAt,
      read: false,
      projectPath: sender.projectPath,
    };
    if (input.replyTo !== undefined) {
      record.replyTo = input.replyTo;
    }

    for (const recipientId of recipients) {
      const messageCopy: IrcMessageRecord = { ...record };
      if (store) {
        messageCopy.sender = agentSenderFor(
          store,
          sender.threadId,
          relationshipOf(store, sender.threadId, recipientId),
          kind,
        );
      }
      // Auto-register recipient if not present and no external store was given
      if (!this.threads.has(recipientId) && !store) {
        this.registerThread({
          threadId: recipientId,
          projectPath: sender.projectPath,
        });
      }

      this.enqueue(recipientId, messageCopy);
    }

    return {
      messageId,
      delivered: recipients.length > 0,
      recipients,
      message: record,
    };
  }

  /**
   * Put a message the courier wrote in one thread's inbox: kone's own agent
   * carrying something an agent did not carry itself, such as a hand-off result
   * nobody waited for.
   *
   * It rides the same inbox and delivery as agent_message — steering a running
   * turn, waking an idle one, retractable until read — but none of the
   * agent-to-agent rules apply. kone already knows the thread, so there is no
   * recipient to resolve, and it is not half of a pair, so it neither counts
   * toward nor resets a ping-pong between two agents.
   */
  sendCourierMessage(input: {
    to: string;
    projectPath: string;
    message: string;
    kind: AgentMessageKind;
    sender: CourierSender;
  }) {
    const messageId = `msg_${randomUUID()}`;
    this.enqueue(input.to, {
      id: messageId,
      from: COURIER_AGENT_ID,
      to: input.to,
      message: input.message,
      kind: input.kind,
      createdAt: Date.now(),
      read: false,
      projectPath: input.projectPath,
      sender: input.sender,
    });
    return { messageId };
  }

  /** Add one copy to a recipient's inbox and tell the delivery listeners. */
  private enqueue(recipientId: string, message: IrcMessageRecord): void {
    let queue = this.inboxes.get(recipientId);
    if (!queue) {
      queue = [];
      this.inboxes.set(recipientId, queue);
    }
    queue.push(message);
    // Oldest first: a backlog this deep means nobody has been reading, and the
    // newest messages are the ones still worth acting on.
    if (queue.length > MAX_INBOX_MESSAGES) queue.splice(0, queue.length - MAX_INBOX_MESSAGES);

    // Notify delivery listeners with an immutable copy
    const readOnlyCopy = Object.freeze({ ...message });
    for (const listener of this.deliveryListeners) {
      try {
        listener(recipientId, readOnlyCopy);
      } catch {
        // Guard against listener failure
      }
    }
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
   * Hold until `threadId` receives the answer to its message `messageId`, and
   * hand it back — or null at the timeout or on abort.
   *
   * The answer is consumed here, as it is returned: it becomes the asking
   * tool call's result, so the delivery that would otherwise steer it into the
   * same turn a moment later finds nothing left to deliver.
   */
  waitForReply(
    threadId: string,
    messageId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<IrcMessageRecord | null> {
    const take = (): IrcMessageRecord | null => {
      const queue = this.inboxes.get(threadId) ?? [];
      const reply = queue.find((m) => !m.read && m.replyTo === messageId);
      if (!reply) return null;
      reply.read = true;
      return reply;
    };
    const already = take();
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: IrcMessageRecord | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish(null);
      const unsubscribe = this.onMessageDelivered((recipient, message) => {
        if (recipient === threadId && message.replyTo === messageId) finish(take());
      });
      const timer = setTimeout(() => finish(null), Math.min(timeoutMs, AGENT_MESSAGE_WAIT_MAX_MS));
      if (signal?.aborted) finish(null);
      else signal?.addEventListener("abort", onAbort);
    });
  }

  /**
   * The peers this thread may address, with the state a sender needs to decide
   * whether a message is worth it.
   *
   * Addressing is the half agents get wrong on their own: without a roster they
   * invent plausible names, the send fails, and the failure reads as "messaging
   * is broken" rather than "that agent does not exist".
   */
  listPeers(sender: IrcPeerScope): IrcPeer[] {
    const ids = new Set<string>();
    for (const [id, reg] of this.threads.entries()) {
      if (id === sender.threadId) continue;
      const sameProject = reg.projectPath === sender.projectPath;
      const sameLineage = Boolean(sender.rootThreadId) && reg.rootThreadId === sender.rootThreadId;
      if (sameProject || sameLineage) ids.add(id);
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

  /** Mark exactly these messages read — the ones a delivery handed over —
   *  rather than the first N unread, which a message taken back in the
   *  meantime would shift onto one the agent never saw. */
  markRead(threadId: string, messageIds: readonly string[]): void {
    const ids = new Set(messageIds);
    for (const message of this.inboxes.get(threadId) ?? []) {
      if (ids.has(message.id)) message.read = true;
    }
  }

  /** Take back a message nobody has read yet. True when it was still unread —
   *  false once it was delivered or read, when there is nothing to take back. */
  retract(threadId: string, messageId: string): boolean {
    const message = (this.inboxes.get(threadId) ?? []).find((m) => m.id === messageId);
    if (!message || message.read) return false;
    message.read = true;
    return true;
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
  "Message another kone agent, whether it is running right now or idle: a running one has it steered into its active turn, and an idle one is woken with a new turn on its existing thread (idle means waiting, not gone). It arrives headed as yours, with how you relate to the reader, so it is never mistaken for the user. Every message costs the reader a turn.",
  "",
  "`kind` says what it is for. note: information that changes what they do (the default). question: you need an answer — a delegate asking its delegator what the user meant, say; set wait to hold for the answer. pushback: you disagree with the task you were handed and propose something else. report: results or a deliverable. answer: a reply to a question, with replyTo set to its message id.",
  "",
  "`to` names the reader by relationship — `delegator` (whoever handed you your work), `delegates` (the agents you delegated to or contracted), `children` (your workers), `main` (your tree's root) — or by name or id from agent_list. `all` broadcasts to every agent on the project and is the main agent's alone. A worker may only report or ask its `parent`.",
  "",
  "When someone you handed work to asks you something, answer from what you know of the user's intent; ask the user only what you cannot answer, then pass the answer down. Never send an acknowledgement, a progress report, anything a tool could answer, or the next line of chit-chat. Between peers the bus refuses a pair that has traded 16 messages with nobody else involved; a question and its answer along a hand-off never count.",
].join("\n");

const IRC_LIST_DESCRIPTION = [
  "List the kone agents you can message on this project: their ids, whether each is running, and how many unread messages each has. A running agent will be interrupted, an away one won't see you until it returns, and one with a pile of unread messages is not reading.",
].join("\n");

const IRC_INBOX_DESCRIPTION = [
  "Read messages other agents sent you.",
  "",
  "You do not need to poll this. A message delivered while you are running is folded into your turn, and one that arrives while you are idle wakes you with it. This is for catching up deliberately — what came in while you could not be reached, or a second look at something already delivered.",
].join("\n");

/**
 * Creates the messaging gateway tools: `agent_message`, `agent_list` and
 * `agent_inbox`.
 */
export function createIrcTools(input: IrcToolInput = {}): ToolEntry[] {
  const mailbox = input.mailbox ?? getIrcMailbox();

  const sendHandler = async (
    ctx: GatewayToolContext,
    args: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const parsed = IrcSendInputSchema.parse(args);
    const kind = parsed.kind ?? "note";

    let parentThreadId: string | null | undefined;
    let rootThreadId: string | undefined;
    let relationshipToParent: ThreadLineage["relationshipToParent"] | undefined;

    if (input.store?.threadLineage) {
      const lineage = input.store.threadLineage(ctx.threadId);
      parentThreadId = lineage?.parentThreadId;
      rootThreadId = lineage?.rootThreadId;
      relationshipToParent = lineage?.relationshipToParent;
    }

    const target = parsed.to.trim().toLowerCase();
    // A broadcast interrupts every agent on the project at once: the main
    // agent's call, never one of the agents working for it.
    if ((target === "all" || target === "*") && parentThreadId) {
      throw new GatewayToolError(
        "permission_denied",
        "Only the main agent may message `all`. Message your `delegator`, or name the agents you mean.",
      );
    }

    const sender = {
      threadId: ctx.threadId,
      projectPath: ctx.cwd,
      parentThreadId,
      rootThreadId,
      model: ctx.model,
      provider: ctx.provider,
    };

    // A worker does its task and reports: it speaks to the agent that started
    // it, and only to report or to say what it is blocked on.
    if (relationshipToParent === "subagent") {
      const recipients = mailbox.resolveRecipients(sender, parsed.to, input.store);
      if (recipients.length !== 1 || recipients[0] !== parentThreadId || (kind !== "report" && kind !== "question")) {
        throw new GatewayToolError(
          "permission_denied",
          "You are a worker: you may only message your `parent`, with kind report or question. Put anything else in your final reply — kone delivers it to your parent as your report.",
        );
      }
    }

    const result = mailbox.sendMessage(sender, parsed, input.store);

    const recipientDesc =
      result.recipients.length === 1
        ? result.recipients[0]
        : `${result.recipients.length} recipients (${result.recipients.join(", ")})`;
    const structured: GatewayRecord = {
      messageId: result.messageId,
      from: ctx.threadId,
      to: parsed.to,
      kind,
      delivered: result.delivered,
      recipients: result.recipients,
      replyTo: parsed.replyTo ?? null,
      createdAt: result.message.createdAt,
    };

    if (parsed.wait === true) {
      const reply = await mailbox.waitForReply(
        ctx.threadId,
        result.messageId,
        parsed.timeoutMs ?? AGENT_MESSAGE_WAIT_MAX_MS,
        ctx.signal,
      );
      if (reply) {
        structured.answer = { messageId: reply.id, from: reply.from, message: reply.message };
        return {
          content: [
            {
              type: "text",
              text: `Asked ${parsed.to} [${recipientDesc}] (${result.messageId}). Their answer:\n${reply.message}`,
            },
          ],
          structuredContent: structured,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Asked ${parsed.to} [${recipientDesc}] (${result.messageId}); no answer yet. It reaches you like any message when it comes — carry on with what you can meanwhile.`,
          },
        ],
        structuredContent: structured,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Sent ${kind} ${result.messageId} to ${parsed.to} [${recipientDesc}].`,
        },
      ],
      structuredContent: structured,
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
    const sender: IrcPeerScope = { threadId: ctx.threadId, projectPath: ctx.cwd, rootThreadId };
    const peers = mailbox.listPeers(sender);
    const store = input.store;
    const rows = peers.map((peer) => {
      const row: PeerRow = {
        ...peer,
        live: input.isThreadLive?.(peer.id) ?? false,
      };
      const agentName = peer.agentName ?? (store ? threadAgentName(store, peer.id) : undefined);
      if (agentName) row.agentName = agentName;
      return row;
    });

    const text =
      rows.length === 0
        ? "No peers — you are the only active agent in this thread tree right now."
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
      name: "agent_message",
      description: IRC_SEND_DESCRIPTION,
      inputSchema: IrcSendInputSchema,
      jsonSchema: IRC_SEND_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet:
        "Message another kone agent, running or idle — a running one is steered mid-turn, an idle one wakes with a new turn — as a note, question, pushback, report or answer, headed as yours so it is never taken for the user.",
      // When to send is the description's; these are the rules that sit
      // between tools: the spawn tools it steers an agent away from, and the
      // hand-off conversation it carries.
      promptGuidelines: [
        "An idle kone agent is not a closed one: agent_followup or agent_message wakes it with a new turn. Never re-spawn or re-delegate to reach an agent that has merely settled.",
        "When a message you were handed work in looks wrong or unclear, ask or push back with agent_message to your delegator instead of guessing; when one you handed work to asks, answer from the user's intent as you know it, and ask the user only what you cannot answer.",
      ],
      handler: sendHandler,
    },
    {
      name: "agent_list",
      description: IRC_LIST_DESCRIPTION,
      inputSchema: IrcListInputSchema,
      jsonSchema: IRC_LIST_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "See the kone agents on this project you can message, and which are running.",
      handler: listHandler,
    },
    {
      name: "agent_inbox",
      description: IRC_INBOX_DESCRIPTION,
      inputSchema: IrcInboxInputSchema,
      jsonSchema: IRC_INBOX_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      onDemand: true,
      promptSnippet:
        "Catch up on messages other agents sent you; delivered ones already reach your turn, so never poll it.",
      handler: inboxHandler,
    },
  ];
}

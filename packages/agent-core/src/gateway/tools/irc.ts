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
  IrcSendInputSchema,
  IRC_INBOX_JSON_SCHEMA,
  IRC_SEND_JSON_SCHEMA,
} from "../schemas.js";

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
}

/**
 * In-memory thread mailbox allowing agents in the same project/parent tree
 * to send direct messages and check their inboxes.
 */
export class IrcMailbox {
  private inboxes = new Map<string, IrcMessageRecord[]>();
  private threads = new Map<string, ThreadRegistration>();
  private agentToThread = new Map<string, string>();

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
      // Push a distinct record copy for independent read tracking if needed
      queue.push({ ...record });

      // Auto-register recipient if not present and no external store was given
      if (!this.threads.has(recipientId) && !store) {
        this.registerThread({
          threadId: recipientId,
          projectPath: sender.projectPath,
        });
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

/**
 * Creates the two IRC gateway tools: `kone_irc_send` and `kone_irc_inbox`.
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

  return [
    {
      name: "kone_irc_send",
      description:
        "Send a direct peer-to-peer message to another agent or parent in the same project/thread tree.",
      inputSchema: IrcSendInputSchema,
      jsonSchema: IRC_SEND_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      handler: sendHandler,
    },
    {
      name: "kone_irc_inbox",
      description:
        "Check and read incoming peer messages from other agents in the thread mailbox.",
      inputSchema: IrcInboxInputSchema,
      jsonSchema: IRC_INBOX_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      handler: inboxHandler,
    },
  ];
}

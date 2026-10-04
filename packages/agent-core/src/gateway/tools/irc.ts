import { createHash, randomUUID } from "node:crypto";

import { COURIER_AGENT_ID, senderLabel, senderRelationshipLabel, type AgentSender, type CourierSender } from "@kone/protocol/message-sender";
import type { ProviderKind, SenderRelationship, SpawnedThreadStatus, StoredThreadMeta, ThreadLineage } from "../../types.js";
import { describeRecipientState, formatSince, recipientState, type RecipientState, type ThreadRuntime } from "../../recipientState.js";
import { agentSenderFor, threadAgentName } from "../../senderHeader.js";
import { deliveryReceipt } from "../../inboxDelivery.js";
import type { AgentRecord } from "../../ConversationStore.js";
import { MemoryAgentInbox, type AgentInboxStore, type InboxClaim, type InboxKind, type InboxRing, type InboxRow, type InboxSender, type SystemSender } from "../../store/agentInbox.js";
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

/** One inter-agent message, as the mailbox hands it out. */
export interface IrcMessageRecord {
  id: string;
  from: string;
  to: string;
  message: string;
  /** Absent on a message from before kinds existed; reads as a note. */
  kind?: InboxKind;
  replyTo?: string;
  /** The sender asked for it to be seen now, even at the cost of disrupting. */
  urgent?: boolean;
  createdAt: number;
  read: boolean;
  projectPath?: string;
  /** Who sent it, as THIS copy's recipient relates to them — each recipient
   *  gets its own copy, so a broadcast reads "your worker" to one agent and
   *  "teammate" to another. Absent when no store could say. A courier sender is
   *  kone's own agent carrying something, never another agent speaking. */
  sender?: InboxSender;
  /** The transcript block it was written as, set once it is on the
   *  recipient's transcript — so a delivery retried after a failed send does
   *  not write it twice, and the turn that delivers it can name its block. */
  blockId?: string;
  /** kone restarted while handing it over, and nothing on record says whether
   *  the recipient got it: it may already be in the recipient's context. */
  uncertain?: true;
}

/** Where a job stands, for a wait pinned to it. */
export interface JobTurn {
  recipient: string;
  handedOver: boolean;
  turnId: string | null;
  /** kone restarted while handing it over; nothing says whether it arrived. */
  uncertain?: true;
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

/** One agent_list row: a peer, how it relates to the caller, and what it is
 *  doing. A type alias rather than an interface, because it has to pass as a
 *  gateway value and only an alias carries the implicit index signature. */
type PeerRow = {
  id: string;
  agentName?: string;
  provider?: string;
  relationship: SenderRelationship;
  state: RecipientState["state"];
  since: number | null;
  activity: string | null;
  steers: boolean | null;
  waitingOn: string[];
  ended: RecipientState["ended"];
  unseen: number;
  oldestUnseenAt: number | null;
  live: boolean;
};

/** How many agents one roster lists. A project's long tail is closed threads
 *  nobody is waiting on; past this they are counted, not listed, and stay
 *  addressable by name or id. */
const ROSTER_MAX = 30;

/** How long to wait before writing a settle or release the store refused
 *  again; the last delay repeats until it lands. */
const STORE_RETRY_MS: readonly number[] = [250, 1_000, 5_000, 15_000, 30_000];

/** How much history agent_inbox shows on request. */
const INBOX_HISTORY_MAX = 20;

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
  /** Delivery runs on the ringer: a note waits for the recipient's next
   *  turn, everything else rings, urgent alone goes into a running turn. */
  deliveryV2?: boolean;
  /** Whether a peer has a live session right now. A message to a live peer
   *  interrupts it and costs it a turn; one to a peer that is away costs
   *  nothing until it returns. The roster says which, because that difference
   *  is the whole economics of sending. */
  isThreadLive?: (threadId: string) => boolean;
  /** What a thread is doing right now. Absent, a live peer reads as idle and
   *  every other as closed. */
  threadRuntime?: (threadId: string) => ThreadRuntime | null;
  /** Whether a provider takes messages into a running turn, for a peer with
   *  no live session to ask. */
  providerSteers?: (provider: ProviderKind) => boolean;
  /** A hand-off's status, for a thread some agent handed work to. */
  spawnedStatus?: (threadId: string) => SpawnedThreadStatus | null;
  /** The children a thread is parked in agent_wait on. */
  waitingOn?: (threadId: string) => { threadIds: string[]; since: number } | null;
}

const SYSTEM_SENDER: SystemSender = { kind: "system" };

/** A stored inbox row as the mailbox's message record. */
function recordFromRow(row: InboxRow): IrcMessageRecord {
  const record: IrcMessageRecord = {
    id: row.inboxId,
    from: row.senderThreadId ?? COURIER_AGENT_ID,
    to: row.recipientThreadId,
    message: row.body,
    kind: row.kind,
    createdAt: row.createdAt,
    read: row.state === "seen" || row.state === "retracted",
    projectPath: row.projectPath,
  };
  if (row.replyTo) record.replyTo = row.replyTo;
  if (row.urgent) record.urgent = true;
  if (row.sender) record.sender = row.sender;
  if (row.blockId) record.blockId = row.blockId;
  if (row.state === "uncertain") record.uncertain = true;
  return record;
}

/** One hand-over's batch, claimed under `deliveryId`. */
export interface IrcDeliveryClaim {
  deliveryId: string;
  messages: IrcMessageRecord[];
}

/**
 * Thread mailbox allowing agents in the same project/parent tree to send
 * direct messages and check their inboxes. The messages themselves live in
 * the inbox store, so they outlive the process; who is registered under what
 * name, and the ping-pong counter, are this process's alone.
 */
export class IrcMailbox {
  /** @param inbox where messages are kept; the app passes the conversation
   *  store, tests and a store-less process get an in-memory one. */
  constructor(
    private readonly inbox: AgentInboxStore = new MemoryAgentInbox(),
    private readonly options: { storeRetryMs?: readonly number[] } = {},
  ) {}

  /** Threads parked in agent_message's wait, on whom, since when. */
  private readonly replyWaits = new Map<string, Array<{ threadIds: string[]; since: number }>>();

  /** Mark `threadId` as parked waiting on `recipients`' answer; returns the
   *  call that ends it. */
  trackWait(threadId: string, recipients: readonly string[]): () => void {
    const entry = { threadIds: [...recipients], since: Date.now() };
    const list = this.replyWaits.get(threadId) ?? [];
    list.push(entry);
    this.replyWaits.set(threadId, list);
    return () => {
      const current = this.replyWaits.get(threadId);
      if (!current) return;
      const at = current.indexOf(entry);
      if (at !== -1) current.splice(at, 1);
      if (current.length === 0) this.replyWaits.delete(threadId);
    };
  }

  /** Who `threadId` is parked waiting on for an answer, and since when. */
  waitingOn(threadId: string): { threadIds: string[]; since: number } | null {
    const list = this.replyWaits.get(threadId);
    if (!list?.length) return null;
    return {
      threadIds: [...new Set(list.flatMap((w) => w.threadIds))],
      since: Math.min(...list.map((w) => w.since)),
    };
  }

  /** The thread's seen messages, newest first. */
  history(threadId: string, limit: number): IrcMessageRecord[] {
    return this.inbox.inboxHistory(threadId, limit).map(recordFromRow);
  }

  /** When the oldest message still unseen in the thread's inbox arrived. */
  oldestUnseenAt(threadId: string): number | null {
    return this.inbox.listUnseenInbox(threadId, 1)[0]?.createdAt ?? null;
  }

  private threads = new Map<string, ThreadRegistration>();
  private agentToThread = new Map<string, string>();
  private deliveryListeners = new Set<(recipientThreadId: string, message: Readonly<IrcMessageRecord>) => void>();
  private readonly settleListeners = new Set<() => void>();
  private readonly releaseListeners = new Set<(recipient: string) => void>();
  /** Who each open hand-over is for, by delivery id. */
  private readonly claimedFor = new Map<string, string>();
  /** Hand-overs a provider took whose settle the store has yet to write, with
   *  the turn that took them. */
  private readonly unsettled = new Map<string, { turnId: string | null }>();
  /** Store writes that failed, per delivery: how many times, and the timer
   *  that tries again. */
  private readonly writeAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, () => void>();
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
    /** How it is kept: whether it rings (default true) and is urgent. */
    options: { rings?: boolean; urgent?: boolean } = {},
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
    if (options.urgent) record.urgent = true;

    // Each recipient's copy is its own stored message, so each has its own id:
    // one recipient's copy can be seen or retracted without touching another's.
    // A lone recipient's copy keeps the id the sender is told.
    const copyIds: string[] = [];
    for (const recipientId of recipients) {
      const copyId = recipients.length === 1 ? messageId : `msg_${randomUUID()}`;
      const messageCopy: IrcMessageRecord = { ...record, id: copyId };
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

      this.enqueue(recipientId, messageCopy, undefined, options.rings ?? true);
      copyIds.push(copyId);
    }

    return {
      messageId,
      /** The id each recipient's copy carries, in `recipients` order — what
       *  an answer from any of them names as its replyTo. */
      copyIds,
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
    /** Names what is being carried, so carrying it twice — a settled turn
     *  reported again — stores nothing the second time. */
    dedupeKey?: string;
    /** False holds it for the recipient's next turn instead of handing it
     *  over on its own. Default true. */
    rings?: boolean;
  }): { messageId: string } | null {
    return this.postFromKone(input);
  }

  /**
   * Put a notice kone writes itself — describing something that happened, not
   * carrying anyone's words — in one thread's inbox. A ringing notice is handed
   * over like any message; a held one waits for whatever turn the thread runs
   * next and rides in front of it. Throws when it could not be stored.
   */
  sendNotice(input: { to: string; projectPath: string; message: string; rings: boolean }): { messageId: string } {
    const sent = this.postFromKone({ ...input, kind: "notice", sender: SYSTEM_SENDER });
    // A notice carries no dedupe key, so null here means it was not stored.
    if (!sent) throw new GatewayToolError("internal", `kone could not store the notice for "${input.to}".`);
    return sent;
  }

  private postFromKone(input: {
    to: string;
    projectPath: string;
    message: string;
    kind: InboxKind;
    sender: CourierSender | SystemSender;
    dedupeKey?: string;
    rings?: boolean;
  }): { messageId: string } | null {
    const messageId = `msg_${randomUUID()}`;
    const record: IrcMessageRecord = {
      id: messageId,
      from: COURIER_AGENT_ID,
      to: input.to,
      message: input.message,
      kind: input.kind,
      createdAt: Date.now(),
      read: false,
      projectPath: input.projectPath,
      sender: input.sender,
    };
    if (!this.enqueue(input.to, record, input.dedupeKey, input.rings ?? true)) return null;
    return { messageId };
  }

  /** Store one copy in a recipient's inbox and, when it rings, tell the
   *  delivery listeners — a held one is nobody's cue to hand anything over.
   *  False when its dedupe key says it was stored already. Throws when it
   *  could not be stored at all: a message nobody will ever see must fail
   *  where its sender can still act on that. */
  private enqueue(recipientId: string, message: IrcMessageRecord, dedupeKey?: string, rings = true): boolean {
    const result = this.inbox.insertInboxMessage({
      inboxId: message.id,
      recipientThreadId: recipientId,
      senderThreadId: message.sender?.kind === "agent" || !message.sender ? message.from : null,
      sender: message.sender ?? null,
      kind: message.kind ?? "note",
      urgent: message.urgent ?? false,
      replyTo: message.replyTo ?? null,
      body: message.message,
      dedupeKey: dedupeKey ?? null,
      projectPath: message.projectPath ?? "",
      createdAt: message.createdAt,
      rings,
    });
    if (result === "duplicate") return false;
    if (result === "failed") {
      throw new GatewayToolError("internal", `kone could not store the message for "${recipientId}"; it was not sent.`);
    }
    if (!rings) return true;

    // Notify delivery listeners with an immutable copy
    const readOnlyCopy = Object.freeze({ ...message });
    for (const listener of this.deliveryListeners) {
      try {
        listener(recipientId, readOnlyCopy);
      } catch {
        // Guard against listener failure
      }
    }
    return true;
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
   * same turn a moment later finds nothing left to deliver. Taking it is one
   * conditional write — unseen to seen — so a hand-over that claimed it first
   * keeps it, and one that comes after finds it gone.
   */
  waitForReply(
    threadId: string,
    messageIds: string | readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<IrcMessageRecord | null> {
    const asked = new Set([messageIds].flat());
    const take = (): IrcMessageRecord | null => {
      const reply = this.inbox.listUnseenInbox(threadId).find((row) => row.replyTo !== null && asked.has(row.replyTo));
      if (!reply) return null;
      if (this.inbox.markInboxSeen([reply.inboxId], "wait").length === 0) return null;
      return { ...recordFromRow(reply), read: true };
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
        if (recipient === threadId && message.replyTo !== undefined && asked.has(message.replyTo)) finish(take());
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
   * Read incoming messages from the thread's inbox. A read marks what it
   * returns seen; a peek leaves it unseen. A message a hand-over is carrying
   * right now is in neither: it is on its way into a turn. What kone was
   * handing over when it restarted, uncertain, comes first, flagged: nothing
   * hands it over again, so this read is where it is seen.
   */
  getInbox(
    threadId: string,
    options?: { peek?: boolean; limit?: number },
  ) {
    const limit = options?.limit && options.limit > 0 ? options.limit : undefined;
    const uncertain = this.inbox.listUncertainInbox(threadId);
    const unseen = [...uncertain, ...this.inbox.listUnseenInbox(threadId, limit)].slice(0, limit);
    if (options?.peek === true) {
      return { messages: unseen.map(recordFromRow), unreadCount: this.inbox.unseenInboxCount(threadId) };
    }
    // A job is work handed over as a turn of its own, and its sender's handle
    // on that turn: reading the inbox never takes it — unless it is uncertain,
    // which no turn will carry.
    const readable = unseen.filter((row) => row.kind !== "job" || row.state === "uncertain");
    const taken = new Set(this.inbox.markInboxSeen(readable.map((row) => row.inboxId), "inbox"));
    return {
      messages: readable.filter((row) => taken.has(row.inboxId)).map((row) => ({ ...recordFromRow(row), read: true })),
      unreadCount: this.inbox.unseenInboxCount(threadId),
    };
  }

  /** One hand-over's claim, remembered with whom it is for until it is
   *  settled or released. */
  private claim(threadId: string, limit: number, which: InboxRing): IrcDeliveryClaim | null {
    const claim: InboxClaim | null = this.inbox.claimInbox(threadId, limit, which);
    if (!claim) return null;
    this.claimedFor.set(claim.deliveryId, threadId);
    return { deliveryId: claim.deliveryId, messages: claim.rows.map(recordFromRow) };
  }

  /** Claim up to `limit` unseen messages for one hand-over. Null when there
   *  are none. Until the claim is settled or released no other hand-over,
   *  inbox read or waiting sender can take them. */
  claimDelivery(threadId: string, limit: number): IrcDeliveryClaim | null {
    return this.claim(threadId, limit, "ringing");
  }

  /** Claim up to `limit` of the held messages — the ones waiting for the
   *  thread's next turn — for the turn starting now. Null when there are none. */
  claimHeld(threadId: string, limit: number): IrcDeliveryClaim | null {
    return this.claim(threadId, limit, "held");
  }

  /** How many held messages are waiting for the thread's next turn. */
  heldCount(threadId: string): number {
    return this.inbox.unseenInboxCount(threadId, "held");
  }

  /** Claim up to `limit` of everything unseen — answers first, then oldest —
   *  for a turn starting now. */
  claimForTurn(threadId: string, limit: number): IrcDeliveryClaim | null {
    return this.claim(threadId, limit, "messages");
  }

  /** Claim up to `limit` urgent messages, for the turn running now. */
  claimUrgent(threadId: string, limit: number): IrcDeliveryClaim | null {
    return this.claim(threadId, limit, "urgent-messages");
  }

  /** Claim the oldest waiting job — only an urgent one when `urgent` — for a
   *  turn of its own. Null when there is none. */
  claimJob(threadId: string, urgent = false): IrcDeliveryClaim | null {
    return this.claim(threadId, 1, urgent ? "urgent-job" : "job");
  }

  /** How many jobs wait unseen. */
  jobCount(threadId: string): number {
    return this.unseenJobs(threadId);
  }

  /** How many jobs wait unseen — only the urgent ones when `urgent`. */
  unseenJobs(threadId: string, urgent = false): number {
    return this.inbox.unseenInboxCount(threadId, urgent ? "urgent-job" : "job");
  }

  /**
   * Put a job — work to do, from the agent that handed the thread its work or
   * from kone's assistant — in one thread's inbox. It always rings, and is
   * handed over as a turn of its own. Its id is the sender's handle on it:
   * once handed over, `jobTurn` names the turn that carried it. A post with a
   * dedupe key already stored stores nothing and returns the same id, so a
   * retried call never asks twice. Throws when it could not be stored.
   */
  postJob(input: {
    to: string;
    projectPath: string;
    message: string;
    sender: AgentSender;
    urgent?: boolean;
    dedupeKey?: string;
  }) {
    const messageId = input.dedupeKey
      ? `msg_${createHash("sha256").update(input.dedupeKey).digest("hex").slice(0, 32)}`
      : `msg_${randomUUID()}`;
    const record: IrcMessageRecord = {
      id: messageId,
      from: input.sender.threadId,
      to: input.to,
      message: input.message,
      kind: "job",
      createdAt: Date.now(),
      read: false,
      projectPath: input.projectPath,
      sender: input.sender,
    };
    if (input.urgent) record.urgent = true;
    const stored = this.enqueue(input.to, record, input.dedupeKey, true);
    return { messageId, duplicate: !stored };
  }

  /** Where a job stands: who it is for, whether it was handed over yet, and
   *  the turn that carried it once it was. An uncertain job was not handed
   *  over as far as anything on record says, and never will be on its own.
   *  Null when there is no such job. */
  jobTurn(inboxId: string): JobTurn | null {
    const row = this.inbox.inboxMessage(inboxId);
    if (!row || row.kind !== "job") return null;
    if (row.state === "uncertain") {
      return { recipient: row.recipientThreadId, handedOver: false, turnId: null, uncertain: true };
    }
    // Taken by a turn whose settle the store has yet to write.
    const pending = row.state === "handing" && row.deliveryId ? this.unsettled.get(row.deliveryId) : undefined;
    if (pending) return { recipient: row.recipientThreadId, handedOver: true, turnId: pending.turnId };
    return { recipient: row.recipientThreadId, handedOver: row.state === "seen", turnId: row.turnId };
  }

  /** How many urgent messages wait unseen. */
  urgentCount(threadId: string): number {
    return this.inbox.unseenInboxCount(threadId, "urgent");
  }

  /** One stored message, whatever its state — what an answer's replyTo is
   *  checked against. */
  message(messageId: string): (IrcMessageRecord & { recipient: string; senderThreadId: string | null }) | null {
    const row = this.inbox.inboxMessage(messageId);
    if (!row) return null;
    return { ...recordFromRow(row), recipient: row.recipientThreadId, senderThreadId: row.senderThreadId };
  }

  /** The provider took the turn carrying this hand-over: its messages are
   *  seen, and remember the turn. When the store cannot write that, the turn
   *  is remembered here and the write retried: the rows stay claimed, so
   *  nothing hands them over again, and a job's id already stands for the
   *  turn that took it. */
  settleDelivery(deliveryId: string, turnId: string | null): void {
    // The link first, apart from the settle: recovery settles by it alone.
    if (turnId !== null) this.inbox.linkInboxDelivery(deliveryId, turnId);
    const settled = this.inbox.settleInboxDelivery(deliveryId, turnId);
    if (settled === null) {
      const pending = this.unsettled.has(deliveryId);
      this.unsettled.set(deliveryId, { turnId });
      this.retryLater(deliveryId, () => this.settleDelivery(deliveryId, turnId));
      // Waits hear once, when the turn first stands for the hand-over.
      if (pending) return;
    } else {
      this.unsettled.delete(deliveryId);
      this.claimedFor.delete(deliveryId);
      this.writeAttempts.delete(deliveryId);
      if (settled === 0) return;
    }
    for (const listener of this.settleListeners) {
      try {
        listener();
      } catch (err) {
        console.warn("[agent] an inbox settle listener failed:", err);
      }
    }
  }

  /** Run a store write that failed again later, later each time: the store
   *  is full or locked, which passes. */
  private retryLater(deliveryId: string, write: () => void): void {
    const attempt = this.writeAttempts.get(deliveryId) ?? 0;
    this.writeAttempts.set(deliveryId, attempt + 1);
    const delays = this.options.storeRetryMs ?? STORE_RETRY_MS;
    const ms = delays[Math.min(attempt, delays.length - 1)] ?? 0;
    const timer = setTimeout(() => {
      this.retryTimers.delete(deliveryId);
      write();
    }, ms);
    timer.unref?.();
    this.retryTimers.get(deliveryId)?.();
    this.retryTimers.set(deliveryId, () => clearTimeout(timer));
  }

  /** Hear when a hand-over is settled with its turn — when a job's id comes
   *  to stand for a turn. Returns the unsubscribe. */
  onDeliverySettled(listener: () => void): () => void {
    this.settleListeners.add(listener);
    return () => this.settleListeners.delete(listener);
  }

  /** The hand-over's send failed: its messages are unseen again, and keep the
   *  block each was written as. When the store cannot write that, the write
   *  is retried; once it lands, whoever hands messages over hears the
   *  recipient has mail again — a release that landed at once was the
   *  caller's own, which knows already. */
  releaseDelivery(deliveryId: string): void {
    const released = this.inbox.releaseInboxDelivery(deliveryId);
    if (released === null) {
      this.retryLater(deliveryId, () => this.releaseDelivery(deliveryId));
      return;
    }
    const recipient = this.claimedFor.get(deliveryId);
    const late = this.writeAttempts.has(deliveryId);
    this.claimedFor.delete(deliveryId);
    this.writeAttempts.delete(deliveryId);
    if (released === 0 || !recipient || !late) return;
    for (const listener of this.releaseListeners) {
      try {
        listener(recipient);
      } catch (err) {
        console.warn("[agent] an inbox release listener failed:", err);
      }
    }
  }

  /** Hear when a hand-over's messages wait again for `recipient`. Returns the
   *  unsubscribe. */
  onDeliveryReleased(listener: (recipient: string) => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  /** The hand-over is going to the provider now. Recorded so a process that
   *  dies from here on leaves it uncertain, not unsent: the next one settles
   *  it from the transcript, or holds it, rather than handing it over again.
   *  Throws when the store could not write that: the turn must not go out,
   *  since a crash after it would read as never sent and hand it over twice.
   *  The caller's refusal path releases the hand-over and tries again later. */
  sendingDelivery(deliveryId: string): void {
    if (!this.inbox.markInboxSending(deliveryId)) {
      throw new Error(`Could not record hand-over ${deliveryId} as sent; not sending it.`);
    }
  }

  /** Remember the transcript block a message was written as. */
  setBlockId(messageId: string, blockId: string): void {
    this.inbox.setInboxBlockId(messageId, blockId);
  }

  /** Take back a message nobody has seen yet. True when it was still unseen —
   *  false once it was handed over, read, or is being handed over now. */
  retract(_threadId: string, messageId: string): boolean {
    return this.inbox.retractInboxMessage(messageId);
  }

  /**
   * Get the count of unread messages for a thread.
   */
  getUnreadCount(threadId: string): number {
    return this.inbox.unseenInboxCount(threadId);
  }

  /** How many unseen messages are waiting to be handed over on their own —
   *  the held ones wait for whatever turn comes next, so nothing is owed them. */
  ringingCount(threadId: string): number {
    return this.inbox.unseenInboxCount(threadId, "ringing");
  }

  /**
   * Forget a thread's registration, or every registration. Stored messages go
   * with their thread, not with this; an in-memory inbox is cleared alongside.
   */
  clear(threadId?: string): void {
    const memory = this.inbox instanceof MemoryAgentInbox ? this.inbox : null;
    if (threadId) {
      const reg = this.threads.get(threadId);
      if (reg?.agentName) {
        this.agentToThread.delete(this.agentKey(reg.projectPath, reg.agentName));
      }
      memory?.clear(threadId);
      this.threads.delete(threadId);
    } else {
      memory?.clear();
      this.threads.clear();
      this.agentToThread.clear();
      this.pairExchanges.clear();
      for (const cancel of this.retryTimers.values()) cancel();
      this.retryTimers.clear();
      this.writeAttempts.clear();
      this.unsettled.clear();
      this.claimedFor.clear();
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

/** Make the default mailbox one that keeps its messages in `inbox`. The app
 *  calls this once, before anything reads the default, so every tool,
 *  delivery and courier shares the stored inbox. */
export function configureIrcMailbox(inbox: AgentInboxStore): IrcMailbox {
  defaultMailbox = new IrcMailbox(inbox);
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
  "`kind` says what it is for. note: information that changes what they do (the default). question: you need an answer — a delegate asking its delegator what the user meant, say. The answer reaches you on its own, so keep working on what does not depend on it; set wait only when you cannot go on without it. pushback: you disagree with the task you were handed and propose something else. report: results or a deliverable. answer: a reply to a question, with replyTo set to its message id.",
  "",
  "`to` names the reader by relationship — `delegator` (whoever handed you your work), `delegates` (the agents you delegated to or contracted), `children` (your workers), `main` (your tree's root) — or by name or id from agent_list. `all` broadcasts to every agent on the project and is the main agent's alone. A worker may only report or ask its `parent`.",
  "",
  "When someone you handed work to asks you something, answer from what you know of the user's intent; ask the user only what you cannot answer, then pass the answer down. Never send an acknowledgement, a progress report, anything a tool could answer, or the next line of chit-chat. Between peers the bus refuses a pair that has traded 16 messages with nobody else involved; a question and its answer along a hand-off never count.",
].join("\n");

/** The same tool when delivery runs on the ringer: what a message costs now
 *  depends on its kind, so the description leads with that. */
const IRC_SEND_DESCRIPTION_V2 = [
  "Message another kone agent. Every message lands in its inbox. A note waits there and is handed over in front of the agent's next turn, whatever starts it: it never starts a turn of its own, so it costs nobody a turn. A question, pushback, answer or report rings: an idle agent is woken with a turn for it, a working one takes it when its running turn ends, and a closed session is brought back up for it. It arrives headed as yours, with how you relate to the reader, so it is never mistaken for the user. The result says what happened to it.",
  "",
  "`urgent` puts it into the reader's running turn instead of waiting for the turn to end. Only along a hand-off (to an agent you handed work to, or the one you work for) or from the main agent; never on a broadcast, never from a worker. Use it only when the work going on is wrong without it.",
  "",
  "`kind` says what it is for. note: information that changes what they do (the default). question: you need an answer — a delegate asking its delegator what the user meant, say. The answer reaches you on its own, so keep working on what does not depend on it; set wait only when you cannot go on without it. pushback: you disagree with the task you were handed and propose something else. report: results or a deliverable. answer: a reply to a question you were asked, with replyTo set to its message id; anything else sent as an answer goes as a note.",
  "",
  "`to` names the reader by relationship — `delegator` (whoever handed you your work), `delegates` (the agents you delegated to or contracted), `children` (your workers), `main` (your tree's root) — or by name or id from agent_list. `all` broadcasts a note to every agent on the project and is the main agent's alone. A worker may only report or ask its `parent`.",
  "",
  "When someone you handed work to asks you something, answer from what you know of the user's intent; ask the user only what you cannot answer, then pass the answer down. Never send an acknowledgement, a progress report, anything a tool could answer, or the next line of chit-chat. Between peers the bus refuses a pair that has traded 16 messages with nobody else involved; a question and its answer along a hand-off never count.",
].join("\n");

const IRC_LIST_DESCRIPTION = [
  "List the kone agents on this project you can message, and what each is doing: working (on what, for how long), idle, waiting on the user, waiting on another agent, starting, compacting, session closed, or its hand-off ended. Each row says how you relate to it, what a message to it would do right now, and how many messages wait unseen in its inbox and for how long.",
  "",
  "Look before you send: a message to an agent waiting on the user waits with it, and one to a busy agent on a provider that cannot steer interrupts its turn.",
].join("\n");

const IRC_INBOX_DESCRIPTION = [
  "Read the messages waiting unseen in your inbox, with who sent each, what kind it is and what it replies to. Reading marks them seen. history: true adds the last 20 you have already seen.",
  "",
  "Open it between steps of long work to see whether a note changes what to do next, before ending your turn to make sure nothing waiting should be acted on now, and after your context was compacted to re-read what fell out of it.",
  "",
  "Never open it to wait for an answer or a result: those reach you on their own. Never open it in a loop: nothing arrives faster for checking.",
].join("\n");

/** One message as agent_inbox lists it. */
function renderInboxLine(m: IrcMessageRecord, now: number): string {
  const kind = m.kind ?? "note";
  const replyTo = m.replyTo ? `, replying to ${m.replyTo}` : "";
  const ago = formatSince(m.createdAt, now);
  const flag = m.uncertain ? " (uncertain: kone restarted while handing it to you — it may already be in your context)" : "";
  return `[${m.id}] ${kind} from ${m.sender ? senderLabel(m.sender) : m.from}${replyTo}, ${ago} ago${flag}:\n${m.message}`;
}

/** One message as agent_inbox returns it in structured form. */
function inboxEntry(m: IrcMessageRecord): GatewayRecord {
  const entry: GatewayRecord = {
    id: m.id,
    from: m.from,
    kind: m.kind ?? "note",
    sender: m.sender ? senderLabel(m.sender) : m.from,
    replyTo: m.replyTo ?? null,
    createdAt: m.createdAt,
    message: m.message,
  };
  if (m.sender?.kind === "agent") entry.relationship = m.sender.relationship;
  if (m.uncertain) entry.uncertain = true;
  return entry;
}

/** One roster row as text. */
function renderPeerLine(p: PeerRow, now: number, v2: boolean): string {
  const name = p.agentName ? `${p.agentName} ` : "";
  const provider = p.provider ? `, ${p.provider}` : "";
  const state = describeRecipientState(
    {
      state: p.state,
      since: p.since,
      activity: p.activity,
      steers: p.steers,
      waitingOn: p.waitingOn,
      ended: p.ended,
      unseen: p.unseen,
      oldestUnseenAt: p.oldestUnseenAt,
    },
    now,
    v2,
  );
  const unseen =
    p.unseen > 0 ? ` ${p.unseen} unseen in its inbox, oldest ${formatSince(p.oldestUnseenAt, now) ?? "just now"}.` : "";
  return `${name}\`${p.id}\` (${senderRelationshipLabel(p.relationship)}${provider}) — ${state}.${unseen}`;
}

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
    let kind = parsed.kind ?? "note";
    const urgent = parsed.urgent === true;
    const v2 = input.deliveryV2 === true;

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
    const broadcast = target === "all" || target === "*";
    // A broadcast interrupts every agent on the project at once: the main
    // agent's call, never one of the agents working for it.
    if (broadcast && parentThreadId) {
      throw new GatewayToolError(
        "permission_denied",
        "Only the main agent may message `all`. Message your `delegator`, or name the agents you mean.",
      );
    }
    // Disrupting someone is a deliberate choice, so it is narrow: never to
    // everyone at once, never from a worker.
    if (urgent && broadcast) {
      throw new GatewayToolError(
        "permission_denied",
        "A broadcast is a note: it never interrupts anyone. Drop urgent, or name the agent that has to see it now.",
      );
    }
    if (urgent && relationshipToParent === "subagent") {
      throw new GatewayToolError(
        "permission_denied",
        "You are a worker: you cannot send urgent. Report or ask your `parent` without it, or put it in your final reply.",
      );
    }
    if (v2 && broadcast && kind !== "note") {
      throw new GatewayToolError(
        "permission_denied",
        "A broadcast is a note: it asks nobody anything and nobody is waiting on a reply. Ask the agent you need an answer from by name.",
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

    const recipients = mailbox.resolveRecipients(sender, parsed.to, input.store);
    // Urgent travels along a hand-off, either way, or comes from the main
    // agent. Between peers it would be one agent deciding another's work is
    // less important than its own.
    if (urgent && parentThreadId) {
      const peer = recipients.find((id) => relationshipOf(input.store, ctx.threadId, id) === "peer");
      if (peer) {
        throw new GatewayToolError(
          "permission_denied",
          `${nameOf(peer)} is not an agent you handed work to or work for, so you cannot send it urgent. Send it without urgent; it reaches ${nameOf(peer)} when its turn ends.`,
        );
      }
    }

    let replyTo = parsed.replyTo;
    let downgraded: string | null = null;
    if (v2) {
      for (const id of recipients) {
        const { state } = stateOf(id);
        // Over: nothing it is sent will be read by anyone working.
        if (state.state === "ended") {
          throw new GatewayToolError(
            "permission_denied",
            `${nameOf(id)}'s work is over (${state.ended ?? "ended"}). Give it more with agent_followup, or message someone else.`,
          );
        }
        // Two agents each parked on the other's answer wait for ever.
        if (parsed.wait === true && state.waitingOn.includes(ctx.threadId)) {
          throw new GatewayToolError(
            "permission_denied",
            `${nameOf(id)} is already waiting on you — answer it first.`,
          );
        }
        if (kind === "note" && !urgent && mailbox.getUnreadCount(id) >= INBOX_FULL) {
          throw new GatewayToolError(
            "permission_denied",
            `${nameOf(id)}'s inbox is full: ${INBOX_FULL} messages wait unseen. Send it only what it has to act on, as a question or report.`,
          );
        }
      }
      // An answer answers something: a question or pushback the recipient
      // sent to this agent. Anything else goes as the note it is, so it
      // cannot release a wait it has no business releasing.
      if (kind === "answer" && replyTo !== undefined) {
        const asked = mailbox.message(replyTo);
        const genuine =
          asked !== null &&
          asked.recipient === ctx.threadId &&
          (asked.kind === "question" || asked.kind === "pushback") &&
          recipients.length === 1 &&
          asked.senderThreadId === recipients[0];
        if (!genuine) {
          downgraded = replyTo;
          kind = "note";
          replyTo = undefined;
        }
      }
    }

    // A note waits for the recipient's next turn; everything else rings. A
    // broadcast is a note whatever it says.
    const rings = !v2 || (!broadcast && (kind !== "note" || urgent));
    const outgoing: IrcSendInput = { ...parsed, kind };
    if (replyTo === undefined) delete outgoing.replyTo;
    else outgoing.replyTo = replyTo;
    // Read before it is sent: an answer to an agent parked on it is returned
    // to that wait, and never rings.
    const before = recipients.map((id) => ({ id, ...stateOf(id) }));
    const result = mailbox.sendMessage(sender, outgoing, input.store, { rings, urgent });
    const now = Date.now();
    const receipts = before.map(({ id, state }) => ({
      to: id,
      ...deliveryReceipt({
        name: nameOf(id),
        state,
        rings,
        urgent,
        returned: kind === "answer" && (mailbox.waitingOn(id)?.threadIds.includes(ctx.threadId) ?? false),
        v2,
        now,
      }),
    }));

    const recipientDesc =
      result.recipients.length === 1
        ? result.recipients[0]
        : `${result.recipients.length} recipients (${result.recipients.join(", ")})`;
    const outcome = receipts.length === 1 && !broadcast ? receipts[0]!.outcome : "broadcast";
    const receiptText =
      receipts.length === 1 ? receipts[0]!.text : receipts.map((r) => `- ${r.text}`).join("\n");
    const downgradeNote = downgraded
      ? ` Sent as a note: ${downgraded} is not a question ${result.recipients.length === 1 ? nameOf(result.recipients[0]!) : "they"} asked you.`
      : "";
    const structured: GatewayRecord = {
      messageId: result.messageId,
      from: ctx.threadId,
      to: parsed.to,
      kind,
      urgent,
      delivered: result.delivered,
      recipients: result.recipients,
      replyTo: replyTo ?? null,
      createdAt: result.message.createdAt,
      outcome,
      text: receiptText + downgradeNote,
      receipts,
    };

    if (parsed.wait === true) {
      const stopWaiting = mailbox.trackWait(ctx.threadId, result.recipients);
      const reply = await mailbox
        .waitForReply(ctx.threadId, result.copyIds, parsed.timeoutMs ?? AGENT_MESSAGE_WAIT_MAX_MS, ctx.signal)
        .finally(stopWaiting);
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
          text: `Sent ${kind} ${result.messageId} to ${parsed.to} [${recipientDesc}]. ${receiptText}${downgradeNote}`,
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
    const now = Date.now();
    // History first, so it holds what was seen before this read, not the
    // messages this read is about to return.
    const history = parsed.history === true ? mailbox.history(ctx.threadId, Math.min(parsed.limit ?? INBOX_HISTORY_MAX, INBOX_HISTORY_MAX)) : [];
    const result = mailbox.getInbox(ctx.threadId, { limit: parsed.limit });

    const parts: string[] = [];
    if (result.messages.length === 0) parts.push("Nothing unseen in your inbox.");
    else {
      const more = result.unreadCount > 0 ? ` ${result.unreadCount} more still unseen.` : "";
      parts.push(
        `${result.messages.length} unseen message${result.messages.length === 1 ? "" : "s"}, now marked seen.${more}\n\n` +
          result.messages.map((m) => renderInboxLine(m, now)).join("\n\n"),
      );
    }
    if (parsed.history === true) {
      parts.push(
        history.length === 0
          ? "No history: you have not seen any messages yet."
          : `Seen before, newest first:\n\n${history.map((m) => renderInboxLine(m, now)).join("\n\n")}`,
      );
    }

    const structured: GatewayRecord = {
      messages: result.messages.map(inboxEntry),
      count: result.messages.length,
      unseenRemaining: result.unreadCount,
    };
    if (parsed.history === true) structured.history = history.map(inboxEntry);
    return { content: [{ type: "text", text: parts.join("\n\n") }], structuredContent: structured };
  };

  /** What one agent is doing now, as a sender sees it. */
  const stateOf = (id: string) => {
    const meta = input.store?.threadMeta?.(id) ?? null;
    const runtime = input.threadRuntime?.(id) ?? (input.isThreadLive?.(id) ? liveOnly() : null);
    const waitingOn = mergeWaits(input.waitingOn?.(id) ?? null, mailbox.waitingOn(id));
    const steersWhenClosed = meta && input.providerSteers ? input.providerSteers(meta.provider) : null;
    const state = recipientState({
      runtime,
      spawned: input.spawnedStatus?.(id) ?? null,
      waitingOn,
      providerSteers: steersWhenClosed,
      unseen: mailbox.getUnreadCount(id),
      oldestUnseenAt: mailbox.oldestUnseenAt(id),
    });
    return { runtime, state };
  };

  /** The name a sender knows an agent by. */
  const nameOf = (id: string): string =>
    mailbox.getThread(id)?.agentName ?? (input.store ? threadAgentName(input.store, id) : id);

  const listHandler = async (ctx: GatewayToolContext): Promise<GatewayToolResult> => {
    const store = input.store;
    const rootThreadId = store?.threadLineage?.(ctx.threadId)?.rootThreadId;
    const now = Date.now();
    // Every agent on the project, from the store, newest activity first —
    // plus anyone the mailbox knows that the store does not (a store-less
    // process, a thread from another project in the same tree).
    const ids: string[] = [];
    const seen = new Set<string>([ctx.threadId]);
    const add = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    for (const meta of store?.listThreads?.(ctx.cwd) ?? []) add(meta.threadId);
    for (const peer of mailbox.listPeers({ threadId: ctx.threadId, projectPath: ctx.cwd, rootThreadId })) add(peer.id);

    const rows = ids.map((id): PeerRow => {
      const meta = store?.threadMeta?.(id) ?? null;
      const { runtime, state } = stateOf(id);
      const row: PeerRow = {
        id,
        // How the listed agent relates to the reader: the reader's delegator
        // reads as "your delegator", as its messages are headed.
        relationship: relationshipOf(store, id, ctx.threadId),
        state: state.state,
        since: state.since,
        activity: state.activity,
        steers: state.steers,
        waitingOn: state.waitingOn,
        ended: state.ended,
        unseen: state.unseen,
        oldestUnseenAt: state.oldestUnseenAt,
        live: runtime?.live ?? false,
      };
      const agentName = mailbox.getThread(id)?.agentName ?? (store ? threadAgentName(store, id) : undefined);
      if (agentName) row.agentName = agentName;
      if (meta) row.provider = meta.provider;
      return row;
    });

    // Reachable agents first; the closed tail is what gets cut.
    const reachable = rows.filter((r) => r.state !== "closed" && r.state !== "ended");
    const rest = rows.filter((r) => r.state === "closed" || r.state === "ended");
    const listed = [...reachable, ...rest].slice(0, Math.max(ROSTER_MAX, reachable.length));
    const hidden = rows.length - listed.length;

    const lines = listed.map((p) => renderPeerLine(p, now, input.deliveryV2 === true));
    if (hidden > 0) {
      lines.push(`${hidden} more agent${hidden === 1 ? "" : "s"} on this project with closed sessions, not listed; address one by name or id.`);
    }
    const text = listed.length === 0 ? "No other agents on this project." : lines.join("\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: { peers: listed, count: listed.length, notListed: hidden },
    };
  };

  return [
    {
      name: "agent_message",
      description: input.deliveryV2 ? IRC_SEND_DESCRIPTION_V2 : IRC_SEND_DESCRIPTION,
      inputSchema: IrcSendInputSchema,
      jsonSchema: IRC_SEND_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet: input.deliveryV2
        ? "Message another kone agent as a note (waits for its next turn), question, pushback, report or answer (these ring: an idle agent wakes, a working one takes it when its turn ends), headed as yours so it is never taken for the user."
        : "Message another kone agent, running or idle — a running one is steered mid-turn, an idle one wakes with a new turn — as a note, question, pushback, report or answer, headed as yours so it is never taken for the user.",
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
        "See every kone agent on this project you can message, what each is doing, and what a message to it would do.",
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
        "Read what waits unseen in your inbox between steps, before ending your turn, or after compaction; answers and results reach you on their own, so never poll it.",
      handler: inboxHandler,
    },
  ];
}

/** Unseen messages past which an agent's inbox refuses more notes. */
export const INBOX_FULL = 200;

/** A runtime for a thread known only to be live: nothing else is known. */
function liveOnly(): ThreadRuntime {
  return {
    live: true,
    starting: false,
    busy: false,
    turnStartedAt: null,
    parked: null,
    parkedSince: null,
    compacting: false,
    steers: null,
    activeTool: null,
    lastActivityAt: null,
  };
}

/** The two kinds of wait — on a hand-off, on an answer — as one. */
function mergeWaits(
  a: { threadIds: string[]; since: number } | null,
  b: { threadIds: string[]; since: number } | null,
): { threadIds: string[]; since: number } | null {
  if (!a) return b;
  if (!b) return a;
  return { threadIds: [...new Set([...a.threadIds, ...b.threadIds])], since: Math.min(a.since, b.since) };
}

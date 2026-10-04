import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import type { AgentSender, CourierSender } from "@kone/protocol/message-sender";
import { setUserDataDir } from "./userDataDir.js";
import { IrcMailbox, type IrcMessageRecord } from "./gateway/tools/irc.js";
import { inboxBlockId } from "./dispatch.js";
import { IRC_DELIVERY_BATCH_MAX, IRC_DELIVERY_DEBOUNCE_MS, IRC_DELIVERY_RETRY_MS, startIrcDelivery } from "./ircDelivery.js";
import type { IrcTurnDispatcher } from "./ircDelivery.js";
import type { StartThreadTurnOptions } from "./dispatch.js";
import type { AgentInboxStore } from "./store/agentInbox.js";
import type { SendTurnInput, TurnStartResult } from "./types.js";

// Delivery against the REAL store, across restarts: the mail is on disk, so
// what a process was carrying when it died is what the next one carries.

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly ? new Database(filePath, { readonly: true }) : new Database(filePath);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}

mock.module("./sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

const COURIER: CourierSender = { kind: "courier", messageKind: "report" };

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-irc-store-test-"));
  setUserDataDir(dir);
  const store = new ConversationStoreCtor(dir);
  store.ensureThread({ threadId: "parent", projectPath: "/repo", provider: "codex" });
  return dir;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** One process: a store on the shared file, a mailbox on it, a delivery with
 *  a hand-cranked clock, and a dispatcher whose sends the test decides. */
function processOn(
  dir: string,
  opts: {
    live?: boolean;
    send?: (input: SendTurnInput, options?: StartThreadTurnOptions) => Promise<TurnStartResult>;
  } = {},
) {
  const store = new ConversationStoreCtor(dir);
  const mailbox = new IrcMailbox(store);
  const sent: SendTurnInput[] = [];
  const journaled: string[] = [];
  const pending = new Set<() => void>();
  /** The delay every arming asked for, in order. */
  const delays: number[] = [];
  const liveListeners = new Set<(threadId: string) => void>();
  let live = opts.live ?? true;
  const send = async (input: SendTurnInput, options?: StartThreadTurnOptions): Promise<TurnStartResult> => {
    sent.push(input);
    if (opts.send) return opts.send(input, options);
    return { threadId: input.threadId, turnId: `turn-${sent.length}` };
  };
  const dispatcher: IrcTurnDispatcher = { sendThreadTurn: send, steerThreadTurn: send };
  const stop = startIrcDelivery({
    mailbox,
    dispatcher,
    isLive: () => live,
    isBusy: () => false,
    onThreadLive: (listener) => {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    journal: (_threadId: string, message: IrcMessageRecord) => {
      journaled.push(message.id);
      return `blk-${message.id}`;
    },
    schedule: (fn, ms) => {
      delays.push(ms);
      pending.add(fn);
      return () => pending.delete(fn);
    },
  });
  return {
    store,
    mailbox,
    sent,
    journaled,
    stop,
    tick: () => {
      const due = [...pending];
      pending.clear();
      for (const fn of due) fn();
    },
    armed: () => pending.size,
    delays,
    report: (text: string) =>
      mailbox.sendCourierMessage({ to: "parent", projectPath: "/repo", message: text, kind: "report", sender: COURIER }),
    /** session.started for a thread. */
    comeBack: (threadId: string) => {
      live = true;
      for (const listener of liveListeners) listener(threadId);
    },
  };
}

describe("delivery on the stored inbox", () => {
  test("a delivery cut off by a restart is re-sent with the same block, never journaled twice", async () => {
    const dir = freshDir();
    // The first process journals the message and dies before the provider answers.
    const first = processOn(dir, { send: () => new Promise<TurnStartResult>(() => {}) });
    const sent = first.report("result");
    first.tick();
    await settle();
    expect(first.journaled).toEqual([sent!.messageId]);
    expect(first.sent).toHaveLength(1);
    first.stop();

    // The next process opens the store, finds it unseen, and carries it again.
    const second = processOn(dir, { live: false });
    expect(second.mailbox.getUnreadCount("parent")).toBe(1);
    second.comeBack("parent");
    second.tick();
    await settle();

    expect(second.journaled).toEqual([]);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.userBlockId).toBe(`blk-${sent!.messageId}`);
    expect(second.mailbox.getUnreadCount("parent")).toBe(0);
    expect(second.store.inboxHistory("parent", 10)[0]).toMatchObject({ state: "seen", turnId: "turn-1" });
  });

  // The provider took the turn; the process died while the checkpoint after
  // it was still being taken. The batch was settled when the provider took
  // it, so the next process has nothing to hand over again.
  test("a batch the provider took is settled before the send resolves, and is not replayed after a restart", async () => {
    const dir = freshDir();
    const first = processOn(dir, {
      send: (input, options) => {
        options?.onAccepted?.("turn-1");
        return new Promise<TurnStartResult>(() => {});
      },
    });
    const sent = first.report("result");
    first.tick();
    await settle();
    expect(first.store.inboxHistory("parent", 10)[0]).toMatchObject({ state: "seen", turnId: "turn-1" });
    first.stop();

    const second = processOn(dir, { live: false });
    expect(second.mailbox.getUnreadCount("parent")).toBe(0);
    second.comeBack("parent");
    second.tick();
    await settle();
    expect(second.sent).toHaveLength(0);
    expect(sent).toBeDefined();
  });

  test("a send that throws releases the batch; the retry names the same block", async () => {
    const dir = freshDir();
    let fail = true;
    const proc = processOn(dir, {
      send: async (input) => {
        if (fail) throw new Error("session reaped");
        return { threadId: input.threadId, turnId: "turn-ok" };
      },
    });
    const sent = proc.report("result");
    proc.tick();
    await settle();
    expect(proc.mailbox.getUnreadCount("parent")).toBe(1);
    expect(proc.store.listUnseenInbox("parent")[0]?.blockId).toBe(`blk-${sent!.messageId}`);

    fail = false;
    proc.comeBack("parent");
    proc.tick();
    await settle();
    expect(proc.journaled).toEqual([sent!.messageId]);
    expect(proc.sent.map((s) => s.userBlockId)).toEqual([`blk-${sent!.messageId}`, `blk-${sent!.messageId}`]);
    expect(proc.mailbox.getUnreadCount("parent")).toBe(0);
  });

  test("a released batch is tried again on its own, later each time, until the tries run out", async () => {
    const dir = freshDir();
    const proc = processOn(dir, {
      send: async () => {
        throw new Error("provider refused");
      },
    });
    proc.report("result");
    for (let i = 0; i <= IRC_DELIVERY_RETRY_MS.length; i++) {
      proc.tick();
      await settle();
    }
    expect(proc.sent).toHaveLength(IRC_DELIVERY_RETRY_MS.length + 1);
    expect(proc.delays).toEqual([IRC_DELIVERY_DEBOUNCE_MS, ...IRC_DELIVERY_RETRY_MS]);
    // Out of tries: it waits in the inbox for the next message or the thread
    // coming back.
    expect(proc.armed()).toBe(0);
    expect(proc.mailbox.getUnreadCount("parent")).toBe(1);
  });

  test("a retry that lands starts the count over", async () => {
    const dir = freshDir();
    let fail = true;
    const proc = processOn(dir, {
      send: async (input) => {
        if (fail) throw new Error("provider refused");
        return { threadId: input.threadId, turnId: "turn-ok" };
      },
    });
    proc.report("one");
    proc.tick();
    await settle();
    fail = false;
    proc.tick();
    await settle();
    expect(proc.mailbox.getUnreadCount("parent")).toBe(0);

    fail = true;
    proc.report("two");
    proc.tick();
    await settle();
    expect(proc.delays.at(-1)).toBe(IRC_DELIVERY_RETRY_MS[0]);
  });

  test("a held notice arms nothing: it waits for whatever turn comes next", async () => {
    const dir = freshDir();
    const proc = processOn(dir);
    proc.mailbox.sendNotice({ to: "parent", projectPath: "/repo", message: "The user spoke to Ada.", rings: false });
    expect(proc.armed()).toBe(0);
    proc.comeBack("parent");
    expect(proc.armed()).toBe(0);
    expect(proc.mailbox.heldCount("parent")).toBe(1);

    // A ringing notice is handed over like any message.
    proc.mailbox.sendNotice({ to: "parent", projectPath: "/repo", message: "Stop here.", rings: true });
    proc.tick();
    await settle();
    expect(proc.sent).toHaveLength(1);
    expect(proc.sent[0]!.input).toBe("<kone_notice>\nStop here.\n</kone_notice>");
    expect(proc.journaled).toHaveLength(1);
    expect(proc.mailbox.heldCount("parent")).toBe(1);
  });

  test("mail sent while the recipient was away survives a restart and goes out on session.started", async () => {
    const dir = freshDir();
    const first = processOn(dir, { live: false });
    first.report("one");
    first.report("two");
    first.tick();
    await settle();
    expect(first.sent).toEqual([]);
    first.stop();

    const second = processOn(dir, { live: false });
    second.comeBack("parent");
    second.tick();
    await settle();
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.input).toContain("one");
    expect(second.sent[0]!.input).toContain("two");
    expect(second.mailbox.getUnreadCount("parent")).toBe(0);
  });

  test("past the batch cap the rest are kept, not dropped, and the overflow re-arms", async () => {
    const dir = freshDir();
    const proc = processOn(dir);
    const total = IRC_DELIVERY_BATCH_MAX + 3;
    for (let i = 0; i < total; i++) proc.report(`r${i}`);
    proc.tick();
    await settle();

    expect(proc.sent).toHaveLength(1);
    expect(proc.sent[0]!.input).toContain("3 more messages are still in your inbox.");
    expect(proc.mailbox.getUnreadCount("parent")).toBe(3);
    expect(proc.armed()).toBe(1);

    proc.tick();
    await settle();
    expect(proc.sent).toHaveLength(2);
    expect(proc.mailbox.getUnreadCount("parent")).toBe(0);
    expect(proc.store.inboxHistory("parent", 100)).toHaveLength(total);
  });

  test("the same settled turn reported twice is stored once", () => {
    const dir = freshDir();
    const proc = processOn(dir);
    const once = proc.mailbox.sendCourierMessage({
      to: "parent",
      projectPath: "/repo",
      message: "done",
      kind: "report",
      sender: COURIER,
      dedupeKey: "report:child:turn-1",
    });
    const twice = proc.mailbox.sendCourierMessage({
      to: "parent",
      projectPath: "/repo",
      message: "done",
      kind: "report",
      sender: COURIER,
      dedupeKey: "report:child:turn-1",
    });
    expect(once).not.toBeNull();
    expect(twice).toBeNull();
    expect(proc.mailbox.getUnreadCount("parent")).toBe(1);
  });

  test("a message to a thread the store does not know fails at the sender", () => {
    const dir = freshDir();
    const proc = processOn(dir);
    expect(() =>
      proc.mailbox.sendCourierMessage({ to: "ghost", projectPath: "/repo", message: "x", kind: "report", sender: COURIER }),
    ).toThrow(/could not store/);
  });
});

// What a dead process was handing over, sorted at the next open: settled only
// by an explicit record of the turn that took it, otherwise held uncertain —
// never resent, never pinned on some other turn.
describe("recovery of a hand-over that was on its way", () => {
  const LEAD: AgentSender = {
    kind: "agent",
    threadId: "lead",
    name: "Vera",
    relationship: "delegator",
    messageKind: "followup",
  };

  /** A job from "lead" to "parent", claimed and marked sent: on its way to
   *  the provider when the process died. */
  function jobOnItsWay(proc: ReturnType<typeof processOn>, text: string) {
    proc.store.ensureThread({ threadId: "lead", projectPath: "/repo", provider: "codex" });
    const id = proc.mailbox.postJob({ to: "parent", projectPath: "/repo", message: text, sender: LEAD, urgent: true })
      .messageId;
    const blockId = inboxBlockId(id);
    proc.store.recordUserBlock({ blockId, threadId: "parent", text, sender: LEAD });
    proc.mailbox.setBlockId(id, blockId);
    const claim = proc.mailbox.claimJob("parent", true)!;
    proc.mailbox.sendingDelivery(claim.deliveryId);
    return { id, deliveryId: claim.deliveryId };
  }

  // The urgent steer was marked sent, the provider refused it, the release
  // was lost, and the user's own queued turn started before the process
  // died. That turn is no record of the job: the job is uncertain.
  test("a refused steer is never settled to an unrelated turn that started after it", () => {
    const dir = freshDir();
    const first = processOn(dir, { live: false });
    const { id } = jobOnItsWay(first, "Revert the migration.");
    first.store.recordUserBlock({ threadId: "parent", text: "the user's own words" });
    first.store.applyEvent({
      type: "turn.started",
      threadId: "parent",
      provider: "codex",
      turnId: "user-turn",
      at: Date.now() + 1,
      source: "codex.app-server",
    });
    first.stop();

    const second = processOn(dir, { live: false });
    expect(second.mailbox.jobTurn(id)).toEqual({ recipient: "parent", handedOver: false, turnId: null, uncertain: true });
    expect(second.store.inboxHistory("parent", 10).map((r) => r.inboxId)).not.toContain(id);
    // Delivery skips it: nothing hands it over again.
    expect(second.mailbox.claimJob("parent", true)).toBeNull();
    expect(second.mailbox.claimJob("parent")).toBeNull();
  });

  // The provider took it and the link was written; the settle was lost with
  // the process. The link is the record: seen, with that turn.
  test("a hand-over whose settle was lost is settled by the link written when the provider took it", () => {
    const dir = freshDir();
    const first = processOn(dir, { live: false });
    const { id, deliveryId } = jobOnItsWay(first, "Revert the migration.");
    // A store whose settle fails, as when the disk is full: the link lands,
    // the settle does not, and the process dies before its retry.
    const losesSettles: AgentInboxStore = Object.assign(Object.create(first.store), {
      settleInboxDelivery: () => null,
    });
    new IrcMailbox(losesSettles).settleDelivery(deliveryId, "turn-7");
    expect(first.store.inboxMessage(id)?.state).toBe("handing");
    first.stop();

    const second = processOn(dir, { live: false });
    expect(second.mailbox.jobTurn(id)).toEqual({ recipient: "parent", handedOver: true, turnId: "turn-7" });
  });

  test("restarting again and again tells the recipient and the sender once each", () => {
    const dir = freshDir();
    const first = processOn(dir, { live: false });
    jobOnItsWay(first, "Revert the migration.");
    first.stop();
    for (let i = 0; i < 3; i++) processOn(dir, { live: false }).stop();

    const last = processOn(dir, { live: false });
    const toRecipient = last.store.listUnseenInbox("parent").filter((r) => r.kind === "notice");
    const toSender = last.store.listUnseenInbox("lead").filter((r) => r.kind === "notice");
    expect(toRecipient).toHaveLength(1);
    expect(toSender).toHaveLength(1);
    // Held: each rides the reader's next turn and never starts one.
    expect(toRecipient[0]!.rings).toBe(false);
    expect(toSender[0]!.rings).toBe(false);
    // No bodies: the job may already be in the recipient's context.
    expect(toRecipient[0]!.body).not.toContain("Revert the migration.");
    expect(toRecipient[0]!.body).toContain("agent_inbox");
    expect(toSender[0]!.body).toContain("agent_followup again with a new requestId");
  });

  test("the recipient's inbox read lists an uncertain message, flagged, and marks it seen", () => {
    const dir = freshDir();
    const first = processOn(dir, { live: false });
    const { id } = jobOnItsWay(first, "Revert the migration.");
    first.stop();

    const second = processOn(dir, { live: false });
    const read = second.mailbox.getInbox("parent");
    expect(read.messages.find((m) => m.id === id)).toMatchObject({ uncertain: true, read: true });
    expect(second.store.inboxMessage(id)?.state).toBe("seen");
    expect(second.mailbox.getInbox("parent").messages.find((m) => m.id === id)).toBeUndefined();
  });

  // Reading says the recipient saw it, not that it ran: whoever waits on the
  // job must still learn it may never have arrived, in this process and the
  // next.
  test("reading an uncertain job leaves it uncertain to whoever waits on it", () => {
    const dir = freshDir();
    const first = processOn(dir, { live: false });
    const { id } = jobOnItsWay(first, "Revert the migration.");
    first.stop();

    const second = processOn(dir, { live: false });
    second.mailbox.getInbox("parent");
    const uncertain = { recipient: "parent", handedOver: false, turnId: null, uncertain: true };
    expect(second.mailbox.jobTurn(id)).toEqual(uncertain);
    second.stop();

    expect(processOn(dir, { live: false }).mailbox.jobTurn(id)).toEqual(uncertain);
  });

  test("a hand-over never marked sent goes back to unseen and is handed over again", () => {
    const dir = freshDir();
    const first = processOn(dir, { live: false });
    first.store.ensureThread({ threadId: "lead", projectPath: "/repo", provider: "codex" });
    const id = first.mailbox.postJob({ to: "parent", projectPath: "/repo", message: "Add tests.", sender: LEAD }).messageId;
    expect(first.mailbox.claimJob("parent")).not.toBeNull();
    first.stop();

    const second = processOn(dir, { live: false });
    expect(second.store.inboxMessage(id)?.state).toBe("unseen");
    expect(second.mailbox.claimJob("parent")?.messages[0]?.id).toBe(id);
  });
});

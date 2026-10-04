import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import type { CourierSender } from "@kone/protocol/message-sender";
import { setUserDataDir } from "./userDataDir.js";
import { IrcMailbox, type IrcMessageRecord } from "./gateway/tools/irc.js";
import { IRC_DELIVERY_BATCH_MAX, startIrcDelivery } from "./ircDelivery.js";
import type { IrcTurnDispatcher } from "./ircDelivery.js";
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
function processOn(dir: string, opts: { live?: boolean; send?: (input: SendTurnInput) => Promise<TurnStartResult> } = {}) {
  const store = new ConversationStoreCtor(dir);
  const mailbox = new IrcMailbox(store);
  const sent: SendTurnInput[] = [];
  const journaled: string[] = [];
  const pending = new Set<() => void>();
  const liveListeners = new Set<(threadId: string) => void>();
  let live = opts.live ?? true;
  const send = async (input: SendTurnInput): Promise<TurnStartResult> => {
    sent.push(input);
    if (opts.send) return opts.send(input);
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
    schedule: (fn) => {
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

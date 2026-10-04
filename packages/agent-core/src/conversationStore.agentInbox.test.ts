import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import type { InboxInsert } from "./store/agentInbox.js";

// ConversationStore imports node:sqlite, which bun can't load: stand it in
// with bun:sqlite and import the store only once the stub is in place.
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

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

let seq = 0;

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-agent-inbox-test-"));
  setUserDataDir(dir);
  const store = new ConversationStoreCtor(dir);
  store.ensureThread({ threadId: "t", projectPath: "/repo", provider: "codex" });
  return { store, dir };
}

function message(over: Partial<InboxInsert> = {}): InboxInsert {
  return {
    inboxId: `msg_${++seq}`,
    recipientThreadId: "t",
    senderThreadId: "s",
    sender: { kind: "agent", threadId: "s", relationship: "peer" },
    kind: "note",
    body: `body ${seq}`,
    projectPath: "/repo",
    createdAt: seq,
    ...over,
  };
}

const stateOf = (store: ConversationStoreType, id: string) => {
  if (store.listUnseenInbox("t").some((r) => r.inboxId === id)) return "unseen";
  return store.inboxHistory("t", 100).find((r) => r.inboxId === id)?.state ?? "other";
};

describe("the agent inbox store", () => {
  test("a claim takes the oldest unseen up to its limit, and no second claim gets them", () => {
    const { store } = freshStore();
    const ids = [message(), message(), message()].map((m) => {
      expect(store.insertInboxMessage(m)).toBe("inserted");
      return m.inboxId;
    });

    const first = store.claimInbox("t", 2, "ringing");
    expect(first?.rows.map((r) => r.inboxId)).toEqual(ids.slice(0, 2));
    expect(first?.rows.every((r) => r.state === "handing" && r.deliveryId === first.deliveryId)).toBe(true);
    const second = store.claimInbox("t", 8, "ringing");
    expect(second?.rows.map((r) => r.inboxId)).toEqual([ids[2]]);
    expect(store.claimInbox("t", 8, "ringing")).toBeNull();
    expect(store.unseenInboxCount("t")).toBe(0);
  });

  test("settle marks the batch seen with its turn; settling again changes nothing", () => {
    const { store } = freshStore();
    const m = message();
    store.insertInboxMessage(m);
    const claim = store.claimInbox("t", 8, "ringing")!;

    expect(store.settleInboxDelivery(claim.deliveryId, "turn-1")).toBe(1);
    const [seen] = store.inboxHistory("t", 10);
    expect(seen).toMatchObject({ inboxId: m.inboxId, state: "seen", seenVia: "turn", turnId: "turn-1" });
    expect(seen!.seenAt).not.toBeNull();
    expect(store.settleInboxDelivery(claim.deliveryId, "turn-2")).toBe(0);
    expect(store.releaseInboxDelivery(claim.deliveryId)).toBe(0);
  });

  test("release puts the batch back to unseen and keeps the block it was written as", () => {
    const { store } = freshStore();
    const m = message();
    store.insertInboxMessage(m);
    const claim = store.claimInbox("t", 8, "ringing")!;
    store.setInboxBlockId(m.inboxId, "blk-1");

    expect(store.releaseInboxDelivery(claim.deliveryId)).toBe(1);
    const [again] = store.listUnseenInbox("t");
    expect(again).toMatchObject({ inboxId: m.inboxId, state: "unseen", deliveryId: null, blockId: "blk-1" });
    // The released delivery no longer owns it: its late settle is a no-op.
    expect(store.settleInboxDelivery(claim.deliveryId, "turn-1")).toBe(0);
    expect(store.claimInbox("t", 8, "ringing")?.rows[0]?.blockId).toBe("blk-1");
  });

  test("markSeen takes only what is unseen, so a claimed message cannot be taken twice", () => {
    const { store } = freshStore();
    const claimed = message();
    const free = message();
    store.insertInboxMessage(claimed);
    store.claimInbox("t", 1, "ringing");
    store.insertInboxMessage(free);

    expect(store.markInboxSeen([claimed.inboxId, free.inboxId], "wait")).toEqual([free.inboxId]);
    expect(store.inboxHistory("t", 10)[0]).toMatchObject({ inboxId: free.inboxId, seenVia: "wait" });
    expect(store.claimInbox("t", 8, "ringing")).toBeNull();
  });

  test("retract takes back only an unseen message", () => {
    const { store } = freshStore();
    const a = message();
    const b = message();
    store.insertInboxMessage(a);
    store.claimInbox("t", 1, "ringing");
    store.insertInboxMessage(b);

    expect(store.retractInboxMessage(a.inboxId)).toBe(false);
    expect(store.retractInboxMessage(b.inboxId)).toBe(true);
    expect(store.retractInboxMessage(b.inboxId)).toBe(false);
    expect(store.unseenInboxCount("t")).toBe(0);
  });

  test("the first open of a new process puts every claimed message back, block kept", () => {
    const { store, dir } = freshStore();
    const m = message();
    store.insertInboxMessage(m);
    const claim = store.claimInbox("t", 8, "ringing")!;
    store.setInboxBlockId(m.inboxId, "blk-9");

    const reopened = new ConversationStoreCtor(dir);
    const [back] = reopened.listUnseenInbox("t");
    expect(back).toMatchObject({ inboxId: m.inboxId, state: "unseen", deliveryId: null, blockId: "blk-9" });
    // The dead process's delivery settles nothing.
    expect(store.settleInboxDelivery(claim.deliveryId, "turn-1")).toBe(0);
  });

  test("resetInboxHandingAtBoot releases what a dead hand-over held", () => {
    const { store } = freshStore();
    store.insertInboxMessage(message());
    store.claimInbox("t", 8, "ringing");
    store.resetInboxHandingAtBoot();
    expect(store.unseenInboxCount("t")).toBe(1);
  });

  test("a dedupe key refuses a second copy of the same message", () => {
    const { store } = freshStore();
    expect(store.insertInboxMessage(message({ dedupeKey: "report:c:turn-1" }))).toBe("inserted");
    expect(store.insertInboxMessage(message({ dedupeKey: "report:c:turn-1" }))).toBe("duplicate");
    expect(store.insertInboxMessage(message({ dedupeKey: "report:c:turn-2" }))).toBe("inserted");
    expect(store.unseenInboxCount("t")).toBe(2);
  });

  test("a message for a thread that does not exist is not stored", () => {
    const { store } = freshStore();
    expect(store.insertInboxMessage(message({ recipientThreadId: "nobody" }))).toBe("failed");
  });

  test("a message with no known sender stores and reads back as null", () => {
    const { store } = freshStore();
    store.insertInboxMessage(message({ sender: null, senderThreadId: null }));
    expect(store.listUnseenInbox("t")[0]?.sender).toBeNull();
  });

  test("a thread's messages go with it", () => {
    const { store } = freshStore();
    store.insertInboxMessage(message());
    store.insertInboxMessage(message());
    expect(store.unseenInboxCount("t")).toBe(2);

    store.deleteThread("t");
    expect(store.unseenInboxCount("t")).toBe(0);
    expect(store.listUnseenInbox("t")).toEqual([]);
  });

  test("a held message is claimed only as held, and a ringing one only as ringing", () => {
    const { store } = freshStore();
    const ringing = message();
    const held = message({ kind: "notice", rings: false, sender: { kind: "system" }, senderThreadId: null });
    store.insertInboxMessage(ringing);
    store.insertInboxMessage(held);

    expect(store.unseenInboxCount("t")).toBe(2);
    expect(store.unseenInboxCount("t", "ringing")).toBe(1);
    expect(store.unseenInboxCount("t", "held")).toBe(1);
    const heldClaim = store.claimInbox("t", 8, "held");
    expect(heldClaim?.rows.map((r) => r.inboxId)).toEqual([held.inboxId]);
    expect(heldClaim?.rows[0]).toMatchObject({ rings: false, sender: { kind: "system" } });
    expect(store.claimInbox("t", 8, "held")).toBeNull();
    expect(store.claimInbox("t", 8, "ringing")?.rows.map((r) => r.inboxId)).toEqual([ringing.inboxId]);
  });

  test("history lists seen messages, newest first, and leaves out retracted ones", () => {
    const { store } = freshStore();
    const [a, b, c] = [message(), message(), message()];
    for (const m of [a!, b!, c!]) store.insertInboxMessage(m);
    store.markInboxSeen([a!.inboxId], "inbox");
    store.retractInboxMessage(b!.inboxId);
    const claim = store.claimInbox("t", 8, "ringing")!;
    store.settleInboxDelivery(claim.deliveryId, "turn-1");

    const history = store.inboxHistory("t", 10).map((r) => r.inboxId);
    expect(history).toEqual([c!.inboxId, a!.inboxId]);
    expect(stateOf(store, b!.inboxId)).toBe("other");
  });
});

describe("what a turn takes from the inbox", () => {
  test("answers first, then oldest, held and ringing alike", () => {
    const { store } = freshStore();
    const held = message({ rings: false });
    const ringing = message({ kind: "question" });
    const answer = message({ kind: "answer" });
    for (const m of [held, ringing, answer]) store.insertInboxMessage(m);

    expect(store.unseenInboxCount("t", "ringing")).toBe(2);
    expect(store.unseenInboxCount("t", "held")).toBe(1);
    const claim = store.claimInbox("t", 8, "all");
    expect(claim?.rows.map((r) => r.inboxId)).toEqual([answer.inboxId, held.inboxId, ringing.inboxId]);
  });

  test("urgent is claimed on its own, and always rings", () => {
    const { store } = freshStore();
    const plain = message({ kind: "question" });
    const urgent = message({ urgent: true, rings: true });
    for (const m of [plain, urgent]) store.insertInboxMessage(m);

    expect(store.unseenInboxCount("t", "urgent")).toBe(1);
    expect(store.claimInbox("t", 8, "urgent")?.rows.map((r) => r.inboxId)).toEqual([urgent.inboxId]);
    expect(stateOf(store, plain.inboxId)).toBe("unseen");
  });

  test("one message reads back by id whatever its state", () => {
    const { store } = freshStore();
    const m = message({ kind: "question" });
    store.insertInboxMessage(m);
    const claim = store.claimInbox("t", 8, "all")!;
    store.settleInboxDelivery(claim.deliveryId, "turn-1");

    expect(store.inboxMessage(m.inboxId)).toMatchObject({ inboxId: m.inboxId, kind: "question", state: "seen" });
    expect(store.inboxMessage("msg_nope")).toBeNull();
  });
});

describe("what the app hears about an inbox", () => {
  test("every state move tells the listener whose inbox moved", () => {
    const { store } = freshStore();
    store.ensureThread({ threadId: "u", projectPath: "/repo", provider: "codex" });
    const heard: string[][] = [];
    const off = store.onInboxChanged((ids) => heard.push([...ids]));

    const a = message();
    const b = message({ recipientThreadId: "u" });
    expect(store.insertInboxMessage(a)).toBe("inserted");
    store.insertInboxMessage(b);
    expect(heard).toEqual([["t"], ["u"]]);

    heard.length = 0;
    const claim = store.claimInbox("t", 8, "all")!;
    store.releaseInboxDelivery(claim.deliveryId);
    const again = store.claimInbox("t", 8, "all")!;
    store.settleInboxDelivery(again.deliveryId, "turn-1");
    expect(heard).toEqual([["t"], ["t"], ["t"], ["t"]]);

    heard.length = 0;
    store.markInboxSeen([b.inboxId], "inbox");
    const c = message({ recipientThreadId: "u" });
    store.insertInboxMessage(c);
    store.retractInboxMessage(c.inboxId);
    expect(heard).toEqual([["u"], ["u"], ["u"]]);

    off();
    store.insertInboxMessage(message());
    expect(heard).toHaveLength(3);
  });

  test("nothing that changed nothing is announced", () => {
    const { store } = freshStore();
    const m = message({ dedupeKey: "k" });
    store.insertInboxMessage(m);
    const heard: string[][] = [];
    store.onInboxChanged((ids) => heard.push([...ids]));

    expect(store.insertInboxMessage(message({ dedupeKey: "k" }))).toBe("duplicate");
    expect(store.settleInboxDelivery("dlv_nope", null)).toBe(0);
    expect(store.releaseInboxDelivery("dlv_nope")).toBe(0);
    expect(store.claimInbox("t", 8, "urgent")).toBeNull();
    store.markInboxSeen([m.inboxId], "inbox");
    heard.length = 0;
    expect(store.markInboxSeen([m.inboxId], "inbox")).toEqual([]);
    expect(store.retractInboxMessage(m.inboxId)).toBe(false);
    expect(heard).toEqual([]);
  });

  test("a listener that throws does not undo the write", () => {
    const { store } = freshStore();
    store.onInboxChanged(() => {
      throw new Error("boom");
    });
    const m = message();
    const errors = console.error;
    console.error = () => {};
    try {
      expect(store.insertInboxMessage(m)).toBe("inserted");
    } finally {
      console.error = errors;
    }
    expect(stateOf(store, m.inboxId)).toBe("unseen");
  });

  test("waiting lists a message a restart left uncertain", () => {
    const { store } = freshStore();
    const m = message();
    store.insertInboxMessage(m);
    const claim = store.claimInbox("t", 8, "all")!;
    store.markInboxSending(claim.deliveryId);
    store.resetInboxHandingAtBoot();

    expect(store.listWaitingInbox("t").find((r) => r.inboxId === m.inboxId)?.state).toBe("uncertain");
  });

  test("a read uncertain message moves to history and stays uncertain", () => {
    const { store } = freshStore();
    const m = message();
    store.insertInboxMessage(m);
    const claim = store.claimInbox("t", 8, "all")!;
    store.markInboxSending(claim.deliveryId);
    store.resetInboxHandingAtBoot();
    store.markInboxSeen([m.inboxId], "inbox");

    expect(store.listWaitingInbox("t").some((r) => r.inboxId === m.inboxId)).toBe(false);
    const read = store.inboxHistory("t", 20).find((r) => r.inboxId === m.inboxId);
    expect(read?.state).toBe("seen");
    expect(read?.uncertainAt).not.toBeNull();
  });

  test("waiting lists unseen and handing, oldest first, and nothing seen", () => {
    const { store } = freshStore();
    const first = message();
    const second = message();
    const third = message();
    for (const m of [first, second, third]) store.insertInboxMessage(m);
    store.markInboxSeen([third.inboxId], "inbox");
    store.claimInbox("t", 1, "all");

    expect(store.listWaitingInbox("t").map((r) => [r.inboxId, r.state])).toEqual([
      [first.inboxId, "handing"],
      [second.inboxId, "unseen"],
    ]);
  });
});

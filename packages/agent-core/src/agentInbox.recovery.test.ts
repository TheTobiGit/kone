import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import type { AgentSender, CourierSender } from "@kone/protocol/message-sender";
import { setUserDataDir } from "./userDataDir.js";
import { IrcMailbox } from "./gateway/tools/irc.js";
import { inboxBlockId } from "./dispatch.js";
import type { AgentInboxStore } from "./store/agentInbox.js";

// The inbox against the REAL store, across restarts: the mail is on disk, so
// what a process was carrying when it died is what the next one sorts out.

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

/** One process: a store on the shared file, and a mailbox on it. */
function processOn(dir: string) {
  const store = new ConversationStoreCtor(dir);
  const mailbox = new IrcMailbox(store);
  return { store, mailbox };
}

describe("the stored inbox", () => {
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
    const first = processOn(dir);
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

    const second = processOn(dir);
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
    const first = processOn(dir);
    const { id, deliveryId } = jobOnItsWay(first, "Revert the migration.");
    // A store whose settle fails, as when the disk is full: the link lands,
    // the settle does not, and the process dies before its retry.
    const losesSettles: AgentInboxStore = Object.assign(Object.create(first.store), {
      settleInboxDelivery: () => null,
    });
    new IrcMailbox(losesSettles).settleDelivery(deliveryId, "turn-7");
    expect(first.store.inboxMessage(id)?.state).toBe("handing");

    const second = processOn(dir);
    expect(second.mailbox.jobTurn(id)).toEqual({ recipient: "parent", handedOver: true, turnId: "turn-7" });
  });

  test("restarting again and again tells the recipient and the sender once each", () => {
    const dir = freshDir();
    const first = processOn(dir);
    jobOnItsWay(first, "Revert the migration.");
    for (let i = 0; i < 3; i++) processOn(dir);

    const last = processOn(dir);
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
    const first = processOn(dir);
    const { id } = jobOnItsWay(first, "Revert the migration.");

    const second = processOn(dir);
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
    const first = processOn(dir);
    const { id } = jobOnItsWay(first, "Revert the migration.");

    const second = processOn(dir);
    second.mailbox.getInbox("parent");
    const uncertain = { recipient: "parent", handedOver: false, turnId: null, uncertain: true };
    expect(second.mailbox.jobTurn(id)).toEqual(uncertain);

    expect(processOn(dir).mailbox.jobTurn(id)).toEqual(uncertain);
  });

  // Recovery is one transaction: when its notices cannot be written, nothing
  // of it is. The rows it was settling must not wait for another restart:
  // once writes come back they are settled, and only they — a hand-over this
  // process started meanwhile is live and left alone.
  test("a boot recovery that could not be written is finished once writes come back", async () => {
    const dir = freshDir();
    const first = processOn(dir);
    const { id: sent } = jobOnItsWay(first, "Revert the migration.");
    const unsent = first.mailbox.postJob({ to: "parent", projectPath: "/repo", message: "Add tests.", sender: LEAD })
      .messageId;
    first.store.ensureThread({ threadId: "other", projectPath: "/repo", provider: "codex" });
    const live = first.mailbox.postJob({ to: "other", projectPath: "/repo", message: "Lint.", sender: LEAD }).messageId;
    expect(first.mailbox.claimJob("parent")?.messages.map((m) => m.id)).toEqual([unsent]);
    const outage = new Database(path.join(dir, "kone.sqlite"));
    outage.exec(`CREATE TRIGGER notices_fail BEFORE INSERT ON agent_inbox WHEN NEW.kind = 'notice'
                  BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);

    const second = processOn(dir);
    expect(second.store.inboxMessage(sent)?.state).toBe("handing");
    expect(second.store.inboxMessage(unsent)?.state).toBe("handing");
    const told: string[] = [];
    second.store.onInboxChanged((threadIds) => told.push(...threadIds));
    const claim = second.mailbox.claimJob("other");
    expect(claim?.messages.map((m) => m.id)).toEqual([live]);
    outage.exec("DROP TRIGGER notices_fail");
    outage.close();

    const start = Date.now();
    while (second.store.inboxMessage(sent)?.state === "handing" && Date.now() - start < 3_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(second.mailbox.jobTurn(sent)).toEqual({ recipient: "parent", handedOver: false, turnId: null, uncertain: true });
    expect(second.store.inboxMessage(unsent)?.state).toBe("unseen");
    expect(second.store.listUnseenInbox("lead").filter((r) => r.kind === "notice")).toHaveLength(1);
    // The ringer hears of what went back to unseen.
    expect(told).toContain("parent");
    // This process's own hand-over is still its own.
    expect(second.store.inboxMessage(live)?.state).toBe("handing");
    expect(second.store.inboxMessage(live)?.deliveryId).toBe(claim!.deliveryId);
  });

  test("a hand-over never marked sent goes back to unseen and is handed over again", () => {
    const dir = freshDir();
    const first = processOn(dir);
    first.store.ensureThread({ threadId: "lead", projectPath: "/repo", provider: "codex" });
    const id = first.mailbox.postJob({ to: "parent", projectPath: "/repo", message: "Add tests.", sender: LEAD }).messageId;
    expect(first.mailbox.claimJob("parent")).not.toBeNull();

    const second = processOn(dir);
    expect(second.store.inboxMessage(id)?.state).toBe("unseen");
    expect(second.mailbox.claimJob("parent")?.messages[0]?.id).toBe(id);
  });
});

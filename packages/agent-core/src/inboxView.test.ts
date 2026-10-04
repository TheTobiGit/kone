import { describe, expect, test } from "bun:test";

import { inboxHistoryView, waitingInbox, type InboxViewSource } from "./inboxView.js";
import type { InboxRow } from "./store/agentInbox.js";

function row(over: Partial<InboxRow>): InboxRow {
  return {
    inboxId: "msg_1",
    recipientThreadId: "t",
    senderThreadId: "s",
    sender: { kind: "agent", threadId: "s", name: "Ada", relationship: "peer" },
    kind: "note",
    urgent: false,
    rings: false,
    replyTo: null,
    body: "hello",
    state: "unseen",
    deliveryId: "dlv_1",
    blockId: "b1",
    turnId: null,
    seenVia: null,
    dedupeKey: "k",
    projectPath: "/repo",
    createdAt: 1,
    seenAt: null,
    sentAt: null,
    uncertainAt: null,
    ...over,
  };
}

function source(rows: InboxRow[]): InboxViewSource & { historyLimits: number[] } {
  const historyLimits: number[] = [];
  return {
    historyLimits,
    listWaitingInbox: (id) => rows.filter((r) => r.recipientThreadId === id && r.state !== "seen"),
    inboxHistory: (id, limit) => {
      historyLimits.push(limit);
      return rows.filter((r) => r.recipientThreadId === id && r.state === "seen").slice(0, limit);
    },
    inboxMessage: (id) => rows.find((r) => r.inboxId === id) ?? null,
  };
}

describe("inbox view", () => {
  test("drops the hand-over bookkeeping", () => {
    const [entry] = waitingInbox(source([row({})]), "t");
    expect(entry).toEqual({
      inboxId: "msg_1",
      kind: "note",
      urgent: false,
      rings: false,
      state: "unseen",
      sender: { kind: "agent", threadId: "s", name: "Ada", relationship: "peer" },
      body: "hello",
      replyTo: null,
      answers: null,
      createdAt: 1,
      seenAt: null,
      seenVia: null,
      turnId: null,
      uncertainAt: null,
    });
  });

  test("an answer quotes the question it replies to, cut to one line", () => {
    const question = row({
      inboxId: "msg_q",
      recipientThreadId: "s",
      kind: "question",
      body: `Which   table?\n${"x".repeat(300)}`,
      state: "seen",
    });
    const answer = row({ inboxId: "msg_a", kind: "answer", replyTo: "msg_q" });
    const [entry] = waitingInbox(source([question, answer]), "t");

    expect(entry?.answers?.inboxId).toBe("msg_q");
    expect(entry?.answers?.kind).toBe("question");
    expect(entry?.answers?.excerpt.startsWith("Which table? xxx")).toBe(true);
    expect(entry?.answers?.excerpt.endsWith("…")).toBe(true);
    expect(entry?.answers?.excerpt.length).toBe(160);
  });

  test("a reply to a message that is gone keeps its id and quotes nothing", () => {
    const [entry] = waitingInbox(source([row({ kind: "answer", replyTo: "msg_gone" })]), "t");
    expect(entry?.replyTo).toBe("msg_gone");
    expect(entry?.answers).toBeNull();
  });

  test("an uncertain message waits, flagged", () => {
    const [entry] = waitingInbox(source([row({ state: "uncertain", uncertainAt: 7 })]), "t");
    expect(entry?.state).toBe("uncertain");
    expect(entry?.uncertainAt).toBe(7);
    expect(entry?.uncertain).toBe(true);
    expect(waitingInbox(source([row({})]), "t")[0]).not.toHaveProperty("uncertain");
  });

  test("a read uncertain message stays flagged in history", () => {
    const [entry] = inboxHistoryView(
      source([row({ state: "seen", seenVia: "inbox", seenAt: 9, uncertainAt: 7 })]),
      "t",
    );
    expect(entry?.state).toBe("seen");
    expect(entry?.uncertainAt).toBe(7);
    expect(entry?.uncertain).toBe(true);
  });

  test("history takes a sane limit", () => {
    const src = source([row({ state: "seen" })]);
    inboxHistoryView(src, "t");
    inboxHistoryView(src, "t", 0);
    inboxHistoryView(src, "t", 2.5);
    inboxHistoryView(src, "t", 5);
    inboxHistoryView(src, "t", 10_000);
    expect(src.historyLimits).toEqual([20, 20, 20, 5, 200]);
  });
});

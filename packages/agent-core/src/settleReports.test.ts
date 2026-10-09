import { describe, expect, test } from "bun:test";

import { IrcMailbox, type IrcToolStore } from "./gateway/tools/irc.js";
import { createMailboxReportSink, renderSettleReport, type SettledTurnReport } from "./settleReports.js";

const PARENT = "parent-1";
const CHILD = "child-1";

// SAFETY: the sink reads only threadMeta and threadLineage off its store.
// eslint-disable-next-line anti-slop/no-chained-type-assertions
const store = {
  threadMeta: (threadId: string) => (threadId === CHILD ? { projectPath: "/p", contract: { name: "Milo" } } : { projectPath: "/p" }),
  threadLineage: (threadId: string) =>
    threadId === CHILD ? { parentThreadId: PARENT, relationshipToParent: "delegation", rootThreadId: PARENT } : null,
} as unknown as IrcToolStore;

function interrupted(turnId: string, cutOff?: string): SettledTurnReport {
  const report: SettledTurnReport = { childThreadId: CHILD, parentThreadId: PARENT, turnId, handOff: "contract", status: "interrupted" };
  if (cutOff) report.cutOff = cutOff;
  return report;
}

describe("the report of an interrupted turn, to an idle parent", () => {
  test("an interrupt somebody asked for is held for the parent's next turn", () => {
    const mailbox = new IrcMailbox();
    const sink = createMailboxReportSink({ mailbox, store, isBusy: () => false });
    expect(sink.deliver(interrupted("t-1"))).not.toBeNull();
    expect(mailbox.ringingCount(PARENT)).toBe(0);
  });

  test("an asked-for interrupt whose abort carries a message is still held", () => {
    const mailbox = new IrcMailbox();
    const sink = createMailboxReportSink({ mailbox, store, isBusy: () => false });
    const report = interrupted("t-5");
    report.detail = "Request cancelled";
    expect(sink.deliver(report)).not.toBeNull();
    expect(mailbox.ringingCount(PARENT)).toBe(0);
  });

  test("a turn its session's end cut off rings", () => {
    const mailbox = new IrcMailbox();
    const sink = createMailboxReportSink({ mailbox, store, isBusy: () => false });
    expect(sink.deliver(interrupted("t-2", "The child's session exited."))).not.toBeNull();
    expect(mailbox.ringingCount(PARENT)).toBe(1);
  });

  test("its report says what ended it; an asked-for one says nothing more", () => {
    expect(renderSettleReport(interrupted("t-3", "The child's session exited."), "Milo")).toContain(
      "interrupted before it finished (thread child-1, turn t-3): The child's session exited.",
    );
    expect(renderSettleReport(interrupted("t-4"), "Milo")).toContain("interrupted before it finished (thread child-1, turn t-4).");
  });
});

describe("a contractor's turn ending", () => {
  const completed: SettledTurnReport = {
    childThreadId: CHILD,
    parentThreadId: PARENT,
    turnId: "t-9",
    handOff: "contract",
    status: "completed",
    summary: "Screens are in.",
  };

  test("is not the job ending while the contract is open", () => {
    const text = renderSettleReport(completed, "Milo", true, true);
    expect(text).toContain("Milo's turn ended (thread child-1, turn t-9). Its contract is still open");
    expect(text).not.toContain("finished the work");
  });

  test("the sink reads the contract off the store: an open one is said so", () => {
    const mailbox = new IrcMailbox();
    createMailboxReportSink({ mailbox, store }).deliver(completed);
    expect(mailbox.getInbox(PARENT).messages[0]?.message).toContain("Its contract is still open");
  });
});

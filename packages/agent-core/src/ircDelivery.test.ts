import { describe, expect, test } from "bun:test";
import { IrcMailbox } from "./gateway/tools/irc.js";
import { startIrcDelivery, renderIncoming, IRC_DELIVERY_BATCH_MAX } from "./ircDelivery.js";
import type { IrcTurnDispatcher } from "./ircDelivery.js";
import type { SendTurnInput, StartThreadTurnOptions } from "./dispatch.js";

const PROJECT = "/tmp/kone-irc";

type Dispatched = {
  destination: "send" | "steer";
  input: SendTurnInput;
  options?: StartThreadTurnOptions;
};

/** A dispatcher that records instead of driving a thread. `fail` makes both
 *  entry points reject, which is the case the drain has to survive. */
function fakeDispatcher(log: Dispatched[], fail = false): IrcTurnDispatcher {
  const record = (destination: "send" | "steer") => {
    return async (input: SendTurnInput, options?: StartThreadTurnOptions) => {
      const entry: Dispatched = { destination, input };
      if (options) entry.options = options;
      log.push(entry);
      if (fail) throw new Error("session reaped");
      return { threadId: input.threadId, turnId: `turn-${log.length}` };
    };
  };
  return { sendThreadTurn: record("send"), steerThreadTurn: record("steer") };
}

/** The drain happens after the turn is accepted, so it lands a microtask behind
 *  the tick that started it. Nothing here is on a timer — this just lets the
 *  already-resolved promise chain run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** A hand-cranked clock: delivery is debounced, and a test that slept on real
 *  time would be both slower and flakier than one that fires it deliberately. */
function fakeClock() {
  const pending = new Set<() => void>();
  return {
    schedule: (fn: () => void) => {
      pending.add(fn);
      return () => pending.delete(fn);
    },
    /** Fire everything still armed. */
    tick: () => {
      const due = [...pending];
      pending.clear();
      for (const fn of due) fn();
    },
    armed: () => pending.size,
  };
}

function harness(over: { live?: boolean; busy?: boolean; fail?: boolean } = {}) {
  const mailbox = new IrcMailbox();
  const log: Dispatched[] = [];
  const clock = fakeClock();
  let live = over.live ?? true;
  const liveListeners = new Set<(threadId: string) => void>();
  const stop = startIrcDelivery({
    mailbox,
    dispatcher: fakeDispatcher(log, over.fail ?? false),
    isLive: () => live,
    isBusy: () => over.busy ?? false,
    onThreadLive: (listener) => {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    schedule: clock.schedule,
  });
  const send = (from: string, to: string, message: string) =>
    mailbox.sendMessage({ threadId: from, projectPath: PROJECT }, { to, message });
  /** A thread coming back: the session exists again, and the app says so. */
  const comeBack = (threadId: string) => {
    live = true;
    for (const listener of liveListeners) listener(threadId);
  };
  return { mailbox, log, clock, stop, send, comeBack };
}

describe("irc delivery", () => {
  test("an idle recipient is woken with a turn of its own", () => {
    const { log, clock, send } = harness({ busy: false });

    send("a", "b", "the config moved to packages/contracts");
    clock.tick();

    expect(log).toHaveLength(1);
    expect(log[0]!.destination).toBe("send");
    expect(log[0]!.input.threadId).toBe("b");
    expect(log[0]!.input.input).toContain("the config moved to packages/contracts");
    // Nobody said it, so the transcript must not claim anyone did.
    expect(log[0]!.options?.silent).toBe(true);
  });

  test("a recipient mid-turn is steered, so the message joins the work in flight", () => {
    const { log, clock, send } = harness({ busy: true });

    send("a", "b", "stop — that file is being rewritten");
    clock.tick();

    expect(log).toHaveLength(1);
    expect(log[0]!.destination).toBe("steer");
    expect(log[0]!.options?.silent).toBe(true);
  });

  test("messages arriving together cost one turn, not one each", () => {
    const { log, clock, send } = harness();

    send("a", "b", "first");
    send("c", "b", "second");
    clock.tick();

    expect(log).toHaveLength(1);
    expect(log[0]!.input.input).toContain("first");
    expect(log[0]!.input.input).toContain("second");
  });

  test("a thread with no live session keeps its mail instead of losing it", () => {
    const { mailbox, log, clock, send } = harness({ live: false });

    send("a", "b", "still here when you get back");
    clock.tick();

    expect(log).toHaveLength(0);
    // Unread, so the inbox tool still has it and a later delivery still can.
    expect(mailbox.getUnreadCount("b")).toBe(1);
  });

  test("delivered messages are drained, so they are not read twice", async () => {
    const { mailbox, clock, send } = harness();

    send("a", "b", "one");
    clock.tick();
    await settle();

    expect(mailbox.getUnreadCount("b")).toBe(0);
  });

  test("a delivery that throws leaves the mail where it was", async () => {
    const { mailbox, log, clock, send } = harness({ fail: true });

    send("a", "b", "please still exist");
    clock.tick();
    await settle();

    expect(log).toHaveLength(1);
    // Draining before the turn was accepted would have eaten this: gone from
    // the inbox, never seen by the agent, and nothing anywhere to notice.
    expect(mailbox.getUnreadCount("b")).toBe(1);
  });

  test("a flood delivers a batch and re-arms for the rest", async () => {
    const { mailbox, log, clock, send } = harness();

    for (let i = 0; i < IRC_DELIVERY_BATCH_MAX + 3; i++) send("a", "b", `msg ${i}`);
    clock.tick();
    await settle();

    expect(log).toHaveLength(1);
    expect(log[0]!.input.input).toContain("3 more messages are still in your inbox");
    expect(mailbox.getUnreadCount("b")).toBe(3);
    // Nothing else is going to come along for the overflow — the senders'
    // events have already fired — so the delivery arms its own next round.
    expect(clock.armed()).toBe(1);

    clock.tick();
    await settle();
    expect(log).toHaveLength(2);
    expect(mailbox.getUnreadCount("b")).toBe(0);
  });

  test("a thread coming back flushes the mail that arrived while it was away", async () => {
    const { mailbox, log, clock, send, comeBack } = harness({ live: false });

    send("a", "b", "waiting for you");
    clock.tick();
    await settle();
    expect(log).toHaveLength(0);

    // The sender's event has already fired and found nothing live. Without this
    // edge, nothing ever runs for that inbox again.
    comeBack("b");
    clock.tick();
    await settle();

    expect(log).toHaveLength(1);
    expect(mailbox.getUnreadCount("b")).toBe(0);
  });

  test("teardown drops armed deliveries", () => {
    const { log, clock, stop, send } = harness();

    send("a", "b", "too late");
    expect(clock.armed()).toBe(1);
    stop();

    expect(clock.armed()).toBe(0);
    clock.tick();
    expect(log).toHaveLength(0);
  });
});

describe("how a delivered message reads", () => {
  const message = {
    id: "m1",
    from: "Explorer",
    to: "b",
    message: "the archive path is in ConversationStore",
    createdAt: 0,
    read: false,
  };

  test("names the sender and says the user did not say it", () => {
    const text = renderIncoming([message]);
    expect(text).toContain("Explorer");
    expect(text).toContain("the archive path is in ConversationStore");
    expect(text).toContain("The user did not say this");
  });

  test("warns off the reflex that makes a two-agent loop", () => {
    expect(renderIncoming([message])).toContain("bare acknowledgement");
  });

  test("carries replyTo so an answer can be correlated", () => {
    expect(renderIncoming([{ ...message, replyTo: "m0" }])).toContain("replying to m0");
  });

  const carried = {
    id: "m2",
    from: "kone",
    to: "b",
    message: "Ada finished the work you handed it (thread t-ada, turn 1). Its final reply:\n\n> Done.",
    kind: "report" as const,
    createdAt: 0,
    read: false,
    sender: {
      kind: "courier" as const,
      messageKind: "report" as const,
      about: { threadId: "t-ada", name: "Ada", relationship: "contractor" as const },
    },
  };

  test("what the courier carries reads as kone's, not as another agent's message", () => {
    const text = renderIncoming([carried]);
    expect(text).toContain('<kone_notice from="kone" kind="report" about="Ada" relationship="contractor" thread="t-ada">');
    expect(text).toContain("Ada did not send it");
    expect(text).toContain("Ada is your contractor");
    expect(text).toContain("> Done.");
    expect(text).not.toContain("<agent_messages>");
    expect(text).not.toContain("another agent arrived");
  });

  test("a mixed batch frames each speaker as itself and counts only the agents", () => {
    const text = renderIncoming([carried, message], 2);
    expect(text).toContain('<kone_notice from="kone"');
    expect(text).toContain("A message from another agent arrived while you were working:");
    expect(text).toContain("2 more messages are still in your inbox.");
    expect(text.indexOf("</kone_notice>")).toBeLessThan(text.indexOf("<agent_messages>"));
  });

  test("a courier message travels the mailbox without counting toward a pair's exchanges", () => {
    const mailbox = new IrcMailbox();
    for (let i = 0; i < 20; i++) {
      mailbox.sendCourierMessage({ to: "lead", projectPath: PROJECT, message: `r${i}`, kind: "report", sender: carried.sender });
    }
    const inbox = mailbox.getInbox("lead");
    expect(inbox.messages).toHaveLength(20);
    expect(inbox.messages[0]!.from).toBe("kone");
    expect(inbox.messages[0]!.sender?.kind).toBe("courier");
  });
});

describe("irc delivery: the transcript", () => {
  test("each message with a sender is journaled once, even when the first delivery fails", async () => {
    const mailbox = new IrcMailbox();
    const log: Dispatched[] = [];
    const clock = fakeClock();
    const journaled: Array<{ threadId: string; message: string }> = [];
    let fail = true;
    const dispatcher: IrcTurnDispatcher = {
      sendThreadTurn: async (input) => {
        log.push({ destination: "send", input });
        if (fail) throw new Error("session reaped");
        return { threadId: input.threadId, turnId: "t" };
      },
      steerThreadTurn: async (input) => ({ threadId: input.threadId, turnId: "t" }),
    };
    startIrcDelivery({
      mailbox,
      dispatcher,
      isLive: () => true,
      isBusy: () => false,
      journal: (threadId, message) => {
        journaled.push({ threadId, message: message.message });
        return `block-${journaled.length}`;
      },
      schedule: clock.schedule,
    });
    // A store-backed send stamps a sender; this one stands in for it.
    const store = {
      threadLineage: (id: string) =>
        id === "child" ? { parentThreadId: "lead", relationshipToParent: "delegation" as const, rootThreadId: "lead" } : null,
    };
    mailbox.sendMessage({ threadId: "child", projectPath: PROJECT }, { to: "lead", message: "Is OAuth in scope?" }, store);

    clock.tick();
    await settle();
    expect(journaled).toEqual([{ threadId: "lead", message: "Is OAuth in scope?" }]);

    // The send failed, so the message is still unread; the retry delivers it
    // without writing it on the transcript a second time.
    fail = false;
    mailbox.sendMessage({ threadId: "peer", projectPath: PROJECT }, { to: "lead", message: "ping" });
    clock.tick();
    await settle();
    expect(journaled).toHaveLength(1);
    expect(log.at(-1)?.input.input).toContain("Is OAuth in scope?");
    // And still names the block it wrote the first time.
    expect(log.at(-1)?.input.userBlockId).toBe("block-1");
  });

  /** Delivery with a journal that writes every message, as the app's does,
   *  handing back the block each became. */
  function journaledHarness(busy: boolean) {
    const mailbox = new IrcMailbox();
    const log: Dispatched[] = [];
    const clock = fakeClock();
    let blocks = 0;
    startIrcDelivery({
      mailbox,
      dispatcher: fakeDispatcher(log),
      isLive: () => true,
      isBusy: () => busy,
      journal: () => `block-${++blocks}`,
      schedule: clock.schedule,
    });
    const store = {
      threadLineage: (id: string) =>
        id === "lead" ? null : { parentThreadId: "lead", relationshipToParent: "delegation" as const, rootThreadId: "lead" },
    };
    const send = (from: string, message: string) =>
      mailbox.sendMessage({ threadId: from, projectPath: PROJECT }, { to: "lead", message }, store);
    return { log, clock, send };
  }

  test("a steer names the block it carries, so the reply splits where it landed", async () => {
    const { log, clock, send } = journaledHarness(true);
    send("child", "Is OAuth in scope?");
    clock.tick();
    await settle();
    expect(log).toHaveLength(1);
    expect(log[0]!.destination).toBe("steer");
    expect(log[0]!.input.userBlockId).toBe("block-1");
    expect(log[0]!.input.userBlockIds).toBeUndefined();
  });

  test("a batch steered as one turn names every block in it, in order", async () => {
    const { log, clock, send } = journaledHarness(true);
    send("child", "Is OAuth in scope?");
    send("other-child", "The schema moved to v2.");
    clock.tick();
    await settle();
    expect(log).toHaveLength(1);
    expect(log[0]!.input.userBlockIds).toEqual(["block-1", "block-2"]);
    // The last of them is the turn's own block.
    expect(log[0]!.input.userBlockId).toBe("block-2");
  });

  test("a wake names its blocks too, so the queue anchors to the message and not the user's last words", async () => {
    const { log, clock, send } = journaledHarness(false);
    send("child", "Done: the login screen is in.");
    clock.tick();
    await settle();
    expect(log[0]!.destination).toBe("send");
    expect(log[0]!.input.userBlockId).toBe("block-1");
  });
});

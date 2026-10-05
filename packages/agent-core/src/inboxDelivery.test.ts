import { describe, expect, test } from "bun:test";
import { IrcMailbox } from "./gateway/tools/irc.js";
import { renderIncoming, renderInboxTurn, startInboxDelivery } from "./inboxDelivery.js";
import type { ThreadRuntime } from "./recipientState.js";
import type { RuntimeEvent } from "./types.js";
import type { SendTurnInput, StartThreadTurnOptions } from "./dispatch.js";

const PROJECT = "/tmp/kone-ringer";

function runtime(over: Partial<ThreadRuntime> = {}): ThreadRuntime {
  return {
    live: true,
    starting: false,
    busy: false,
    turnStartedAt: null,
    parked: null,
    parkedSince: null,
    compacting: false,
    steers: true,
    activeTool: null,
    lastActivityAt: null,
    ...over,
  };
}

/** A hand-cranked clock, so a ring fires when the test says. */
function fakeClock() {
  const pending = new Set<() => void>();
  return {
    schedule: (fn: () => void) => {
      pending.add(fn);
      return () => pending.delete(fn);
    },
    tick: () => {
      const due = [...pending];
      pending.clear();
      for (const fn of due) fn();
    },
    armed: () => pending.size,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function harness(initial: Partial<ThreadRuntime> = {}) {
  const mailbox = new IrcMailbox();
  const clock = fakeClock();
  let rt = runtime(initial);
  const kicks: string[] = [];
  const steers: { input: SendTurnInput; options?: StartThreadTurnOptions }[] = [];
  const restarts: string[] = [];
  const interrupts: string[] = [];
  const control = { restartFails: false, steerRefused: false };
  const journaled: { id: string; before: string | undefined }[] = [];
  const placedLast: string[] = [];
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const delivery = startInboxDelivery({
    mailbox,
    service: {
      threadRuntime: () => rt,
      kickTurnSlot: (threadId) => kicks.push(threadId),
      interruptAfterStep: (threadId) => {
        interrupts.push(threadId);
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    dispatcher: {
      steerThreadTurn: async (input, options) => {
        const entry: (typeof steers)[number] = { input };
        if (options) entry.options = options;
        steers.push(entry);
        // The service's live-only refusal: the turn ended on the way.
        if (control.steerRefused) throw new Error("No running turn can take this steer yet.");
        const turnId = `steered-${steers.length}`;
        options?.onAccepted?.(turnId);
        return { threadId: input.threadId, turnId };
      },
      ensureThreadSession: async (threadId) => {
        restarts.push(threadId);
        if (control.restartFails) throw new Error("provider is down");
      },
      takeReplayPreamble: () => null,
    },
    journal: (_threadId, message, before) => {
      journaled.push({ id: message.id, before });
      return `blk-${message.id}`;
    },
    blockSender: (_threadId, blockId) => (blockId === "blk-user" ? { kind: "user" } : null),
    placeLast: (_threadId, blockId) => placedLast.push(blockId),
    schedule: clock.schedule,
  });
  /** Under the ringer a note is kept quiet; everything else rings. */
  const send = (
    from: string,
    message: string,
    over: { kind?: "note" | "question" | "answer" | "pushback"; urgent?: boolean; replyTo?: string } = {},
  ) => {
    const kind = over.kind ?? "note";
    const input = over.replyTo ? { to: "b", message, kind, replyTo: over.replyTo } : { to: "b", message, kind };
    return mailbox.sendMessage({ threadId: from, projectPath: PROJECT }, input, undefined, {
      rings: kind !== "note" || over.urgent === true,
      urgent: over.urgent === true,
    });
  };
  const emit = (event: RuntimeEvent) => {
    for (const listener of listeners) listener(event);
  };
  /** A follow-up from the agent that handed `b` its work. */
  const job = (message: string, urgent = false) =>
    mailbox.postJob({
      to: "b",
      projectPath: PROJECT,
      message,
      sender: { kind: "agent", threadId: "lead", name: "Vera", relationship: "delegator", messageKind: "followup" },
      urgent,
    }).messageId;
  return {
    mailbox,
    clock,
    delivery,
    kicks,
    steers,
    restarts,
    interrupts,
    control,
    journaled,
    placedLast,
    send,
    job,
    emit,
    set: (over: Partial<ThreadRuntime>) => {
      rt = runtime(over);
    },
  };
}

const base = { threadId: "b", provider: "codex", at: 0, source: "codex.app-server" } as const;
const approvalResolved: RuntimeEvent = { ...base, type: "approval.resolved", requestId: "r-1", decision: "allow-once" };
const sessionStarted: RuntimeEvent = { ...base, type: "session.started" };

describe("the ringer", () => {
  test("a note never starts a turn; it rides the next one", () => {
    const { clock, delivery, kicks, send } = harness();
    send("a", "the config moved");
    clock.tick();

    expect(kicks).toHaveLength(0);
    expect(delivery.carry("b", null)).toBeNull();

    const carried = delivery.carry("b", { threadId: "b", input: "next step" });
    expect(carried?.input.input).toContain("the config moved");
    expect(carried?.input.input.endsWith("next step")).toBe(true);
  });

  test("a question to an idle agent lets the turn slot run", () => {
    const { clock, delivery, kicks, send } = harness();
    send("a", "which branch?", { kind: "question" });
    clock.tick();

    expect(kicks).toEqual(["b"]);
    const carried = delivery.carry("b", null);
    expect(carried?.input.input).toContain("which branch?");
    expect(carried?.input.input).toContain("A question or pushback is waiting on you");
  });

  test("a question to a busy agent waits, then rides in front of the user's message, headed", () => {
    const { clock, delivery, kicks, steers, send, mailbox } = harness({ busy: true });
    send("a", "which branch?", { kind: "question" });
    // kone's own notices carry a sender even without a store, so this one is
    // written to the transcript and names a block.
    const notice = mailbox.sendNotice({ to: "b", projectPath: PROJECT, message: "your hand-off finished", rings: false });
    clock.tick();
    expect(kicks).toHaveLength(0);
    expect(steers).toHaveLength(0);

    const carried = delivery.carry("b", { threadId: "b", input: "ship it", userBlockId: "blk-user" }, "blk-user");
    const text = carried!.input.input;
    expect(text.indexOf("which branch?")).toBeLessThan(text.indexOf("<from_user>"));
    expect(text.endsWith("ship it")).toBe(true);
    // The carried block first, the user's own last: one turn, in reading order.
    expect(carried!.input.userBlockIds).toEqual([`blk-${notice.messageId}`, "blk-user"]);
    expect(carried!.input.userBlockId).toBe("blk-user");

    carried!.settle("turn-7");
    expect(mailbox.getUnreadCount("b")).toBe(0);
  });

  test("an agent's own words are not headed as the user's", () => {
    const { delivery, send } = harness();
    send("a", "fyi");
    const carried = delivery.carry("b", { threadId: "b", input: "from the courier" }, "blk-other");
    expect(carried!.input.input).not.toContain("<from_user>");
  });

  test("a release puts what was carried back, unseen", () => {
    const { delivery, send, mailbox } = harness();
    send("a", "which branch?", { kind: "question" });
    const carried = delivery.carry("b", null);
    expect(mailbox.getUnreadCount("b")).toBe(0);
    carried!.release();
    expect(mailbox.getUnreadCount("b")).toBe(1);
  });

  test("urgent goes into a running turn, and settles with the steered turn", async () => {
    const { clock, steers, send, mailbox } = harness({ busy: true, turnStartedAt: 1 });
    send("a", "stop — that file is being rewritten", { urgent: true });
    send("c", "a plain question", { kind: "question" });
    clock.tick();
    await flush();

    expect(steers).toHaveLength(1);
    expect(steers[0]!.options?.silent).toBe(true);
    expect(steers[0]!.input.input).toContain("that file is being rewritten");
    expect(steers[0]!.input.input).not.toContain("a plain question");
    // Only the urgent one was seen; the question waits for the next turn.
    expect(mailbox.getUnreadCount("b")).toBe(1);
  });

  test("a parked agent holds everything, urgent included, until the user answers", () => {
    const h = harness({ parked: "approval", busy: true });
    h.send("a", "now!", { urgent: true });
    h.clock.tick();
    expect(h.steers).toHaveLength(0);
    expect(h.kicks).toHaveLength(0);

    h.set({});
    h.emit(approvalResolved);
    h.clock.tick();
    expect(h.kicks).toEqual(["b"]);
  });

  test("a session starting or compacting holds, and rings again once it is up", () => {
    const h = harness({ starting: true, live: false });
    h.send("a", "which branch?", { kind: "question" });
    h.clock.tick();
    expect(h.kicks).toHaveLength(0);
    expect(h.restarts).toHaveLength(0);

    h.set({});
    h.emit(sessionStarted);
    h.clock.tick();
    expect(h.kicks).toEqual(["b"]);
  });

  test("a closed session is brought back for what rings, never for a note", async () => {
    const h = harness({ live: false });
    h.send("a", "fyi");
    h.clock.tick();
    expect(h.restarts).toHaveLength(0);

    h.send("a", "which branch?", { kind: "question" });
    h.clock.tick();
    h.send("c", "and which base?", { kind: "question" });
    h.clock.tick();
    expect(h.restarts).toEqual(["b"]);
    await flush();
  });

  test("answers go first, then oldest, at most eight to a turn", () => {
    const { delivery, send, mailbox } = harness();
    for (let i = 0; i < 9; i++) send(`s${i}`, `note ${i}`);
    send("z", "the answer", { kind: "answer" });

    const carried = delivery.carry("b", { threadId: "b", input: "go" });
    const text = carried!.input.input;
    expect(text.indexOf("the answer")).toBeLessThan(text.indexOf("note 0"));
    expect(text).toContain("note 6");
    expect(text).not.toContain("note 7");
    expect(text).toContain("2 more messages are still in your inbox.");
    expect(mailbox.getUnreadCount("b")).toBe(2);
  });
});

describe("jobs", () => {
  test("a job never rides someone else's turn; it gets one of its own", () => {
    const h = harness();
    const id = h.job("Now add tests.");
    h.send("a", "fyi: the schema moved");
    h.clock.tick();
    expect(h.kicks).toEqual(["b"]);

    const userTurn = h.delivery.carry("b", { threadId: "b", input: "ship it" });
    expect(userTurn!.input.input).toContain("the schema moved");
    expect(userTurn!.input.input).not.toContain("Now add tests.");
    userTurn!.settle("turn-1");

    const own = h.delivery.carry("b", null)!;
    expect(own.input.input).toContain('<from_agent name="Vera" relationship="delegator" kind="followup">');
    expect(own.input.input.endsWith("Now add tests.")).toBe(true);
    own.settle("turn-2");
    expect(h.mailbox.jobTurn(id)).toEqual({ recipient: "b", handedOver: true, turnId: "turn-2" });
  });

  test("what waits rides in front of a job, which is written last", () => {
    const h = harness();
    h.send("a", "a note first");
    const id = h.job("Now add tests.");

    const own = h.delivery.carry("b", null)!;
    const text = own.input.input;
    expect(text.indexOf("a note first")).toBeLessThan(text.indexOf("Now add tests."));
    expect(h.journaled.at(-1)!.id).toBe(id);
    expect(own.input.userBlockId).toBe(`blk-${id}`);
  });

  test("two jobs are two turns", () => {
    const h = harness();
    h.job("first job");
    h.job("second job");

    const one = h.delivery.carry("b", null)!;
    expect(one.input.input).toContain("first job");
    expect(one.input.input).not.toContain("second job");
    one.settle("turn-1");
    expect(h.delivery.carry("b", null)!.input.input).toContain("second job");
  });

  test("an urgent job goes into the running turn; a plain one waits for it to end", async () => {
    const h = harness({ busy: true, turnStartedAt: 1 });
    h.job("plain job");
    h.clock.tick();
    await flush();
    expect(h.steers).toHaveLength(0);

    h.job("stop and revert", true);
    h.clock.tick();
    await flush();
    expect(h.steers).toHaveLength(1);
    expect(h.steers[0]!.input.input).toContain("stop and revert");
    expect(h.steers[0]!.input.input).not.toContain("plain job");
    expect(h.mailbox.jobCount("b")).toBe(1);
  });

  // A provider that cannot take a message mid-turn: a steer would only queue
  // it, and settle the job with the queue's id, which no turn ever carries.
  // kone steer ends the turn after its current step instead.
  test("an urgent job to a provider with kone steer ends the turn after its step, and waits for the next one, unseen", async () => {
    const h = harness({ busy: true, turnStartedAt: 1, steers: false, urgent: "after-step" });
    const id = h.job("stop and revert", true);
    h.clock.tick();
    await flush();
    expect(h.steers).toHaveLength(0);
    expect(h.interrupts).toEqual(["b"]);
    expect(h.mailbox.jobTurn(id)).toMatchObject({ handedOver: false, turnId: null });

    // The next turn is the job's own, ahead of anything the user queued, and
    // it settles with the turn the provider started.
    h.set({});
    expect(h.delivery.cutsIn?.("b")).toBe(true);
    const turn = h.delivery.carry("b", null)!;
    expect(turn.input.input).toContain("stop and revert");
    turn.settle("turn-2");
    expect(h.mailbox.jobTurn(id)).toMatchObject({ handedOver: true, turnId: "turn-2" });
  });

  // A provider that failed the cancel probe would lose the step it is on, so
  // nothing interrupts it: the mail goes when the turn ends.
  test("urgent mail to a provider without kone steer never interrupts, and goes when the turn ends", async () => {
    const h = harness({ busy: true, turnStartedAt: 1, steers: false, urgent: "turn-end" });
    const id = h.job("stop and revert", true);
    h.send("a", "and this", { urgent: true });
    h.clock.tick();
    await flush();
    expect(h.steers).toHaveLength(0);
    expect(h.interrupts).toEqual([]);
    expect(h.mailbox.jobTurn(id)).toMatchObject({ handedOver: false, turnId: null });

    h.set({});
    const turn = h.delivery.carry("b", null)!;
    expect(turn.input.input).toContain("stop and revert");
    expect(turn.input.input).toContain("and this");
  });

  // The steer is live only: a turn that ended while it was on its way refuses
  // it instead of queueing it, so the job is never settled with a queue id.
  test("an urgent steer the ended turn refused is asked live only, stays unseen, and is tried again", async () => {
    const h = harness({ busy: true, turnStartedAt: 1 });
    h.control.steerRefused = true;
    const id = h.job("stop and revert", true);
    h.clock.tick();
    await flush();
    expect(h.steers[0]!.options?.liveOnly).toBe(true);
    expect(h.mailbox.jobTurn(id)).toMatchObject({ handedOver: false, turnId: null });
    expect(h.mailbox.jobCount("b")).toBe(1);
    expect(h.clock.armed()).toBe(1);

    h.control.steerRefused = false;
    h.clock.tick();
    await flush();
    expect(h.mailbox.jobTurn(id)).toMatchObject({ handedOver: true, turnId: "steered-2" });
  });

  test("urgent mail waits for a starting turn to announce itself, then goes in", async () => {
    const h = harness({ busy: true, turnStartedAt: null });
    h.job("stop and revert", true);
    h.clock.tick();
    await flush();
    expect(h.steers).toHaveLength(0);

    h.set({ busy: true, turnStartedAt: 5 });
    h.emit({ ...base, type: "turn.started", turnId: "turn-1" });
    h.clock.tick();
    await flush();
    expect(h.steers).toHaveLength(1);
  });

  // An idle thread whose provider refuses the turn has nothing else to wake
  // it: the ringer tries again on its backoff, then stops.
  test("a refused turn of its own is tried again, a bounded number of times", () => {
    const h = harness();
    h.job("Now add tests.");
    let refused = 0;
    for (let i = 0; i < 10 && h.clock.armed() > 0; i++) {
      h.clock.tick();
      const turn = h.delivery.carry("b", null);
      if (!turn) break;
      refused++;
      turn.release();
    }
    expect(refused).toBe(5);
    expect(h.clock.armed()).toBe(0);
    expect(h.mailbox.jobCount("b")).toBe(1);
  });

  test("a session that will not come back up is tried again", async () => {
    const h = harness({ live: false });
    h.control.restartFails = true;
    h.job("Now add tests.");
    h.clock.tick();
    await flush();
    expect(h.restarts).toEqual(["b"]);
    expect(h.clock.armed()).toBe(1);

    h.control.restartFails = false;
    h.clock.tick();
    await flush();
    expect(h.restarts).toEqual(["b", "b"]);
  });

  test("a job to a parked thread is held until the user answers", () => {
    const h = harness({ parked: "user-input" });
    h.job("Now add tests.");
    h.clock.tick();
    expect(h.kicks).toHaveLength(0);

    h.set({});
    h.emit(approvalResolved);
    h.clock.tick();
    expect(h.kicks).toEqual(["b"]);
  });

  test("reading the inbox never takes a job", () => {
    const h = harness();
    h.job("Now add tests.");
    h.send("a", "fyi");
    const read = h.mailbox.getInbox("b");
    expect(read.messages.map((m) => m.message)).toEqual(["fyi"]);
    expect(h.mailbox.jobCount("b")).toBe(1);
  });
});

describe("transcript order", () => {
  test("what a turn carries is written above the turn's own words", () => {
    const h = harness();
    h.mailbox.sendNotice({ to: "b", projectPath: PROJECT, message: "your hand-off finished", rings: false });

    h.delivery.carry("b", { threadId: "b", input: "ship it", userBlockId: "blk-user" }, "blk-user");

    expect(h.journaled).toHaveLength(1);
    expect(h.journaled[0]!.before).toBe("blk-user");
    expect(h.placedLast).toEqual(["blk-user"]);
  });

  test("nothing carried, nothing moved", () => {
    const h = harness();
    expect(h.delivery.carry("b", { threadId: "b", input: "ship it" }, "blk-user")).toBeNull();
    expect(h.placedLast).toHaveLength(0);
  });
});

describe("renderInboxTurn", () => {
  test("one header per sender, each message under it", () => {
    const mailbox = new IrcMailbox();
    const from = (threadId: string, message: string) =>
      mailbox.sendMessage({ threadId, projectPath: PROJECT }, { to: "b", message });
    from("a", "one");
    from("a", "two");
    from("c", "three");
    const claim = mailbox.claimForTurn("b", 8)!;
    const text = renderInboxTurn(claim.messages);

    expect(text.match(/From `a`/g)).toHaveLength(1);
    expect(text.match(/From `c`/g)).toHaveLength(1);
    expect(text).toContain("3 messages from other agents are waiting for you:");
    expect(text.indexOf("one")).toBeLessThan(text.indexOf("two"));
    expect(text).toContain("nobody is waiting on a reply");
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

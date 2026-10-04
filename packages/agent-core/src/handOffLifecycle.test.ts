import { beforeEach, describe, expect, test } from "bun:test";

import { HandOffLifecycle, type HandOffLifecycleDeps } from "./handOffLifecycle.js";
import type { RuntimeEvent, SendTurnInput, StoredThreadMeta, ThreadLineage } from "./types.js";

// The tree every test starts from:
//
//   main ─┬─ backend (delegate, working) ─── api-worker (its worker, live)
//         ├─ frontend (contractor, working)
//         ├─ docs (delegate, idle)
//         └─ search (main's worker, live)

class TreeStore {
  metas = new Map<string, StoredThreadMeta>();

  add(threadId: string, title: string, parent?: { id: string; relationship: "delegation" | "subagent" }, contractName?: string) {
    const meta: StoredThreadMeta = { threadId, projectPath: "/p", provider: "codex", createdAt: 1, updatedAt: 1, title };
    if (parent) {
      meta.lineage = { parentThreadId: parent.id, relationshipToParent: parent.relationship, rootThreadId: "main" };
    }
    if (contractName) {
      meta.contract = { name: contractName, role: "r", instructions: "i", scope: "s", deliverable: "d", doneCriteria: "c" };
    }
    this.metas.set(threadId, meta);
  }
  threadMeta(threadId: string): StoredThreadMeta | null {
    return this.metas.get(threadId) ?? null;
  }
  threadLineage(threadId: string): ThreadLineage | null {
    return this.metas.get(threadId)?.lineage ?? null;
  }
  spawnedChildren(parentThreadId: string): StoredThreadMeta[] {
    return [...this.metas.values()].filter((m) => m.lineage?.parentThreadId === parentThreadId);
  }
}

/** How something reached a thread: a turn sent or steered, or a notice put in
 *  its inbox, ringing or held for its next turn. */
type Said = { threadId: string; how: "steer" | "send" | "rings" | "held"; text: string; sender?: string };

function harness() {
  const store = new TreeStore();
  store.add("main", "Auth feature");
  store.add("backend", "Auth API", { id: "main", relationship: "delegation" });
  store.add("api-worker", "Write route tests", { id: "backend", relationship: "subagent" });
  store.add("frontend", "Login screens", { id: "main", relationship: "delegation" }, "Frontend Auth");
  store.add("docs", "Auth docs", { id: "main", relationship: "delegation" });
  store.add("search", "Find session code", { id: "main", relationship: "subagent" });

  const busy = new Set(["backend", "frontend"]);
  const live = new Set(["backend", "frontend", "docs", "search", "api-worker", "main"]);
  const stopped: string[] = [];
  const interrupted: string[] = [];
  /** Threads whose session was brought back up. */
  const ensured: string[] = [];
  const said: Said[] = [];
  /** Every stop-shaped call, in order, so tests can check what came first. */
  const calls: string[] = [];
  /** Dispatches that should be refused, by kind. */
  type Failures = { send?: Error; steer?: Error };
  const failures: Failures = {};
  let turn = 0;

  const deps: HandOffLifecycleDeps = {
    store,
    service: {
      isThreadBusy: (id) => busy.has(id),
      hasLiveSession: (id) => live.has(id),
      interruptTurn: async (id) => {
        calls.push(`interrupt:${id}`);
        interrupted.push(id);
        busy.delete(id);
      },
      stopSession: async (id) => {
        calls.push(`stop:${id}`);
        stopped.push(id);
        live.delete(id);
        busy.delete(id);
      },
      cancelQueuedTurns: async (id) => {
        calls.push(`cancel-queue:${id}`);
      },
    },
    dispatcher: {
      sendThreadTurn: async (input: SendTurnInput) => {
        if (failures.send) throw failures.send;
        said.push({ threadId: input.threadId, how: "send", text: input.input });
        return { threadId: input.threadId, turnId: `turn-${++turn}` };
      },
      steerThreadTurn: async (input: SendTurnInput) => {
        if (failures.steer) throw failures.steer;
        const steered: Said = { threadId: input.threadId, how: "steer", text: input.input };
        if (input.sender) steered.sender = input.sender.kind;
        said.push(steered);
        return { threadId: input.threadId, turnId: `turn-${++turn}` };
      },
      queueNotice: (threadId: string, text: string, options?: { rings?: boolean }) => {
        said.push({ threadId, how: options?.rings ? "rings" : "held", text });
        return `msg_${said.length}`;
      },
      ensureThreadSession: async (threadId: string) => {
        ensured.push(threadId);
        return null;
      },
    },
  };
  /** The id the last turn sent or steered answered with. */
  const lastTurnId = () => `turn-${turn}`;
  return { lifecycle: new HandOffLifecycle(deps), store, busy, live, stopped, interrupted, ensured, said, calls, failures, lastTurnId };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("when the user stops an agent", () => {
  test("its workers stop outright, its working delegates are told, and it gets a decision turn", async () => {
    const result = await h.lifecycle.onUserStopped("main");

    expect(result.decisionTurn).toBe(true);
    expect(h.stopped).toEqual(["search"]);
    // Only the two still working are told, with a notice that rings.
    const toDelegates = h.said.filter((s) => s.threadId !== "main");
    expect(toDelegates.map((s) => [s.threadId, s.how])).toEqual([
      ["backend", "rings"],
      ["frontend", "rings"],
    ]);
    expect(toDelegates[0]?.text).toContain("deciding whether you carry on");

    const decision = h.said.find((s) => s.threadId === "main");
    expect(decision?.how).toBe("send");
    expect(decision?.text).toContain("Auth API");
    expect(decision?.text).toContain("Frontend Auth (frontend)");
    expect(decision?.text).not.toContain("Auth docs");
    expect(decision?.text).toContain("agent_keep_or_stop");
  });

  test("with no delegates working it is a plain stop", async () => {
    h.busy.clear();
    const result = await h.lifecycle.onUserStopped("main");
    expect(result.decisionTurn).toBe(false);
    expect(h.said).toEqual([]);
    expect(h.lifecycle.isDeciding("main")).toBe(false);
  });

  test("it is deciding until its decision turn settles, not the interrupted one", async () => {
    await h.lifecycle.onUserStopped("main");
    expect(h.lifecycle.isDeciding("main")).toBe(true);
    h.lifecycle.onTurnSettled("main", "turn-old");
    expect(h.lifecycle.isDeciding("main")).toBe(true);
    const decisionTurn = h.lastTurnId();
    h.lifecycle.onTurnSettled("main", decisionTurn);
    expect(h.lifecycle.isDeciding("main")).toBe(false);
  });

  test("a decision turn that could not be sent leaves nothing deciding", async () => {
    h.failures.send = new Error("session gone");
    await expect(h.lifecycle.onUserStopped("main")).rejects.toThrow("session gone");
    expect(h.lifecycle.isDeciding("main")).toBe(false);
  });

  test("a queued decision promoted without a turn id is the next turn to start", async () => {
    // The send answers with a queue id: the stopped turn had not aborted yet.
    await h.lifecycle.onUserStopped("main");
    const queueId = h.lastTurnId();
    const base = { threadId: "main", provider: "codex", source: "kone.store", at: 1 } as const;
    const events: RuntimeEvent[] = [
      { ...base, type: "turn.aborted", turnId: "turn-old" },
      { ...base, type: "turn.promoted", queueId },
    ];
    for (const event of events) h.lifecycle.onEvent(event);
    expect(h.lifecycle.isDeciding("main")).toBe(true);
    h.lifecycle.onEvent({ ...base, type: "turn.started", turnId: "turn-decision" });
    h.lifecycle.onEvent({ ...base, type: "turn.completed", turnId: "turn-other" });
    expect(h.lifecycle.isDeciding("main")).toBe(true);
    h.lifecycle.onEvent({ ...base, type: "turn.completed", turnId: "turn-decision" });
    expect(h.lifecycle.isDeciding("main")).toBe(false);
  });
});

describe("the user pressing Stop", () => {
  test("drops its queue, interrupts, then settles what it handed off", async () => {
    h.busy.add("main");
    await h.lifecycle.userStops("main");
    // The queue goes first: the interrupt's abort would otherwise promote the
    // next queued follow-up.
    expect(h.calls.slice(0, 2)).toEqual(["cancel-queue:main", "interrupt:main"]);
    expect(h.stopped).toEqual(["search"]);
    expect(h.lifecycle.isDeciding("main")).toBe(true);
  });

  test("during its decision turn ends the decision instead of asking again", async () => {
    await h.lifecycle.userStops("main");
    const decisionsSent = h.said.filter((s) => s.threadId === "main").length;
    h.calls.length = 0;

    await h.lifecycle.userStops("main");

    expect(h.lifecycle.isDeciding("main")).toBe(false);
    expect(h.said.filter((s) => s.threadId === "main")).toHaveLength(decisionsSent);
    // The decision had not started yet, so it is dropped from the queue before
    // the interrupt could promote it.
    expect(h.calls).toEqual(["cancel-queue:main", "interrupt:main"]);
  });

  test("a stop that lands while it is already deciding asks nothing new", async () => {
    await h.lifecycle.onUserStopped("main");
    const sent = h.said.length;
    expect((await h.lifecycle.onUserStopped("main")).decisionTurn).toBe(true);
    expect(h.said).toHaveLength(sent);
  });
});

describe("the decisions", () => {
  test("continue tells it; stop stops it and passes the decision down; ask_user leaves it", async () => {
    await h.lifecycle.onUserStopped("main");
    h.said.length = 0;

    const outcomes = await h.lifecycle.decide("main", [
      { threadId: "frontend", decision: "continue" },
      { threadId: "backend", decision: "stop" },
      { threadId: "docs", decision: "ask_user" },
    ]);

    expect(outcomes.map((o) => [o.name, o.decision])).toEqual([
      ["Frontend Auth", "continue"],
      // Bound to no teammate: named by the call sign rolled from the thread
      // id — the name the user sees on it — not by its title.
      ["Heron", "stop"],
      ["Beacon", "ask_user"],
    ]);
    // Still working, the one carrying on hears now.
    expect(h.said.find((s) => s.threadId === "frontend")).toMatchObject({
      how: "rings",
      text: expect.stringContaining("carry on"),
    });
    // The stopped delegate is interrupted, hears why, and its own worker stops
    // with it — the stop travelled one link further.
    expect(h.interrupted).toContain("backend");
    // Its queued follow-ups go first, or the interrupt's abort would promote one.
    expect(h.calls.indexOf("cancel-queue:backend")).toBeLessThan(h.calls.indexOf("interrupt:backend"));
    expect(h.said.find((s) => s.threadId === "backend")?.how).toBe("held");
    expect(h.stopped).toContain("api-worker");
    expect(h.said.some((s) => s.threadId === "docs")).toBe(false);
  });

  test("a delegate that finished meanwhile hears it may carry on at its next turn, not woken for it", async () => {
    await h.lifecycle.onUserStopped("main");
    h.busy.delete("frontend");
    h.said.length = 0;
    await h.lifecycle.decide("main", [{ threadId: "frontend", decision: "continue" }]);
    expect(h.said).toEqual([{ threadId: "frontend", how: "held", text: expect.stringContaining("carry on") }]);
  });

  test("only the caller's own delegates and contractors can be decided about", async () => {
    await expect(h.lifecycle.decide("main", [{ threadId: "search", decision: "stop" }])).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(h.lifecycle.decide("backend", [{ threadId: "frontend", decision: "stop" }])).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("withdrawing work", () => {
  test("a worker stops; a delegate is told to wrap up and is never stopped from under itself", async () => {
    expect(await h.lifecycle.withdraw("main", "search")).toBe("stopped");
    expect(h.stopped).toEqual(["search"]);

    h.busy.delete("docs");
    expect(await h.lifecycle.withdraw("main", "docs")).toBe("told");
    const told = h.said.find((s) => s.threadId === "docs");
    expect(told?.how).toBe("rings");
    expect(told?.text).toContain("withdrew this task");
    expect(h.stopped).not.toContain("docs");
    expect(h.ensured).toEqual([]);
  });

  test("a delegate whose session is closed is brought back up to hear it", async () => {
    h.live.delete("docs");
    expect(await h.lifecycle.withdraw("main", "docs")).toBe("told");
    expect(h.said.find((s) => s.threadId === "docs")?.how).toBe("rings");
    expect(h.ensured).toEqual(["docs"]);
  });
});

describe("the user speaking to a delegate directly", () => {
  test("its delegator hears about it quietly, on its next turn, running or not", async () => {
    h.lifecycle.onUserSpokeTo("frontend", "Use magic links instead of passwords.");
    expect(h.said).toEqual([
      {
        threadId: "main",
        how: "held",
        text: expect.stringContaining('The user spoke to Frontend Auth directly: "Use magic links instead of passwords."'),
      },
    ]);

    h.busy.add("main");
    h.lifecycle.onUserSpokeTo("backend", "Rate-limit the login route.");
    expect(h.said.at(-1)).toMatchObject({ threadId: "main", how: "held" });
  });

  test("a steer the user types is dispatched as theirs, and the delegator hears of it", async () => {
    // A sender smuggled in with typed words is dropped: they are the user's.
    await h.lifecycle.userSteers({ threadId: "frontend", input: "Drop the SMS fallback.", sender: { kind: "system" } });
    expect(h.said[0]).toEqual({ threadId: "frontend", how: "steer", text: "Drop the SMS fallback." });
    expect(h.said[1]).toMatchObject({ threadId: "main", how: "held" });
    expect(h.said[1]?.text).toContain('"Drop the SMS fallback."');
  });

  test("a send or steer that is refused tells nobody", async () => {
    h.failures.steer = new Error("compacting");
    h.failures.send = new Error("no session");
    await expect(h.lifecycle.userSteers({ threadId: "frontend", input: "x" })).rejects.toThrow("compacting");
    await expect(h.lifecycle.userSends({ threadId: "frontend", input: "x" })).rejects.toThrow("no session");
    expect(h.said).toEqual([]);
  });

  test("nothing is said for a worker or a thread nobody handed over", async () => {
    h.lifecycle.onUserSpokeTo("search", "hi");
    h.lifecycle.onUserSpokeTo("main", "hi");
    expect(h.said).toEqual([]);
  });
});

describe("stop everything", () => {
  test("stops the whole tree under the thread, deepest first, asking nothing", async () => {
    h.busy.add("main");
    const stopped = await h.lifecycle.stopEverything("main");
    expect(stopped).toEqual(["api-worker", "backend", "frontend", "docs", "search", "main"]);
    expect(h.said).toEqual([]);
    // Its queued follow-ups go before the interrupt, whose abort would promote one.
    expect(h.calls.slice(-2)).toEqual(["cancel-queue:main", "interrupt:main"]);
  });
});

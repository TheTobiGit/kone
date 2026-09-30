import { beforeEach, describe, expect, test } from "bun:test";

import { HandOffLifecycle, type HandOffLifecycleDeps } from "./handOffLifecycle.js";
import type { SendTurnInput, StoredThreadMeta, ThreadLineage } from "./types.js";

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

type Said = { threadId: string; how: "steer" | "send" | "notice"; text: string };

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
  const said: Said[] = [];
  let turn = 0;

  const deps: HandOffLifecycleDeps = {
    store,
    service: {
      isThreadBusy: (id) => busy.has(id),
      hasLiveSession: (id) => live.has(id),
      interruptTurn: async (id) => {
        interrupted.push(id);
        busy.delete(id);
      },
      stopSession: async (id) => {
        stopped.push(id);
        live.delete(id);
        busy.delete(id);
      },
    },
    dispatcher: {
      sendThreadTurn: async (input: SendTurnInput) => {
        said.push({ threadId: input.threadId, how: "send", text: input.input });
        return { threadId: input.threadId, turnId: `turn-${++turn}` };
      },
      steerThreadTurn: async (input: SendTurnInput) => {
        said.push({ threadId: input.threadId, how: "steer", text: input.input });
        return { threadId: input.threadId, turnId: `turn-${++turn}` };
      },
      queueNotice: (threadId: string, text: string) => {
        said.push({ threadId, how: "notice", text });
      },
      ensureThreadSession: async () => {},
    },
  };
  return { lifecycle: new HandOffLifecycle(deps), store, busy, stopped, interrupted, said };
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
    // Only the two still working are told, into their running turns.
    const toDelegates = h.said.filter((s) => s.threadId !== "main");
    expect(toDelegates.map((s) => [s.threadId, s.how])).toEqual([
      ["backend", "steer"],
      ["frontend", "steer"],
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
    const decisionTurn = `turn-${h.said.length}`;
    h.lifecycle.onTurnSettled("main", decisionTurn);
    expect(h.lifecycle.isDeciding("main")).toBe(false);
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
      ["Auth API", "stop"],
      ["Auth docs", "ask_user"],
    ]);
    expect(h.said.find((s) => s.threadId === "frontend")?.text).toContain("carry on");
    // The stopped delegate is interrupted, hears why, and its own worker stops
    // with it — the stop travelled one link further.
    expect(h.interrupted).toContain("backend");
    expect(h.said.find((s) => s.threadId === "backend")?.how).toBe("notice");
    expect(h.stopped).toContain("api-worker");
    expect(h.said.some((s) => s.threadId === "docs")).toBe(false);
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
    expect(told?.how).toBe("send");
    expect(told?.text).toContain("withdrew this task");
    expect(h.stopped).not.toContain("docs");
  });
});

describe("the user speaking to a delegate directly", () => {
  test("its delegator hears about it — quietly when idle, in its turn when running", async () => {
    await h.lifecycle.onUserSpokeTo("frontend", "Use magic links instead of passwords.");
    expect(h.said).toEqual([
      {
        threadId: "main",
        how: "notice",
        text: expect.stringContaining('The user spoke to Frontend Auth directly: "Use magic links instead of passwords."'),
      },
    ]);

    h.busy.add("main");
    await h.lifecycle.onUserSpokeTo("backend", "Rate-limit the login route.");
    expect(h.said.at(-1)).toMatchObject({ threadId: "main", how: "steer" });
  });

  test("nothing is said for a worker or a thread nobody handed over", async () => {
    await h.lifecycle.onUserSpokeTo("search", "hi");
    await h.lifecycle.onUserSpokeTo("main", "hi");
    expect(h.said).toEqual([]);
  });
});

describe("stop everything", () => {
  test("stops the whole tree under the thread, deepest first, asking nothing", async () => {
    h.busy.add("main");
    const stopped = await h.lifecycle.stopEverything("main");
    expect(stopped).toEqual(["api-worker", "backend", "frontend", "docs", "search", "main"]);
    expect(h.said).toEqual([]);
  });
});

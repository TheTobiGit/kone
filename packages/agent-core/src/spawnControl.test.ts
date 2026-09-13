import { describe, expect, test } from "bun:test";

import { ThreadControlManager } from "./spawnControl.js";
import { SpawnError, type SpawnCaller, type TrackedChild } from "./threadSpawn.js";
import type { UserInputAnswers, UserInputRespondResult } from "./types.js";

// The control manager against in-memory fakes: a stopper that records every
// session release, a gate responder that records every decline/answer, a live
// tracked map, and a hand-driven subtree check — no sqlite, no dispatcher, no
// real adapters.

class FakeStopper {
  readonly stopped: string[] = [];

  async stopSession(threadId: string): Promise<void> {
    this.stopped.push(threadId);
  }
}

class FakeGateResponder {
  readonly decisions: Array<{ threadId: string; requestId: string; decision: string }> = [];
  readonly answers: Array<{ threadId: string; requestId: string; answers: UserInputAnswers }> = [];
  nextUserInputResult: UserInputRespondResult = { owned: true };

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: "reject-once" | "reject-and-stop",
  ): Promise<void> {
    this.decisions.push({ threadId, requestId, decision });
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: UserInputAnswers,
  ): Promise<{ owned: boolean; followUp?: string }> {
    this.answers.push({ threadId, requestId, answers });
    return this.nextUserInputResult;
  }
}

type ControlHarness = {
  manager: ThreadControlManager;
  stopper: FakeStopper;
  gate: FakeGateResponder;
  tracked: Map<string, TrackedChild>;
  recomputed: TrackedChild[];
};

function makeHarness(
  isInSubtree: (rootThreadId: string, threadId: string) => boolean = () => true,
): ControlHarness {
  const stopper = new FakeStopper();
  const gate = new FakeGateResponder();
  const tracked = new Map<string, TrackedChild>();
  const recomputed: TrackedChild[] = [];
  const manager = new ThreadControlManager({
    providers: {
      stopSession: (threadId: string): Promise<void> => stopper.stopSession(threadId),
      respondToRequest: (
        threadId: string,
        requestId: string,
        decision: "reject-once" | "reject-and-stop",
      ): Promise<void> => gate.respondToRequest(threadId, requestId, decision),
      respondToUserInput: (
        threadId: string,
        requestId: string,
        answers: UserInputAnswers,
      ): Promise<{ owned: boolean; followUp?: string }> =>
        gate.respondToUserInput(threadId, requestId, answers),
    },
    tracked,
    recompute: (child) => {
      recomputed.push(child);
    },
    isInSubtree,
  });
  return { manager, stopper, gate, tracked, recomputed };
}

const CALLER: SpawnCaller = {
  threadId: "parent-1",
  turnId: "turn-1",
  provider: "opencode",
  model: "deepseek-v4",
  cwd: "/tmp/proj",
};

const CHILD_ID = "child-1";

function trackedChild(overrides: Partial<TrackedChild> = {}): TrackedChild {
  return {
    threadId: CHILD_ID,
    parentThreadId: CALLER.threadId,
    parentTurnId: CALLER.turnId,
    title: "Child one",
    provider: "opencode",
    createdAt: 1,
    updatedAt: 2,
    turns: [],
    gate: {
      kind: "approval",
      detail: "rm -rf dist",
      requestId: "ap-1",
      approval: { kind: "command", title: "rm -rf dist" },
    },
    hasLiveSession: true,
    sessionStopped: false,
    lastProjection: null,
    ...overrides,
  };
}

describe("ThreadControlManager", () => {
  test("cancel stops the session, seals the tracked child, and reports the cancellation", async () => {
    const h = makeHarness();
    const child = trackedChild();
    h.tracked.set(CHILD_ID, child);

    const result = await h.manager.cancelChild(CALLER, CHILD_ID);

    expect(result).toEqual({
      threadId: CHILD_ID,
      parentThreadId: CALLER.threadId,
      cancelled: true,
    });
    expect(h.stopper.stopped).toEqual([CHILD_ID]);
    expect(child.hasLiveSession).toBe(false);
    expect(child.sessionStopped).toBe(true);
    expect(child.gate).toBeNull();
    expect(h.recomputed).toEqual([child]);
  });

  test("cancel of an untracked child still stops the session and reports cancelled", async () => {
    const h = makeHarness();

    const result = await h.manager.cancelChild(CALLER, CHILD_ID);

    expect(result).toEqual({
      threadId: CHILD_ID,
      parentThreadId: CALLER.threadId,
      cancelled: true,
    });
    expect(h.stopper.stopped).toEqual([CHILD_ID]);
    // A pre-boot child has no projection to emit, so there is nothing to
    // recompute — the stop is the whole effect, and it must not crash.
    expect(h.recomputed).toEqual([]);
  });

  test("a caller cannot cancel, decline, or answer its own thread", async () => {
    const h = makeHarness();

    const cancelError: unknown = await h.manager
      .cancelChild(CALLER, CALLER.threadId)
      .catch((cause: unknown) => cause);
    expect(cancelError).toBeInstanceOf(SpawnError);
    if (cancelError instanceof SpawnError) expect(cancelError.code).toBe("not_found");

    const declineError: unknown = await h.manager
      .declineChildGate(CALLER, { threadId: CALLER.threadId, requestId: "gate-1" })
      .catch((cause: unknown) => cause);
    expect(declineError).toBeInstanceOf(SpawnError);
    if (declineError instanceof SpawnError) expect(declineError.code).toBe("not_found");

    const answerError: unknown = await h.manager
      .answerChildInput(CALLER, { threadId: CALLER.threadId, requestId: "q-1", answers: {} })
      .catch((cause: unknown) => cause);
    expect(answerError).toBeInstanceOf(SpawnError);
    if (answerError instanceof SpawnError) expect(answerError.code).toBe("not_found");

    // Refused before any provider call — nothing was stopped or answered.
    expect(h.stopper.stopped).toEqual([]);
    expect(h.gate.decisions).toEqual([]);
    expect(h.gate.answers).toEqual([]);
  });

  test("a child outside the caller's subtree reads as not_found on every control", async () => {
    const h = makeHarness(() => false);

    const cancelError: unknown = await h.manager
      .cancelChild(CALLER, "foreign-1")
      .catch((cause: unknown) => cause);
    expect(cancelError).toBeInstanceOf(SpawnError);
    if (cancelError instanceof SpawnError) expect(cancelError.code).toBe("not_found");

    const declineError: unknown = await h.manager
      .declineChildGate(CALLER, { threadId: "foreign-1", requestId: "gate-1" })
      .catch((cause: unknown) => cause);
    expect(declineError).toBeInstanceOf(SpawnError);
    if (declineError instanceof SpawnError) expect(declineError.code).toBe("not_found");

    const answerError: unknown = await h.manager
      .answerChildInput(CALLER, { threadId: "foreign-1", requestId: "q-1", answers: {} })
      .catch((cause: unknown) => cause);
    expect(answerError).toBeInstanceOf(SpawnError);
    if (answerError instanceof SpawnError) expect(answerError.code).toBe("not_found");

    expect(h.stopper.stopped).toEqual([]);
    expect(h.gate.decisions).toEqual([]);
    expect(h.gate.answers).toEqual([]);
  });

  test("decline answers the parked gate with reject-once and nothing else", async () => {
    const h = makeHarness();

    const result = await h.manager.declineChildGate(CALLER, {
      threadId: CHILD_ID,
      requestId: "gate-1",
    });

    expect(result).toEqual({ threadId: CHILD_ID, requestId: "gate-1", resolved: true });
    expect(h.gate.decisions).toHaveLength(1);
    // Decline-only: the decision is always a reject variant, never an allow —
    // a parent cannot grant its child a capability through this path.
    expect(h.gate.decisions[0]).toEqual({
      threadId: CHILD_ID,
      requestId: "gate-1",
      decision: "reject-once",
    });
    expect(h.gate.decisions[0]?.decision).toBe("reject-once");
  });

  test("answer forwards the answers verbatim and carries the follow-up through", async () => {
    const h = makeHarness();
    h.gate.nextUserInputResult = { owned: true, followUp: "Tell me more." };
    const answers: UserInputAnswers = {
      "q-1": "Use Postgres.",
      picks: ["a", "b"],
      skipped: null,
    };

    const result = await h.manager.answerChildInput(CALLER, {
      threadId: CHILD_ID,
      requestId: "q-1",
      answers,
    });

    expect(h.gate.answers).toHaveLength(1);
    expect(h.gate.answers[0]).toEqual({ threadId: CHILD_ID, requestId: "q-1", answers });
    // Verbatim: the exact object the caller passed, not a copy.
    expect(h.gate.answers[0]?.answers).toBe(answers);
    expect(result).toEqual({
      threadId: CHILD_ID,
      requestId: "q-1",
      owned: true,
      followUp: "Tell me more.",
    });
  });

  test("answer without a follow-up returns owned and no followUp key", async () => {
    const h = makeHarness();
    h.gate.nextUserInputResult = { owned: false };

    const result = await h.manager.answerChildInput(CALLER, {
      threadId: CHILD_ID,
      requestId: "q-1",
      answers: { "q-1": "Yes." },
    });

    expect(result).toEqual({ threadId: CHILD_ID, requestId: "q-1", owned: false });
    expect("followUp" in result).toBe(false);
  });
});

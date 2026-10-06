import { describe, expect, test } from "bun:test";
import { UserQuestionRequests, type UserQuestionRequest } from "./userQuestionRequests.js";
import type { RuntimeEvent } from "./types.js";

type Requested = Extract<RuntimeEvent, { type: "user-input.requested" }>;
type Resolved = Extract<RuntimeEvent, { type: "user-input.resolved" }>;

function providerAsk(requestId: string, turnId = "turn"): Requested {
  return { type: "user-input.requested", threadId: "t", provider: "codex", source: "codex.app-server", at: 0,
    requestId, turnId, questions: [{ id: "q0", header: "Native", question: "Native?", options: [] }] };
}

function providerResolved(requestId: string): Resolved {
  return { type: "user-input.resolved", threadId: "t", provider: "codex", source: "codex.app-server", at: 0,
    requestId, answers: { q0: "yes" } };
}

const request: UserQuestionRequest = {
  threadId: "t", turnId: "turn", provider: "codex", cwd: "/tmp",
  questions: [{ id: "q0", header: "Color", question: "Which color?", options: [{ label: "Blue" }] }],
};

function fixture() {
  const events: RuntimeEvent[] = [];
  const questions = new UserQuestionRequests((event) => events.push(event));
  const requested = () => events.filter((e) => e.type === "user-input.requested");
  return { events, questions, requested };
}

describe("blocking Kone question calls", () => {
  test("waits for the answer and resolves only the originating tool call", async () => {
    const { questions, events, requested } = fixture();
    let settled = false;
    const answer = questions.ask(request).then((a) => { settled = true; return a; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const id = requested()[0]!.requestId;
    expect(questions.respond("other-thread", id, { q0: "Blue" })).toBe(false);
    expect(settled).toBe(false);
    expect(questions.respond("t", id, { q0: "Blue" })).toBe(true);
    expect(await answer).toEqual({ q0: "Blue" });
    expect(questions.respond("t", id, { q0: "Green" })).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["user-input.requested", "user-input.resolved"]);
  });

  test("parallel question calls queue dialogs and keep their answers separate", async () => {
    const { questions, requested } = fixture();
    const first = questions.ask(request);
    const second = questions.ask({ ...request, questions: [{ ...request.questions[0]!, question: "Any details?" }] });
    expect(requested()).toHaveLength(1);
    questions.respond("t", requested()[0]!.requestId, { q0: "Blue" });
    expect(requested()).toHaveLength(2);
    questions.respond("t", requested()[1]!.requestId, { q0: "Keep it simple" });
    expect(await first).toEqual({ q0: "Blue" });
    expect(await second).toEqual({ q0: "Keep it simple" });
  });

  test("cancellation unblocks tools and never resurfaces a cancelled queued dialog", async () => {
    const { questions, events, requested } = fixture();
    const first = questions.ask(request);
    const second = questions.ask(request);
    questions.cancel("t", "unrelated-turn");
    expect(events).toHaveLength(1);
    questions.cancel("t", "turn");
    expect(await first).toEqual({});
    expect(await second).toEqual({});
    expect(requested()).toHaveLength(1);
    // Only the dialog that showed is announced resolved; the queued one never surfaced.
    expect(events.filter((e) => e.type === "user-input.resolved")).toHaveLength(1);
  });

  test("MCP cancellation and session revocation clear the dialog", async () => {
    const { questions, events, requested } = fixture();
    const controller = new AbortController();
    const answer = questions.ask({ ...request, signal: controller.signal });
    const id = requested()[0]!.requestId;
    controller.abort();
    expect(await answer).toEqual({});
    expect(questions.respond("t", id, { q0: "late" })).toBe(false);
    expect(await questions.ask({ ...request, signal: controller.signal })).toEqual({});
    expect(events).toHaveLength(2);
  });
});

describe("one question queue for Kone and provider asks", () => {
  test("the same provider request ID belongs to an independent queue in each thread", async () => {
    const { questions, requested } = fixture();
    expect(questions.admit(providerAsk("shared"))).toBe(true);
    expect(questions.admit({ ...providerAsk("shared"), threadId: "other" })).toBe(true);
    const first = questions.ask(request);
    const second = questions.ask({ ...request, threadId: "other" });
    expect(requested().map((e) => [e.threadId, e.requestId])).toEqual([
      ["t", "shared"], ["other", "shared"],
    ]);

    questions.admit({ ...providerResolved("shared"), threadId: "other" });
    const otherKoneId = requested()[2]!.requestId;
    expect(requested()[2]!.threadId).toBe("other");
    // Resolving one thread must leave the other thread's native ask parked.
    expect(requested().filter((e) => e.threadId === "t")).toHaveLength(1);
    questions.admit(providerResolved("shared"));
    const firstKoneId = requested()[3]!.requestId;
    expect(requested()[3]!.threadId).toBe("t");
    expect(questions.respond("t", otherKoneId, { q0: "wrong thread" })).toBe(false);
    questions.respond("t", firstKoneId, { q0: "Blue" });
    questions.respond("other", otherKoneId, { q0: "Green" });
    expect(await first).toEqual({ q0: "Blue" });
    expect(await second).toEqual({ q0: "Green" });
  });

  test("ending a thread cannot drop another thread's queued ask with the same ID", async () => {
    const { questions, requested } = fixture();
    const first = questions.ask(request);
    const second = questions.ask({ ...request, threadId: "other" });
    expect(questions.admit(providerAsk("shared"))).toBe(true);
    expect(questions.admit({ ...providerAsk("shared"), threadId: "other" })).toBe(true);
    expect(requested()).toHaveLength(2);
    const otherKoneId = requested()[1]!.requestId;

    questions.end("t", "turn");
    expect(await first).toEqual({});
    expect(requested()).toHaveLength(2);
    expect(questions.admit(providerResolved("shared"))).toBe(false);
    questions.respond("other", otherKoneId, { q0: "Green" });
    expect(await second).toEqual({ q0: "Green" });
    expect(requested()[2]).toMatchObject({ threadId: "other", requestId: "shared" });
    expect(questions.admit({ ...providerResolved("shared"), threadId: "other" })).toBe(true);
  });

  test("a Kone question waits behind a provider's ask and shows once the provider resolves it", async () => {
    const { questions, events, requested } = fixture();
    expect(questions.admit(providerAsk("native-1"))).toBe(true);
    const answer = questions.ask(request);
    expect(requested().map((e) => e.requestId)).toEqual(["native-1"]);
    // Nobody can answer the Kone question while the provider's shows.
    expect(events).toHaveLength(1);
    expect(questions.admit(providerResolved("native-1"))).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["user-input.requested", "user-input.resolved", "user-input.requested"]);
    const koneId = requested()[1]!.requestId;
    expect(koneId.startsWith("question:")).toBe(true);
    expect(questions.respond("t", koneId, { q0: "Blue" })).toBe(true);
    expect(await answer).toEqual({ q0: "Blue" });
  });

  test("a provider's ask waits behind a Kone question; resolved while queued, it never surfaces", async () => {
    const { questions, events, requested } = fixture();
    const answer = questions.ask(request);
    expect(questions.admit(providerAsk("native-1"))).toBe(true);
    expect(questions.admit(providerAsk("native-2"))).toBe(true);
    expect(requested()).toHaveLength(1);
    // The provider gave up on native-1 (its abort signal) before it showed.
    expect(questions.admit(providerResolved("native-1"))).toBe(true);
    expect(events).toHaveLength(1);
    questions.respond("t", requested()[0]!.requestId, { q0: "Blue" });
    expect(await answer).toEqual({ q0: "Blue" });
    expect(requested().map((e) => e.requestId)).toEqual([requested()[0]!.requestId, "native-2"]);
    // A provider's ask is never answered here: its adapter owns the reply.
    expect(questions.respond("t", "native-2", { q0: "x" })).toBe(false);
  });

  test("cancel unblocks Kone calls only; a turn's end also drops its provider asks and shows the next", async () => {
    const { questions, requested } = fixture();
    questions.admit(providerAsk("native-1"));
    const kone = questions.ask(request);
    questions.admit(providerAsk("native-next", "next-turn"));
    questions.cancel("t");
    expect(await kone).toEqual({});
    expect(requested().map((e) => e.requestId)).toEqual(["native-1"]);
    questions.end("t", "turn");
    expect(requested().map((e) => e.requestId)).toEqual(["native-1", "native-next"]);
    // The adapter's own late word on the dropped ask passes through untouched.
    expect(questions.admit(providerResolved("native-1"))).toBe(false);
    questions.end("t");
    expect(questions.admit(providerResolved("native-next"))).toBe(false);
  });

  test("events the queue does not own pass through", () => {
    const { questions, events } = fixture();
    expect(questions.admit({ type: "turn.started", threadId: "t", provider: "codex", source: "codex.app-server", at: 0, turnId: "turn" })).toBe(false);
    expect(questions.admit(providerResolved("unknown"))).toBe(false);
    expect(events).toHaveLength(0);
  });
});

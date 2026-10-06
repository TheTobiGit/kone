import { expect, test } from "bun:test";
import { createRegistry } from "../registry.js";
import { createQuestionTools } from "./questions.js";
import type { GatewayToolContext } from "../schemas.js";
import { UserQuestionRequests } from "../../userQuestionRequests.js";
import type { RuntimeEvent } from "../../types.js";

const ctx: GatewayToolContext = { threadId: "t", turnId: "turn", provider: "codex", cwd: "/tmp", requestId: 1 };

function harness() {
  const events: RuntimeEvent[] = [];
  const questions = new UserQuestionRequests((e) => events.push(e));
  const registry = createRegistry(createQuestionTools((r) => questions.ask(r)));
  const requested = () => {
    const event = events.find((e) => e.type === "user-input.requested");
    if (event?.type !== "user-input.requested") throw new Error("missing dialog request");
    return event;
  };
  return { events, questions, registry, requested };
}

test("every form's dialog answer becomes the awaited MCP tool result, without a follow-up send", async () => {
  const { events, questions, registry, requested } = harness();
  const result = registry.call(ctx, "ask_question", { questions: [
    { question: "Which color?", options: ["Blue", { label: "Green", description: "A second choice" }] },
    { question: "Which extras?", header: "Extras", options: ["Tests", "Docs", "Lint"], multiSelect: true },
    { question: "Which name?", options: ["Ada"] },
    { question: "Any details?" },
  ] });
  const event = requested();
  expect(event.questions.map((q) => [q.id, q.header, q.multiSelect])).toEqual([
    ["q0", "Question", false], ["q1", "Extras", true], ["q2", "Question", false], ["q3", "Question", false],
  ]);
  expect(event.questions[0]?.options).toEqual([{ label: "Blue" }, { label: "Green", description: "A second choice" }]);
  expect(event.questions[3]?.options).toEqual([]);
  // single pick, multi pick with a typed extra, typed custom value, free text
  questions.respond("t", event.requestId, { q0: "Green", q1: ["Tests", "Docs", " My own "], q2: "Grace", q3: "Keep it simple" });
  const reply = await result;
  expect(reply.isError).toBeUndefined();
  expect(JSON.parse(reply.content[0]!.text)).toEqual({ answers: [
    { question: "Which color?", answer: "Green" },
    { question: "Which extras?", answer: ["Tests", "Docs", "My own"] },
    { question: "Which name?", answer: "Grace" },
    { question: "Any details?", answer: "Keep it simple" },
  ] });
  expect(events.map((e) => e.type)).toEqual(["user-input.requested", "user-input.resolved"]);
  expect(registry.listTools("worker", "core").map((t) => t.name)).toContain("ask_question");
  expect(registry.listTools("assistant", "core").map((t) => t.name)).toContain("ask_question");
});

test("answers keep one shape per form whatever the dialog hands back", async () => {
  const { questions, registry, requested } = harness();
  const result = registry.call(ctx, "ask_question", { questions: [
    { question: "Pick several", options: ["A", "B"], multiSelect: true },
    { question: "Pick one", options: ["A", "B"] },
    { question: "Say something" },
  ] });
  questions.respond("t", requested().requestId, { q0: "A", q1: ["B"], q2: "   " });
  expect(JSON.parse((await result).content[0]!.text)).toEqual({ answers: [
    { question: "Pick several", answer: ["A"] },
    { question: "Pick one", answer: "B" },
    { question: "Say something", answer: null },
  ] });
});

test("a dismissed dialog returns a declined result, not an error", async () => {
  const { questions, registry, requested } = harness();
  const result = registry.call(ctx, "ask_question", { questions: [{ question: "Proceed?", options: ["Yes", "No"] }] });
  questions.respond("t", requested().requestId, {});
  const reply = await result;
  expect(reply.isError).toBeUndefined();
  expect(JSON.parse(reply.content[0]!.text)).toEqual({ declined: true, answers: [{ question: "Proceed?", answer: null }] });
});

test("a transport cancel closes the dialog and settles the call", async () => {
  const { events, registry, requested } = harness();
  const controller = new AbortController();
  const result = registry.call({ ...ctx, signal: controller.signal }, "ask_question", { questions: [{ question: "Wait?" }] });
  const { requestId } = requested();
  controller.abort();
  await result;
  const resolved = events.find((e) => e.type === "user-input.resolved");
  expect(resolved?.type === "user-input.resolved" && resolved.requestId).toBe(requestId);
});

test("the turn ending under an open question settles it as declined", async () => {
  const { questions, registry, requested } = harness();
  const result = registry.call(ctx, "ask_question", { questions: [{ question: "Still there?" }] });
  requested();
  questions.cancel("t", "turn");
  expect(JSON.parse((await result).content[0]!.text)).toEqual({ declined: true, answers: [{ question: "Still there?", answer: null }] });
});

test("invalid or idle calls never open a dialog", async () => {
  let calls = 0;
  const registry = createRegistry(createQuestionTools(async () => { calls++; return {}; }));
  expect((await registry.call(ctx, "ask_question", { questions: [] })).isError).toBe(true);
  expect((await registry.call({ ...ctx, turnId: null }, "ask_question", { questions: [{ question: "Q?" }] })).isError).toBe(true);
  expect((await registry.call(ctx, "ask_question", { questions: [{ question: " " }] })).isError).toBe(true);
  expect(calls).toBe(0);
  expect((await createRegistry(createQuestionTools()).call(ctx, "ask_question", { questions: [{ question: "Q?" }] })).isError).toBe(true);
});

test("every session is told to ask through the tool, never by message", () => {
  const [tool] = createQuestionTools();
  expect(tool?.promptGuidelines?.join(" ")).toContain("`ask_question`");
  expect(tool?.promptGuidelines?.join(" ")).toContain("never ask the user to answer in a new message");
});

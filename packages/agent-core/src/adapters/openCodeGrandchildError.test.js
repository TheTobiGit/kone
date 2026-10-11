import { expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";

mock.module("../sqlite.js", () => ({ DatabaseSync: Database }));
const { OpenCodeAdapter } = await import("./OpenCodeAdapter.ts");

test("a grandchild session error stays in the ancestor transcript and does not settle its run", () => {
  const events = [];
  const adapter = new OpenCodeAdapter(event => events.push(event));
  const run = { snapshot: { toolUseId: "parent-task", taskId: "child-session", status: "running" }, turnId: "parent-turn", announced: true, settled: false };
  const session = { threadId: "parent-thread", activeTurnId: "parent-turn", openCodeSessionId: "parent-session", subagentRuns: new Map([["parent-task", run]]), subagentChildSessions: new Map([["child-session", "parent-task"]]), settledSubagentToolUseIds: new Set(), pendingUserInputs: new Map(), mode: "default", messageRoleById: new Map(), partById: new Map(), emittedTextByPartId: new Map(), completedTextPartIds: new Set() };

  adapter.handleTaskTool(session, { callID: "nested-task" }, { metadata: { sessionId: "grandchild-session" }, status: "running" }, "parent-task");
  adapter.handleChildEvent(session, session.subagentChildSessions.get("grandchild-session"), "grandchild-session", { type: "session.error", properties: { sessionID: "grandchild-session", error: { name: "APIError", data: { message: "grandchild model call failed" } } } });
  adapter.handleChildEvent(session, "parent-task", "child-session", { type: "question.asked", properties: { sessionID: "child-session", id: "question-after-nested-error", questions: [{ question: "Retry?", header: "Retry", options: [{ label: "Yes" }] }] } });

  expect(run.settled).toBe(false);
  expect(session.subagentChildSessions.has("child-session")).toBe(true);
  expect(events.filter(event => event.type === "user-input.requested")).toHaveLength(1);
  expect(events.find(event => event.type === "item.completed" && event.item.status === "failed")).toMatchObject({
    subagentToolUseId: "parent-task",
    item: { kind: "assistant_text", text: "grandchild model call failed", status: "failed" },
  });
});

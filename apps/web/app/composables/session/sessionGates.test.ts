import { expect, test } from "bun:test";
import { ref } from "vue";
import { useSessionGates } from "./sessionGates";
import type { PendingUserInput } from "../agentTypes";
import type { UserInputAnswers } from "~/types/desktop";

const question: PendingUserInput = { requestId: "question:call",
  questions: [{ id: "q0", header: "Question", question: "Color?", options: [] }] };

function fixture(respond: (requestId: string, answers: UserInputAnswers) => Promise<{ owned: boolean }>) {
  // SAFETY: this gate only uses respondUserInput from the bridge.
  const api = { respondUserInput: async (_thread: string, id: string, answers: UserInputAnswers) => respond(id, answers) } as never;
  return useSessionGates({ threadId: ref("thread"), bridge: () => api,
    mockHasPendingApproval: () => false, mockRespondApproval: () => {} });
}

test("answers resolve through IPC; no send callback exists in the question flow", async () => {
  const replies: { requestId: string; answers: UserInputAnswers }[] = [];
  const gates = fixture(async (requestId, answers) => {
    replies.push({ requestId, answers });
    return { owned: true };
  });
  gates.parkedUserInput.value = question;
  await gates.respondUserInput(question.requestId, { q0: "Blue" });
  expect(replies).toEqual([{ requestId: question.requestId, answers: { q0: "Blue" } }]);
  expect(gates.pendingUserInput.value).toBeNull();
});

test("failed answers restore the dialog, and a retry resolves it", async () => {
  let attempts = 0;
  const gates = fixture(async () => {
    if (++attempts === 1) throw new Error("IPC unavailable");
    return { owned: true };
  });
  gates.parkedUserInput.value = question;
  await gates.respondUserInput(question.requestId, { q0: "Blue" });
  expect(gates.pendingUserInput.value?.requestId).toBe(question.requestId);
  await gates.respondUserInput(question.requestId, { q0: "Blue" });
  expect(gates.pendingUserInput.value).toBeNull();
});

test("stale answers and dismissal never start another turn", async () => {
  const answers: UserInputAnswers[] = [];
  const gates = fixture(async (_id, answer) => { answers.push(answer); return { owned: false }; });
  gates.parkedUserInput.value = question;
  await gates.respondUserInput(question.requestId, {});
  await gates.respondUserInput(question.requestId, { q0: "Late" });
  expect(answers).toEqual([{}, { q0: "Late" }]);
  expect(gates.pendingUserInput.value).toBeNull();
});

/** A bridge whose answer stays in flight until the test settles it. */
function deferredFixture() {
  const calls: { requestId: string; resolve: () => void; reject: () => void }[] = [];
  const gates = fixture((requestId) => new Promise((resolve, reject) => {
    calls.push({ requestId, resolve: () => resolve({ owned: true }), reject: () => reject(new Error("IPC unavailable")) });
  }));
  return { gates, calls };
}

const next: PendingUserInput = { requestId: "question:next",
  questions: [{ id: "q0", header: "Next", question: "Size?", options: [] }] };

test("the prompt hides while its answer travels", async () => {
  const { gates, calls } = deferredFixture();
  gates.parkedUserInput.value = question;
  const answering = gates.respondUserInput(question.requestId, { q0: "Blue" });
  expect(gates.pendingUserInput.value).toBeNull();
  expect(gates.attention.value).toBeNull();
  calls[0]!.resolve();
  await answering;
  expect(gates.pendingUserInput.value).toBeNull();
  expect(gates.parkedUserInput.value).toBeNull();
});

test("a failed answer never brings back a question a newer one replaced", async () => {
  const { gates, calls } = deferredFixture();
  gates.parkedUserInput.value = question;
  const answering = gates.respondUserInput(question.requestId, { q0: "Blue" });
  // The backend resolved it and showed the next before the IPC call failed.
  gates.parkedUserInput.value = next;
  expect(gates.pendingUserInput.value?.requestId).toBe(next.requestId);
  calls[0]!.reject();
  await answering;
  expect(gates.pendingUserInput.value?.requestId).toBe(next.requestId);
});

test("a failed answer never resurrects a question resolved or aborted meanwhile", async () => {
  const { gates, calls } = deferredFixture();
  gates.parkedUserInput.value = question;
  const answering = gates.respondUserInput(question.requestId, { q0: "Blue" });
  gates.parkedUserInput.value = null; // user-input.resolved or turn.aborted
  calls[0]!.reject();
  await answering;
  expect(gates.pendingUserInput.value).toBeNull();
});

test("an earlier answer settling late leaves a newer answer in flight hidden", async () => {
  const { gates, calls } = deferredFixture();
  gates.parkedUserInput.value = question;
  const first = gates.respondUserInput(question.requestId, { q0: "Blue" });
  gates.parkedUserInput.value = next;
  const second = gates.respondUserInput(next.requestId, { q0: "Large" });
  calls[0]!.reject();
  await first;
  expect(gates.pendingUserInput.value).toBeNull();
  // The newer one fails for real: it is still parked, so it comes back to retry.
  calls[1]!.reject();
  await second;
  expect(gates.pendingUserInput.value?.requestId).toBe(next.requestId);
});

import { describe, expect, test } from "bun:test";
import { useAgent } from "./useAgent.js";
import type { ApprovalDecision } from "~/types/desktop";

let seq = 0;
function harness() {
  const agent = useAgent({ provider: "codex", cwd: `/tmp/kone-mock-test-${seq++}`, rehydrate: false });
  const session = agent.sessions.value[0]!;
  return { agent, session };
}

describe("agentMock and demo conversation approvals", () => {
  test("demo() requests user approvals for file-change and command", async () => {
    const { session } = harness();
    session.demo({ fast: true });

    // Give the mock turn a moment to start and reach the approval request
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new Error("Timeout waiting for demo approvals"));
      }, 5000);

      const interval = setInterval(() => {
        if (session.pendingApprovals.value.length >= 2) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    expect(session.pendingApprovals.value).toHaveLength(2);
    const [editAsk, cmdAsk] = session.pendingApprovals.value;
    expect(editAsk?.approval.kind).toBe("file-change");
    expect(editAsk?.approval.title).toBe("ConversationThread.vue");
    expect(cmdAsk?.approval.kind).toBe("command");
    expect(cmdAsk?.approval.title).toBe("bun test useAgent");

    // Clean up
    await session.interrupt();
  });

  test("responding to demo approvals with allow-once lets the turn proceed", async () => {
    const { session } = harness();
    session.demo({ fast: true });

    // Wait for approvals
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new Error("Timeout waiting for demo approvals"));
      }, 5000);

      const interval = setInterval(() => {
        if (session.pendingApprovals.value.length >= 2) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    const [editAsk, cmdAsk] = session.pendingApprovals.value;
    expect(editAsk).toBeDefined();
    expect(cmdAsk).toBeDefined();

    if (editAsk && cmdAsk) {
      // SAFETY: allow-once is a valid ApprovalDecision union member.
      const allowOnce = "allow-once" as ApprovalDecision;
      await session.respondApproval(editAsk.requestId, allowOnce);
      expect(session.pendingApprovals.value).toHaveLength(1);

      await session.respondApproval(cmdAsk.requestId, allowOnce);
      expect(session.pendingApprovals.value).toHaveLength(0);
    }

    // Clean up
    await session.interrupt();
  });

  test("reject-and-stop decision halts the demo turn immediately", async () => {
    const { session } = harness();
    session.demo({ fast: true });

    // Wait for approvals
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new Error("Timeout waiting for demo approvals"));
      }, 5000);

      const interval = setInterval(() => {
        if (session.pendingApprovals.value.length >= 2) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    const editAsk = session.pendingApprovals.value[0];
    expect(editAsk).toBeDefined();

    if (editAsk) {
      // SAFETY: reject-and-stop is a valid ApprovalDecision union member.
      const rejectStop = "reject-and-stop" as ApprovalDecision;
      await session.respondApproval(editAsk.requestId, rejectStop);
    }

    expect(session.pendingApprovals.value).toHaveLength(0);
    expect(session.sessionState.value).toBe("ready");
  });
});

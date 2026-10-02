import { describe, expect, test } from "bun:test";
import { queuedRowStatus, resolveFollowUpDispatch } from "./followUp";

describe("resolveFollowUpDispatch", () => {
  test("an idle thread always starts a turn", () => {
    expect(resolveFollowUpDispatch({ behavior: "steer", busy: false })).toBe("queue");
    expect(resolveFollowUpDispatch({ behavior: "steer", busy: false, opposite: true })).toBe("queue");
  });

  test("while busy the preference holds, and the chord flips it for one send", () => {
    expect(resolveFollowUpDispatch({ behavior: "queue", busy: true })).toBe("queue");
    expect(resolveFollowUpDispatch({ behavior: "queue", busy: true, opposite: true })).toBe("steer");
    expect(resolveFollowUpDispatch({ behavior: "steer", busy: true })).toBe("steer");
    expect(resolveFollowUpDispatch({ behavior: "steer", busy: true, opposite: true })).toBe("queue");
  });
});

describe("queuedRowStatus", () => {
  const waiting = { state: "queued" as const };

  test("the first waiting row runs when the turn ends; the rest wait", () => {
    expect(queuedRowStatus(waiting, 0, true, false).label).toBe("After this turn");
    expect(queuedRowStatus(waiting, 1, true, false).label).toBe("Waiting");
  });

  test("a claimed row is sending", () => {
    expect(queuedRowStatus({ state: "promoting" }, 0, true, false)).toMatchObject({ label: "Sending…", tone: "active" });
  });

  test("a held row says it didn't send and why, and rows behind it wait on it", () => {
    const held = queuedRowStatus({ state: "failed", error: "provider is down" }, 0, false, false);
    expect(held).toMatchObject({ label: "Didn't send", tone: "failed" });
    expect(held.detail).toContain("provider is down");
    expect(queuedRowStatus(waiting, 1, false, true).detail).toContain("didn't send");
  });

  test("a row waiting out a retry, or whose Send now was refused, says so", () => {
    expect(queuedRowStatus({ state: "queued", retryAt: 1, error: "busy" }, 0, false, false).label).toBe("Retrying");
    expect(queuedRowStatus({ state: "queued", error: "turn ended" }, 0, true, false).label).toBe("Not sent");
  });
});

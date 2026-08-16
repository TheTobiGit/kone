import { describe, expect, mock, test } from "bun:test";

import type { InFlightCancellation } from "./inFlightRequests.js";
import { makeInFlightRequestRegistry } from "./inFlightRequests.js";

describe("inFlightRequests", () => {
  test("cancel by session+requestId fires only that request and reports count 1", () => {
    const registry = makeInFlightRequestRegistry();
    const aCancel = mock(() => Promise.resolve());
    const bCancel = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t1", requestId: "r1", cancel: aCancel });
    registry.register({ sessionKey: "s2", turnId: "t1", requestId: "r1", cancel: bCancel });

    const result = registry.cancel({ sessionKey: "s1", requestId: "r1" });

    expect(result.count).toBe(1);
    expect(aCancel).toHaveBeenCalledTimes(1);
    expect(bCancel).toHaveBeenCalledTimes(0);
  });

  test("cancel with no requestId fires every request for that session", () => {
    const registry = makeInFlightRequestRegistry();
    const cancels = [mock(() => Promise.resolve()), mock(() => Promise.resolve()), mock(() => Promise.resolve())];
    registry.register({ sessionKey: "s1", turnId: "t1", requestId: "a", cancel: cancels[0] });
    registry.register({ sessionKey: "s1", turnId: "t2", requestId: "b", cancel: cancels[1] });
    registry.register({ sessionKey: "s2", turnId: "t1", requestId: "c", cancel: cancels[2] });

    const result = registry.cancel({ sessionKey: "s1" });

    expect(result.count).toBe(2);
    expect(cancels[0]).toHaveBeenCalledTimes(1);
    expect(cancels[1]).toHaveBeenCalledTimes(1);
    expect(cancels[2]).toHaveBeenCalledTimes(0);
  });

  test("unregister prevents a later cancel from firing that request", () => {
    const registry = makeInFlightRequestRegistry();
    const cancel = mock(() => Promise.resolve());
    const unregister = registry.register({
      sessionKey: "s1",
      turnId: "t1",
      requestId: "r1",
      cancel,
    });
    unregister();

    const result = registry.cancel({ sessionKey: "s1", requestId: "r1" });

    expect(result.count).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(0);
  });

  test("cancelTurn tombstones the turn so a late register is cancelled and never stays registered", () => {
    const registry = makeInFlightRequestRegistry();
    const firstCancel = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t1", requestId: "r1", cancel: firstCancel });

    const first = registry.cancelTurn("s1", "t1");
    expect(first.count).toBe(1);
    expect(firstCancel).toHaveBeenCalledTimes(1);

    const lateCancel = mock(() => Promise.resolve());
    const unregister = registry.register({
      sessionKey: "s1",
      turnId: "t1",
      requestId: "r2",
      cancel: lateCancel,
    });
    expect(lateCancel).toHaveBeenCalledTimes(1);
    unregister();

    const again = registry.cancelTurn("s1", "t1");
    expect(again.count).toBe(0);
    const byRequest = registry.cancel({ sessionKey: "s1", requestId: "r2" });
    expect(byRequest.count).toBe(0);
  });

  test("a different turn on the same session is not auto-cancelled by another turn's tombstone", () => {
    const registry = makeInFlightRequestRegistry();
    registry.cancelTurn("s1", "t1");

    const cancel = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t2", requestId: "r1", cancel });

    expect(cancel).toHaveBeenCalledTimes(0);

    const sweep = registry.cancel({ sessionKey: "s1", requestId: "r1" });
    expect(sweep.count).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("revokeSession cancels everything for the session and drops its tombstones", () => {
    const registry = makeInFlightRequestRegistry();
    const firstCancel = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t1", requestId: "r1", cancel: firstCancel });
    registry.cancelTurn("s1", "t1");

    const otherCancel = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t2", requestId: "r2", cancel: otherCancel });

    const revoked = registry.revokeSession("s1");
    expect(revoked.count).toBe(1);
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(otherCancel).toHaveBeenCalledTimes(1);

    const lateCancel = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t1", requestId: "r3", cancel: lateCancel });
    expect(lateCancel).toHaveBeenCalledTimes(0);

    const sweep = registry.cancelTurn("s1", "t1");
    expect(sweep.count).toBe(1);
    expect(lateCancel).toHaveBeenCalledTimes(1);
  });

  test("a synchronously-throwing cancel() is fail-open: a result is still returned and siblings still fire", () => {
    const registry = makeInFlightRequestRegistry();
    const throwing = mock(() => {
      throw new Error("boom");
    });
    const healthy = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t1", requestId: "r1", cancel: throwing });
    registry.register({ sessionKey: "s1", turnId: "t1", requestId: "r2", cancel: healthy });

    let cancelResult: InFlightCancellation | undefined;
    expect(() => {
      cancelResult = registry.cancel({ sessionKey: "s1" });
    }).not.toThrow();
    expect(cancelResult?.count).toBe(2);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);

    const throwing2 = mock(() => {
      throw new Error("boom");
    });
    const healthy2 = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t2", requestId: "r3", cancel: throwing2 });
    registry.register({ sessionKey: "s1", turnId: "t2", requestId: "r4", cancel: healthy2 });

    let turnResult: InFlightCancellation | undefined;
    expect(() => {
      turnResult = registry.cancelTurn("s1", "t2");
    }).not.toThrow();
    expect(turnResult?.count).toBe(2);
    expect(throwing2).toHaveBeenCalledTimes(1);
    expect(healthy2).toHaveBeenCalledTimes(1);

    const throwing3 = mock(() => {
      throw new Error("boom");
    });
    const healthy3 = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t3", requestId: "r5", cancel: throwing3 });
    registry.register({ sessionKey: "s1", turnId: "t3", requestId: "r6", cancel: healthy3 });

    let revokeResult: InFlightCancellation | undefined;
    expect(() => {
      revokeResult = registry.revokeSession("s1");
    }).not.toThrow();
    expect(revokeResult?.count).toBe(2);
    expect(throwing3).toHaveBeenCalledTimes(1);
    expect(healthy3).toHaveBeenCalledTimes(1);
  });

  test("a rejected cancel() promise is swallowed: settled resolves instead of rejecting", async () => {
    const registry = makeInFlightRequestRegistry();
    const rejecting = mock(() => Promise.reject(new Error("nope")));
    const healthy = mock(() => Promise.resolve());
    registry.register({ sessionKey: "s1", turnId: "t1", requestId: "r1", cancel: rejecting });
    registry.register({ sessionKey: "s1", turnId: "t1", requestId: "r2", cancel: healthy });

    const result = registry.cancel({ sessionKey: "s1" });

    expect(result.count).toBe(2);
    await expect(result.settled).resolves.toBeUndefined();
  });
});

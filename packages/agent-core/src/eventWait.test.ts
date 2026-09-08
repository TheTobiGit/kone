import { describe, expect, test } from "bun:test";

import { delay, onceEvent, withTimeout } from "./eventWait.js";
import type { RuntimeEvent } from "./types.js";

// Direct unit tests for the one-shot event wait. AgentService's compaction
// orchestration is the main consumer; these pin the settle/cancel/timeout
// contract it leans on without standing up a service.

function started(threadId = "t1"): RuntimeEvent {
  return { type: "session.started", threadId, provider: "codex", at: 1, source: "kone.store" };
}

function exited(code: number | null = 0, threadId = "t1"): RuntimeEvent {
  return { type: "session.exited", threadId, provider: "codex", at: 2, source: "kone.store", code };
}

/** A manual event bus: subscribe wires a listener, emit fans out to all of
 *  them, and the counts let tests assert the wait actually unwired itself. */
function bus() {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  let unsubscribed = 0;
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        unsubscribed += 1;
        listeners.delete(listener);
      };
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    size: () => listeners.size,
    unsubscribes: () => unsubscribed,
  };
}

function acceptExits(event: RuntimeEvent): number | undefined {
  return event.type === "session.exited" ? event.code : undefined;
}

describe("onceEvent", () => {
  test("resolves with the filter value for the accepted event", async () => {
    const b = bus();
    const wait = onceEvent(b.subscribe, acceptExits);

    expect(wait.arrived()).toBe(false);
    b.emit(exited(3));

    expect(wait.arrived()).toBe(true);
    expect(await wait.settled).toBe(3);
    // Settling unwires the listener — the wait holds nothing open.
    expect(b.size()).toBe(0);
  });

  test("a falsy-but-defined filter value still counts as accepted", async () => {
    const b = bus();
    const wait = onceEvent(b.subscribe, acceptExits);

    b.emit(exited(0));

    // Exit code 0 is a real answer, not "nothing arrived".
    expect(wait.arrived()).toBe(true);
    expect(await wait.settled).toBe(0);
  });

  test("non-matching events are ignored until the accepted one lands", async () => {
    const b = bus();
    const wait = onceEvent(b.subscribe, acceptExits);

    b.emit(started());
    b.emit(started("other-thread"));
    expect(wait.arrived()).toBe(false);

    b.emit(exited(1));
    expect(wait.arrived()).toBe(true);
    expect(await wait.settled).toBe(1);
  });

  test("a boundary that already landed wins — later events settle nothing", async () => {
    const b = bus();
    const wait = onceEvent(b.subscribe, acceptExits);

    b.emit(exited(3));
    b.emit(exited(7));

    expect(await wait.settled).toBe(3);
    expect(wait.arrived()).toBe(true);
  });

  test("a timeout resolves null and unwires the listener", async () => {
    const b = bus();
    const wait = onceEvent(b.subscribe, acceptExits, { timeoutMs: 10 });

    b.emit(started());
    expect(await wait.settled).toBeNull();

    expect(wait.arrived()).toBe(false);
    expect(b.size()).toBe(0);
  });

  test("cancel resolves null, is idempotent, and stops listening", async () => {
    const b = bus();
    const wait = onceEvent(b.subscribe, acceptExits);

    expect(b.size()).toBe(1);
    wait.cancel();
    wait.cancel();

    expect(await wait.settled).toBeNull();
    expect(wait.arrived()).toBe(false);
    expect(b.size()).toBe(0);
    expect(b.unsubscribes()).toBe(1);

    // An event landing after the cancel finds nobody home.
    b.emit(exited(9));
    expect(await wait.settled).toBeNull();
    expect(wait.arrived()).toBe(false);
  });

  test("a subscriber that dispatches synchronously still settles", async () => {
    const event = exited(5);
    const wait = onceEvent(
      (listener) => {
        // Fires before subscribe returns, while unsubscribe is still the
        // hoisted no-op and no timer exists yet — the declarations must be
        // usable in that order rather than tripping the temporal dead zone.
        listener(event);
        return () => {};
      },
      acceptExits,
      { timeoutMs: 20 },
    );

    expect(await wait.settled).toBe(5);
    expect(wait.arrived()).toBe(true);
  });
});

describe("withTimeout", () => {
  test("a fast promise passes its value through", async () => {
    expect(await withTimeout(Promise.resolve("ok"), 50, "too slow")).toBe("ok");
  });

  test("a rejecting promise keeps its own error, not the timeout's", async () => {
    let caught: unknown;
    try {
      await withTimeout(Promise.reject(new Error("inner failure")), 50, "too slow");
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toContain("inner failure");
  });

  test("a slow promise rejects with the timeout message", async () => {
    let caught: unknown;
    try {
      await withTimeout(new Promise<string>(() => {}), 10, "took too long");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain("took too long");
  });
});

describe("delay", () => {
  test("resolves without holding the process open", async () => {
    await delay(5);
    await delay(0);
  });
});

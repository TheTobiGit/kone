import { describe, expect, test } from "bun:test";

import {
  makeDeferredDesktopQuitIntentCoordinator,
  settleDeferredDesktopQuitAfterUpdaterFailure,
} from "./desktopQuitIntent.js";

// The coordinator is pure state — these tests drive it exactly the way
// main.ts would around an updater-owned shutdown, and mirror the reference
// proven: first intent wins, replay happens exactly once, repeated failure
// signals can't chain extra quit cycles.

function makeRecoveryHarness() {
  const quitReasons: string[] = [];
  let resumed = 0;
  return {
    quitReasons,
    get resumeCount() {
      return resumed;
    },
    actions: {
      replayQuit: ({ reason }: { readonly reason: string }) => quitReasons.push(reason),
      resumeApp: () => {
        resumed += 1;
      },
    },
  };
}

describe("deferred desktop quit intent coordination", () => {
  test("replays the first deferred quit when updater preflight fails", () => {
    const coordinator = makeDeferredDesktopQuitIntentCoordinator();
    const recovery = makeRecoveryHarness();

    expect(coordinator.defer("window-close")).toBe(true);
    expect(coordinator.defer("before-quit")).toBe(false);
    expect(
      settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions),
    ).toBe("replayed-quit");
    expect(recovery.quitReasons).toEqual(["window-close"]);
    expect(recovery.resumeCount).toBe(0);
  });

  test("preserves a valid updater before-quit through watchdog failure", () => {
    const coordinator = makeDeferredDesktopQuitIntentCoordinator();
    const recovery = makeRecoveryHarness();

    coordinator.defer("before-quit");
    expect(coordinator.observeUpdaterQuitAttempt()).toBe(true);
    expect(
      settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions),
    ).toBe("replayed-quit");
    expect(recovery.quitReasons).toEqual(["before-quit"]);
    expect(recovery.resumeCount).toBe(0);
  });

  test("ignores duplicate failure signals after starting quit replay", () => {
    const coordinator = makeDeferredDesktopQuitIntentCoordinator();
    const recovery = makeRecoveryHarness();

    coordinator.defer("SIGTERM");
    expect(
      settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions),
    ).toBe("replayed-quit");
    expect(
      settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions),
    ).toBe("already-replaying");
    expect(coordinator.defer("duplicate-quit")).toBe(false);
    expect(recovery.quitReasons).toEqual(["SIGTERM"]);
    expect(recovery.resumeCount).toBe(0);
  });

  test("resumes the app when updater failure has no deferred quit", () => {
    const coordinator = makeDeferredDesktopQuitIntentCoordinator();
    const recovery = makeRecoveryHarness();

    expect(coordinator.observeUpdaterQuitAttempt()).toBe(false);
    expect(
      settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions),
    ).toBe("resumed-app");
    expect(recovery.quitReasons).toEqual([]);
    expect(recovery.resumeCount).toBe(1);
  });
});

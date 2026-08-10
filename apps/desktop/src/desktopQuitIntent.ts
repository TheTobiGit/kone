// ── Deferred quit intent (updater-owns-shutdown) ─────────────────────────────
// updater failures"): if the user quits while the updater owns app shutdown
// (install preparation / quit-and-install handoff), the plain app.quit() must
// not preempt it — so the first quit intent is deferred. If the updater then
// FAILS (watchdog discovers quitAndInstall left the process alive, preflight
// validation rejects the artifact, …), the deferred intent is replayed exactly
// once so the user's quit still happens; repeated failure signals are
// idempotent (can't chain multiple quit cycles). No Electron globals — fully
// unit-testable.
//
// Integration point (kone, today): main.ts's before-quit handler runs the
// agent/terminal teardown and always quits — kone has no app updater, so there
// is no updater-owns-shutdown path to coordinate with yet. When an
// electron-updater quit-and-install path lands, call `defer()` from the
// before-quit branch that defers to the updater and route the updater's
// failure signal through `settleDeferredDesktopQuitAfterUpdaterFailure`
// (replayQuit → app.quit, resumeApp → revive what the updater stopped).

export interface DeferredDesktopQuitIntent {
  readonly reason: string;
}

export type DeferredDesktopQuitSettlement =
  | { readonly type: "replay-quit"; readonly intent: DeferredDesktopQuitIntent }
  | { readonly type: "resume-app" }
  | { readonly type: "already-replaying" };

export interface DeferredDesktopQuitIntentCoordinator {
  /** Records the first quit intent while the updater owns shutdown. Returns
   *  false for every later intent (and after replay started) — only the first
   *  user-visible reason matters. */
  readonly defer: (reason: string) => boolean;
  /** True when a quit was deferred — lets an updater quit-and-install attempt
   *  know the intent must survive even if the handoff turns out to have
   *  failed (before-quit firing is not proof the process will exit). */
  readonly observeUpdaterQuitAttempt: () => boolean;
  /** Settles after an updater failure: replays the deferred quit (once), or
   *  resumes the app when nothing was deferred. */
  readonly settleAfterUpdaterFailure: () => DeferredDesktopQuitSettlement;
}

export type DeferredDesktopQuitFailureOutcome =
  | "replayed-quit"
  | "resumed-app"
  | "already-replaying";

/**
 * Keeps the first quit request that arrives while the updater owns app
 * shutdown. Consuming the intent before replay makes repeated updater failure
 * signals idempotent and prevents multiple app.quit() chains.
 */
export function makeDeferredDesktopQuitIntentCoordinator(): DeferredDesktopQuitIntentCoordinator {
  let pending: DeferredDesktopQuitIntent | null = null;
  let replayStarted = false;

  return {
    defer(reason: string): boolean {
      if (pending !== null || replayStarted) {
        return false;
      }
      pending = { reason };
      return true;
    },
    /** A valid updater before-quit may still be followed by watchdog failure. */
    observeUpdaterQuitAttempt(): boolean {
      return pending !== null;
    },
    settleAfterUpdaterFailure(): DeferredDesktopQuitSettlement {
      if (replayStarted) {
        return { type: "already-replaying" };
      }
      if (pending === null) {
        return { type: "resume-app" };
      }
      const intent = pending;
      pending = null;
      replayStarted = true;
      return { type: "replay-quit", intent };
    },
  };
}

/** Routes one updater failure signal without coupling the state machine to
 *  Electron globals. */
export function settleDeferredDesktopQuitAfterUpdaterFailure(
  coordinator: DeferredDesktopQuitIntentCoordinator,
  actions: {
    readonly replayQuit: (intent: DeferredDesktopQuitIntent) => void;
    readonly resumeApp: () => void;
  },
): DeferredDesktopQuitFailureOutcome {
  const settlement = coordinator.settleAfterUpdaterFailure();
  switch (settlement.type) {
    case "replay-quit":
      actions.replayQuit(settlement.intent);
      return "replayed-quit";
    case "resume-app":
      actions.resumeApp();
      return "resumed-app";
    case "already-replaying":
      return "already-replaying";
  }
}

// One bound on a piece of off-screen work: a deadline and a cancellation that
// both stop it at once, wherever it has got to. Every step the work awaits runs
// through the scope, so a page whose script hangs after it loads is cut off by
// the same deadline as one that never loads, and an abort is honoured at the
// step in flight rather than at the next check.

/** The bound a piece of work runs inside. */
export interface RenderScope {
  /** `work`, or the scope's stop if that comes first. */
  run<T>(work: Promise<T>): Promise<T>;
  /** A pause that ends early, in failure, when the scope stops. */
  wait(ms: number): Promise<void>;
  /** Release the deadline and the abort listener once the work is over. */
  dispose(): void;
}

export function renderScope(deadlineMs: number, signal: AbortSignal | undefined, deadlineMessage: string): RenderScope {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(deadlineMessage)), deadlineMs);
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // The stop is only ever observed through a race; one that fires after the
  // work has finished has nobody left to tell.
  stopped.catch(() => {});

  // The stop goes first in each race, so a scope that has already stopped wins
  // over a step that happens to be ready on the same tick.
  return {
    run: (work) => Promise.race([stopped, work]),
    wait: (ms) => Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, ms))]),
    dispose: () => {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    },
  };
}

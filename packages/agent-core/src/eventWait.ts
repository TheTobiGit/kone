import type { RuntimeEvent } from "./types.js";

// Shared one-shot event waits and timeouts. AgentService's compaction
// orchestration is the first consumer; the adapter-local `withTimeout` copies
// (DroidAdapter, the Antigravity adapters) resolve `undefined` on timeout
// rather than rejecting, so they are not the same helper and stay where they
// are.

/** Resolve after `ms` without holding the process open on the timer's account. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Reject with `message` when `promise` takes longer than `ms`. The loser of
 *  the race stays subscribed (so no unhandled rejection), and its timer is
 *  cleared on settle. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** A one-shot wait for the first event a filter accepts. `settled` resolves
 *  with the filter's value, or null on timeout / `cancel` — it never rejects,
 *  so a wait nobody listens to anymore reads as "nothing arrived" instead of
 *  hanging. */
export type EventWait<T> = {
  settled: Promise<T | null>;
  /** Stop listening; `settled` resolves null. Idempotent. */
  cancel: () => void;
  /** Whether an accepted event has arrived yet — the synchronous read for
   *  callers that decide on arrival instead of waiting (a settled call whose
   *  boundary already landed synthesizes nothing). */
  arrived: () => boolean;
};

/** Wait for the first event `filter` accepts. `subscribe` wires the listener
 *  and returns its unsubscribe (AgentService passes its `onEvent`); the
 *  optional `timeoutMs` bounds the wait, resolving null instead of hanging. */
export function onceEvent<T>(
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void,
  filter: (event: RuntimeEvent) => T | undefined,
  options?: { timeoutMs?: number },
): EventWait<T> {
  let matched = false;
  let done = false;
  let resolveSettled: (value: T | null) => void = () => {};
  const settled = new Promise<T | null>((resolve) => {
    resolveSettled = resolve;
  });
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (value: T | null): void => {
    if (done) return;
    done = true;
    if (value !== null) matched = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    resolveSettled(value);
  };
  unsubscribe = subscribe((event) => {
    const accepted = filter(event);
    if (accepted !== undefined) finish(accepted);
  });
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
  }
  return { settled, cancel: () => finish(null), arrived: () => matched };
}

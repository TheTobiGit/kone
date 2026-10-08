import { isQuotaOrRateLimitError, limitResetFromError } from "./adapters/errors.js";

// Usage-limit state and snooze.
//
// A turn that fails on a provider usage limit is a real state, not a generic
// failure: the thread is waiting out the provider, and it can be resumed at the
// provider's own reset. This module holds the pure rules — what counts as a
// limit, how a reset is read (never invented), and when a snooze wakes early.

export type LimitFailure = {
  /** The failure is a provider usage limit. */
  limited: boolean;
  /** The provider's reset time, epoch millis, or null when it gave none. */
  resetAt: number | null;
};

/** Classify a turn failure: a provider usage limit, and the provider's own
 *  reset time when the payload carried one. `now` is the reference the reset
 *  reader uses to reject a time already past. */
export function limitFailureFromError(cause: unknown, now: number): LimitFailure {
  return { limited: isQuotaOrRateLimitError(cause), resetAt: limitResetFromError(cause, now) };
}

/** A turn's latest outcome, as the snooze wake rules read it. `limit` marks a
 *  usage-limit failure, which must not wake the snooze it itself set. */
export type TurnOutcome = {
  state: "failed" | "completed" | "interrupted" | "running";
  at: number;
  limit: boolean;
};

/**
 * Whether a thread is snoozed right now. A future `snoozedUntil` means snoozed
 * unless a wake-early rule fires:
 * - a parked gate (an approval or a question for the user) always wakes;
 * - a completion after the snooze was set wakes;
 * - a fresh failure after it wakes, but NOT the usage-limit failure that set a
 *   "snooze until reset" — that is the thing being waited out;
 * - an interrupt or cancel alone never wakes.
 */
export function isSnoozed(
  input: {
    snoozedUntil: number | null;
    snoozedAt: number | null;
    /** A pending approval or question right now. */
    parked: boolean;
    /** The thread's latest turn, or null when it has none. */
    latest: TurnOutcome | null;
  },
  now: number,
): boolean {
  if (input.snoozedUntil === null || input.snoozedUntil <= now) return false;
  if (input.parked) return false;
  const setAt = input.snoozedAt ?? 0;
  const latest = input.latest;
  if (latest !== null && latest.at > setAt) {
    if (latest.state === "completed") return false;
    if (latest.state === "failed" && !latest.limit) return false;
  }
  return true;
}

/** The snooze deadline for "snooze until reset": the reset when it is still in
 *  the future, else null. No reset known — or one already past — means no
 *  snooze deadline, never a guessed one. */
export function snoozeUntilReset(limitResetAt: number | null, now: number): number | null {
  return limitResetAt !== null && limitResetAt > now ? limitResetAt : null;
}

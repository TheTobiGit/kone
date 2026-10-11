export interface ContinuationDeferral {
  retryAt: number;
  startedAt: number;
  intervalMs: number;
  warned: boolean;
}

export interface ContinuationDeferralUpdate {
  deferral: ContinuationDeferral;
  shouldWarn: boolean;
}

const INITIAL_RESTORE_DEFER_MS = 250;
const MAX_RESTORE_DEFER_MS = 30_000;
const RESTORE_WARNING_AFTER_MS = 5 * 60_000;

/** Grow restore retries without dropping the durable row or spinning the sweep. */
export function nextContinuationDeferral(
  previous: ContinuationDeferral | undefined,
  now: number,
): ContinuationDeferralUpdate {
  const intervalMs = previous
    ? Math.min(previous.intervalMs * 2, MAX_RESTORE_DEFER_MS)
    : INITIAL_RESTORE_DEFER_MS;
  const startedAt = previous?.startedAt ?? now;
  const shouldWarn = !previous?.warned && now - startedAt >= RESTORE_WARNING_AFTER_MS;
  return {
    deferral: {
      retryAt: now + intervalMs,
      startedAt,
      intervalMs,
      warned: previous?.warned === true || shouldWarn,
    },
    shouldWarn,
  };
}

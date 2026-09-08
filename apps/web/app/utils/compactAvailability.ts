// Manual-compaction availability for one thread — the single rule the Compact
// control gates on, so the strip and any future surface agree. Pure, so the
// cases are pinned by unit tests rather than by clicking through live threads.
//
// Layering: this module sits below the session — it never imports the
// composable. Callers hand over a structural snapshot (plain values, or the
// live ref shape below), and the adapter unwraps it.
import type { ProviderKind, ProviderStatus } from "~/types/desktop";
import type { MeterCompactProps } from "~/types/session";

/** Whether the Compact control runs, waits, or stays out of the way. */
export type CompactAvailability =
  /** Ready to run. */
  | { state: "available" }
  /** A compaction this surface asked for is still in flight. */
  | { state: "compacting" }
  /** Shown disabled (or hidden, when the provider has no such concept) with
   *  `reason` as the explanation. */
  | { state: "unavailable"; reason: string };

export function compactAvailability(input: {
  /** The provider's surface row advertises manual compaction. */
  supported: boolean;
  /** The thread has a user turn worth compacting. */
  hasUserTurn: boolean;
  /** A turn is running or follow-ups are queued behind one. */
  working: boolean;
  /** A compaction is already in flight on this thread. */
  compacting: boolean;
}): CompactAvailability {
  if (!input.supported) {
    return { state: "unavailable", reason: "Compaction is unavailable for this provider" };
  }
  if (!input.hasUserTurn) {
    return { state: "unavailable", reason: "Nothing to compact yet" };
  }
  if (input.compacting) {
    return { state: "compacting" };
  }
  if (input.working) {
    return { state: "unavailable", reason: "Wait for the turn to finish" };
  }
  return { state: "available" };
}

/** The meter's Compact control for one thread — re-exported here so existing
 *  importers keep working; the type itself lives with the other session
 *  contracts in `~/types/session`. */
export type { MeterCompactProps } from "~/types/session";

/** The live thread facts the control props derive from, as a structural
 *  snapshot — plain values, so tests build it literally and live callers
 *  unwrap their session at the boundary. */
export type CompactSnapshot = {
  provider: ProviderKind;
  hasUserTurn: boolean;
  working: boolean;
  compacting: boolean;
  compactError: string | null;
  compactThread: () => void;
};

/** The smallest live-session shape the adapter reads — structural, so any
 *  session with these refs qualifies and no composable import is needed.
 *  `blocks` only needs each block's role; `queuedTurns` only its length. */
export type CompactSessionLike = {
  provider: { value: ProviderKind };
  blocks: { value: Array<{ role: string }> };
  busy: { value: boolean };
  queuedTurns: { value: Array<unknown> };
  compacting: { value: boolean };
  compactError: { value: string | null };
  compactThread: () => void;
};

/** A live session carries its facts in refs; a snapshot carries them plainly.
 *  The provider field tells them apart — a ref object on one side, a bare
 *  provider id on the other. */
function isSessionLike(
  source: CompactSnapshot | CompactSessionLike,
): source is CompactSessionLike {
  return source.provider instanceof Object;
}

/** The meter's Compact props for one thread, from a live session or a plain
 *  snapshot (or none). The strip column and the inbox live pane share this so
 *  their controls can never disagree. Null source — no live session — hides
 *  the card; unsupported providers hide it too; the rest render the row
 *  enabled, pending, or disabled with a reason. */
export function compactPropsForSession(
  source: CompactSnapshot | CompactSessionLike | null | undefined,
  statuses: readonly ProviderStatus[],
): MeterCompactProps {
  if (!source) return {};
  // A live session unwraps to the same snapshot at the boundary; a plain
  // snapshot passes through untouched.
  let snapshot: CompactSnapshot;
  if (isSessionLike(source)) {
    const live = source;
    snapshot = {
      provider: live.provider.value,
      hasUserTurn: live.blocks.value.some((b) => b.role === "user"),
      working: live.busy.value || live.queuedTurns.value.length > 0,
      compacting: live.compacting.value,
      compactError: live.compactError.value,
      compactThread: () => {
        void live.compactThread();
      },
    };
  } else {
    snapshot = source;
  }
  const supported =
    statuses.find((row) => row.provider === snapshot.provider)?.supportsThreadCompaction === true;
  if (!supported) return {};
  const availability = compactAvailability({
    supported,
    hasUserTurn: snapshot.hasUserTurn,
    working: snapshot.working,
    compacting: snapshot.compacting,
  });
  const props: MeterCompactProps = {
    compactState: availability.state,
    compactError: snapshot.compactError,
    onCompact: snapshot.compactThread,
  };
  if (availability.state === "unavailable") props.compactReason = availability.reason;
  return props;
}

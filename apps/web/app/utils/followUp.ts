import type { QueuedTurnEntry } from "~/composables/agentTypes";

// What a message sent while the agent works does, and what each queued one is
// doing. Pure, so the composer's choice and the strip's wording are decided
// in one place each and tested without mounting either.

/** A follow-up written while a turn runs either waits for the turn to end
 *  (`queue`) or goes into the running turn (`steer`). */
export type FollowUpBehavior = "queue" | "steer";

/** What a send does: the preference while a turn runs, flipped for one send
 *  by the opposite-key chord. With no turn running every send simply starts
 *  one, which the queue path does. */
export function resolveFollowUpDispatch(input: {
  behavior: FollowUpBehavior;
  busy: boolean;
  opposite?: boolean;
}): FollowUpBehavior {
  if (!input.busy) return "queue";
  if (!input.opposite) return input.behavior;
  return input.behavior === "queue" ? "steer" : "queue";
}

/** A queued row's short status, the longer line its tooltip carries, and how
 *  loudly the strip shows it. */
export type QueuedRowStatus = {
  label: string;
  detail: string;
  tone: "quiet" | "active" | "failed";
};

/** What one queued row is doing. `index` is its place in the strip (0 runs
 *  first); `busy` is whether a turn is running now; `heldAhead` is whether a
 *  row above it didn't send and is holding the queue. */
export function queuedRowStatus(
  entry: Pick<QueuedTurnEntry, "state" | "retryAt" | "error">,
  index: number,
  busy: boolean,
  heldAhead: boolean,
): QueuedRowStatus {
  if (entry.state === "promoting") {
    return { label: "Sending…", detail: "Handing it to the agent now.", tone: "active" };
  }
  if (entry.state === "failed") {
    return {
      label: "Didn't send",
      detail: `It didn't start${entry.error ? ` (${entry.error})` : ""}. Messages after it wait until you send it now or remove it.`,
      tone: "failed",
    };
  }
  if (entry.retryAt) {
    return {
      label: "Retrying",
      detail: `It didn't start${entry.error ? ` (${entry.error})` : ""}; trying again shortly.`,
      tone: "failed",
    };
  }
  if (entry.error) {
    return { label: "Not sent", detail: `Send now didn't go through (${entry.error}). It's still queued.`, tone: "failed" };
  }
  if (heldAhead) {
    return { label: "Waiting", detail: "Waits for the message above that didn't send.", tone: "quiet" };
  }
  if (index === 0 && busy) {
    return { label: "After this turn", detail: "Runs when this turn ends.", tone: "quiet" };
  }
  return { label: "Waiting", detail: "Runs after the messages above it.", tone: "quiet" };
}

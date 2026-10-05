import type { StepWait } from "~/types/desktop";

// The user steered a turn whose provider cannot take a message mid-turn, and
// kone steer is holding it until the running tool call finishes. Past a while
// the user is offered Interrupt now. Pure, so the timing and the wording are
// tested without mounting the pill.

/** How long a steer waits on a tool call before Interrupt now is offered. */
export const STEER_WAIT_OFFER_MS = 30_000;

/** Whether the pill shows: the user's own wait, 30 s on. An agent's urgent
 *  message keeps waiting with no offer. */
export function steerWaitOffered(wait: StepWait | null | undefined, now: number): boolean {
  return !!wait && wait.from === "user" && now - wait.since >= STEER_WAIT_OFFER_MS;
}

/** "Waiting for Ada to finish Bash (bun test)". */
export function steerWaitLabel(wait: StepWait, agentName?: string | null): string {
  const who = agentName?.trim() || "the agent";
  const tool = wait.tool;
  if (!tool) return `Waiting for ${who} to finish the current step`;
  const target = tool.text.trim().split("\n")[0] ?? "";
  const shown = target.length > 60 ? `${target.slice(0, 57)}...` : target;
  return `Waiting for ${who} to finish ${tool.name}${shown ? ` (${shown})` : ""}`;
}

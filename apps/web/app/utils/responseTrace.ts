// What a response did, read off its turn as the thread already holds it: how
// long it took, the tools it called by kind, and what it said last. The token
// side comes from the turn's usage row; this is everything the transcript
// itself can answer.

import type { AssistantBlock } from "~/composables/agentTypes";
import type { RuntimeItem } from "~/types/desktop";
import type { ToolOrbFamily } from "~/utils/toolOrb/types";
import { toolMeta } from "~/utils/toolPresentation";

/** Each tool family as a trace names it: what the agent was doing. */
export const FAMILY_LABEL = {
  read: "Read",
  write: "Edit",
  search: "Search",
  intel: "Code intel",
  run: "Run",
  web: "Web",
  agent: "Agents and plans",
  del: "Delete",
  neutral: "Other",
} satisfies Record<ToolOrbFamily, string>;

export type ToolTally = { family: ToolOrbFamily; label: string; count: number };

export type ResponseSummary = {
  state: AssistantBlock["state"];
  startedAt: number;
  /** When the turn settled; absent while it runs. */
  endedAt: number | undefined;
  /** The turn's own tool calls, most-used kind first. */
  tools: ToolTally[];
  toolCalls: number;
  /** Tool calls that failed. */
  failedCalls: number;
  /** Subagents the turn started, and the calls they made on its behalf. */
  subagents: number;
  subagentCalls: number;
  /** The last thing it said, for the card's quote. */
  reply: string;
};

/** Every piece of one turn (a steer splits a reply into pieces that share its
 *  `turnId`), read as the one response they are. */
export function summarizeResponse(
  pieces: readonly AssistantBlock[],
  familyOf: (name: string | undefined) => ToolOrbFamily = (name) => toolMeta(name).family,
): ResponseSummary | null {
  const first = pieces[0];
  const last = pieces.at(-1);
  if (!first || !last) return null;

  const counts = new Map<ToolOrbFamily, number>();
  let toolCalls = 0;
  let failedCalls = 0;
  let subagents = 0;
  let subagentCalls = 0;
  let reply = "";
  for (const piece of pieces) {
    for (const item of piece.items) {
      if (item.kind === "assistant_text" && item.text.trim()) reply = item.text.trim();
      if (item.kind !== "tool_call") continue;
      toolCalls += 1;
      if (item.status === "failed") failedCalls += 1;
      const family = familyOf(item.name);
      counts.set(family, (counts.get(family) ?? 0) + 1);
      if (item.subagent) {
        subagents += 1;
        subagentCalls += nestedCalls(item.subagent.items);
      }
    }
  }

  const tools = [...counts]
    .map(([family, count]) => ({ family, label: FAMILY_LABEL[family], count }))
    .sort((a, b) => b.count - a.count);

  return {
    state: last.state,
    startedAt: first.at,
    endedAt: last.state === "running" ? undefined : (last.endedAt ?? undefined),
    tools,
    toolCalls,
    failedCalls,
    subagents,
    subagentCalls,
    reply,
  };
}

/** Tool calls inside a subagent's run, its own subagents' included. */
function nestedCalls(items: readonly RuntimeItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind !== "tool_call") continue;
    n += 1;
    if (item.subagent) n += nestedCalls(item.subagent.items);
  }
  return n;
}

/** A duration as a trace reads it: "48s", "2m 14s", "1h 3m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

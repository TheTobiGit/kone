import type { MessageSender } from "@kone/protocol/message-sender";

import type { RuntimeItem, StoredBlock } from "./types.js";

// What agent_read shows of a thread an agent handed work to, at the depth the
// reader asks for.
//
// Three depths, from the one a report already carries to the whole history:
//
//   · final      — the reply the latest turn ended on: the text after its last
//                  batch of work. The same rule picks the reply a hand-off report
//                  carries (latestAssistantText) and the one a finished turn
//                  always shows in the app (turnPlan), so "the final reply" means
//                  one thing everywhere. It is where an agent puts its report.
//   · response   — the latest request and everything the agent wrote answering
//                  it: every piece of the turn, the messages steered into it in
//                  their place, and one line naming what it did. For when the
//                  final reply is not enough context.
//   · transcript — the conversation, newest last, a window at a time.
//
// Tool calls appear only as that one line, never with their payloads: the
// child's raw tool use stays in its own thread.

export type AgentReadScope = "final" | "response" | "transcript";

/** What final and response return by default, so a full report arrives whole.
 *  Above the cap a hand-off summary carries (SPAWN_SUMMARY_CHAR_CAP): reading
 *  is how an agent gets past that cap, so it must not cut at the same place. */
export const AGENT_READ_RESPONSE_CHAR_CAP = 48_000;
/** Tool calls named on a response's action line before the rest are counted. */
const ACTIONS_SHOWN = 12;

export type AgentReadTurn = {
  turnId: string;
  state: Extract<StoredBlock, { role: "assistant" }>["state"];
  error?: string;
  /** The message the turn answers, absent when the transcript holds none. */
  request?: Extract<StoredBlock, { role: "user" }>;
  /** The turn's pieces, with the messages steered into it between them, in
   *  reading order. */
  blocks: StoredBlock[];
};

/**
 * The thread's latest turn: the request it answers and everything after it.
 * Null when no turn has started.
 */
export function latestTurn(blocks: StoredBlock[]): AgentReadTurn | null {
  let lastPiece = -1;
  let last: Extract<StoredBlock, { role: "assistant" }> | undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.role === "assistant") {
      lastPiece = i;
      last = block;
      break;
    }
  }
  if (!last) return null;
  let first = lastPiece;
  for (let i = lastPiece - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.role === "assistant") {
      if (block.turnId !== last.turnId) break;
      first = i;
    }
  }
  // The request is the newest message above the turn's first piece that was
  // not steered into it. A message steered in before the turn said anything
  // reads above the reply, so it is passed over on the way up and kept with
  // the turn instead.
  let requestIndex = -1;
  let request: Extract<StoredBlock, { role: "user" }> | undefined;
  for (let i = first - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.role === "assistant") break;
    if (!block.steered) {
      requestIndex = i;
      request = block;
      break;
    }
  }
  const start = requestIndex === -1 ? first : requestIndex + 1;
  const turn: AgentReadTurn = {
    turnId: last.turnId,
    state: last.state,
    blocks: blocks.slice(start, lastPiece + 1),
  };
  if (last.error) turn.error = last.error;
  if (request) turn.request = request;
  return turn;
}

/** The turn's own items across all its pieces, in order. */
function turnItems(turn: AgentReadTurn): RuntimeItem[] {
  return turn.blocks.flatMap((b) => (b.role === "assistant" ? b.items : []));
}

/**
 * The reply a turn ended on: walking back from its end, past any tool calls it
 * ended on, the text up to the tool call before it. Null when it said nothing
 * after its work. The same rule as the store's latestAssistantText.
 */
export function finalReplyOf(turn: AgentReadTurn): string | null {
  const items = turnItems(turn);
  const run: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "tool_call") {
      if (run.length > 0) break;
      continue;
    }
    if (item.kind === "assistant_text" && item.text.trim().length > 0) run.unshift(item.text);
  }
  const text = run.join("").trim();
  return text || null;
}

/** One line naming what the turn did: `Read(ipc.ts), Bash(bun test) failed`.
 *  Null when it ran no tools. */
export function actionsLine(turn: AgentReadTurn): string | null {
  const calls = turnItems(turn).filter((item) => item.kind === "tool_call");
  if (calls.length === 0) return null;
  const shown = calls.slice(0, ACTIONS_SHOWN).map((call) => {
    const target = call.text.replace(/\s+/g, " ").trim();
    const short = target.length > 60 ? `${target.slice(0, 60).trimEnd()}…` : target;
    const name = call.name ?? "tool";
    const label = short ? `${name}(${short})` : name;
    return call.status === "failed" ? `${label} failed` : label;
  });
  const rest = calls.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/** Who a message is from, as the agent reading another agent's thread sees it. */
function fromWhom(sender: MessageSender | undefined): string {
  if (!sender || sender.kind === "user") return "the user";
  if (sender.kind === "agent") return sender.name?.trim() || "another agent";
  return "kone";
}

/** How the turn stands, in words. */
function stateText(turn: AgentReadTurn): string {
  if (turn.state === "running") return "still working — this is what it has written so far";
  if (turn.state === "failed") return turn.error ? `failed: ${turn.error}` : "failed";
  if (turn.state === "interrupted") return "interrupted before it finished";
  return turn.state;
}

function capped(text: string, cap: number, marker: string): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, Math.max(0, cap - marker.length)).trimEnd()}${marker}`;
}

/** The latest turn's final reply, as the reader is shown it. `name` is how
 *  the thread is named to the reader, e.g. its quoted title. */
export function renderFinal(turn: AgentReadTurn | null, name: string, cap = AGENT_READ_RESPONSE_CHAR_CAP): string {
  if (!turn) return `${name} has no reply yet.`;
  const reply = finalReplyOf(turn);
  const head = `Final reply in ${name} (turn ${turn.turnId}, ${stateText(turn)}):`;
  if (!reply) {
    return `${head}\n(It said nothing after its last step. Read scope "response" for the whole turn.)`;
  }
  return `${head}\n\n${capped(reply, cap, `\n…[cut at ${cap} characters — read scope "transcript" with a higher maxTextChars for the rest]`)}`;
}

/** The latest request and the whole response to it, as the reader is shown it. */
export function renderResponse(turn: AgentReadTurn | null, name: string, cap = AGENT_READ_RESPONSE_CHAR_CAP): string {
  if (!turn) return `${name} has no reply yet.`;
  const parts: string[] = [];
  if (turn.request) {
    parts.push(`Latest request, from ${fromWhom(turn.request.sender)}:`, turn.request.text.trim(), "");
  }
  parts.push(`Response in ${name} (turn ${turn.turnId}, ${stateText(turn)}):`);
  const body: string[] = [];
  for (const block of turn.blocks) {
    if (block.role === "user") {
      body.push(`[message from ${fromWhom(block.sender)} arrived here] ${block.text.trim()}`);
      continue;
    }
    const text = block.items
      .filter((item) => item.kind === "assistant_text")
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (text) body.push(text);
  }
  parts.push(
    body.length > 0
      ? capped(body.join("\n\n"), cap, `\n…[cut at ${cap} characters — read scope "transcript" for the rest]`)
      : "(no text — tool calls only)",
  );
  const actions = actionsLine(turn);
  if (actions) parts.push("", `What it did: ${actions}`);
  return parts.join("\n");
}

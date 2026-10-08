// Title context selection: which parts of a whole conversation a title one-shot
// gets to see. The first-turn rename reads a single message, but regenerating a
// title later has to answer "what is this thread about" from everything that
// happened since — so the selection here is deliberate:
//
//   - User intent is reserved first. The first user message holds the original
//     constraints, and every later user message is a correction or a follow-up;
//     neither may be evicted by a long assistant answer.
//   - Assistant findings fill what is left, in conversation order, because the
//     answer is the work the user asked for.
//   - Reasoning/system items are dropped entirely: thinking traces are working
//     notes, not what the thread is about, and they dwarf the answer they precede.
//
// Budgets are characters, not tokens: the title one-shot is a cheap small-model
// call, and a generous character budget is already far more than a title needs.
// A message longer than its budget is trimmed head+tail (a long request keeps
// its opening and its final constraints) rather than dropped, since the first
// user message is usually where the request lives.

/** One message as the title context sees it. Only role and text matter; every
 *  other item kind (tool calls, plans, commands) is already flattened to text
 *  by the caller or left out. */
export interface ThreadTitleMessage {
  readonly role: "user" | "assistant" | "system" | "reasoning";
  readonly text: string;
}

/** Total characters handed to the one-shot, matching t3's title context. */
export const TITLE_CONTEXT_MAX_CHARS = 8_000;
/** Characters a single message may take before its middle is dropped. */
export const TITLE_CONTEXT_MAX_MESSAGE_CHARS = 2_000;
/** Characters reserved for assistant output so a pile of user messages cannot
 *  crowd out the answers that say what the work turned out to be. */
const TITLE_CONTEXT_ASSISTANT_RESERVE = 2_000;

const OMITTED = "[Earlier content truncated]\n\n";
const TRUNCATED = "\n[Content truncated]\n";

/** Keep a message's head and tail when it is too long: for a request the head
 *  is the ask and the tail is the last-minute constraint, and for an answer the
 *  tail is the conclusion. */
export function limitTitleMessage(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= TRUNCATED.length) return "";
  const available = budget - TRUNCATED.length;
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${text.slice(0, head)}${TRUNCATED}${tail > 0 ? text.slice(-tail) : ""}`;
}

/** Build the whole-conversation context for a regenerated title.
 *
 *  Order of acquisition, mirroring t3:
 *   1. the first user message, up to one message budget;
 *   2. every other user message, newest first, never touching the assistant
 *      reserve;
 *   3. assistant messages, newest first, into what remains;
 *   4. any spare space then expands the selected messages again.
 *
 *  Returns "" when nothing survives (no user or assistant text at all), which
 *  the caller treats as "keep the current title". */
export function formatThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
): string {
  const sections = messages.flatMap((message, index) => {
    if (message.role === "system" || message.role === "reasoning") return [];
    const text = message.text.trim();
    if (!text) return [];
    return [{ index, message, prefix: `${message.role.toUpperCase()}:\n` }];
  });
  const selected = new Map<number, string>();
  let remaining = TITLE_CONTEXT_MAX_CHARS - OMITTED.length;
  const add = (section: (typeof sections)[number], budget: number): void => {
    if (selected.has(section.index)) return;
    const limit = Math.min(budget, remaining) - section.prefix.length - 2;
    if (limit <= TRUNCATED.length) return;
    const contents = limitTitleMessage(section.message.text.trim(), limit);
    if (!contents) return;
    const text = section.prefix + contents;
    selected.set(section.index, text);
    remaining -= text.length + 2;
  };

  const firstUser = sections.find((section) => section.message.role === "user");
  if (firstUser) add(firstUser, TITLE_CONTEXT_MAX_MESSAGE_CHARS);
  // Newest user messages first, but hold back the assistant reserve so a burst
  // of corrections cannot evict the answer they were correcting.
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    if (!section || section.message.role !== "user") continue;
    add(section, Math.min(TITLE_CONTEXT_MAX_MESSAGE_CHARS, remaining - TITLE_CONTEXT_ASSISTANT_RESERVE));
  }
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    if (!section || section.message.role !== "assistant") continue;
    add(section, TITLE_CONTEXT_MAX_MESSAGE_CHARS);
  }
  // Spare space (a short conversation) goes back to the selected messages so
  // the one-shot sees them whole rather than clipped at a fixed budget.
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    if (!section) continue;
    const previous = selected.get(section.index);
    if (previous === undefined) continue;
    const expanded =
      section.prefix +
      limitTitleMessage(section.message.text.trim(), previous.length + remaining - section.prefix.length);
    remaining -= expanded.length - previous.length;
    selected.set(section.index, expanded);
  }

  const retained = sections.filter((section) => selected.has(section.index));
  const truncated =
    retained.some((section) => selected.get(section.index) !== section.prefix + section.message.text.trim()) ||
    retained.length < sections.length;
  return `${truncated ? OMITTED : ""}${retained
    .map((section) => selected.get(section.index))
    .join("\n\n")}`;
}

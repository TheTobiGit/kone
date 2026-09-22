import { randomUUID } from "node:crypto";
import { buildSemanticBranchSummary, estimateBlockTokens, findCutPoint } from "./compaction/index.js";

import { getConversationStore } from "./ConversationStore.js";
import { buildPromptThreadTitleFallback } from "./threadTitle.js";
import type {
  CreateSideChatInput,
  CreateSideChatResult,
  ForkContext,
  ForkImportedBlock,
  StoredBlock,
  StoredThread,
  ThreadLineage,
} from "./types.js";
import { copyTurnStamp, isBranchForkContext, isEditForkContext, isHandoffForkContext } from "./types.js";
import {
  BRANCH_BOUNDARY_INSTRUCTION,
  BRANCH_INTRO,
  BRANCH_MESSAGE_TOO_LONG,
  HANDOFF_BOUNDARY_INSTRUCTION,
  HANDOFF_INTRO,
  HANDOFF_MESSAGE_TOO_LONG,
  transferText,
} from "./handoff.js";
import {
  HAND_IN_BOUNDARY_INSTRUCTION,
  HAND_IN_INTRO,
  HAND_IN_MESSAGE_TOO_LONG,
} from "./handIn.js";

// Side chat creation + context handoff (docs/side-chat-design.md). A side chat
// is a user-initiated child conversation forked from a parent thread: it
// inherits the parent's transcript as *reference-only* context, runs as its
// own root thread, and never pollutes the parent.
//
// Two halves:
//   1. `createSidechatThread` — the creation command. The renderer mints the
//      thread id (kone owns thread ids), the full non-streaming native
//      transcript of the source is imported as `fork-import` rows (re-minted
//      ids, original timestamps, attachments kept), and the thread row carries
//      the ForkContext + lineage pointer back at the source.
//   2. `sidechatBootstrapForTurn` — the one-shot context handoff. kone's
//      adapters have no native fork API, so every side chat takes the
//      synthetic bootstrap path: on the FIRST turn only, the imported
//      transcript is replayed as budgeted text inside
//      `<sidechat_context>…</sidechat_context>` with the boundary instruction
//      wrapped in `<latest_user_message>`. Gated on `bootstrapStatus:
//      "pending"` + no native assistant turn; consumed when the first turn
//      completes (ConversationStore.completeSidechatBootstrap).

export const SIDECHAT_BOUNDARY_INSTRUCTION =
  "You are in a sidechat. Treat all prior conversation as reference-only context. Do not continue any prior task automatically. Do not mutate files, git, or the workspace and do not run workspace-changing commands unless the latest user message explicitly asks you to do so after this boundary. Use this sidechat for focused explanation, safety checks, summaries, and alternatives.";

const RECENT_MESSAGE_COUNT = 6;
const RECENT_MESSAGE_CHAR_LIMIT = 2_400;
const EARLIER_MESSAGE_CHAR_LIMIT = 320;
/** Hard ceiling for any bootstrap transcript: it replays as one uncached user
 *  message, so long threads must drop their oldest summaries rather than grow
 */
export const SIDECHAT_TRANSCRIPT_CHAR_BUDGET = 32_000;
export const SIDECHAT_SEND_TURN_MAX_INPUT_CHARS = 120_000;
const BOOTSTRAP_CHAR_BUDGET = Math.floor(SIDECHAT_SEND_TURN_MAX_INPUT_CHARS * 0.75);

const INTRO = "This sidechat was cloned from an earlier conversation.";

/** Framing for an edit fork's replayed prefix: the copied transcript is the
 *  conversation's real history up to the edit point — the model continues
 *  from it — not reference material fenced off from the task. */
const EDIT_FORK_INTRO =
  "This thread continues an earlier conversation from an edited message. The transcript below is the conversation's real history up to the edit point.";

export const EDIT_FORK_BOUNDARY_INSTRUCTION =
  "Continue this conversation from the edited message below. Treat the transcript above as settled history — what was actually said and done — not as reference material. Answer the latest user message directly, building on that history.";

/** The message a too-long first side-chat turn is rejected with, up front,
 *  than silently dropping context). */
export const SIDECHAT_MESSAGE_TOO_LONG =
  "This message is too long to include the side chat's imported context. Shorten the message and retry.";

/** The message a too-long first edit-fork turn is rejected with. The forked
 *  history rides the first turn, so an overlong edited message cannot carry
 *  it — the turn is rejected up front rather than silently dropping history. */
export const EDIT_FORK_MESSAGE_TOO_LONG =
  "This message is too long to include the forked conversation's history. Shorten the message and retry.";

/** Collapse run-of-line whitespace so a long message stays a compact block
 */
function normalize(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(value: string, cap: number): string {
  const flat = normalize(value);
  if (flat.length <= cap) return flat;
  const cut = cap > 3 ? cap - 3 : 0;
  return `${flat.slice(0, cut).trimEnd()}...`;
}

/** Render one imported message verbatim (capped) — the label plus the text. A
 *  block with nothing transferable (no prose, no tool calls) renders as empty
 *  so the caller skips it instead of emitting a content-free stanza. */
function renderVerbatim(block: StoredBlock): string {
  const text = truncate(transferText(block) ?? "", RECENT_MESSAGE_CHAR_LIMIT);
  if (!text) return "";
  return block.role === "user" ? `User:\n${text}` : `Assistant:\n${text}`;
}

/** Render one imported message as a one-line summary for the earlier section. */
function renderSummary(block: StoredBlock): string {
  const text = truncate(transferText(block) ?? "", EARLIER_MESSAGE_CHAR_LIMIT);
  if (!text) return "";
  return block.role === "user" ? `- User: ${text}` : `- Assistant: ${text}`;
}

/** The model-visible narrative of a block: the prompt for user blocks, the
 *  joined assistant_text items for assistant blocks (tool calls are not
 */
function blockText(block: StoredBlock): string {
  if (block.role === "user") return block.text;
  return block.items
    .filter((item) => item.kind === "assistant_text")
    .map((item) => item.text)
    .join(" ");
}

/**
 * The budgeted plain-text replay of a side chat's imported transcript, framed
 * so the receiving agent reads it as reference context rather than as
 *
 * - the last 6 imported messages verbatim (≤2,400 chars each),
 * - older messages as one-line summaries (≤320 chars each) newest-first until
 *   the budget,
 * - hard ceiling of 32,000 chars (75% of the send-turn cap),
 * - intro + source title + branch framing, wrapped by the caller in
 *   `<sidechat_context>…</sidechat_context>`.
 *
 * Returns null when there is nothing to replay (no imported blocks).
 */
export function buildSidechatForkContext(
  thread: Pick<StoredThread, "blocks" | "title" | "branch">,
  maxChars = BOOTSTRAP_CHAR_BUDGET,
  intro = INTRO,
  /** Which blocks replay as context. Defaults to fork-imported rows only —
   *  a side chat's own turns are its live conversation, not its import. An
   *  edit fork instead replays everything before its edited message (a
   *  nested fork's intermediate edits are native rows, but they are still
   *  history the continuation needs). */
  includeBlock: (block: StoredBlock, index: number, blocks: StoredBlock[]) => boolean = (block) =>
    block.source === "fork-import",
): string | null {
  const imported = thread.blocks.filter(includeBlock);
  if (imported.length === 0) return null;
  const budget = Math.min(Math.max(0, maxChars), SIDECHAT_TRANSCRIPT_CHAR_BUDGET);

  let cutIndex = 0;
  if (imported.length > RECENT_MESSAGE_COUNT) {
    const recentCandidate = imported.slice(-RECENT_MESSAGE_COUNT);
    const keepTokens = recentCandidate.reduce((acc, b) => acc + estimateBlockTokens(b), 0);
    const cutResult = findCutPoint(imported, keepTokens);
    cutIndex = cutResult.cutIndex > 0 ? cutResult.cutIndex : Math.max(0, imported.length - RECENT_MESSAGE_COUNT);
  }

  const recent = imported.slice(cutIndex);
  const earlier = imported.slice(0, cutIndex);

  // One budget shared by the earlier-summary and recent-verbatim sections
  // below — splitting it in two let the recent (most valuable) half grow past
  // what was left, forcing a final truncate() to cut it instead of the
  // earlier half. The recent section is reserved first (newest messages
  // first, so a shortfall drops the oldest of the recent set rather than the
  // newest), and the earlier summary only spends what recent didn't need.
  const parts: string[] = [];
  let used = 0;
  const push = (line: string): void => {
    parts.push(line);
    used += line.length + 1;
  };
  push(intro);
  if (thread.title) push(`Original conversation title: ${thread.title}`);
  if (thread.branch) push(`Git branch: ${thread.branch}`);

  const recentHeader = "Most recent imported messages:";
  const recentLines: string[] = [];
  let recentReserved = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const block = recent[i];
    if (!block) continue;
    const rendered = renderVerbatim(block);
    if (rendered.length === 0) continue;
    if (used + recentHeader.length + 1 + recentReserved + rendered.length > budget) break;
    recentLines.unshift(rendered);
    recentReserved += rendered.length + 1;
  }
  const recentBudget = budget - used - (recentLines.length > 0 ? recentHeader.length + 1 + recentReserved : 0);

  // Earlier messages: newest-first one-line summaries, oldest dropped if the
  // remaining budget runs out (the transcript must shrink, never blow the
  // cap, and the recent section above always wins the shared budget first).
  if (earlier.length > 0) {
    const branchSummary = buildSemanticBranchSummary(earlier, {
      title: thread.title,
      branch: thread.branch ?? undefined,
      maxSummaryChars: budget,
    });

    const summaryLines: string[] = [];
    let summaryChars = 0;
    for (let i = earlier.length - 1; i >= 0; i -= 1) {
      const block = earlier[i];
      if (!block) continue;
      const line = renderSummary(block);
      if (line.length === 0) continue;
      if (summaryChars + line.length > recentBudget) break;
      summaryLines.unshift(line);
      summaryChars += line.length + 1;
    }
    // What's left of the earlier section's share after the summary lines
    // above — the operations lists below spend from this, never from what
    // the recent section already reserved.
    let earlierRemaining = recentBudget;
    if (summaryLines.length > 0) {
      const omitted = earlier.length - summaryLines.length;
      const header = `Earlier conversation summary (${omitted} older message${omitted === 1 ? "" : "s"} omitted to fit the context budget):`;
      push(header);
      earlierRemaining -= header.length + 1;
      for (const line of summaryLines) {
        push(line);
        earlierRemaining -= line.length + 1;
      }
    }

    const pushIfFits = (line: string): void => {
      if (line.length + 1 > earlierRemaining) return;
      push(line);
      earlierRemaining -= line.length + 1;
    };
    const { operations } = branchSummary;
    if (operations.filesModified.length > 0) {
      pushIfFits("Files Modified / Created:");
      for (const file of operations.filesModified) {
        pushIfFits(`- \`${file}\``);
      }
    }
    if (operations.filesRead.length > 0) {
      pushIfFits("Files Read / Inspected:");
      for (const file of operations.filesRead) {
        pushIfFits(`- \`${file}\``);
      }
    }
    if (operations.commandsRun.length > 0) {
      pushIfFits("Commands Executed:");
      for (const cmd of operations.commandsRun) {
        pushIfFits(`- \`${cmd}\``);
      }
    }
  }

  if (recentLines.length > 0) {
    push(recentHeader);
    for (const line of recentLines) push(line);
  }
  return truncate(parts.join("\n"), budget);
}

/** The `<latest_user_message>`-wrapped boundary block that rides every side
 *  chat's first turn, after the imported-context block. */
function boundaryBlock(input: string, instruction: string): string {
  return `<sidechat_boundary>\n${instruction}\n</sidechat_boundary>\n<latest_user_message>\n${input}\n</latest_user_message>`;
}

/** Assemble the full first-turn prompt: imported context in
 *  `<sidechat_context>…</sidechat_context>`, then the boundary block with the
 *  user's message wrapped in `<latest_user_message>`. */
export function assembleSidechatPreamble(
  context: string,
  input: string,
  instruction: string = SIDECHAT_BOUNDARY_INSTRUCTION,
): string {
  return `<sidechat_context>\n${context}\n</sidechat_context>\n\n${boundaryBlock(input, instruction)}`;
}

/** The three strings one fork kind's replay is worded with, plus which blocks
 *  replay as context. Edit forks replay all but the last block (everything
 *  before the edited message); hand-ins replay everything (the thread is the
 *  history); the rest replay fork-imported rows only (a side chat's own turns
 *  are its live conversation, and a handoff's import is already fork-import). */
type ForkFraming = {
  /** Header the replayed transcript opens with. */
  intro: string;
  /** What the receiving session is told to do with it. */
  instruction: string;
  /** Refusal for a first message that leaves no room for the transcript. */
  tooLong: string;
  /** Which blocks replay as context. */
  include: (block: StoredBlock, index: number, blocks: StoredBlock[]) => boolean;
};

/** Which blocks replay as context for an import: fork-imported rows only. A
 *  side chat's own turns are its live conversation, and a handoff's or
 *  branch's import is already fork-import — one predicate for all three. */
const includeImportOnly = (block: StoredBlock): boolean => block.source === "fork-import";

/** How a fork's one-shot replay is worded: the header the transcript opens
 *  with, the instruction that frames it, and the refusal for a first message
 *  that leaves no room for it. One lookup rather than a ternary per field, so
 *  a kind can never pick up one kind's intro and another's instruction.
 *
 *  The three continuation kinds differ in what the receiving session must
 *  not assume. A handoff's reader is a new owner and needs to know the work
 *  is now theirs; a branch's reader is continuing from a point that is not
 *  the end and must not invent the turns that followed; an edit fork's
 *  reader is answering a rewritten message. A side chat's reader is
 *  borrowing the transcript, not continuing it. */
function forkFraming(ctx: ForkContext): ForkFraming {
  if (isEditForkContext(ctx)) {
    return {
      intro: EDIT_FORK_INTRO,
      instruction: EDIT_FORK_BOUNDARY_INSTRUCTION,
      tooLong: EDIT_FORK_MESSAGE_TOO_LONG,
      include: (_block, index, blocks) => index < blocks.length - 1,
    };
  }
  if (isBranchForkContext(ctx)) {
    return {
      intro: BRANCH_INTRO,
      instruction: BRANCH_BOUNDARY_INSTRUCTION,
      tooLong: BRANCH_MESSAGE_TOO_LONG,
      include: includeImportOnly,
    };
  }
  if (isHandoffForkContext(ctx)) {
    return {
      intro: HANDOFF_INTRO,
      instruction: HANDOFF_BOUNDARY_INSTRUCTION,
      tooLong: HANDOFF_MESSAGE_TOO_LONG,
      include: includeImportOnly,
    };
  }
  return {
    intro: INTRO,
    instruction: SIDECHAT_BOUNDARY_INSTRUCTION,
    tooLong: SIDECHAT_MESSAGE_TOO_LONG,
    include: includeImportOnly,
  };
}

/** How a hand-in's one-shot replay is worded. Every block counts as history
 *  here — a hand-in keeps the thread, so its native turns are exactly what
 *  the new provider has not seen. Everything but the message being sent is
 *  replayed; the message itself arrives in `<latest_user_message>`. */
const handInFraming: ForkFraming = {
  intro: HAND_IN_INTRO,
  instruction: HAND_IN_BOUNDARY_INSTRUCTION,
  tooLong: HAND_IN_MESSAGE_TOO_LONG,
  include: () => true,
};

/** Assemble one replay: budget the transcript against the send-turn cap,
 *  frame it, and refuse a first message that leaves no room for it. Returns
 *  null when there is nothing worth replaying. Throws when the imported
 *  context plus the new message would exceed the cap — the turn is rejected
 *  up front rather than silently dropping context. */
function replayForTurn(
  thread: Pick<StoredThread, "blocks" | "title" | "branch">,
  input: string,
  framing: ForkFraming,
): string | null {
  const boundary = boundaryBlock(input, framing.instruction);
  const available = SIDECHAT_SEND_TURN_MAX_INPUT_CHARS - boundary.length - 64;
  if (available <= 0) throw new Error(framing.tooLong);
  const context = buildSidechatForkContext(thread, available, framing.intro, framing.include);
  if (!context) return null;
  const preamble = assembleSidechatPreamble(context, input, framing.instruction);
  if (preamble.length > SIDECHAT_SEND_TURN_MAX_INPUT_CHARS) {
    throw new Error(framing.tooLong);
  }
  return preamble;
}

/** The one-shot replay handed to a session born from a hand-in: the thread's
 *  own prior transcript, framed as the settled history of this same
 *  conversation, plus the user's message. Null when the thread has no
 *  pending hand-in, or has no history worth replaying. */
function handInBootstrapForTurn(threadId: string, input: string): string | null {
  const store = getConversationStore();
  if (!store.pendingHandIn(threadId)) return null;
  const thread = store.loadThread(threadId);
  if (!thread) return null;
  return replayForTurn(thread, input, handInFraming);
}

/**
 * The one-shot bootstrap preamble for a fork's first turn — the fully
 * assembled input text (imported context + boundary + the user's message
 * wrapped), or null when no bootstrap applies (not a fork, already
 * consumed, or nothing to import).
 *
 * An edit fork replays its copied prefix the same way a side chat replays
 * its import, but framed as continuation: the prefix is settled history the
 * turn builds on, and the boundary names the edited message as the thing to
 * answer. A handoff replays the full handed transcript framed the same way —
 * the new provider continues the same task as its new owner. Side chats keep
 * the reference-only framing.
 *
 * Throws when the imported context plus the new message would exceed the
 * send-turn cap — the turn is rejected up front rather than silently
 * dropping context.
 */
export function sidechatBootstrapForTurn(threadId: string, input: string): string | null {
  const store = getConversationStore();
  // A thread that has just changed hands replays first. Its bootstrap is not
  // a fork's — the thread is the same thread, so there is no import to find
  // and the native-turn gate below would refuse it outright (its history IS
  // native turns). The pending hand-in row is its own one-shot flag.
  const handIn = handInBootstrapForTurn(threadId, input);
  if (handIn) return handIn;
  const ctx = store.threadForkContext(threadId);
  if (!ctx || ctx.bootstrapStatus !== "pending") return null;
  // Belt and braces alongside bootstrapStatus: a native assistant block means
  if (store.hasNativeAssistantTurn(threadId)) return null;

  const thread = store.loadThread(threadId);
  if (!thread) return null;
  return replayForTurn(thread, input, forkFraming(ctx));
}

/** The blocks of a source thread that get imported into a side chat: every
 *  non-streaming native user + assistant message. Fork-imported blocks of a
 *  source that is itself a side chat are NOT re-imported — their history is
 *  already the source's own (a nested import would duplicate it). Assistant
 *  blocks are reduced to their narrative text, or — when a turn ran tools and
 *  wrote no prose — to a one-line note naming those tools, so the replay can
 *  still show the work happened (imported rows keep no items to re-derive it
 *  from); genuinely empty blocks are skipped. Tool items are not imported.
 *  Ids are re-minted (randomUUID), `at` timestamps and attachments are kept,
 *  and nothing from the renderer-only timeline leaks through. */
function buildImportedBlocks(source: StoredThread): ForkImportedBlock[] {
  const rows: ForkImportedBlock[] = [];
  for (const b of source.blocks) {
    if (b.source === "fork-import") continue;
    if (b.role === "user") {
      const imported: ForkImportedBlock = {
        id: randomUUID(),
        role: "user",
        text: blockText(b),
        at: b.at,
      };
      if (b.attachments?.length) imported.attachments = b.attachments;
      copyTurnStamp(b, imported);
      rows.push(imported);
      continue;
    }
    const text = transferText(b);
    if (!text) continue;
    rows.push({ id: randomUUID(), role: "assistant", text, at: b.at });
  }
  return rows;
}

/** The id of the source's last native block at import time — provenance for
 *  the fork point; the import itself is never truncated. */
function forkPointOf(source: StoredThread): string | null {
  for (let i = source.blocks.length - 1; i >= 0; i -= 1) {
    const block = source.blocks[i];
    if (block && block.source !== "fork-import") return block.id;
  }
  return null;
}

/** The child's resolved provider and model — an explicit target wins,
 *  otherwise the source thread's provider (model kept only while staying on
 *  that provider, since a foreign model id means nothing to another CLI). */
type ResolvedSideChatTarget = {
  provider: CreateSideChatResult["provider"];
  model?: string;
};

/** Resolve the child's provider/model: explicit target wins; otherwise the
 *  source thread's provider (and its model only while staying on that
 *  provider — a foreign model id means nothing to another CLI). */
function resolveTarget(
  input: CreateSideChatInput,
  source: StoredThread,
): ResolvedSideChatTarget {
  const provider = input.target?.provider ?? source.provider;
  const model = input.target?.model ?? (provider === source.provider ? source.model : undefined);
  return { provider, model };
}

/** The default side-chat title: the prompt-derived word-cap when a prompt was
 *  given, else the source thread's title (no prefix — the icon carries the
 *  "side chat" signal, never the title). */
function defaultTitle(input: CreateSideChatInput, source: StoredThread): string {
  return input.prompt?.trim()
    ? buildPromptThreadTitleFallback(input.prompt)
    : source.title?.trim() || "Conversation";
}

/**
 * Create a side chat: a root thread carrying the source's imported transcript
 * as reference-only context. The renderer mints `threadId` and `requestId`
 * (kone owns thread ids); this resolves to `status: "created"`, or
 * `"exists"` when the same threadId was already created (requireThreadAbsent
 * idempotency — the exact-once seam the agent/MCP path rides too). Throws on
 * validation failures: unknown source thread, or the same requestId bound to
 * a different thread (idempotency conflict).
 *
 * Does not start a session or dispatch a turn — the renderer runs the normal
 * start-session → send-turn flow afterwards, and the bootstrap rides the
 * first send. The `thread.sidechat-created` event is emitted by the IPC
 * layer.
 */
export function createSidechatThread(input: CreateSideChatInput): CreateSideChatResult {
  const store = getConversationStore();

  if (!input.sourceThreadId || !input.threadId || !input.requestId) {
    throw new Error("create-side-chat requires requestId, threadId and sourceThreadId");
  }

  // Natural idempotency on the minted thread id: a replay of the same
  // creation resolves as "exists" without touching anything.
  if (store.threadExists(input.threadId)) {
    return {
      requestId: input.requestId,
      threadId: input.threadId,
      sourceThreadId: input.sourceThreadId,
      provider: store.threadMeta(input.threadId)?.provider ?? "opencode",
      status: "exists",
    };
  }

  // SpawnRequest-style exactly-once: one requestId is bound to exactly one
  // thread. Replayed with the same threadId → the branch above; replayed with
  // a different threadId → this is a genuine conflict, not a retry.
  const bound = store.threadIdForRequestId(input.requestId);
  if (bound) {
    throw new Error(
      `Idempotency conflict: requestId "${input.requestId}" is already bound to thread "${bound}"`,
    );
  }

  const source = store.loadThread(input.sourceThreadId);
  if (!source) {
    throw new Error(`Side chat source thread not found: ${input.sourceThreadId}`);
  }
  // No nesting: a side chat cannot be forked from another side chat. The UI
  // hides the creator on side chats too, but the server enforces it — a
  // nested fork would import a transcript that is itself reference context.
  if (source.forkContext) {
    throw new Error("A side chat cannot be forked from another side chat");
  }

  // One side chat per source thread: a second fork request joins the existing
  // one (its pane reopens) instead of minting a duplicate. Enforced here so it
  // holds across app restarts and from any client, not just the button's
  // in-flight dedup.
  const existing = store.sidechatForSource(input.sourceThreadId);
  if (existing) {
    return {
      requestId: input.requestId,
      threadId: existing.threadId,
      sourceThreadId: input.sourceThreadId,
      provider: existing.provider,
      status: "exists",
    };
  }

  const { provider, model } = resolveTarget(input, source);
  const createdAt = Date.now();
  const forkContext: ForkContext = {
    sourceThreadId: input.sourceThreadId,
    forkPointBlockId: forkPointOf(source),
    importedAt: createdAt,
    bootstrapStatus: "pending",
  };
  const lineage: ThreadLineage = {
    parentThreadId: null,
    relationshipToParent: "side_chat",
    rootThreadId: input.threadId,
  };

  const forkInput: Parameters<typeof store.writeForkThread>[0] = {
    threadId: input.threadId,
    projectPath: source.projectPath,
    provider,
    createdAt,
    title: input.title ?? defaultTitle(input, source),
    sourceThreadId: input.sourceThreadId,
    forkContext,
    lineage,
    requestId: input.requestId,
    importedBlocks: buildImportedBlocks(source),
  };
  if (model) forkInput.model = model;
  const written = store.writeForkThread(forkInput);
  if (!written) {
    // A concurrent duplicate (the threadExists check raced) reads as a replay;
    // a concurrent first fork (the sidechatForSource check raced) joins it;
    // anything else is a persistence failure.
    if (store.threadExists(input.threadId)) {
      return {
        requestId: input.requestId,
        threadId: input.threadId,
        sourceThreadId: input.sourceThreadId,
        provider: store.threadMeta(input.threadId)?.provider ?? provider,
        status: "exists",
      };
    }
    const joined = store.sidechatForSource(input.sourceThreadId);
    if (joined) {
      return {
        requestId: input.requestId,
        threadId: joined.threadId,
        sourceThreadId: input.sourceThreadId,
        provider: joined.provider,
        status: "exists",
      };
    }
    throw new Error(`Could not persist side chat thread: ${input.threadId}`);
  }

  // A side chat carries whoever worked the source thread — a named agent or
  // guest binding alike follows the fork, write-once.
  const carried = store.carryThreadAgent(input.sourceThreadId, input.threadId);
  if (!carried) {
    store.bindThreadAgent(input.threadId, null);
  }

  return {
    requestId: input.requestId,
    threadId: input.threadId,
    sourceThreadId: input.sourceThreadId,
    provider,
    model,
    status: "created",
  };
}

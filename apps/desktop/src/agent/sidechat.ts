import { randomUUID } from "node:crypto";

import { getConversationStore } from "./ConversationStore.js";
import { buildPromptThreadTitleFallback } from "./threadTitle.js";
import type {
  ChatAttachment,
  CreateSideChatInput,
  CreateSideChatResult,
  ForkContext,
  StoredBlock,
  StoredThread,
  ThreadLineage,
} from "./types.js";

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

/** The message a too-long first side-chat turn is rejected with, up front,
 *  than silently dropping context). */
export const SIDECHAT_MESSAGE_TOO_LONG =
  "This message is too long to include the side chat's imported context. Shorten the message and retry.";

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

/** Render one imported message verbatim (capped) — the label plus the text. */
function renderVerbatim(block: StoredBlock): string {
  const text = truncate(blockText(block), RECENT_MESSAGE_CHAR_LIMIT);
  return block.role === "user" ? `User:\n${text}` : `Assistant:\n${text}`;
}

/** Render one imported message as a one-line summary for the earlier section. */
function renderSummary(block: StoredBlock): string {
  const text = truncate(blockText(block), EARLIER_MESSAGE_CHAR_LIMIT);
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
): string | null {
  const imported = thread.blocks.filter((b) => b.source === "fork-import");
  if (imported.length === 0) return null;
  const budget = Math.min(Math.max(0, maxChars), SIDECHAT_TRANSCRIPT_CHAR_BUDGET);

  const recent = imported.slice(-RECENT_MESSAGE_COUNT);
  const earlier = imported.slice(0, Math.max(0, imported.length - RECENT_MESSAGE_COUNT));

  const parts: string[] = [INTRO];
  if (thread.title) parts.push(`Original conversation title: ${thread.title}`);
  if (thread.branch) parts.push(`Git branch: ${thread.branch}`);

  // Earlier messages: newest-first one-line summaries, oldest dropped if the
  // budget runs out (the transcript must shrink, never blow the cap).
  const summaryLines: string[] = [];
  let used = 0;
  for (let i = earlier.length - 1; i >= 0; i -= 1) {
    const block = earlier[i];
    if (!block) continue;
    const line = renderSummary(block);
    if (line.length === 0) continue;
    if (used + line.length > budget) break;
    summaryLines.unshift(line);
    used += line.length + 1;
  }
  if (summaryLines.length > 0) {
    const omitted = earlier.length - summaryLines.length;
    parts.push(
      `Earlier conversation summary (${omitted} older message${omitted === 1 ? "" : "s"} omitted to fit the context budget):`,
    );
    parts.push(...summaryLines);
  }

  parts.push("Most recent imported messages:");
  for (const block of recent) {
    const rendered = renderVerbatim(block);
    if (rendered.length === 0) continue;
    if (used + rendered.length > budget) break;
    parts.push(rendered);
    used += rendered.length + 1;
  }

  return truncate(parts.join("\n"), budget);
}

/** The `<latest_user_message>`-wrapped boundary block that rides every side
 *  chat's first turn, after the imported-context block. */
function boundaryBlock(input: string): string {
  return `<sidechat_boundary>\n${SIDECHAT_BOUNDARY_INSTRUCTION}\n</sidechat_boundary>\n<latest_user_message>\n${input}\n</latest_user_message>`;
}

/** Assemble the full first-turn prompt: imported context in
 *  `<sidechat_context>…</sidechat_context>`, then the boundary block with the
 *  user's message wrapped in `<latest_user_message>`. */
export function assembleSidechatPreamble(context: string, input: string): string {
  return `<sidechat_context>\n${context}\n</sidechat_context>\n\n${boundaryBlock(input)}`;
}

/**
 * The one-shot bootstrap preamble for a side chat's first turn — the fully
 * assembled input text (imported context + boundary + the user's message
 * wrapped), or null when no bootstrap applies (not a side chat, already
 * consumed, or nothing to import).
 *
 * Throws {@link SIDECHAT_MESSAGE_TOO_LONG} when the imported context plus the
 * new message would exceed the send-turn cap — the turn is rejected up front
 * rather than silently dropping context.
 */
export function sidechatBootstrapForTurn(threadId: string, input: string): string | null {
  const store = getConversationStore();
  const ctx = store.threadForkContext(threadId);
  if (!ctx || ctx.bootstrapStatus !== "pending") return null;
  // Belt and braces alongside bootstrapStatus: a native assistant block means
  if (store.hasNativeAssistantTurn(threadId)) return null;

  const thread = store.loadThread(threadId);
  if (!thread) return null;
  const boundary = boundaryBlock(input);
  const available = SIDECHAT_SEND_TURN_MAX_INPUT_CHARS - boundary.length - 64;
  if (available <= 0) {
    throw new Error(SIDECHAT_MESSAGE_TOO_LONG);
  }
  const context = buildSidechatForkContext(thread, available);
  if (!context) return null;
  // Double-check the assembled prompt fits the cap: the context block itself
  // is budgeted, but the wrapper adds a little on top.
  const preamble = assembleSidechatPreamble(context, input);
  if (preamble.length > SIDECHAT_SEND_TURN_MAX_INPUT_CHARS) {
    throw new Error(SIDECHAT_MESSAGE_TOO_LONG);
  }
  return preamble;
}

/** The blocks of a source thread that get imported into a side chat: every
 *  non-streaming native user + assistant message. Fork-imported blocks of a
 *  source that is itself a side chat are NOT re-imported — their history is
 *  already the source's own (a nested import would duplicate it). Assistant
 *  blocks are reduced to their narrative text; tool items are not imported.
 *  Ids are re-minted (randomUUID), `at` timestamps and attachments are kept,
 *  and nothing from the renderer-only timeline leaks through. */
function buildImportedBlocks(
  source: StoredThread,
): Array<{
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  attachments?: ChatAttachment[];
}> {
  return source.blocks
    .filter((b) => b.source !== "fork-import")
    .map((b) => ({
      id: randomUUID(),
      role: b.role,
      text: blockText(b),
      at: b.at,
      ...(b.role === "user" && b.attachments?.length
        ? { attachments: b.attachments }
        : {}),
    }));
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

/** Resolve the child's provider/model: explicit target wins; otherwise the
 *  source thread's provider (and its model only while staying on that
 *  provider — a foreign model id means nothing to another CLI). */
function resolveTarget(
  input: CreateSideChatInput,
  source: StoredThread,
): { provider: CreateSideChatResult["provider"]; model?: string } {
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
    forkPointMessageId: forkPointOf(source),
    importedAt: createdAt,
    bootstrapStatus: "pending",
  };
  const lineage: ThreadLineage = {
    parentThreadId: null,
    relationshipToParent: "side_chat",
    rootThreadId: input.threadId,
  };

  const written = store.writeForkThread({
    threadId: input.threadId,
    projectPath: source.projectPath,
    provider,
    ...(model ? { model } : {}),
    createdAt,
    title: input.title ?? defaultTitle(input, source),
    sourceThreadId: input.sourceThreadId,
    forkContext,
    lineage,
    requestId: input.requestId,
    importedBlocks: buildImportedBlocks(source),
  });
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

  return {
    requestId: input.requestId,
    threadId: input.threadId,
    sourceThreadId: input.sourceThreadId,
    provider,
    model,
    status: "created",
  };
}

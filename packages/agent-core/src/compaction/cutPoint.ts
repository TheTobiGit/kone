import type { StoredBlock } from "../types.js";
import type { ContextUsageEstimate, CutPointResult } from "./types.js";

const CHARS_PER_TOKEN = 4;

function userBlockCharacters(block: Extract<StoredBlock, { role: "user" }>): number {
  let chars = block.text.length;
  if (block.attachments) {
    for (const att of block.attachments) {
      chars += att.name.length + att.mimeType.length + att.sizeBytes;
    }
  }
  return chars;
}

function assistantBlockCharacters(
  block: Extract<StoredBlock, { role: "assistant" }>,
): number {
  let chars = 0;
  for (const item of block.items) {
    chars += item.text.length;
    if (item.detail) {
      chars += item.detail.length;
    }
  }
  return chars;
}

/**
 * Estimate token count for a single stored block (user or assistant).
 */
export function estimateBlockTokens(block: StoredBlock): number {
  const chars =
    block.role === "user"
      ? userBlockCharacters(block)
      : assistantBlockCharacters(block);
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

/**
 * Estimate total context tokens and item metrics across an array of blocks.
 */
export function estimateContextTokens(blocks: StoredBlock[]): ContextUsageEstimate {
  let tokens = 0;
  let characters = 0;
  let toolItemCount = 0;

  for (const block of blocks) {
    if (block.role === "user") {
      characters += userBlockCharacters(block);
    } else {
      characters += assistantBlockCharacters(block);
      for (const item of block.items) {
        if (item.kind === "tool_call") {
          toolItemCount += 1;
        }
      }
    }
    tokens += estimateBlockTokens(block);
  }

  return { tokens, characters, toolItemCount };
}

/**
 * Find the optimal cut point in the conversation history that preserves approximately
 * `keepRecentTokens` while snapping strictly to user-turn boundaries.
 *
 * @param blocks - The full sequence of conversation blocks
 * @param keepRecentTokens - Target token budget to preserve in the active recent window
 * @returns CutPointResult indicating the cut index and token splits
 */
export function findCutPoint(blocks: StoredBlock[], keepRecentTokens: number): CutPointResult {
  if (blocks.length <= 2) {
    const totalTokens = blocks.reduce((acc, block) => acc + estimateBlockTokens(block), 0);
    return {
      cutIndex: 0,
      preservedTokens: totalTokens,
      compactedTokens: 0,
    };
  }

  let accumulatedRecentTokens = 0;
  let cutIndex = blocks.length;

  // Walk backwards from the end of conversation
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block === undefined) {
      continue;
    }

    accumulatedRecentTokens += estimateBlockTokens(block);

    // Once we have accumulated enough recent tokens and hit a user turn boundary,
    // this marks a candidate cut point.
    if (accumulatedRecentTokens >= keepRecentTokens && block.role === "user") {
      cutIndex = i;
      break;
    }
  }

  // If no user-turn boundary exceeded the keep budget, preserve the whole
  // transcript rather than compacting an empty prefix.
  if (cutIndex >= blocks.length) {
    cutIndex = 0;
  }

  const preservedTokens = blocks
    .slice(cutIndex)
    .reduce((acc, block) => acc + estimateBlockTokens(block), 0);
  const compactedTokens = blocks
    .slice(0, cutIndex)
    .reduce((acc, block) => acc + estimateBlockTokens(block), 0);

  return {
    cutIndex,
    preservedTokens,
    compactedTokens,
  };
}

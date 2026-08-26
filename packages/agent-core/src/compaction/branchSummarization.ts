import type { StoredBlock } from "../types.js";
import type { ExtractedBlockOperations, SemanticBranchSummary } from "./types.js";

const MAX_SUMMARY_ITEMS = 12;

function firstLine(text: string, maxChars: number): string {
  const newlineIndex = text.indexOf("\n");
  const line = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
  return line.slice(0, maxChars);
}

/**
 * Extract files touched, commands executed, and core decisions from a block sequence.
 */
export function extractBlockOperations(blocks: StoredBlock[]): ExtractedBlockOperations {
  const filesReadSet = new Set<string>();
  const filesModifiedSet = new Set<string>();
  const commandsRunSet = new Set<string>();
  const keyPoints: string[] = [];

  for (const block of blocks) {
    if (block.role === "user") {
      const trimmed = block.text.trim();
      if (trimmed.length > 0) {
        keyPoints.push(`User request: ${firstLine(trimmed, 160)}`);
      }
      continue;
    }

    for (const item of block.items) {
      if (item.kind === "tool_call" && item.name) {
        const toolLower = item.name.toLowerCase();
        const target = item.text.trim();

        if (toolLower.includes("read") || toolLower === "view" || toolLower === "cat") {
          if (target.length > 0) filesReadSet.add(target);
        } else if (
          toolLower.includes("edit") ||
          toolLower.includes("write") ||
          toolLower.includes("patch") ||
          toolLower.includes("create")
        ) {
          if (target.length > 0) filesModifiedSet.add(target);
        } else if (
          toolLower === "bash" ||
          toolLower === "powershell" ||
          toolLower === "exec" ||
          toolLower === "terminal"
        ) {
          if (target.length > 0) commandsRunSet.add(target);
        }
      } else if (item.kind === "assistant_text" && item.text.trim().length > 0) {
        // Collect high-level conclusions (first sentence or bullet points)
        const lines = item.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
        for (const line of lines.slice(0, 2)) {
          if (line.startsWith("-") || line.startsWith("*") || line.length < 140) {
            keyPoints.push(line.replace(/^[-*]\s*/, ""));
          }
        }
      }
    }
  }

  return {
    filesRead: Array.from(filesReadSet).slice(0, MAX_SUMMARY_ITEMS),
    filesModified: Array.from(filesModifiedSet).slice(0, MAX_SUMMARY_ITEMS),
    commandsRun: Array.from(commandsRunSet).slice(0, MAX_SUMMARY_ITEMS),
    keyPoints: keyPoints.slice(0, MAX_SUMMARY_ITEMS),
  };
}

/**
 * Construct a structured semantic markdown summary for a sequence of conversation blocks.
 */
export function buildSemanticBranchSummary(
  blocks: StoredBlock[],
  options?: {
    title?: string;
    branch?: string;
    maxSummaryChars?: number;
  },
): SemanticBranchSummary {
  const operations = extractBlockOperations(blocks);
  const maxChars = options?.maxSummaryChars ?? 16_000;

  const sections: string[] = [];

  sections.push("## Previous Conversation Context Summary");

  if (options?.title) {
    sections.push(`**Original Thread Title:** ${options.title}`);
  }
  if (options?.branch) {
    sections.push(`**Git Branch:** ${options.branch}`);
  }

  if (operations.keyPoints.length > 0) {
    sections.push("### Key Objectives & Findings");
    for (const point of operations.keyPoints) {
      sections.push(`- ${point}`);
    }
  }

  if (operations.filesModified.length > 0) {
    sections.push("### Files Modified / Created");
    for (const file of operations.filesModified) {
      sections.push(`- \`${file}\``);
    }
  }

  if (operations.filesRead.length > 0) {
    sections.push("### Files Read / Inspected");
    for (const file of operations.filesRead) {
      sections.push(`- \`${file}\``);
    }
  }

  if (operations.commandsRun.length > 0) {
    sections.push("### Commands Executed");
    for (const cmd of operations.commandsRun) {
      sections.push(`- \`${cmd}\``);
    }
  }

  let formattedSummary = sections.join("\n\n");
  if (formattedSummary.length > maxChars) {
    const keep = Math.max(0, maxChars - 3);
    formattedSummary = `${formattedSummary.slice(0, keep).trimEnd()}...`;
  }

  const estimatedTokens = Math.max(1, Math.ceil(formattedSummary.length / 4));

  return {
    summary: formattedSummary,
    operations,
    estimatedTokens,
  };
}

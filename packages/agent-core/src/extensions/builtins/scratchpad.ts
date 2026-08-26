/**
 * Built-in Scratchpad Extension for Kone.
 *
 * Provides persistent working memory across turns within an extension's storage
 * lifecycle, allowing agents to store notes, drafts, and plans without polluting
 * the conversation transcript.
 */

import type {
  CustomToolDefinition,
  ExtensionAPI,
  ExtensionContext,
  ExtensionModule,
} from "../types.js";

export const SCRATCHPAD_EXTENSION_NAME = "scratchpad";

export interface ScratchpadWriteResult {
  success: boolean;
  key: string;
  bytesWritten: number;
  append: boolean;
  message: string;
}

export interface ScratchpadReadResult {
  found: boolean;
  key?: string;
  content?: string | null;
  count?: number;
  entries?: Record<string, unknown>;
  message?: string;
}

export interface ScratchpadClearResult {
  success: boolean;
  key?: string;
  deleted?: boolean;
  clearedAll?: boolean;
  message: string;
}

/**
 * Scratchpad Write Tool: Stores or appends text under a specific key.
 */
export const scratchpadWriteTool: CustomToolDefinition = {
  name: "scratchpad_write",
  description:
    "Write or append working notes to persistent extension storage across turns without polluting the conversation transcript.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "The key or topic for the scratchpad entry. Defaults to 'default' if omitted.",
      },
      content: {
        type: "string",
        description: "The text content or notes to write into the scratchpad.",
      },
      append: {
        type: "boolean",
        description:
          "If true, appends content to the existing entry separated by a newline instead of overwriting.",
      },
    },
    required: ["content"],
  },
  execute: (
    args: Record<string, unknown>,
    context: ExtensionContext,
  ): ScratchpadWriteResult => {
    if (typeof args.content !== "string") {
      throw new Error("scratchpad_write requires a 'content' string parameter");
    }

    const content = args.content;
    const key =
      typeof args.key === "string" && args.key.trim().length > 0
        ? args.key.trim()
        : "default";
    const append = Boolean(args.append);

    let finalContent = content;
    if (append && context.storage.has(key)) {
      const existing = context.storage.get<string>(key);
      if (typeof existing === "string" && existing.length > 0) {
        finalContent = `${existing}\n${content}`;
      }
    }

    context.storage.set(key, finalContent);

    return {
      success: true,
      key,
      bytesWritten: finalContent.length,
      append,
      message: `Scratchpad note for key '${key}' ${append ? "appended" : "saved"} successfully.`,
    };
  },
};

/**
 * Scratchpad Read Tool: Reads notes under a key or returns all entries.
 */
export const scratchpadReadTool: CustomToolDefinition = {
  name: "scratchpad_read",
  description:
    "Read working notes from persistent extension storage by key, or retrieve all scratchpad entries.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "The key of the scratchpad entry to read. If omitted or 'all', all stored scratchpad entries are returned.",
      },
    },
  },
  execute: (
    args: Record<string, unknown>,
    context: ExtensionContext,
  ): ScratchpadReadResult => {
    const rawKey = typeof args.key === "string" ? args.key.trim() : undefined;

    if (rawKey && rawKey !== "all") {
      const content = context.storage.get<string>(rawKey);
      if (content === undefined) {
        return {
          found: false,
          key: rawKey,
          content: null,
          message: `No scratchpad note found for key '${rawKey}'.`,
        };
      }

      return {
        found: true,
        key: rawKey,
        content,
      };
    }

    const allEntries = context.storage.entries();
    const entriesRecord: Record<string, unknown> = {};
    for (const [k, v] of allEntries) {
      entriesRecord[k] = v;
    }

    return {
      found: allEntries.length > 0,
      count: allEntries.length,
      entries: entriesRecord,
    };
  },
};

/**
 * Scratchpad Clear Tool: Deletes notes under a key or clears all notes.
 */
export const scratchpadClearTool: CustomToolDefinition = {
  name: "scratchpad_clear",
  description:
    "Clear a specific scratchpad entry by key, or clear all entries in the scratchpad.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "The specific key to clear. If omitted or 'all', all scratchpad entries are cleared.",
      },
    },
  },
  execute: (
    args: Record<string, unknown>,
    context: ExtensionContext,
  ): ScratchpadClearResult => {
    const rawKey = typeof args.key === "string" ? args.key.trim() : undefined;

    if (rawKey && rawKey !== "all") {
      const existed = context.storage.has(rawKey);
      const deleted = context.storage.delete(rawKey);
      return {
        success: true,
        key: rawKey,
        deleted: existed && deleted,
        message: existed
          ? `Scratchpad note for key '${rawKey}' cleared.`
          : `Scratchpad note for key '${rawKey}' did not exist.`,
      };
    }

    context.storage.clear();
    return {
      success: true,
      clearedAll: true,
      message: "All scratchpad notes cleared.",
    };
  },
};

/**
 * Creates a scratchpad extension instance.
 */
export function createScratchpadExtension(): ExtensionModule {
  return {
    name: SCRATCHPAD_EXTENSION_NAME,
    version: "1.0.0",
    activate(api: ExtensionAPI): void {
      api.registerTool(scratchpadWriteTool);
      api.registerTool(scratchpadReadTool);
      api.registerTool(scratchpadClearTool);
    },
  };
}

export const scratchpadExtension: ExtensionModule = createScratchpadExtension();

export default scratchpadExtension;

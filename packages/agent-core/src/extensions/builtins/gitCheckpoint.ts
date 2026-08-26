/**
 * Git Checkpoint Built-in Extension for Agent-Core.
 * Automatically hooks into `turn_start` to take a lightweight, non-destructive
 * git checkpoint before the turn executes and potentially mutates the workspace.
 *
 * Uses `@kone/git-core` checkpoint helpers if operating inside a git repository.
 */
import process from "node:process";

import {
  createCheckpoint,
  listCheckpoints,
  repoRoot,
  restoreCheckpoint,
  type CreateCheckpointOptions,
  type GitCheckpoint,
} from "@kone/git-core";
import type {
  CustomToolDefinition,
  ExtensionAPI,
  ExtensionContext,
  ExtensionModule,
  TurnStartEvent,
} from "../types.js";

export interface GitCheckpointOptions {
  /**
   * Whether to include untracked files in the turn checkpoint snapshot.
   * Defaults to true.
   */
  includeUntracked?: boolean;
  /**
   * If true, errors during checkpoint creation will throw and fail the turn start event.
   * If false (default), errors are logged as warnings and the turn continues.
   */
  strict?: boolean;
  /**
   * Whether to automatically register helper custom tools (`git_list_checkpoints`, `git_restore_checkpoint`).
   * Defaults to true.
   */
  registerTools?: boolean;
}

/**
 * Resolves the target working directory for the repository root check.
 * Checks context.projectPath, payload.metadata.cwd, context.metadata.cwd, and falls back to process.cwd().
 */
export function resolveTargetDirectory(
  payload: TurnStartEvent,
  context: ExtensionContext,
): string {
  if (
    typeof context.projectPath === "string" &&
    context.projectPath.trim() !== ""
  ) {
    return context.projectPath;
  }

  const payloadMetadata = payload.metadata;
  if (
    payloadMetadata &&
    typeof payloadMetadata === "object" &&
    typeof payloadMetadata.cwd === "string" &&
    payloadMetadata.cwd.trim() !== ""
  ) {
    return payloadMetadata.cwd;
  }

  const contextMetadata = context.metadata;
  if (
    contextMetadata &&
    typeof contextMetadata === "object" &&
    typeof contextMetadata.cwd === "string" &&
    contextMetadata.cwd.trim() !== ""
  ) {
    return contextMetadata.cwd;
  }

  return process.cwd();
}

/**
 * Handles the `turn_start` lifecycle event by creating a git checkpoint if in a git repo.
 */
export async function handleTurnStartCheckpoint(
  payload: TurnStartEvent,
  context: ExtensionContext,
  api: ExtensionAPI,
  options?: GitCheckpointOptions,
): Promise<GitCheckpoint | null> {
  const targetDir = resolveTargetDirectory(payload, context);
  const root = await repoRoot(targetDir);

  if (!root) {
    api.logger.debug(
      `Directory "${targetDir}" is not inside a git repository. Skipping git checkpoint.`,
    );
    return null;
  }

  try {
    const promptSummary = payload.prompt
      ? payload.prompt.trim().replace(/\s+/g, " ").slice(0, 80)
      : "";
    const message = promptSummary
      ? `Auto checkpoint before turn ${payload.turnId}: ${promptSummary}`
      : `Auto checkpoint before turn ${payload.turnId}`;

    const checkpointOpts: CreateCheckpointOptions = {
      threadId: payload.threadId,
      turnId: payload.turnId,
      message,
      includeUntracked: options?.includeUntracked ?? true,
    };

    const checkpoint = await createCheckpoint(root, checkpointOpts);

    context.storage.set("latestCheckpoint", checkpoint);
    context.storage.set(`checkpoint:${payload.turnId}`, checkpoint);

    const existingCheckpoints = context.storage.get<GitCheckpoint[]>("checkpoints");
    const history = Array.isArray(existingCheckpoints)
      ? [...existingCheckpoints, checkpoint]
      : [checkpoint];
    context.storage.set("checkpoints", history);

    api.logger.info(
      `Created git checkpoint "${checkpoint.id}" (commit ${checkpoint.commitHash.slice(0, 7)}) for turn "${payload.turnId}"`,
    );

    return checkpoint;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    api.logger.warn(
      `Failed to create git checkpoint for turn "${payload.turnId}": ${errorMessage}`,
    );

    if (options?.strict) {
      throw err;
    }
    return null;
  }
}

/**
 * Custom tool definition for listing recorded checkpoints.
 */
export const listCheckpointsTool: CustomToolDefinition = {
  name: "git_list_checkpoints",
  description: "Lists git checkpoints recorded for the current workspace or thread.",
  parameters: {
    type: "object",
    properties: {
      threadId: {
        type: "string",
        description: "Optional thread ID to filter checkpoints by.",
      },
    },
  },
  execute: async (
    args: Record<string, unknown>,
    context: ExtensionContext,
  ): Promise<{ checkpoints: GitCheckpoint[]; count: number; message?: string }> => {
    const targetDir =
      typeof context.projectPath === "string" && context.projectPath.trim() !== ""
        ? context.projectPath
        : typeof context.metadata?.cwd === "string" && context.metadata.cwd.trim() !== ""
          ? context.metadata.cwd
          : process.cwd();

    const root = await repoRoot(targetDir);
    if (!root) {
      return {
        checkpoints: [],
        count: 0,
        message: `Directory "${targetDir}" is not a git repository.`,
      };
    }

    const filterThreadId =
      typeof args.threadId === "string" && args.threadId.trim() !== ""
        ? args.threadId.trim()
        : context.threadId;

    const checkpoints = await listCheckpoints(
      root,
      filterThreadId ? { threadId: filterThreadId } : undefined,
    );

    return {
      checkpoints,
      count: checkpoints.length,
    };
  },
};

/**
 * Custom tool definition for restoring workspace state to a previous checkpoint.
 */
export const restoreCheckpointTool: CustomToolDefinition = {
  name: "git_restore_checkpoint",
  description:
    "Restores the repository working tree and index to a previously recorded checkpoint snapshot.",
  parameters: {
    type: "object",
    properties: {
      checkpointId: {
        type: "string",
        description: "The unique ID of the checkpoint to restore.",
      },
      hard: {
        type: "boolean",
        description:
          "If true, untracked files are removed to match the snapshot state exactly.",
      },
    },
    required: ["checkpointId"],
  },
  execute: async (
    args: Record<string, unknown>,
    context: ExtensionContext,
  ): Promise<{ success: boolean; checkpointId: string; message: string }> => {
    const checkpointId =
      typeof args.checkpointId === "string" ? args.checkpointId.trim() : "";
    if (!checkpointId) {
      throw new Error('Required parameter "checkpointId" was not provided.');
    }

    const hard = args.hard === true;
    const targetDir =
      typeof context.projectPath === "string" && context.projectPath.trim() !== ""
        ? context.projectPath
        : typeof context.metadata?.cwd === "string" && context.metadata.cwd.trim() !== ""
          ? context.metadata.cwd
          : process.cwd();

    const root = await repoRoot(targetDir);
    if (!root) {
      throw new Error(`Directory "${targetDir}" is not inside a git repository.`);
    }

    const success = await restoreCheckpoint(root, checkpointId, { hard });

    return {
      success,
      checkpointId,
      message: success
        ? `Successfully restored workspace to checkpoint "${checkpointId}".`
        : `Failed to restore workspace to checkpoint "${checkpointId}".`,
    };
  },
};

/**
 * Factory to create a Git Checkpoint extension module with custom options.
 */
export function createGitCheckpointExtension(
  options?: GitCheckpointOptions,
): ExtensionModule {
  return {
    name: "gitCheckpoint",
    version: "1.0.0",
    activate: (api: ExtensionAPI) => {
      // Register turn_start hook
      api.on("turn_start", async (payload, context) => {
        await handleTurnStartCheckpoint(payload, context, api, options);
      });

      // Register helper custom tools unless disabled
      if (options?.registerTools !== false) {
        api.registerTool(listCheckpointsTool);
        api.registerTool(restoreCheckpointTool);
      }
    },
  };
}

/**
 * Standard default Git Checkpoint extension instance.
 */
export const gitCheckpointExtension: ExtensionModule =
  createGitCheckpointExtension();

export const gitCheckpoint = gitCheckpointExtension;

export default gitCheckpointExtension;

/**
 * Built-in Extensions for Kone Agent Core.
 * Out-of-the-box extensions providing safety gating, git checkpointing,
 * scratchpad working memory, and subagent dispatching.
 */

import type { DispatchContextOptions, ExtensionRegistry } from "../ExtensionRegistry.js";
import { gitCheckpointExtension } from "./gitCheckpoint.js";
import { safetyGateExtension } from "./safetyGate.js";
import { scratchpadExtension } from "./scratchpad.js";
import { subagentDispatcherExtension } from "./subagentDispatcher.js";

export * from "./gitCheckpoint.js";
export * from "./safetyGate.js";
export * from "./scratchpad.js";
export * from "./subagentDispatcher.js";

/**
 * Registers all default built-in extensions into the given ExtensionRegistry.
 *
 * Default extensions registered:
 * - gitCheckpoint: Automatic git branch/tag checkpointing per turn and restore tools
 * - safetyGate: Command safety scanner and execution barrier
 * - scratchpad: Isolated multi-turn working memory notes
 * - subagentDispatcher: Tool for delegating tasks to subagent workers
 *
 * @param registry The target ExtensionRegistry instance.
 * @param options Optional dispatch and context options.
 * @returns The populated ExtensionRegistry instance.
 */
export async function registerDefaultExtensions(
  registry: ExtensionRegistry,
  options?: DispatchContextOptions,
): Promise<ExtensionRegistry> {
  await registry.registerExtension("gitCheckpoint", gitCheckpointExtension, options);
  await registry.registerExtension("safetyGate", safetyGateExtension, options);
  await registry.registerExtension("scratchpad", scratchpadExtension, options);
  await registry.registerExtension("subagentDispatcher", subagentDispatcherExtension, options);
  return registry;
}

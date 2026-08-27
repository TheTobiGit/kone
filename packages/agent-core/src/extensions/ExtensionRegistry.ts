/**
 * Dynamic Extension Registry for agent-core.
 * Manages custom tool registration, event lifecycle dispatch,
 * and hot unregistering/reloading of extensions.
 */

import type {
  CustomToolDefinition,
  DispatchResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionDefinition,
  ExtensionEventHandler,
  ExtensionEventMap,
  ExtensionEventName,
  ExtensionLogger,
  ExtensionStorage,
} from "./types.js";
import { ExtensionVetoError } from "./veto.js";

export class InMemoryExtensionStorage implements ExtensionStorage {
  private readonly store = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    // SAFETY: Generic storage map retrieves value cast to requested return type T
    return this.store.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.store.set(key, value);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
  }

  entries(): Array<[string, unknown]> {
    return Array.from(this.store.entries());
  }
}

export class ScopedExtensionLogger implements ExtensionLogger {
  constructor(private readonly extensionId: string) {}

  debug(message: string, ...args: unknown[]): void {
    console.debug(`[extension:${this.extensionId}] ${message}`, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    console.info(`[extension:${this.extensionId}] ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`[extension:${this.extensionId}] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`[extension:${this.extensionId}] ${message}`, ...args);
  }
}

interface EventSubscription<E extends ExtensionEventName = ExtensionEventName> {
  id: string;
  extensionId?: string;
  event: E;
  handler: ExtensionEventHandler<E>;
}

interface RegisteredExtensionEntry {
  extensionId: string;
  definition: ExtensionDefinition;
  api: ExtensionAPI;
  storage: ExtensionStorage;
  cleanupFns: Array<() => void>;
}

export interface ExecuteToolOptions {
  threadId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  projectPath?: string;
  environment?: Record<string, string>;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface DispatchContextOptions {
  threadId?: string;
  sessionId?: string;
  projectPath?: string;
  environment?: Record<string, string>;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export class ExtensionRegistry {
  private readonly tools = new Map<string, CustomToolDefinition>();
  private readonly subscriptions = new Map<
    ExtensionEventName,
    Set<EventSubscription<any>>
  >();
  private readonly extensions = new Map<string, RegisteredExtensionEntry>();
  /** Durable storage for ids with no registered extension, keyed by extension id. */
  private readonly unownedStorage = new Map<string, InMemoryExtensionStorage>();
  private subscriptionCounter = 0;

  /**
   * Register a custom tool definition.
   * Throws if the tool name is empty, invalid, or already registered.
   */
  registerTool(tool: CustomToolDefinition, extensionId?: string): () => void {
    if (!tool || typeof tool.name !== "string" || tool.name.trim() === "") {
      throw new Error("Tool definition must have a non-empty name string");
    }
    if (typeof tool.execute !== "function") {
      throw new Error(`Tool "${tool.name}" must provide an execute function`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }

    const boundTool: CustomToolDefinition = {
      ...tool,
      extensionId: extensionId ?? tool.extensionId,
    };

    this.tools.set(tool.name, boundTool);

    return () => {
      this.unregisterTool(tool.name);
    };
  }

  /**
   * Unregister a custom tool by name.
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a registered custom tool definition by name.
   */
  getTool(name: string): CustomToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a custom tool is currently registered.
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List all registered custom tools.
   */
  listTools(): CustomToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Execute a registered custom tool.
   * Automatically dispatches tool_call lifecycle events before and after execution.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown> = {},
    options: ExecuteToolOptions = {},
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Custom tool "${name}" not found`);
    }

    const extensionId = tool.extensionId ?? "core";
    const storage = this.getExtensionStorage(extensionId);

    const context: ExtensionContext = {
      extensionId,
      threadId: options.threadId,
      sessionId: options.sessionId,
      projectPath: options.projectPath,
      environment: options.environment,
      metadata: options.metadata,
      storage,
      signal: options.signal,
    };

    // Emit the pre-execution tool_call event. Handlers may veto the call, in
    // which case the tool must not run at all.
    const preDispatch = await this.dispatch(
      "tool_call",
      {
        toolName: name,
        args,
        toolCallId: options.toolCallId,
        turnId: options.turnId,
        threadId: options.threadId,
      },
      options,
    );

    const veto = preDispatch.vetoes[0];
    if (veto) {
      await this.dispatch(
        "tool_call",
        {
          toolName: name,
          args,
          toolCallId: options.toolCallId,
          turnId: options.turnId,
          threadId: options.threadId,
          isError: true,
          error: veto.error,
        },
        options,
      );
      throw veto.error;
    }

    try {
      const result = await tool.execute(args, context);

      // Emit completed tool_call event with result
      await this.dispatch(
        "tool_call",
        {
          toolName: name,
          args,
          toolCallId: options.toolCallId,
          turnId: options.turnId,
          threadId: options.threadId,
          result,
          isError: false,
        },
        options,
      );

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Emit failed tool_call event with error
      await this.dispatch(
        "tool_call",
        {
          toolName: name,
          args,
          toolCallId: options.toolCallId,
          turnId: options.turnId,
          threadId: options.threadId,
          isError: true,
          error,
        },
        options,
      );

      throw error;
    }
  }

  /**
   * Subscribe to lifecycle events.
   * Returns an unregister cleanup function.
   */
  on<E extends ExtensionEventName>(
    event: E,
    handler: ExtensionEventHandler<E>,
    extensionId?: string,
  ): () => void {
    if (typeof handler !== "function") {
      throw new Error("Event handler must be a function");
    }

    let set = this.subscriptions.get(event);
    if (!set) {
      set = new Set();
      this.subscriptions.set(event, set);
    }

    this.subscriptionCounter += 1;
    const subscription: EventSubscription<E> = {
      id: `sub_${this.subscriptionCounter}`,
      extensionId,
      event,
      handler,
    };

    set.add(subscription);

    return () => {
      this.removeSubscription(event, subscription.id);
    };
  }

  /**
   * Unsubscribe a lifecycle event handler.
   */
  off<E extends ExtensionEventName>(
    event: E,
    handler: ExtensionEventHandler<E>,
  ): boolean {
    const set = this.subscriptions.get(event);
    if (!set) {
      return false;
    }

    for (const sub of set) {
      if (sub.handler === handler) {
        return this.removeSubscription(event, sub.id);
      }
    }

    return false;
  }

  /**
   * Dispatch lifecycle events to all registered hooks.
   * Runs handlers in order, capturing any handler errors without aborting other hooks.
   */
  async dispatch<E extends ExtensionEventName>(
    event: E,
    payload: ExtensionEventMap[E],
    options: DispatchContextOptions = {},
  ): Promise<DispatchResult> {
    const set = this.subscriptions.get(event);
    const result: DispatchResult = { errors: [], vetoes: [] };

    if (!set || set.size === 0) {
      return result;
    }

    const subscriptions = Array.from(set);

    for (const sub of subscriptions) {
      const extensionId = sub.extensionId ?? "core";
      const storage = this.getExtensionStorage(extensionId);

      const context: ExtensionContext = {
        extensionId,
        threadId: options.threadId,
        sessionId: options.sessionId,
        projectPath: options.projectPath,
        environment: options.environment,
        metadata: options.metadata,
        storage,
        signal: options.signal,
      };

      try {
        await sub.handler(payload, context);
      } catch (err) {
        if (err instanceof ExtensionVetoError) {
          result.vetoes.push({ extensionId: sub.extensionId, error: err });
        } else {
          result.errors.push({ extensionId: sub.extensionId, error: err });
        }
      }
    }

    return result;
  }

  /**
   * Register and activate an extension.
   */
  async registerExtension(
    extensionId: string,
    definition: ExtensionDefinition,
    options: DispatchContextOptions = {},
  ): Promise<ExtensionAPI> {
    if (!extensionId || extensionId.trim() === "") {
      throw new Error("Extension ID must be a non-empty string");
    }
    if (this.extensions.has(extensionId)) {
      throw new Error(
        `Extension "${extensionId}" is already registered. Use reloadExtension() to update.`,
      );
    }

    const storage = new InMemoryExtensionStorage();
    const cleanupFns: Array<() => void> = [];

    const api = this.createBoundExtensionAPI(
      extensionId,
      storage,
      cleanupFns,
      options,
    );

    const entry: RegisteredExtensionEntry = {
      extensionId,
      definition,
      api,
      storage,
      cleanupFns,
    };

    this.extensions.set(extensionId, entry);

    try {
      if (typeof definition === "function") {
        await definition(api);
      } else if (definition && typeof definition.activate === "function") {
        await definition.activate(api);
      }
    } catch (err) {
      // If activation fails, rollback registrations
      await this.unregisterExtension(extensionId);
      throw err;
    }

    return api;
  }

  /**
   * Unregister an extension and tear down its tools and event listeners.
   */
  async unregisterExtension(extensionId: string): Promise<boolean> {
    const entry = this.extensions.get(extensionId);
    if (!entry) {
      return false;
    }

    // Call deactivate hook if it's an ExtensionModule
    if (
      typeof entry.definition === "object" &&
      entry.definition !== null &&
      "deactivate" in entry.definition &&
      typeof entry.definition.deactivate === "function"
    ) {
      try {
        await entry.definition.deactivate();
      } catch (err) {
        console.error(
          `Error deactivating extension "${extensionId}":`,
          err,
        );
      }
    }

    // Run all tracked cleanup functions (tools and event listeners)
    for (const cleanup of entry.cleanupFns) {
      try {
        cleanup();
      } catch (err) {
        console.error(
          `Error running cleanup for extension "${extensionId}":`,
          err,
        );
      }
    }

    entry.cleanupFns.length = 0;
    entry.storage.clear();
    this.extensions.delete(extensionId);

    return true;
  }

  /**
   * Hot-reload an extension by cleanly unregistering the old version and activating the new one.
   */
  async reloadExtension(
    extensionId: string,
    definition: ExtensionDefinition,
    options: DispatchContextOptions = {},
  ): Promise<ExtensionAPI> {
    if (this.extensions.has(extensionId)) {
      await this.unregisterExtension(extensionId);
    }
    return this.registerExtension(extensionId, definition, options);
  }

  /**
   * Check if an extension is registered.
   */
  isExtensionRegistered(extensionId: string): boolean {
    return this.extensions.has(extensionId);
  }

  /**
   * List all registered extension IDs.
   */
  getActiveExtensions(): string[] {
    return Array.from(this.extensions.keys());
  }

  /**
   * Create an ExtensionAPI instance bound to a specific extension ID.
   */
  createExtensionAPI(
    extensionId: string,
    options: DispatchContextOptions = {},
  ): ExtensionAPI {
    const storage = this.getExtensionStorage(extensionId);
    return this.createBoundExtensionAPI(extensionId, storage, [], options);
  }

  /**
   * Clear all extensions, custom tools, and event listeners.
   */
  async clear(): Promise<void> {
    const extensionIds = Array.from(this.extensions.keys());
    for (const id of extensionIds) {
      await this.unregisterExtension(id);
    }
    this.tools.clear();
    this.subscriptions.clear();
    this.extensions.clear();
    this.unownedStorage.clear();
  }

  /**
   * Remove a subscription by its own id.
   *
   * Matching on handler identity is not sufficient: two extensions may register
   * the same function reference, and removing "the first one that matches" would
   * tear down another extension's subscription while leaving the caller's live.
   */
  private removeSubscription(event: ExtensionEventName, id: string): boolean {
    const set = this.subscriptions.get(event);
    if (!set) {
      return false;
    }
    for (const sub of set) {
      if (sub.id === id) {
        set.delete(sub);
        if (set.size === 0) {
          this.subscriptions.delete(event);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve the storage for an extension id.
   *
   * Tools and handlers registered without an owning extension resolve to "core",
   * which is never present in `extensions`. They still need storage that survives
   * between calls, so unowned ids get a durable store of their own rather than a
   * throwaway that discards every write.
   */
  private getExtensionStorage(extensionId: string): ExtensionStorage {
    const entry = this.extensions.get(extensionId);
    if (entry) {
      return entry.storage;
    }
    let unowned = this.unownedStorage.get(extensionId);
    if (!unowned) {
      unowned = new InMemoryExtensionStorage();
      this.unownedStorage.set(extensionId, unowned);
    }
    return unowned;
  }

  private createBoundExtensionAPI(
    extensionId: string,
    storage: ExtensionStorage,
    cleanupFns: Array<() => void>,
    options: DispatchContextOptions,
  ): ExtensionAPI {
    const logger = new ScopedExtensionLogger(extensionId);

    const api: ExtensionAPI = {
      extensionId,
      storage,
      logger,
      registerTool: (tool: CustomToolDefinition) => {
        const cleanup = this.registerTool(tool, extensionId);
        cleanupFns.push(cleanup);
        return () => {
          cleanup();
          const idx = cleanupFns.indexOf(cleanup);
          if (idx >= 0) {
            cleanupFns.splice(idx, 1);
          }
        };
      },
      on: <E extends ExtensionEventName>(
        event: E,
        handler: ExtensionEventHandler<E>,
      ) => {
        const cleanup = this.on(event, handler, extensionId);
        cleanupFns.push(cleanup);
        return () => {
          cleanup();
          const idx = cleanupFns.indexOf(cleanup);
          if (idx >= 0) {
            cleanupFns.splice(idx, 1);
          }
        };
      },
      emit: async <E extends ExtensionEventName>(
        event: E,
        payload: ExtensionEventMap[E],
      ) => {
        await this.dispatch(event, payload, options);
      },
      getContext: (): ExtensionContext => ({
        extensionId,
        threadId: options.threadId,
        sessionId: options.sessionId,
        projectPath: options.projectPath,
        environment: options.environment,
        metadata: options.metadata,
        storage,
        signal: options.signal,
      }),
    };

    return api;
  }
}

/**
 * Types and interfaces for the dynamic extension engine.
 */

import type { ExtensionVetoError } from "./veto.js";

export interface ToolCallEvent {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId?: string;
  turnId?: string;
  threadId?: string;
  result?: unknown;
  isError?: boolean;
  error?: Error | string;
}

export interface TurnStartEvent {
  turnId: string;
  threadId: string;
  prompt?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface SessionStartEvent {
  sessionId: string;
  threadId: string;
  provider?: string;
  model?: string;
  projectPath?: string;
  timestamp?: number;
}

export interface BeforeCompactEvent {
  threadId: string;
  currentTokens: number;
  targetTokens?: number;
  cutIndex?: number;
  blocksCount?: number;
  customData?: Record<string, unknown>;
}

export interface ExtensionEventMap {
  tool_call: ToolCallEvent;
  turn_start: TurnStartEvent;
  session_start: SessionStartEvent;
  before_compact: BeforeCompactEvent;
}

export type ExtensionEventName = keyof ExtensionEventMap;

export interface ExtensionStorage {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  clear(): void;
  entries(): Array<[string, unknown]>;
}

export interface ExtensionContext {
  extensionId: string;
  threadId?: string;
  sessionId?: string;
  projectPath?: string;
  environment?: Record<string, string>;
  metadata?: Record<string, unknown>;
  storage: ExtensionStorage;
  signal?: AbortSignal;
}

export type ToolPermission = "allow" | "ask" | "deny";

export interface CustomToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: ExtensionContext,
  ) => Promise<unknown> | unknown;
  permission?: ToolPermission;
  requiresActiveTurn?: boolean;
  extensionId?: string;
}

export type ExtensionEventHandler<E extends keyof ExtensionEventMap> = (
  payload: ExtensionEventMap[E],
  context: ExtensionContext,
) => Promise<void> | void;

export interface ExtensionLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ExtensionAPI {
  readonly extensionId: string;
  readonly storage: ExtensionStorage;
  readonly logger: ExtensionLogger;
  registerTool(tool: CustomToolDefinition): () => void;
  on<E extends keyof ExtensionEventMap>(
    event: E,
    handler: ExtensionEventHandler<E>,
  ): () => void;
  emit<E extends keyof ExtensionEventMap>(
    event: E,
    payload: ExtensionEventMap[E],
  ): Promise<void>;
  getContext(): ExtensionContext;
}

export interface ExtensionModule {
  name?: string;
  version?: string;
  activate?: (api: ExtensionAPI) => Promise<void> | void;
  deactivate?: () => Promise<void> | void;
}

export type ExtensionFactory = (api: ExtensionAPI) => Promise<void> | void;

export type ExtensionDefinition = ExtensionModule | ExtensionFactory;

export interface DispatchResult {
  errors: Array<{
    extensionId?: string;
    error: unknown;
  }>;
  /**
   * Handlers that vetoed the pending operation by throwing an `ExtensionVetoError`.
   * Kept apart from `errors` so callers can abort on a veto without treating every
   * incidental handler failure as a blocking condition.
   */
  vetoes: Array<{
    extensionId?: string;
    error: ExtensionVetoError;
  }>;
}

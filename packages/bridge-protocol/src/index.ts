export type DroidModelDescriptor = {
  id: string;
  name: string;
  shortName: string;
  isCustom: boolean;
  modelProvider: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
};

export type PermissionRequestKind =
  | "command"
  | "file-read"
  | "file-change"
  | "network"
  | "unknown";

export type TurnToolPhase = "start" | "end";

export type TurnToolKind =
  | "read"
  | "write"
  | "execute"
  | "search"
  | "network"
  | "mcp"
  | "unknown";

export type TurnCancellationReason = "user" | "timeout" | "disconnect";

export type BridgeArtifactKind =
  | "text"
  | "code"
  | "markdown"
  | "image"
  | "diff"
  | "url"
  | "file";

export type BridgeArtifact = {
  id?: string;
  kind: BridgeArtifactKind;
  title: string;
  source: string;
  language?: string;
  content?: string;
  mimeType?: string;
  size?: number;
};

export type BridgeClientMessage =
  | {
      type: "prompt.submit";
      turnId: string;
      prompt: string;
      modelId: string;
      reasoningEffort: string;
      thinking?: boolean;
    }
  | {
      type: "permission.respond";
      requestId: string;
      approved: boolean;
    }
  | {
      type: "turn.cancel";
      turnId: string;
    }
  | {
      type: "models.list";
    };

export type BridgeServerMessage =
  | {
      type: "session.ready";
      sessionId: string;
      cwd: string;
    }
  | {
      type: "models.available";
      models: DroidModelDescriptor[];
      defaultModelId: string;
      defaultReasoningEffort: string;
    }
  | {
      type: "turn.delta";
      turnId: string;
      text: string;
    }
  | {
      type: "turn.thinking";
      turnId: string;
      text: string;
    }
  | {
      type: "turn.tool";
      turnId: string;
      name: string;
      phase: TurnToolPhase;
      toolCallId: string;
      kind?: TurnToolKind;
      inputSummary?: string;
      command?: string;
      paths?: string[];
      url?: string;
      startedAt?: string;
      completedAt?: string;
      resultSummary?: string;
      outputLength?: number;
      isError?: boolean;
      errorMessage?: string;
      artifacts?: BridgeArtifact[];
    }
  | {
      type: "turn.completed";
      turnId: string;
    }
  | {
      type: "turn.cancelled";
      turnId: string;
      reason: TurnCancellationReason;
    }
  | {
      type: "turn.error";
      turnId: string;
      message: string;
    }
  | {
      type: "permission.request";
      requestId: string;
      detail: string;
      requestKind: PermissionRequestKind;
      expiresAt: string;
      turnId?: string;
      toolCallId?: string;
      toolCallIds?: string[];
      target?: string;
      command?: string;
      paths?: string[];
    }
  | {
      type: "bridge.error";
      message: string;
    };

export const BRIDGE_WS_PORT = 8787;
export const DEFAULT_BRIDGE_WS_URL = `ws://localhost:${BRIDGE_WS_PORT}`;
/** @deprecated Use {@link DEFAULT_BRIDGE_WS_URL} or {@link resolveBridgeWsUrl}. */
export const BRIDGE_WS_URL = DEFAULT_BRIDGE_WS_URL;

/** Default permission request lifetime mirrored by the bridge. */
export const PERMISSION_REQUEST_TTL_MS = 120_000;

const PERMISSION_REQUEST_KINDS = new Set<PermissionRequestKind>([
  "command",
  "file-read",
  "file-change",
  "network",
  "unknown",
]);

const TURN_TOOL_KINDS = new Set<TurnToolKind>([
  "read",
  "write",
  "execute",
  "search",
  "network",
  "mcp",
  "unknown",
]);

const TURN_CANCELLATION_REASONS = new Set<TurnCancellationReason>([
  "user",
  "timeout",
  "disconnect",
]);

const BRIDGE_ARTIFACT_KINDS = new Set<BridgeArtifactKind>([
  "text",
  "code",
  "markdown",
  "image",
  "diff",
  "url",
  "file",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): string | undefined {
  return nonEmptyString(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseDroidModelDescriptor(value: unknown): DroidModelDescriptor | null {
  if (!isRecord(value)) return null;
  const supportedReasoningEfforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.filter((entry): entry is string => typeof entry === "string")
    : null;

  if (
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.shortName) ||
    typeof value.isCustom !== "boolean" ||
    !nonEmptyString(value.modelProvider) ||
    !supportedReasoningEfforts ||
    !nonEmptyString(value.defaultReasoningEffort)
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    shortName: value.shortName,
    isCustom: value.isCustom,
    modelProvider: value.modelProvider,
    supportedReasoningEfforts,
    defaultReasoningEffort: value.defaultReasoningEffort,
  };
}

function parsePermissionRequestKind(value: unknown): PermissionRequestKind | null {
  return typeof value === "string" && PERMISSION_REQUEST_KINDS.has(value as PermissionRequestKind)
    ? (value as PermissionRequestKind)
    : null;
}

function parseTurnToolKind(value: unknown): TurnToolKind | undefined {
  return typeof value === "string" && TURN_TOOL_KINDS.has(value as TurnToolKind)
    ? (value as TurnToolKind)
    : undefined;
}

function parseTurnToolPhase(value: unknown): TurnToolPhase | null {
  return value === "start" || value === "end" ? value : null;
}

function parseTurnCancellationReason(value: unknown): TurnCancellationReason | null {
  return typeof value === "string" &&
    TURN_CANCELLATION_REASONS.has(value as TurnCancellationReason)
    ? (value as TurnCancellationReason)
    : null;
}

function parseBridgeArtifactKind(value: unknown): BridgeArtifactKind | null {
  return typeof value === "string" && BRIDGE_ARTIFACT_KINDS.has(value as BridgeArtifactKind)
    ? (value as BridgeArtifactKind)
    : null;
}

function parseArtifact(value: unknown): BridgeArtifact | null {
  if (!isRecord(value)) return null;
  const kind = parseBridgeArtifactKind(value.kind);
  if (!kind || !nonEmptyString(value.title) || !nonEmptyString(value.source)) {
    return null;
  }

  return {
    id: optionalString(value.id),
    kind,
    title: value.title,
    source: value.source,
    language: optionalString(value.language),
    content: optionalString(value.content),
    mimeType: optionalString(value.mimeType),
    size: optionalNumber(value.size),
  };
}

function parseArtifacts(value: unknown): BridgeArtifact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((entry) => parseArtifact(entry))
    .filter((entry): entry is BridgeArtifact => entry !== null);
  return items.length > 0 ? items : undefined;
}

function parseBridgeClientMessageValue(value: unknown): BridgeClientMessage | null {
  if (!isRecord(value) || !nonEmptyString(value.type)) return null;

  switch (value.type) {
    case "prompt.submit":
      if (
        !nonEmptyString(value.turnId) ||
        typeof value.prompt !== "string" ||
        typeof value.modelId !== "string" ||
        typeof value.reasoningEffort !== "string" ||
        (value.thinking !== undefined && typeof value.thinking !== "boolean")
      ) {
        return null;
      }
      return {
        type: "prompt.submit",
        turnId: value.turnId,
        prompt: value.prompt,
        modelId: value.modelId,
        reasoningEffort: value.reasoningEffort,
        thinking: optionalBoolean(value.thinking),
      };

    case "permission.respond":
      if (
        !nonEmptyString(value.requestId) ||
        typeof value.approved !== "boolean"
      ) {
        return null;
      }
      return {
        type: "permission.respond",
        requestId: value.requestId,
        approved: value.approved,
      };

    case "turn.cancel":
      if (!nonEmptyString(value.turnId)) return null;
      return {
        type: "turn.cancel",
        turnId: value.turnId,
      };

    case "models.list":
      return { type: "models.list" };

    default:
      return null;
  }
}

function parseBridgeServerMessageValue(value: unknown): BridgeServerMessage | null {
  if (!isRecord(value) || !nonEmptyString(value.type)) return null;

  switch (value.type) {
    case "session.ready":
      if (!nonEmptyString(value.sessionId) || !nonEmptyString(value.cwd)) return null;
      return {
        type: "session.ready",
        sessionId: value.sessionId,
        cwd: value.cwd,
      };

    case "models.available": {
      if (
        !Array.isArray(value.models) ||
        !nonEmptyString(value.defaultModelId) ||
        !nonEmptyString(value.defaultReasoningEffort)
      ) {
        return null;
      }

      const models = value.models
        .map((entry) => parseDroidModelDescriptor(entry))
        .filter((entry): entry is DroidModelDescriptor => entry !== null);

      if (models.length !== value.models.length) return null;

      return {
        type: "models.available",
        models,
        defaultModelId: value.defaultModelId,
        defaultReasoningEffort: value.defaultReasoningEffort,
      };
    }

    case "turn.delta":
    case "turn.thinking":
      if (!nonEmptyString(value.turnId) || typeof value.text !== "string") return null;
      return {
        type: value.type,
        turnId: value.turnId,
        text: value.text,
      };

    case "turn.tool": {
      const phase = parseTurnToolPhase(value.phase);
      if (!nonEmptyString(value.turnId) || !nonEmptyString(value.name) || !phase) {
        return null;
      }

      const toolCallId = nonEmptyString(value.toolCallId) ? value.toolCallId : value.name;

      return {
        type: "turn.tool",
        turnId: value.turnId,
        name: value.name,
        phase,
        toolCallId,
        kind: parseTurnToolKind(value.kind),
        inputSummary: optionalString(value.inputSummary),
        command: optionalString(value.command),
        paths: stringArray(value.paths),
        url: optionalString(value.url),
        startedAt: optionalString(value.startedAt),
        completedAt: optionalString(value.completedAt),
        resultSummary: optionalString(value.resultSummary),
        outputLength: optionalNumber(value.outputLength),
        isError: optionalBoolean(value.isError),
        errorMessage: optionalString(value.errorMessage),
        artifacts: parseArtifacts(value.artifacts),
      };
    }

    case "turn.completed":
      if (!nonEmptyString(value.turnId)) return null;
      return {
        type: "turn.completed",
        turnId: value.turnId,
      };

    case "turn.cancelled": {
      const reason = parseTurnCancellationReason(value.reason);
      if (!nonEmptyString(value.turnId) || !reason) return null;
      return {
        type: "turn.cancelled",
        turnId: value.turnId,
        reason,
      };
    }

    case "turn.error":
      if (!nonEmptyString(value.turnId) || !nonEmptyString(value.message)) return null;
      return {
        type: "turn.error",
        turnId: value.turnId,
        message: value.message,
      };

    case "permission.request": {
      const requestKind = parsePermissionRequestKind(value.requestKind) ?? "unknown";
      if (!nonEmptyString(value.requestId) || !nonEmptyString(value.detail)) {
        return null;
      }

      const expiresAt =
        nonEmptyString(value.expiresAt) ? value.expiresAt : new Date().toISOString();

      return {
        type: "permission.request",
        requestId: value.requestId,
        detail: value.detail,
        requestKind,
        expiresAt,
        turnId: optionalString(value.turnId),
        toolCallId: optionalString(value.toolCallId),
        toolCallIds: stringArray(value.toolCallIds),
        target: optionalString(value.target),
        command: optionalString(value.command),
        paths: stringArray(value.paths),
      };
    }

    case "bridge.error":
      if (!nonEmptyString(value.message)) return null;
      return {
        type: "bridge.error",
        message: value.message,
      };

    default:
      return null;
  }
}

export function resolveBridgeWsUrl(override?: string | null): string {
  const value = override?.trim();
  return value ? value : DEFAULT_BRIDGE_WS_URL;
}

export function parseBridgeClientMessage(raw: string): BridgeClientMessage | null {
  try {
    return parseBridgeClientMessageValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseBridgeServerMessage(raw: string): BridgeServerMessage | null {
  try {
    return parseBridgeServerMessageValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function isBridgeClientMessage(value: unknown): value is BridgeClientMessage {
  return parseBridgeClientMessageValue(value) !== null;
}

export function isBridgeServerMessage(value: unknown): value is BridgeServerMessage {
  return parseBridgeServerMessageValue(value) !== null;
}

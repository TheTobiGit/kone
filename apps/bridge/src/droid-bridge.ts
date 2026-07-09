import {
  AutonomyLevel,
  createSession,
  DroidMessageType,
  ReasoningEffort,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type DroidSession,
  type RequestPermissionRequestParams,
} from "@factory/droid-sdk";
import {
  PERMISSION_REQUEST_TTL_MS,
  type BridgeClientMessage,
  type BridgeServerMessage,
  type PermissionRequestKind,
  type TurnToolKind,
} from "@kone/bridge-protocol";

const DEFAULT_MODEL_ID = "claude-opus-4-8";

function mapReasoningEffort(id: string): ReasoningEffort {
  const map: Record<string, ReasoningEffort> = {
    none: ReasoningEffort.None,
    dynamic: ReasoningEffort.Dynamic,
    off: ReasoningEffort.Off,
    minimal: ReasoningEffort.Minimal,
    low: ReasoningEffort.Low,
    medium: ReasoningEffort.Medium,
    high: ReasoningEffort.High,
    xhigh: ReasoningEffort.ExtraHigh,
    max: ReasoningEffort.Max,
  };

  return map[id] ?? ReasoningEffort.Medium;
}

type SendFn = (message: BridgeServerMessage) => void;

type PendingPermission = {
  resolve: (approved: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inferToolKind(toolName: string): TurnToolKind {
  const normalized = toolName.toLowerCase();

  if (/(read|cat|view|list|glob|grep|search|find)/.test(normalized)) {
    return /(grep|search|find|glob)/.test(normalized) ? "search" : "read";
  }
  if (/(write|edit|patch|create|delete|remove|apply)/.test(normalized)) {
    return "write";
  }
  if (/(bash|shell|exec|run|command|terminal)/.test(normalized)) {
    return "execute";
  }
  if (/(fetch|http|url|browser|web)/.test(normalized)) {
    return "network";
  }
  if (/mcp/.test(normalized)) {
    return "mcp";
  }

  return "unknown";
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;

  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : undefined;
  if (command) return command;

  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.filePath === "string"
        ? input.filePath
        : typeof input.path === "string"
          ? input.path
          : undefined;
  if (filePath) return filePath;

  const url = typeof input.url === "string" ? input.url : undefined;
  if (url) return url;

  const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
  if (pattern) return pattern;

  const keys = Object.keys(input);
  if (keys.length === 0) return undefined;
  if (keys.length === 1) {
    const value = input[keys[0]!];
    if (typeof value === "string") return value;
  }

  return keys.slice(0, 3).join(", ");
}

function extractToolPaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];

  const paths = new Set<string>();
  for (const key of ["file_path", "filePath", "path", "paths"]) {
    const value = input[key];
    if (typeof value === "string") paths.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") paths.add(entry);
      }
    }
  }

  return [...paths];
}

function extractToolCommand(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  if (typeof input.command === "string") return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  return undefined;
}

function extractToolUrl(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  return typeof input.url === "string" ? input.url : undefined;
}

function mapPermissionKind(
  confirmationType: ToolConfirmationType,
): PermissionRequestKind {
  switch (confirmationType) {
    case ToolConfirmationType.Execute:
      return "command";
    case ToolConfirmationType.Edit:
    case ToolConfirmationType.Create:
    case ToolConfirmationType.ApplyPatch:
      return "file-change";
    case ToolConfirmationType.McpTool:
      return "network";
    default:
      return "unknown";
  }
}

function permissionTargetFromParams(
  params: RequestPermissionRequestParams,
): { target?: string; command?: string; paths?: string[] } {
  const paths = new Set<string>();
  let command: string | undefined;
  let target: string | undefined;

  for (const toolUse of params.toolUses) {
    const details = toolUse.details;
    if (!isRecord(details)) continue;

    switch (details.type) {
      case ToolConfirmationType.Execute:
        command = typeof details.command === "string" ? details.command : command;
        target = typeof details.fullCommand === "string" ? details.fullCommand : target;
        break;
      case ToolConfirmationType.Edit:
      case ToolConfirmationType.Create:
      case ToolConfirmationType.ApplyPatch:
        if (typeof details.filePath === "string") {
          paths.add(details.filePath);
          target = target ?? details.filePath;
        }
        break;
      case ToolConfirmationType.McpTool:
        target = typeof details.toolName === "string" ? details.toolName : target;
        break;
      default:
        break;
    }
  }

  return {
    target,
    command,
    paths: paths.size > 0 ? [...paths] : undefined,
  };
}

function buildPermissionDetail(params: RequestPermissionRequestParams): string {
  const toolNames = params.toolUses.map((tool) => tool.toolUse.name).join(", ");
  if (toolNames) return `Allow: ${toolNames}`;

  const { command, target } = permissionTargetFromParams(params);
  if (command) return `Allow command: ${command}`;
  if (target) return `Allow access to: ${target}`;
  return "Allow tool execution?";
}

function summarizeToolResult(content: string | unknown[] | undefined): {
  resultSummary?: string;
  outputLength?: number;
  errorMessage?: string;
} {
  if (content === undefined) return {};

  if (typeof content === "string") {
    const trimmed = content.trim();
    return {
      resultSummary: trimmed.slice(0, 240) || undefined,
      outputLength: content.length,
      errorMessage: trimmed.startsWith("Error") ? trimmed.slice(0, 240) : undefined,
    };
  }

  if (Array.isArray(content)) {
    const text = content
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isRecord(entry) && typeof entry.text === "string") return entry.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");

    return {
      resultSummary: text.slice(0, 240) || undefined,
      outputLength: text.length,
    };
  }

  return {};
}

export class DroidBridgeConnection {
  private session: DroidSession | null = null;
  private sessionModelId: string | null = null;
  private sessionReasoningEffort: ReasoningEffort | null = null;
  private activeTurnId: string | null = null;
  private activeTurnAbort: AbortController | null = null;
  private readonly cancelledTurnIds = new Set<string>();
  private readonly permissionResolvers = new Map<string, PendingPermission>();
  private readonly cwd: string;

  constructor(
    private readonly send: SendFn,
    cwd = process.env.KONE_CWD ?? process.cwd(),
  ) {
    this.cwd = cwd;
  }

  async handleMessage(message: BridgeClientMessage) {
    switch (message.type) {
      case "prompt.submit":
        await this.submitPrompt(message);
        return;
      case "permission.respond":
        this.resolvePermission(message.requestId, message.approved);
        return;
      case "turn.cancel":
        this.cancelTurn(message.turnId);
        return;
    }
  }

  async close() {
    this.rejectAllPendingPermissions();
    this.activeTurnAbort?.abort();
    this.activeTurnAbort = null;
    this.activeTurnId = null;

    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }

  private resolvePermission(requestId: string, approved: boolean) {
    const pending = this.permissionResolvers.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    this.permissionResolvers.delete(requestId);
    pending.resolve(approved);
  }

  private rejectAllPendingPermissions() {
    for (const [requestId, pending] of this.permissionResolvers) {
      clearTimeout(pending.timeoutId);
      pending.resolve(false);
      this.permissionResolvers.delete(requestId);
    }
  }

  private waitForPermission(
    requestId: string,
    payload: Extract<BridgeServerMessage, { type: "permission.request" }>,
  ): Promise<boolean> {
    this.send(payload);

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        if (!this.permissionResolvers.has(requestId)) return;
        this.permissionResolvers.delete(requestId);
        resolve(false);
      }, PERMISSION_REQUEST_TTL_MS);

      this.permissionResolvers.set(requestId, { resolve, timeoutId });
    });
  }

  private cancelTurn(turnId: string) {
    if (this.activeTurnId !== turnId) return;

    this.cancelledTurnIds.add(turnId);
    this.activeTurnId = null;
    this.activeTurnAbort?.abort(new DOMException("Turn cancelled.", "AbortError"));
    this.rejectAllPendingPermissions();

    void this.session?.interrupt().catch(() => undefined);
  }

  private async ensureSession(modelId: string, reasoningEffort: ReasoningEffort) {
    const normalizedModelId = modelId.trim() || DEFAULT_MODEL_ID;

    if (
      this.session &&
      this.sessionModelId === normalizedModelId &&
      this.sessionReasoningEffort === reasoningEffort
    ) {
      return this.session;
    }

    if (this.session) {
      await this.session.close();
      this.session = null;
    }

    const session = await createSession({
      apiKey: process.env.FACTORY_API_KEY!,
      cwd: this.cwd,
      modelId: normalizedModelId,
      reasoningEffort,
      autonomyLevel: AutonomyLevel.Medium,
      permissionHandler: async (params) => {
        const requestId = crypto.randomUUID();
        const toolCallIds = params.toolUses.map((tool) => tool.toolUse.id);
        const toolCallId = toolCallIds[0];
        const requestKind = mapPermissionKind(
          params.toolUses[0]?.confirmationType ?? ToolConfirmationType.Execute,
        );
        const { target, command, paths } = permissionTargetFromParams(params);
        const expiresAt = new Date(Date.now() + PERMISSION_REQUEST_TTL_MS).toISOString();

        const approved = await this.waitForPermission(requestId, {
          type: "permission.request",
          requestId,
          detail: buildPermissionDetail(params),
          requestKind,
          expiresAt,
          turnId: this.activeTurnId ?? undefined,
          toolCallId,
          toolCallIds,
          target,
          command,
          paths,
        });

        return approved
          ? ToolConfirmationOutcome.ProceedOnce
          : ToolConfirmationOutcome.Cancel;
      },
    });

    this.session = session;
    this.sessionModelId = normalizedModelId;
    this.sessionReasoningEffort = reasoningEffort;

    this.send({
      type: "session.ready",
      sessionId: session.sessionId,
      cwd: this.cwd,
    });

    return session;
  }

  private async submitPrompt(message: Extract<BridgeClientMessage, { type: "prompt.submit" }>) {
    if (this.activeTurnId) {
      this.send({
        type: "turn.error",
        turnId: message.turnId,
        message: "A turn is already in progress.",
      });
      return;
    }

    this.activeTurnId = message.turnId;
    const abortController = new AbortController();
    this.activeTurnAbort = abortController;

    try {
      const session = await this.ensureSession(
        message.modelId,
        mapReasoningEffort(message.reasoningEffort),
      );

      let turnFinished = false;

      for await (const event of session.stream(message.prompt, {
        includePartialMessages: true,
        abortSignal: abortController.signal,
      })) {
        if (this.activeTurnId !== message.turnId) break;

        switch (event.type) {
          case DroidMessageType.AssistantTextDelta:
            this.send({
              type: "turn.delta",
              turnId: message.turnId,
              text: event.text,
            });
            break;

          case DroidMessageType.ThinkingTextDelta:
            if (message.thinking !== false) {
              this.send({
                type: "turn.thinking",
                turnId: message.turnId,
                text: event.text,
              });
            }
            break;

          case DroidMessageType.ToolCall: {
            const input = isRecord(event.toolUse.input) ? event.toolUse.input : undefined;
            this.send({
              type: "turn.tool",
              turnId: message.turnId,
              name: event.toolUse.name,
              phase: "start",
              toolCallId: event.toolUse.id,
              kind: inferToolKind(event.toolUse.name),
              inputSummary: summarizeToolInput(input),
              command: extractToolCommand(input),
              paths: extractToolPaths(input),
              url: extractToolUrl(input),
              startedAt: new Date().toISOString(),
            });
            break;
          }

          case DroidMessageType.ToolResult: {
            const summary = summarizeToolResult(event.content);
            this.send({
              type: "turn.tool",
              turnId: message.turnId,
              name: event.toolName,
              phase: "end",
              toolCallId: event.toolUseId,
              kind: inferToolKind(event.toolName),
              completedAt: new Date().toISOString(),
              isError: event.isError,
              resultSummary: summary.resultSummary,
              outputLength: summary.outputLength,
              errorMessage: event.isError ? summary.errorMessage ?? summary.resultSummary : undefined,
            });
            break;
          }

          case DroidMessageType.Result:
            if (event.isError) {
              const errorText =
                event.errors?.join("\n") ??
                event.error?.message ??
                "Droid returned an error.";
              this.send({
                type: "turn.error",
                turnId: message.turnId,
                message: errorText,
              });
            } else {
              this.send({
                type: "turn.completed",
                turnId: message.turnId,
              });
            }
            turnFinished = true;
            break;

          case DroidMessageType.Error:
            this.send({
              type: "turn.error",
              turnId: message.turnId,
              message: event.message,
            });
            turnFinished = true;
            break;
        }
      }

      if (
        this.activeTurnId === message.turnId &&
        !turnFinished &&
        !this.cancelledTurnIds.has(message.turnId)
      ) {
        this.send({
          type: "turn.completed",
          turnId: message.turnId,
        });
      }
    } catch (error) {
      if (this.cancelledTurnIds.has(message.turnId)) {
        return;
      }

      const messageText =
        error instanceof Error ? error.message : "Failed to run Droid turn.";
      this.send({
        type: "turn.error",
        turnId: message.turnId,
        message: messageText,
      });
    } finally {
      if (this.cancelledTurnIds.has(message.turnId)) {
        this.send({
          type: "turn.cancelled",
          turnId: message.turnId,
          reason: "user",
        });
        this.cancelledTurnIds.delete(message.turnId);
      }

      if (this.activeTurnAbort === abortController) {
        this.activeTurnAbort = null;
      }

      if (this.activeTurnId === message.turnId) {
        this.activeTurnId = null;
      }
    }
  }
}

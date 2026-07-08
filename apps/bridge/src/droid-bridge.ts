import {
  AutonomyLevel,
  createSession,
  DroidMessageType,
  ReasoningEffort,
  ToolConfirmationOutcome,
  type DroidSession,
} from "@factory/droid-sdk";
import type { BridgeClientMessage, BridgeServerMessage } from "@kone/bridge-protocol";

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

export class DroidBridgeConnection {
  private session: DroidSession | null = null;
  private sessionModelId: string | null = null;
  private sessionReasoningEffort: ReasoningEffort | null = null;
  private activeTurnId: string | null = null;
  private readonly permissionResolvers = new Map<string, (approved: boolean) => void>();
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
    }
  }

  async close() {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }

  private resolvePermission(requestId: string, approved: boolean) {
    const resolve = this.permissionResolvers.get(requestId);
    if (!resolve) return;
    this.permissionResolvers.delete(requestId);
    resolve(approved);
  }

  private waitForPermission(requestId: string, detail: string): Promise<boolean> {
    this.send({ type: "permission.request", requestId, detail });

    return new Promise((resolve) => {
      this.permissionResolvers.set(requestId, resolve);

      setTimeout(() => {
        if (!this.permissionResolvers.has(requestId)) return;
        this.permissionResolvers.delete(requestId);
        resolve(false);
      }, 120_000);
    });
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
        const toolNames = params.toolUses.map((tool) => tool.name).join(", ");
        const approved = await this.waitForPermission(
          requestId,
          toolNames ? `Allow: ${toolNames}` : "Allow tool execution?",
        );

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

    try {
      const session = await this.ensureSession(
        message.modelId,
        mapReasoningEffort(message.reasoningEffort),
      );

      let turnFinished = false;

      for await (const event of session.stream(message.prompt, {
        includePartialMessages: true,
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
            this.send({
              type: "turn.thinking",
              turnId: message.turnId,
              text: event.text,
            });
            break;

          case DroidMessageType.ToolCall:
            this.send({
              type: "turn.tool",
              turnId: message.turnId,
              name: event.toolUse.name,
              phase: "start",
            });
            break;

          case DroidMessageType.ToolResult:
            this.send({
              type: "turn.tool",
              turnId: message.turnId,
              name: "tool",
              phase: "end",
              isError: event.isError,
            });
            break;

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

      if (this.activeTurnId === message.turnId && !turnFinished) {
        this.send({
          type: "turn.completed",
          turnId: message.turnId,
        });
      }
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Failed to run Droid turn.";
      this.send({
        type: "turn.error",
        turnId: message.turnId,
        message: messageText,
      });
    } finally {
      if (this.activeTurnId === message.turnId) {
        this.activeTurnId = null;
      }
    }
  }
}

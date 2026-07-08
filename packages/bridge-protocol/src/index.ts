export type DroidModelDescriptor = {
  id: string;
  name: string;
  shortName: string;
  isCustom: boolean;
  modelProvider: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
};

export type BridgeClientMessage =
  | {
      type: "prompt.submit";
      turnId: string;
      prompt: string;
      modelId: string;
      reasoningEffort: string;
    }
  | {
      type: "permission.respond";
      requestId: string;
      approved: boolean;
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
      phase: "start" | "end";
      isError?: boolean;
    }
  | {
      type: "turn.completed";
      turnId: string;
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
    }
  | {
      type: "bridge.error";
      message: string;
    };

export const BRIDGE_WS_PORT = 8787;
export const BRIDGE_WS_URL = `ws://localhost:${BRIDGE_WS_PORT}`;

export function parseBridgeClientMessage(raw: string): BridgeClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as BridgeClientMessage;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseBridgeServerMessage(raw: string): BridgeServerMessage | null {
  try {
    const parsed = JSON.parse(raw) as BridgeServerMessage;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

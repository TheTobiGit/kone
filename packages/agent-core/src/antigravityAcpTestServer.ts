import type {
  AntigravityAcpValue,
  AntigravityRpcClient,
} from "./adapters/AntigravityAcpAdapter.js";

// Test-only: an in-process scripted ACP server. It implements the transport
// surface the adapter drives — no child process is ever spawned, so these
// tests are immune to module-registry order (several suites mock.module the
// real JsonRpcClient) and to machine load. Scenarios cover a basic streaming
// turn plus the two permission-request shapes (an approval and a native
// fixed-choice question). Every inbound call is recorded so tests can assert
// the exact outcome the adapter replied with.

export type FakeAntigravityScenario = "basic" | "approval" | "question";

type NotificationHandler = (params: AntigravityAcpValue | null | undefined) => void;
type RequestHandler = (
  params: AntigravityAcpValue | null | undefined,
) => Promise<AntigravityAcpValue>;

export class FakeAntigravityRpc implements AntigravityRpcClient {
  readonly inbound: { method: string; params?: AntigravityAcpValue }[] = [];
  /** Outcomes the adapter returned for server→client permission requests. */
  readonly permissionOutcomes: AntigravityAcpValue[] = [];
  private readonly notifications = new Map<string, Set<NotificationHandler>>();
  private readonly requests = new Map<string, RequestHandler>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private model = "gemini-mock";
  private mode = "default";
  /** When true, prompt turns hold before their tool call + reply until
   *  releasePrompt() runs — for tests that need a turn in flight. */
  holdPrompt = false;
  private releasePromptGate: (() => void) | null = null;

  constructor(readonly scenario: FakeAntigravityScenario = "basic") {}

  /** Release one held prompt turn. No-op when nothing is held. */
  releasePrompt(): void {
    const release = this.releasePromptGate;
    this.releasePromptGate = null;
    release?.();
  }

  async call<T>(
    method: string,
    params?: AntigravityAcpValue,
    _timeoutMs?: number,
  ): Promise<T> {
    void _timeoutMs;
    this.inbound.push({ method, params });
    const response = await this.answer(method, params);
    // SAFETY: each arm of answer() builds exactly the payload the adapter's
    // protocol expects for `method`; T is that shape at every call site.
    return response as T;
  }

  notify(method: string, params?: AntigravityAcpValue): void {
    this.inbound.push({ method, params });
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notifications.get(method);
    if (!set) {
      set = new Set();
      this.notifications.set(method, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requests.set(method, handler);
  }

  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  onStderrLine(): () => void {
    return () => {};
  }

  async kill(): Promise<void> {
    for (const handler of this.exitHandlers) handler(0);
  }

  private emitUpdate(update: AntigravityAcpValue): void {
    const handlers = this.notifications.get("session/update");
    if (!handlers) return;
    const params: AntigravityAcpValue = { sessionId: "mock-session-1", update };
    for (const handler of handlers) handler(params);
  }

  private configOptions(): AntigravityAcpValue {
    return [
      {
        id: "model",
        name: "Model",
        currentValue: this.model,
        options: [{ value: "gemini-mock", name: "Gemini Mock" }],
      },
      {
        id: "mode",
        name: "Mode",
        currentValue: this.mode,
        options: [{ value: "yolo" }, { value: "auto_edit" }, { value: "default" }],
      },
    ];
  }

  private async answer(method: string, params?: AntigravityAcpValue): Promise<AntigravityAcpValue> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: {} },
          authMethods: [{ id: "oauth-personal" }],
        };
      case "authenticate":
        return {};
      case "session/new":
      case "session/resume":
        return { sessionId: "mock-session-1", configOptions: this.configOptions() };
      case "session/set_config_option": {
        const configId = readText(params, "configId");
        const value = readText(params, "value");
        if (configId === "mode" && value) this.mode = value;
        if (configId === "model" && value) this.model = value;
        // The refreshed matrix arrives as a notification, like the real server.
        queueMicrotask(() =>
          this.emitUpdate({ sessionUpdate: "config_option_update", configOptions: this.configOptions() }),
        );
        return {};
      }
      case "session/prompt":
        return this.runPrompt();
      default:
        return {};
    }
  }

  private async runPrompt(): Promise<AntigravityAcpValue> {
    this.emitUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
    this.emitUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there." } });
    if (this.holdPrompt) {
      await new Promise<void>((resolve) => {
        this.releasePromptGate = resolve;
      });
    }
    if (this.scenario === "approval" || this.scenario === "question") {
      const handler = this.requests.get("session/request_permission");
      if (handler) {
        const outcome = await handler(this.scenarioParams());
        this.permissionOutcomes.push(outcome);
      }
    }
    this.emitUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_9",
      title: "Run tests?",
      kind: "execute",
      status: "completed",
    });
    return { stopReason: "end_turn" };
  }

  private scenarioParams(): AntigravityAcpValue {
    if (this.scenario === "question") {
      return {
        sessionId: "mock-session-1",
        toolCall: { toolCallId: "interaction_9", title: "Pick one." },
        options: [
          { optionId: "a", name: "Alpha" },
          { optionId: "b", name: "Beta" },
        ],
      };
    }
    return {
      sessionId: "mock-session-1",
      toolCall: { toolCallId: "call_1", title: "Run tests?", kind: "execute", command: "npm test" },
      options: [
        { optionId: "proceed_once", kind: "allow_once", name: "Allow once" },
        { optionId: "cancel", kind: "reject_once", name: "Cancel" },
      ],
    };
  }
}

function readText(value: AntigravityAcpValue | undefined, key: string): string | undefined {
  if (!(value instanceof Object) || Array.isArray(value)) return undefined;
  // SAFETY: value is verified as a non-array Object record.
  const record = value as { [key: string]: AntigravityAcpValue };
  const leaf = record[key];
  if (
    leaf === null ||
    leaf === undefined ||
    leaf === true ||
    leaf === false ||
    leaf instanceof Object ||
    Number.isFinite(leaf)
  ) {
    return undefined;
  }
  return String(leaf);
}

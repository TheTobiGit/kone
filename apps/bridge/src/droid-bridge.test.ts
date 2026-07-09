import { beforeEach, describe, expect, mock, test } from "bun:test";
import { DroidMessageType } from "@factory/droid-sdk";
import type { BridgeServerMessage } from "@kone/bridge-protocol";

const streamMock = mock(
  async function* (): AsyncGenerator<unknown> {
    yield {
      type: DroidMessageType.AssistantTextDelta,
      messageId: "msg-1",
      blockIndex: 0,
      text: "partial",
    };

    await new Promise((resolve) => setTimeout(resolve, 50));

    yield {
      type: DroidMessageType.Result,
      subtype: "success",
      isError: false,
      sessionId: "session-1",
      durationMs: 1,
      numTurns: 1,
      result: "done",
      tokenUsage: null,
      messages: [],
      text: "done",
      turnCount: 1,
      success: true,
      error: null,
    };
  },
) as ReturnType<typeof mock<() => AsyncGenerator<unknown>>>;

const interruptMock = mock(async () => undefined);
const closeMock = mock(async () => undefined);

mock.module("@factory/droid-sdk", () => ({
  AutonomyLevel: { Medium: "medium" },
  ReasoningEffort: { Medium: "medium" },
  ToolConfirmationOutcome: { ProceedOnce: "proceed_once", Cancel: "cancel" },
  ToolConfirmationType: {
    Execute: "exec",
    Edit: "edit",
    Create: "create",
    ApplyPatch: "apply_patch",
    McpTool: "mcp_tool",
    AskUser: "ask_user",
  },
  DroidMessageType,
  createSession: mock(async () => ({
    sessionId: "session-1",
    stream: streamMock,
    interrupt: interruptMock,
    close: closeMock,
  })),
}));

const { DroidBridgeConnection } = await import("./droid-bridge");

describe("DroidBridgeConnection", () => {
  let messages: BridgeServerMessage[];

  beforeEach(() => {
    messages = [];
    streamMock.mockClear();
    interruptMock.mockClear();
    closeMock.mockClear();
    process.env.FACTORY_API_KEY = "test-key";
  });

  test("cancels an active turn without emitting turn.completed", async () => {
    const connection = new DroidBridgeConnection((message) => {
      messages.push(message);
    });

    const submitPromise = connection.handleMessage({
      type: "prompt.submit",
      turnId: "turn-1",
      prompt: "hello",
      modelId: "claude-opus-4-8",
      reasoningEffort: "medium",
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await connection.handleMessage({
      type: "turn.cancel",
      turnId: "turn-1",
    });

    await submitPromise;

    expect(messages.some((message) => message.type === "turn.delta")).toBe(true);
    expect(messages.some((message) => message.type === "turn.completed")).toBe(false);
    expect(messages).toContainEqual({
      type: "turn.cancelled",
      turnId: "turn-1",
      reason: "user",
    });
    expect(interruptMock).toHaveBeenCalled();
  });

  test("emits structured tool lifecycle events", async () => {
    (streamMock as { mockImplementationOnce: (fn: () => AsyncGenerator<unknown>) => void }).mockImplementationOnce(
      async function* (): AsyncGenerator<unknown> {
        yield {
          type: DroidMessageType.ToolCall,
          toolUse: {
            type: "tool_use",
            id: "tool-abc",
            name: "Read",
            input: { path: "src/index.ts" },
          },
        };
        yield {
          type: DroidMessageType.ToolResult,
          toolUseId: "tool-abc",
          toolName: "Read",
          content: "file contents",
          isError: false,
        };
        yield {
          type: DroidMessageType.Result,
          subtype: "success",
          isError: false,
          sessionId: "session-1",
          durationMs: 1,
          numTurns: 1,
          result: "done",
          tokenUsage: null,
          messages: [],
          text: "done",
          turnCount: 1,
          success: true,
          error: null,
        };
      },
    );

    const connection = new DroidBridgeConnection((message) => {
      messages.push(message);
    });

    await connection.handleMessage({
      type: "prompt.submit",
      turnId: "turn-2",
      prompt: "read file",
      modelId: "claude-opus-4-8",
      reasoningEffort: "medium",
    });

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "turn.tool",
        phase: "start",
        toolCallId: "tool-abc",
        name: "Read",
        kind: "read",
        paths: ["src/index.ts"],
      }),
    );

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "turn.tool",
        phase: "end",
        toolCallId: "tool-abc",
        name: "Read",
        isError: false,
        resultSummary: "file contents",
        artifacts: [
          {
            kind: "code",
            title: "index.ts",
            source: "src/index.ts",
            language: "typescript",
            content: "file contents",
          },
        ],
      }),
    );
  });

  test("emits a write artifact derived from the tool input, not a bare result", async () => {
    (streamMock as { mockImplementationOnce: (fn: () => AsyncGenerator<unknown>) => void }).mockImplementationOnce(
      async function* (): AsyncGenerator<unknown> {
        yield {
          type: DroidMessageType.ToolCall,
          toolUse: {
            type: "tool_use",
            id: "tool-write-1",
            name: "Write",
            input: { file_path: "notes/todo.md", content: "- [ ] ship it" },
          },
        };
        yield {
          type: DroidMessageType.ToolResult,
          toolUseId: "tool-write-1",
          toolName: "Write",
          content: "Wrote 1 file",
          isError: false,
        };
        yield {
          type: DroidMessageType.Result,
          subtype: "success",
          isError: false,
          sessionId: "session-1",
          durationMs: 1,
          numTurns: 1,
          result: "done",
          tokenUsage: null,
          messages: [],
          text: "done",
          turnCount: 1,
          success: true,
          error: null,
        };
      },
    );

    const connection = new DroidBridgeConnection((message) => {
      messages.push(message);
    });

    await connection.handleMessage({
      type: "prompt.submit",
      turnId: "turn-3",
      prompt: "write a todo",
      modelId: "claude-opus-4-8",
      reasoningEffort: "medium",
    });

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "turn.tool",
        phase: "end",
        toolCallId: "tool-write-1",
        artifacts: [
          {
            kind: "code",
            title: "todo.md",
            source: "notes/todo.md",
            language: "markdown",
            content: "- [ ] ship it",
          },
        ],
      }),
    );
  });

  test("omits artifacts when no path can be confidently extracted", async () => {
    (streamMock as { mockImplementationOnce: (fn: () => AsyncGenerator<unknown>) => void }).mockImplementationOnce(
      async function* (): AsyncGenerator<unknown> {
        yield {
          type: DroidMessageType.ToolCall,
          toolUse: {
            type: "tool_use",
            id: "tool-bash-1",
            name: "Bash",
            input: { command: "ls" },
          },
        };
        yield {
          type: DroidMessageType.ToolResult,
          toolUseId: "tool-bash-1",
          toolName: "Bash",
          content: "file1\nfile2",
          isError: false,
        };
        yield {
          type: DroidMessageType.Result,
          subtype: "success",
          isError: false,
          sessionId: "session-1",
          durationMs: 1,
          numTurns: 1,
          result: "done",
          tokenUsage: null,
          messages: [],
          text: "done",
          turnCount: 1,
          success: true,
          error: null,
        };
      },
    );

    const connection = new DroidBridgeConnection((message) => {
      messages.push(message);
    });

    await connection.handleMessage({
      type: "prompt.submit",
      turnId: "turn-4",
      prompt: "list files",
      modelId: "claude-opus-4-8",
      reasoningEffort: "medium",
    });

    const toolEnd = messages.find(
      (entry) => entry.type === "turn.tool" && entry.phase === "end",
    ) as { artifacts?: unknown } | undefined;
    expect(toolEnd?.artifacts).toBeUndefined();
  });
});

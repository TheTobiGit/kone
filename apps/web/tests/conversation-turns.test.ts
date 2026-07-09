import { describe, expect, test } from "bun:test";

import { useConversationTurns } from "../app/composables/useConversationTurns";

describe("conversation event reduction", () => {
  test("preserves partial response when a turn errors", () => {
    const conversation = useConversationTurns();
    const turn = conversation.createTurn({
      prompt: "Inspect the app",
      modelId: "droid",
      reasoningEffort: "medium",
    });

    conversation.applyMessage({
      type: "turn.delta",
      turnId: turn.id,
      text: "Partial answer",
    });
    conversation.applyMessage({
      type: "turn.error",
      turnId: turn.id,
      message: "Connection lost",
    });

    expect(turn.responseText).toBe("Partial answer");
    expect(turn.status).toBe("error");
    expect(turn.errorMessage).toBe("Connection lost");
  });

  test("pairs a tool start and completion", () => {
    const conversation = useConversationTurns();
    const turn = conversation.createTurn({
      prompt: "Read a file",
      modelId: "droid",
      reasoningEffort: "medium",
    });

    conversation.applyMessage({
      type: "turn.tool",
      turnId: turn.id,
      toolCallId: "tool-1",
      name: "ReadFile",
      phase: "start",
    });
    conversation.applyMessage({
      type: "turn.tool",
      turnId: turn.id,
      toolCallId: "tool-1",
      name: "ReadFile",
      phase: "end",
    });

    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0]?.status).toBe("completed");
  });
});

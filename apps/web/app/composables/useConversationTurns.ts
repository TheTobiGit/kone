import type { BridgeServerMessage } from "@kone/bridge-protocol";
import { computed, ref } from "vue";

import type {
  ArtifactKind,
  ArtifactReference,
  ConversationTurn,
  ToolActivity,
  ToolActivityStatus,
} from "~/types/conversation";

type TurnMessage = Extract<BridgeServerMessage, { turnId: string }>;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const ARTIFACT_KINDS = new Set<ArtifactKind>([
  "text",
  "code",
  "markdown",
  "image",
  "diff",
  "url",
  "file",
]);

function artifactList(value: unknown): ArtifactReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.title !== "string" ||
      typeof record.source !== "string" ||
      typeof record.kind !== "string" ||
      !ARTIFACT_KINDS.has(record.kind as ArtifactKind)
    ) {
      return [];
    }
    return [
      {
        id:
          typeof record.id === "string" ? record.id : crypto.randomUUID(),
        kind: record.kind as ArtifactKind,
        title: record.title,
        source: record.source,
        language: optionalString(record.language),
        content: optionalString(record.content),
        mimeType: optionalString(record.mimeType),
        size: typeof record.size === "number" ? record.size : undefined,
      },
    ];
  });
}

function toolStatus(
  phase: unknown,
  isError: boolean,
): ToolActivityStatus {
  if (isError) return "error";
  if (phase === "start") return "running";
  if (phase === "cancelled") return "cancelled";
  return "completed";
}

export function useConversationTurns() {
  const turns = ref<ConversationTurn[]>([]);

  const hasThread = computed(() => turns.value.length > 0);
  const activeTurn = computed(
    () =>
      turns.value.findLast((turn) =>
        ["queued", "pending", "streaming"].includes(turn.status),
      ) ?? null,
  );

  function findTurn(turnId: string) {
    return turns.value.find((turn) => turn.id === turnId);
  }

  function createTurn(input: {
    prompt: string;
    modelId: string;
    reasoningEffort: string;
  }): ConversationTurn {
    const turn: ConversationTurn = {
      id: crypto.randomUUID(),
      prompt: input.prompt,
      responseText: "",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingUserToggled: false,
      status: "pending",
      tools: [],
      artifacts: [],
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      createdAt: new Date().toISOString(),
    };
    turns.value.push(turn);
    return turn;
  }

  function replaceTurns(nextTurns: ConversationTurn[]) {
    turns.value = nextTurns;
  }

  function removeTurn(turnId: string) {
    turns.value = turns.value.filter((turn) => turn.id !== turnId);
  }

  function updateThinkingExpanded(turnId: string, expanded: boolean) {
    const turn = findTurn(turnId);
    if (!turn) return;
    turn.thinkingExpanded = expanded;
    turn.thinkingUserToggled = true;
  }

  function markToolAwaitingPermission(
    turnId: string | undefined,
    toolCallId: string | undefined,
    waiting: boolean,
  ) {
    if (!turnId || !toolCallId) return;
    const tool = findTurn(turnId)?.tools.find(
      (activity) => activity.id === toolCallId,
    );
    if (!tool) return;
    if (waiting && tool.status === "running") {
      tool.status = "awaiting_permission";
    } else if (!waiting && tool.status === "awaiting_permission") {
      tool.status = "running";
    }
  }

  function applyToolMessage(turn: ConversationTurn, message: TurnMessage) {
    const payload = message as TurnMessage & Record<string, unknown>;
    const name = optionalString(payload.name) ?? "Tool";
    const isError = payload.isError === true;
    const phase = payload.phase;
    const explicitId = optionalString(payload.toolCallId);
    const nextArtifacts = artifactList(payload.artifacts);
    if (nextArtifacts.length) {
      const existingIds = new Set(turn.artifacts.map((artifact) => artifact.id));
      turn.artifacts.push(
        ...nextArtifacts.filter((artifact) => !existingIds.has(artifact.id)),
      );
    }
    const activity =
      (explicitId
        ? turn.tools.find((tool) => tool.id === explicitId)
        : undefined) ??
      [...turn.tools]
        .reverse()
        .find(
          (tool) =>
            tool.status === "running" &&
            (name === "tool" || tool.name === name),
        );

    if (activity) {
      activity.status = toolStatus(phase, isError);
      activity.isError = isError;
      activity.completedAt =
        activity.status === "running" ? undefined : new Date().toISOString();
      activity.outputSummary =
        optionalString(payload.resultSummary) ??
        optionalString(payload.outputSummary) ??
        optionalString(payload.errorMessage) ??
        activity.outputSummary;
      activity.paths = [
        ...new Set([...activity.paths, ...stringList(payload.paths)]),
      ];
      return;
    }

    const status = toolStatus(phase, isError);
    const nextActivity: ToolActivity = {
      id: explicitId ?? crypto.randomUUID(),
      name,
      kind: optionalString(payload.kind),
      status,
      inputSummary: optionalString(payload.inputSummary),
      outputSummary:
        optionalString(payload.resultSummary) ??
        optionalString(payload.outputSummary) ??
        optionalString(payload.errorMessage),
      command: optionalString(payload.command),
      paths: stringList(payload.paths),
      startedAt:
        optionalString(payload.startedAt) ?? new Date().toISOString(),
      completedAt:
        status === "running"
          ? undefined
          : optionalString(payload.completedAt) ?? new Date().toISOString(),
      isError,
    };
    turn.tools.push(nextActivity);
  }

  function applyMessage(message: BridgeServerMessage): ConversationTurn | null {
    if (!("turnId" in message) || typeof message.turnId !== "string") return null;
    const turn = findTurn(message.turnId);
    if (!turn) return null;

    switch (message.type) {
      case "turn.delta":
        turn.status = "streaming";
        turn.responseText += message.text;
        break;
      case "turn.thinking":
        turn.status = "streaming";
        turn.thinkingText += message.text;
        break;
      case "turn.tool":
        turn.status = "streaming";
        applyToolMessage(turn, message);
        break;
      case "turn.completed":
        turn.status = "completed";
        turn.completedAt = new Date().toISOString();
        if (!turn.thinkingUserToggled) turn.thinkingExpanded = false;
        for (const tool of turn.tools) {
          if (tool.status === "running") {
            tool.status = "completed";
            tool.completedAt = turn.completedAt;
          }
        }
        break;
      case "turn.error":
        turn.status = "error";
        turn.errorMessage = message.message;
        turn.completedAt = new Date().toISOString();
        if (!turn.thinkingUserToggled) turn.thinkingExpanded = false;
        break;
      default: {
        const payload = message as { type: string; message?: string };
        if (payload.type === "turn.cancelled") {
          turn.status = "cancelled";
          turn.errorMessage =
            payload.message ??
            ((payload as { reason?: string }).reason === "user"
              ? "Turn cancelled."
              : "Turn stopped before completion.");
          turn.completedAt = new Date().toISOString();
          if (!turn.thinkingUserToggled) turn.thinkingExpanded = false;
          for (const tool of turn.tools) {
            if (
              tool.status === "running" ||
              tool.status === "awaiting_permission"
            ) {
              tool.status = "cancelled";
              tool.completedAt = turn.completedAt;
            }
          }
        }
      }
    }

    return turn;
  }

  return {
    turns,
    hasThread,
    activeTurn,
    findTurn,
    createTurn,
    replaceTurns,
    removeTurn,
    updateThinkingExpanded,
    markToolAwaitingPermission,
    applyMessage,
  };
}

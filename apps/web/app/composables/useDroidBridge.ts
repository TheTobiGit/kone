import {
  resolveBridgeWsUrl,
  type BridgeClientMessage,
  type BridgeServerMessage,
  type DroidModelDescriptor,
  parseBridgeServerMessage,
} from "@kone/bridge-protocol";
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";

import { useDroidModelStore } from "~/lib/droid-model-store";
import type { PermissionRequest } from "~/types/conversation";

function getBridgeWsUrl(): string {
  if (import.meta.client && window.koneDesktop?.bridgeWsUrl) {
    return resolveBridgeWsUrl(window.koneDesktop.bridgeWsUrl);
  }

  const config = useRuntimeConfig();
  return resolveBridgeWsUrl(config.public.bridgeWsUrl);
}

export function useDroidBridge() {
  const socket = shallowRef<WebSocket | null>(null);
  const isConnected = ref(false);
  const isBridgeReady = ref(false);
  const isReconnecting = ref(false);
  const bridgeError = ref<string | null>(null);
  const permissionRequests = ref<PermissionRequest[]>([]);
  const { setDroidModels } = useDroidModelStore();
  const pendingPermission = computed(() => permissionRequests.value[0] ?? null);
  const connectionStatus = computed<
    "connecting" | "ready" | "reconnecting" | "offline"
  >(() => {
    if (isConnected.value) return "ready";
    if (isReconnecting.value) return "reconnecting";
    return socket.value ? "connecting" : "offline";
  });

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const permissionExpiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  let reconnectFailures = 0;
  let disposed = false;
  const handlers = new Set<(message: BridgeServerMessage) => void>();
  const modelReadyHandlers = new Set<
    (payload: {
      models: DroidModelDescriptor[];
      defaultModelId: string;
      defaultReasoningEffort: string;
    }) => void
  >();

  const connect = () => {
    if (
      disposed ||
      (socket.value &&
        (socket.value.readyState === WebSocket.OPEN ||
          socket.value.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }

    const ws = new WebSocket(getBridgeWsUrl());
    socket.value = ws;

    ws.addEventListener("open", () => {
      isConnected.value = true;
      isReconnecting.value = false;
      reconnectFailures = 0;
      bridgeError.value = null;
    });

    ws.addEventListener("message", (event) => {
      const message = parseBridgeServerMessage(String(event.data));
      if (!message) return;

      if (message.type === "session.ready") {
        isBridgeReady.value = true;
      }

      if (message.type === "models.available") {
        setDroidModels(message.models);
        for (const handler of modelReadyHandlers) {
          handler({
            models: message.models,
            defaultModelId: message.defaultModelId,
            defaultReasoningEffort: message.defaultReasoningEffort,
          });
        }
      }

      if (message.type === "bridge.error") {
        bridgeError.value = message.message;
      }

      if (message.type === "permission.request") {
        const payload = message as typeof message & Record<string, unknown>;
        const request: PermissionRequest = {
          requestId: message.requestId,
          detail: message.detail,
          turnId:
            typeof payload.turnId === "string" ? payload.turnId : undefined,
          toolCallId:
            typeof payload.toolCallId === "string"
              ? payload.toolCallId
              : undefined,
          requestKind:
            payload.requestKind === "command" ||
            payload.requestKind === "file-read" ||
            payload.requestKind === "file-change" ||
            payload.requestKind === "network"
              ? payload.requestKind
              : "unknown",
          target:
            typeof payload.target === "string"
              ? payload.target
              : typeof payload.command === "string"
                ? payload.command
                : Array.isArray(payload.paths) &&
                    typeof payload.paths[0] === "string"
                  ? payload.paths[0]
                  : undefined,
          expiresAt:
            typeof payload.expiresAt === "string"
              ? payload.expiresAt
              : undefined,
        };
        permissionRequests.value = [
          ...permissionRequests.value.filter(
            (entry) => entry.requestId !== request.requestId,
          ),
          request,
        ];
        const expiresAt = request.expiresAt
          ? new Date(request.expiresAt).getTime()
          : Date.now() + 120_000;
        const existingTimer = permissionExpiryTimers.get(request.requestId);
        if (existingTimer) clearTimeout(existingTimer);
        permissionExpiryTimers.set(
          request.requestId,
          setTimeout(() => {
            permissionRequests.value = permissionRequests.value.filter(
              (entry) => entry.requestId !== request.requestId,
            );
            permissionExpiryTimers.delete(request.requestId);
          }, Math.max(0, expiresAt - Date.now() + 250)),
        );
      }

      for (const handler of handlers) {
        handler(message);
      }
    });

    ws.addEventListener("close", () => {
      isConnected.value = false;
      isBridgeReady.value = false;
      socket.value = null;
      if (disposed) return;

      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectFailures++;
      isReconnecting.value = true;
      const baseDelay = Math.min(30_000, 750 * 2 ** (reconnectFailures - 1));
      const jitter = Math.round(baseDelay * (Math.random() * 0.2 - 0.1));
      reconnectTimer = setTimeout(connect, Math.max(500, baseDelay + jitter));
    });

    ws.addEventListener("error", () => {
      bridgeError.value = "Could not connect to the Droid bridge.";
    });

  };

  const send = (message: BridgeClientMessage) => {
    if (!socket.value || socket.value.readyState !== WebSocket.OPEN) {
      bridgeError.value = "Bridge is not connected. Start it with `bun run dev:bridge`.";
      return false;
    }

    socket.value.send(JSON.stringify(message));
    return true;
  };

  const submitPrompt = (input: {
    turnId: string;
    prompt: string;
    modelId: string;
    reasoningEffort: string;
    thinking?: boolean;
  }) =>
    send(
      {
        type: "prompt.submit",
        ...input,
      } as BridgeClientMessage,
    );

  const respondToPermission = (approved: boolean, requestId?: string) => {
    const request =
      permissionRequests.value.find((entry) => entry.requestId === requestId) ??
      pendingPermission.value;
    if (!request) return;

    const sent = send({
      type: "permission.respond",
      requestId: request.requestId,
      approved,
    });
    if (sent) {
      const expiryTimer = permissionExpiryTimers.get(request.requestId);
      if (expiryTimer) clearTimeout(expiryTimer);
      permissionExpiryTimers.delete(request.requestId);
      permissionRequests.value = permissionRequests.value.filter(
        (entry) => entry.requestId !== request.requestId,
      );
    }
  };

  const cancelTurn = (turnId: string) =>
    send({ type: "turn.cancel", turnId } as BridgeClientMessage);

  const onMessage = (handler: (message: BridgeServerMessage) => void) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };

  const onModelsReady = (
    handler: (payload: {
      models: DroidModelDescriptor[];
      defaultModelId: string;
      defaultReasoningEffort: string;
    }) => void,
  ) => {
    modelReadyHandlers.add(handler);
    return () => modelReadyHandlers.delete(handler);
  };

  const refreshModels = () => send({ type: "models.list" });

  onMounted(connect);

  onUnmounted(() => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket.value?.close();
    handlers.clear();
    modelReadyHandlers.clear();
    for (const timer of permissionExpiryTimers.values()) clearTimeout(timer);
    permissionExpiryTimers.clear();
  });

  return {
    isConnected,
    isBridgeReady,
    isReconnecting,
    connectionStatus,
    bridgeError,
    pendingPermission,
    permissionRequests,
    submitPrompt,
    cancelTurn,
    respondToPermission,
    onMessage,
    onModelsReady,
    refreshModels,
    connect,
  };
}

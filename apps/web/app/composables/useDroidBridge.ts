import {
  resolveBridgeWsUrl,
  type BridgeClientMessage,
  type BridgeServerMessage,
  type DroidModelDescriptor,
  parseBridgeServerMessage,
} from "@kone/bridge-protocol";
import { onMounted, onUnmounted, ref, shallowRef } from "vue";

import { useDroidModelStore } from "~/lib/droid-model-store";

function getBridgeWsUrl(): string {
  if (import.meta.client && window.koneDesktop?.bridgeWsUrl) {
    return resolveBridgeWsUrl(window.koneDesktop.bridgeWsUrl);
  }

  const config = useRuntimeConfig();
  return resolveBridgeWsUrl(config.public.bridgeWsUrl);
}

export type PendingPermission = {
  requestId: string;
  detail: string;
};

export function useDroidBridge() {
  const socket = shallowRef<WebSocket | null>(null);
  const isConnected = ref(false);
  const isBridgeReady = ref(false);
  const bridgeError = ref<string | null>(null);
  const pendingPermission = ref<PendingPermission | null>(null);
  const { setDroidModels } = useDroidModelStore();

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const handlers = new Set<(message: BridgeServerMessage) => void>();
  const modelReadyHandlers = new Set<
    (payload: {
      models: DroidModelDescriptor[];
      defaultModelId: string;
      defaultReasoningEffort: string;
    }) => void
  >();

  const connect = () => {
    if (socket.value && socket.value.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(getBridgeWsUrl());

    ws.addEventListener("open", () => {
      isConnected.value = true;
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
        pendingPermission.value = {
          requestId: message.requestId,
          detail: message.detail,
        };
      }

      for (const handler of handlers) {
        handler(message);
      }
    });

    ws.addEventListener("close", () => {
      isConnected.value = false;
      isBridgeReady.value = false;
      socket.value = null;

      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1500);
    });

    ws.addEventListener("error", () => {
      bridgeError.value = "Could not connect to the Droid bridge.";
    });

    socket.value = ws;
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
  }) =>
    send({
      type: "prompt.submit",
      ...input,
    });

  const respondToPermission = (approved: boolean) => {
    const request = pendingPermission.value;
    if (!request) return;

    send({
      type: "permission.respond",
      requestId: request.requestId,
      approved,
    });
    pendingPermission.value = null;
  };

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
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket.value?.close();
    handlers.clear();
  });

  return {
    isConnected,
    isBridgeReady,
    bridgeError,
    pendingPermission,
    submitPrompt,
    respondToPermission,
    onMessage,
    onModelsReady,
    refreshModels,
    connect,
  };
}

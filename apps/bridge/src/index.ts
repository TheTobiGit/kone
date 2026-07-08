import {
  BRIDGE_WS_PORT,
  type BridgeServerMessage,
  parseBridgeClientMessage,
} from "@kone/bridge-protocol";

import { DroidBridgeConnection } from "./droid-bridge";
import { loadDroidModels } from "./droid-models";

type BridgeSocketData = {
  connection: DroidBridgeConnection;
};

async function sendAvailableModels(send: (message: BridgeServerMessage) => void) {
  try {
    const catalog = await loadDroidModels();
    send({
      type: "models.available",
      models: catalog.models,
      defaultModelId: catalog.defaultModelId,
      defaultReasoningEffort: catalog.defaultReasoningEffort,
    });
  } catch (error) {
    send({
      type: "bridge.error",
      message:
        error instanceof Error
          ? `Failed to load Droid models: ${error.message}`
          : "Failed to load Droid models.",
    });
  }
}

Bun.serve<BridgeSocketData>({
  port: BRIDGE_WS_PORT,
  fetch(request, server) {
    if (server.upgrade(request, { data: { connection: null! } })) {
      return undefined;
    }

    return new Response("Kone Droid bridge\n", {
      headers: { "content-type": "text/plain" },
    });
  },
  websocket: {
    open(ws) {
      const send = (message: BridgeServerMessage) => {
        ws.send(JSON.stringify(message));
      };

      ws.data.connection = new DroidBridgeConnection(send);
      void sendAvailableModels(send);
    },
    async message(ws, rawMessage) {
      const text = typeof rawMessage === "string" ? rawMessage : rawMessage.toString();
      const message = parseBridgeClientMessage(text);

      if (!message) {
        ws.send(JSON.stringify({ type: "bridge.error", message: "Invalid message payload." }));
        return;
      }

      if (message.type === "models.list") {
        await sendAvailableModels((payload) => {
          ws.send(JSON.stringify(payload));
        });
        return;
      }

      await ws.data.connection.handleMessage(message);
    },
    async close(ws) {
      await ws.data.connection.close();
    },
  },
});

console.log(`Kone Droid bridge listening on ws://localhost:${BRIDGE_WS_PORT}`);

import { BRIDGE_WS_URL } from "@kone/bridge-protocol";
import { contextBridge } from "electron";

const api = {
  isDesktop: true as const,
  bridgeWsUrl: BRIDGE_WS_URL,
  platform: process.platform,
  version: process.versions.electron,
};

contextBridge.exposeInMainWorld("koneDesktop", api);

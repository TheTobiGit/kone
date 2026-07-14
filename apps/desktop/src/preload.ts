import { contextBridge } from "electron";

const api = {
  isDesktop: true as const,
  platform: process.platform,
  version: process.versions.electron,
};

contextBridge.exposeInMainWorld("koneDesktop", api);

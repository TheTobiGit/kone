export type KoneDesktopApi = {
  isDesktop: true;
  bridgeWsUrl: string;
  platform: NodeJS.Platform;
  version: string;
};

declare global {
  interface Window {
    koneDesktop?: KoneDesktopApi;
  }
}

export {};

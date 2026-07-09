export type KoneDesktopApi = {
  isDesktop: true;
  bridgeWsUrl: string;
  platform: string;
  version: string;
};

declare global {
  interface Window {
    koneDesktop?: KoneDesktopApi;
  }
}

export {};

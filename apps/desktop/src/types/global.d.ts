export type KoneDesktopApi = {
  isDesktop: true;
  platform: NodeJS.Platform;
  version: string;
};

declare global {
  interface Window {
    koneDesktop?: KoneDesktopApi;
  }
}

export {};

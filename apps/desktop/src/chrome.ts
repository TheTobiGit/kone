export const CHROME_HEADER_HEIGHT_PX = 46;
export const MAC_TRAFFIC_LIGHT_INSET_X_PX = 16;
export const MAC_TRAFFIC_LIGHT_INSET_Y_PX = 10;

export function getMacTrafficLightPosition(): { x: number; y: number } {
  return {
    x: MAC_TRAFFIC_LIGHT_INSET_X_PX,
    y: MAC_TRAFFIC_LIGHT_INSET_Y_PX,
  };
}

export type TitleBarOptions = {
  frame?: false;
  titleBarStyle?: "hiddenInset";
  trafficLightPosition?: { x: number; y: number };
  autoHideMenuBar?: boolean;
};

export function titleBarOptions(platform: NodeJS.Platform): TitleBarOptions {
  if (platform === "win32") {
    // Frame-free so the renderer draws its own caption cluster.
    return { frame: false, autoHideMenuBar: true };
  }
  if (platform === "darwin") {
    // Native traffic lights, inset into the renderer's header strip.
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: getMacTrafficLightPosition(),
    };
  }
  // Keep the OS frame elsewhere so the platform supplies the window buttons.
  return {};
}

export type WindowChromeState = {
  isMaximized: boolean;
  isFullscreen: boolean;
};

export function windowChromeState(win: {
  isMaximized(): boolean;
  isFullScreen(): boolean;
}): WindowChromeState {
  return {
    isMaximized: win.isMaximized(),
    isFullscreen: win.isFullScreen(),
  };
}

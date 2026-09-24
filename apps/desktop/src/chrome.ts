export const CHROME_HEADER_HEIGHT_PX = 46;
export const MAC_TRAFFIC_LIGHT_INSET_X_PX = 16;
export const MAC_TRAFFIC_LIGHT_INSET_Y_PX = 6;

export type MacTrafficLightPosition = { x: number; y: number };

export function getMacTrafficLightPosition(): MacTrafficLightPosition {
  return {
    x: MAC_TRAFFIC_LIGHT_INSET_X_PX,
    y: MAC_TRAFFIC_LIGHT_INSET_Y_PX,
  };
}

export type TitleBarOptions = {
  frame?: false;
  hasShadow?: false;
  titleBarStyle?: "hiddenInset";
  trafficLightPosition?: { x: number; y: number };
};

export function titleBarOptions(platform: NodeJS.Platform): TitleBarOptions {
  if (platform === "darwin") {
    // Native traffic lights, inset into the renderer's header strip.
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: getMacTrafficLightPosition(),
    };
  }
  // Windows and Linux: frame-free so the renderer draws its own caption
  // cluster (<WindowCaption>, fixed top-right). The application menu is
  // removed globally via Menu.setApplicationMenu(null), so no per-window
  // hiding is needed.
  if (platform === "linux") {
    // No shadow: on Wayland a frameless window otherwise gets GTK drop
    // shadows and extended resize borders, drawn as a band of empty surface
    // around the content (and tiling compositors like niri show it as a gap).
    return { frame: false, hasShadow: false };
  }
  return { frame: false };
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

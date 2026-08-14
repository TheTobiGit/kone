import { describe, expect, test } from "bun:test";

import {
  getMacTrafficLightPosition,
  titleBarOptions,
  windowChromeState,
} from "./chrome.js";

describe("getMacTrafficLightPosition", () => {
  test("centers the traffic-light row on the 46px header", () => {
    expect(getMacTrafficLightPosition()).toEqual({ x: 16, y: 16 });
  });
});

describe("titleBarOptions", () => {
  test("darwin keeps the native traffic lights and insets them in the content", () => {
    expect(titleBarOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    });
  });

  test("win32 drops the frame for renderer-drawn caption buttons", () => {
    expect(titleBarOptions("win32")).toEqual({
      frame: false,
      autoHideMenuBar: true,
    });
  });

  test("linux keeps the native frame so the OS supplies window buttons", () => {
    expect(titleBarOptions("linux")).toEqual({});
  });
});

describe("windowChromeState", () => {
  test("reads both maximized and fullscreen flags", () => {
    const win = {
      isMaximized: () => true,
      isFullScreen: () => false,
    };
    expect(windowChromeState(win)).toEqual({
      isMaximized: true,
      isFullscreen: false,
    });
  });

  test("reports false for both flags when the window is normal", () => {
    const win = {
      isMaximized: () => false,
      isFullScreen: () => false,
    };
    expect(windowChromeState(win)).toEqual({
      isMaximized: false,
      isFullscreen: false,
    });
  });

  test("reflects fullscreen independently of maximized", () => {
    const win = {
      isMaximized: () => false,
      isFullScreen: () => true,
    };
    expect(windowChromeState(win)).toEqual({
      isMaximized: false,
      isFullscreen: true,
    });
  });
});

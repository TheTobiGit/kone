import { BrowserWindow } from "electron";
import { z } from "zod";

import type { VisualConsoleMessage, VisualMeasurer, VisualPreview, VisualPreviewer } from "@kone/agent-core/gateway/index.js";
import { VISUAL_MAX_HEIGHT, VISUAL_MIN_HEIGHT, visualThemeFragment, type VisualAppearance, type VisualTheme } from "@kone/protocol/visual-render";

import { currentVisualTheme } from "./modules/system/system.js";
import { holdPreviewVisual } from "./visualProtocol.js";
import { renderScope } from "./renderScope.js";

// Renders an agent's visual off screen: for `visual_preview`, the screenshot,
// the height the visual needs, and what it logged; for `visual_show`, the
// height it needs at each width it is drawn at. The app already ships a browser,
// so a preview is one more hidden window of it rather than a browser of its
// own to download.
//
// Each render gets a fresh window that is gone when the call returns, so one
// visual's scripts and state can never reach the next, and nothing outlives the
// call to cost memory.

/** The whole render, from load to screenshot: long enough for a chart library
 *  to arrive from a CDN and draw; a visual that takes longer than this has a
 *  problem the agent should hear about. */
const RENDER_TIMEOUT_MS = 20_000;
/** After load, how long scripts get to finish drawing before the visual is
 *  measured. Charts commonly animate in on load. */
const SETTLE_MS = 600;
/** The viewport a visual is first laid out in, before it is resized to fit. */
const INITIAL_HEIGHT = 800;
/** Enough to see what went wrong without one noisy loop flooding the answer. */
const MAX_CONSOLE_MESSAGES = 50;
const MAX_CONSOLE_TEXT = 1_000;

// A visual laid out at a viewport taller than itself reports the viewport as
// its scroll height, so a short visual is measured by its own box instead.
const MEASURE_SCRIPT = `(() => {
  const root = document.documentElement;
  return Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
})()`;

// Two frames: one for the resize to lay out, one for it to paint.
const NEXT_PAINT_SCRIPT = `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`;
/** After a resize, how long a script that lays itself out on resize (a chart
 *  redrawing to its new width) gets before the height is read. */
const RESIZE_SETTLE_MS = 150;

/** The theme the visual is checked in: the one on the user's screen, unless the
 *  agent asks for the other appearance. Asked for the other one, or before the
 *  app has reported a theme, the visual gets no variables and its base
 *  stylesheet's fallbacks — a preview never paints in colours nobody is
 *  looking at. */
function previewTheme(appearance: VisualAppearance | undefined): VisualTheme {
  const live = currentVisualTheme();
  if (live && (appearance === undefined || live.appearance === appearance)) return live;
  return { appearance: appearance ?? "dark", variables: {} };
}

function consoleLevel(level: "info" | "warning" | "error" | "debug"): VisualConsoleMessage["level"] {
  return level === "warning" || level === "error" ? level : "log";
}

/** A hidden window for one render. The visual is the agent's, so it goes
 *  nowhere: no new windows, no navigating away from itself. */
function renderWindow(width: number): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width,
    height: INITIAL_HEIGHT,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  return win;
}

/** What the measuring script answers with: the height the visual needs. */
const MeasuredHeightSchema = z.coerce.number().positive().finite().catch(INITIAL_HEIGHT);

/** The height a measurement read, or the starting height when it read none. */
function measureHeight(contents: Electron.WebContents, scope: ReturnType<typeof renderScope>): Promise<number> {
  return scope.run(contents.executeJavaScript(MEASURE_SCRIPT)).then((measured) => MeasuredHeightSchema.parse(measured));
}

export const previewVisual: VisualPreviewer = async ({ html, width, appearance }, signal) => {
  signal?.throwIfAborted();
  // One deadline and one cancellation for every step, so a script that hangs
  // after load is cut off like one that never loads, and the window goes the
  // moment either fires.
  const scope = renderScope(
    RENDER_TIMEOUT_MS,
    signal,
    `The visual did not finish rendering within ${RENDER_TIMEOUT_MS / 1000}s.`,
  );
  const held = holdPreviewVisual(html);
  const win = renderWindow(width);
  try {
    const contents = win.webContents;

    const consoleMessages: VisualConsoleMessage[] = [];
    contents.on("console-message", ({ level, message }) => {
      if (consoleMessages.length >= MAX_CONSOLE_MESSAGES) return;
      consoleMessages.push({ level: consoleLevel(level), text: message.slice(0, MAX_CONSOLE_TEXT) });
    });

    const theme = previewTheme(appearance);
    await scope.run(win.loadURL(held.url + visualThemeFragment(theme)));
    await scope.wait(SETTLE_MS);

    const contentHeight = await measureHeight(contents, scope);
    const capturedHeight = Math.max(1, Math.min(contentHeight, VISUAL_MAX_HEIGHT));
    win.setContentSize(width, capturedHeight);
    await scope.run(contents.executeJavaScript(NEXT_PAINT_SCRIPT));

    const image = await scope.run(contents.capturePage());
    const result: VisualPreview = {
      png: image.toPNG().toString("base64"),
      width,
      appearance: theme.appearance,
      contentHeight,
      capturedHeight,
      consoleMessages,
    };
    return result;
  } finally {
    scope.dispose();
    win.destroy();
    held.release();
  }
};

/** The visual's height at each width, read from one window loaded once and
 *  resized across them, in the theme on the user's screen. A window is laid
 *  out at a short viewport before each read, since a visual laid out taller
 *  than itself reports the viewport rather than its own height. */
export const measureVisual: VisualMeasurer = async ({ html, widths }, signal) => {
  signal?.throwIfAborted();
  const [first] = widths;
  if (first === undefined) return [];
  const scope = renderScope(RENDER_TIMEOUT_MS, signal, `The visual could not be measured within ${RENDER_TIMEOUT_MS / 1000}s.`);
  const held = holdPreviewVisual(html);
  const win = renderWindow(first);
  try {
    const contents = win.webContents;
    await scope.run(win.loadURL(held.url + visualThemeFragment(previewTheme(undefined))));
    await scope.wait(SETTLE_MS);
    const heights: Array<[number, number]> = [];
    for (const width of widths) {
      win.setContentSize(width, VISUAL_MIN_HEIGHT);
      await scope.run(contents.executeJavaScript(NEXT_PAINT_SCRIPT));
      await scope.wait(RESIZE_SETTLE_MS);
      heights.push([width, await measureHeight(contents, scope)]);
    }
    return heights;
  } finally {
    scope.dispose();
    win.destroy();
    held.release();
  }
};

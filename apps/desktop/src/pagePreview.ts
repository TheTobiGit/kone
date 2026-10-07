import { BrowserWindow } from "electron";

import type { PageConsoleMessage, PagePreview, PagePreviewer } from "@kone/agent-core/gateway/index.js";
import { PAGE_MAX_HEIGHT, pageThemeFragment, type PageAppearance, type PageTheme } from "@kone/protocol/page-render";

import { currentPageTheme } from "./modules/system/system.js";
import { holdPreviewPage } from "./pageProtocol.js";
import { renderScope } from "./renderScope.js";

// Renders an agent's page off screen, for `page_preview`: the screenshot, the
// height the page needs, and what it logged. The app already ships a browser,
// so a preview is one more hidden window of it rather than a browser of its
// own to download.
//
// Each preview gets a fresh window that is gone when the call returns, so one
// page's scripts and state can never reach the next, and nothing outlives the
// call to cost memory.

/** The whole render, from load to screenshot: long enough for a chart library
 *  to arrive from a CDN and draw; a page that takes longer than this has a
 *  problem the agent should hear about. */
const RENDER_TIMEOUT_MS = 20_000;
/** After load, how long scripts get to finish drawing before the page is
 *  measured. Charts commonly animate in on load. */
const SETTLE_MS = 600;
/** The viewport a page is first laid out in, before it is resized to fit. */
const INITIAL_HEIGHT = 800;
/** Enough to see what went wrong without one noisy loop flooding the answer. */
const MAX_CONSOLE_MESSAGES = 50;
const MAX_CONSOLE_TEXT = 1_000;

// A page laid out at a viewport taller than itself reports the viewport as
// its scroll height, so a short page is measured by its own box instead.
const MEASURE_SCRIPT = `(() => {
  const root = document.documentElement;
  return Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
})()`;

// Two frames: one for the resize to lay out, one for it to paint.
const NEXT_PAINT_SCRIPT = `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`;

/** The theme the page is checked in: the one on the user's screen, unless the
 *  agent asks for the other appearance. Asked for the other one, or before the
 *  app has reported a theme, the page gets no variables and its base
 *  stylesheet's fallbacks — a preview never paints in colours nobody is
 *  looking at. */
function previewTheme(appearance: PageAppearance | undefined): PageTheme {
  const live = currentPageTheme();
  if (live && (appearance === undefined || live.appearance === appearance)) return live;
  return { appearance: appearance ?? "dark", variables: {} };
}

function consoleLevel(level: "info" | "warning" | "error" | "debug"): PageConsoleMessage["level"] {
  return level === "warning" || level === "error" ? level : "log";
}

export const previewPage: PagePreviewer = async ({ html, width, appearance }, signal) => {
  signal?.throwIfAborted();
  // One deadline and one cancellation for every step, so a script that hangs
  // after load is cut off like one that never loads, and the window goes the
  // moment either fires.
  const scope = renderScope(
    RENDER_TIMEOUT_MS,
    signal,
    `The page did not finish rendering within ${RENDER_TIMEOUT_MS / 1000}s.`,
  );
  const held = holdPreviewPage(html);
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
  try {
    const contents = win.webContents;
    // The page is the agent's, so it goes nowhere: no new windows, no
    // navigating away from itself.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());

    const consoleMessages: PageConsoleMessage[] = [];
    contents.on("console-message", ({ level, message }) => {
      if (consoleMessages.length >= MAX_CONSOLE_MESSAGES) return;
      consoleMessages.push({ level: consoleLevel(level), text: message.slice(0, MAX_CONSOLE_TEXT) });
    });

    const theme = previewTheme(appearance);
    await scope.run(win.loadURL(held.url + pageThemeFragment(theme)));
    await scope.wait(SETTLE_MS);

    const measured = Number(await scope.run(contents.executeJavaScript(MEASURE_SCRIPT)));
    const contentHeight = Number.isFinite(measured) && measured > 0 ? measured : INITIAL_HEIGHT;
    const capturedHeight = Math.max(1, Math.min(contentHeight, PAGE_MAX_HEIGHT));
    win.setContentSize(width, capturedHeight);
    await scope.run(contents.executeJavaScript(NEXT_PAINT_SCRIPT));

    const image = await scope.run(contents.capturePage());
    const result: PagePreview = {
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

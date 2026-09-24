import { shellChrome } from "~/utils/desktopShell";

/** Window-chrome flags, set once at boot — not as a side effect of the
 *  caption component mounting.
 *
 *  `window.koneDesktop.platform` is available synchronously, so the class is
 *  present before first paint and no frame renders with the wrong layout.
 *  The caption component then only renders buttons.
 *
 *  `frameless` — the caption floats over the content (Windows).
 *  `titlebar` — the caption sits in its own bar above the app (Linux). */
export default defineNuxtPlugin(() => {
  if (!import.meta.client) return;
  try {
    const chrome = shellChrome(window.koneDesktop?.platform);
    const root = document.documentElement;
    root.classList.toggle("frameless", chrome === "overlay");
    root.classList.toggle("titlebar", chrome === "titlebar");
  } catch {
    /* DOM unavailable — browser build stays framed. */
  }
});

import { shellChrome, type ShellChrome } from "~/utils/desktopShell";

/** The window-chrome mode, decided once at boot — not as a side effect of the
 *  caption component mounting.
 *
 *  `window.koneDesktop.platform` is available synchronously, so
 *  `<html data-chrome>` is set before first paint and no frame renders with
 *  the wrong layout. Styles key off that attribute; `<WindowCaption>` reads
 *  the same answer through `$shellChrome` and only renders buttons. Runs on
 *  the server too, so a server-rendered caption agrees with hydration. */
export default defineNuxtPlugin(() => {
  let chrome: ShellChrome = "native";
  // Server render (browser build) has no shell and no DOM: stays native.
  if (!import.meta.client) return { provide: { shellChrome: chrome } };
  try {
    chrome = shellChrome(window.koneDesktop?.platform);
    document.documentElement.dataset.chrome = chrome;
  } catch {
    /* DOM unavailable — browser build stays framed. */
  }
  return { provide: { shellChrome: chrome } };
});

/** How the desktop shell draws its window chrome.
 *
 *  - `overlay` (Windows): frameless, with a fixed caption cluster top-right
 *    over the content, which clears room for it (`--caption-inset`) and
 *    doubles as the window drag surface.
 *  - `titlebar` (Linux): frameless, with a slim renderer-drawn title bar
 *    above the app holding the drag surface and the caption buttons. The app
 *    sits below it untouched — the same layout as the macOS window.
 *  - `native`: macOS (native traffic lights) and the browser (its own chrome).
 *
 *  See `ui/WindowCaption` for the buttons and `plugins/frameless.client` for
 *  the root classes each mode sets. */
export type ShellChrome = "overlay" | "titlebar" | "native";

export function shellChrome(platform: string | undefined): ShellChrome {
  if (platform === "win32") return "overlay";
  if (platform === "linux") return "titlebar";
  return "native";
}

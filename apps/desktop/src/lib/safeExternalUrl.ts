/**
 * Canonicalize a string that may be handed to shell.openExternal.
 * Only http and https survive: file:, javascript:, custom schemes, and
 * unparseable strings would otherwise reach the OS protocol handler.
 */
export function parseSafeExternalUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/**
 * True when navigationUrl is still inside the renderer we loaded (same
 * protocol and host). Custom schemes report origin as the string "null",
 * so file: would compare equal to app: if we used origin — protocol+host
 * is the check that actually separates them.
 */
export function isRendererOriginNavigation(
  applicationUrl: string,
  navigationUrl: string,
): boolean {
  try {
    const app = new URL(applicationUrl);
    const nav = new URL(navigationUrl);
    return app.protocol === nav.protocol && app.host === nav.host;
  } catch {
    return false;
  }
}

/**
 * Fetching a picture for an agent.
 *
 * This has to happen in main, and the reason is worth stating: the renderer can
 * *display* a cross-origin image but not *read* it — a canvas that has drawn one
 * refuses to hand back its pixels — and the bytes are the whole point here. The
 * generator answers with a different face on every request, so a stored URL
 * would repaint a new face forever; only bytes make a picture stay the agent's.
 *
 * Deliberately narrow for something that takes a URL from the renderer. HTTPS
 * only, an image content type or nothing, a hard size cap, and a timeout — the
 * renderer is our own code, but a handler that will fetch anything and hand back
 * the bytes is worth more than the convenience of leaving it open.
 */
import { ipcMain } from "electron";

import type { AvatarFetchInput, AvatarFetchResult } from "./types.js";

/** Long enough for a slow generator, short enough that a picker doesn't hang on
 *  a source that has stopped answering. */
const TIMEOUT_MS = 15_000;

/** The largest picture worth carrying home. The generator's own is around a
 *  megabyte; anything far past that is not the thing we asked for, and it is
 *  about to be downscaled to a fraction of it anyway. */
const MAX_BYTES = 8 * 1024 * 1024;

let registered = false;

/** Read a picture's bytes, or null when there was nothing to read. Every
 *  failure — offline, refused, a redirect to something that isn't an image, a
 *  body past the cap — answers the same way: no picture. The caller's fallback
 *  is the same in every case, so distinguishing them would only give the picker
 *  a list of excuses to show. */
async function fetchAvatar(url: string): Promise<AvatarFetchResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== "https:") return null;

  try {
    const response = await fetch(target, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Asking for an image is also how a source that would rather answer with
      // an HTML page is told not to bother.
      headers: { accept: "image/*" },
    });
    if (!response.ok) return null;

    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!mime.startsWith("image/")) return null;

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) return null;
    return { mime, bytes: new Uint8Array(buffer) };
  } catch (err) {
    console.error("[avatars] fetch failed:", err);
    return null;
  }
}

/** Register the avatars:* IPC handlers. Call once, before creating the window. */
export function registerAvatarsIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle("avatars:fetch", (_event, input: AvatarFetchInput) => fetchAvatar(input.url));
}

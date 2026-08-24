// Dev fallback for fetching an agent's picture (desktop uses the Electron
// bridge). The packaged app has no server at all — it loads over `app://` with
// nitro built static — so this route exists purely so the picker works in a
// browser `nuxt dev`, where the bridge is absent.
//
// It has to be server-side either way: the renderer can display a cross-origin
// image but not read its bytes, and the bytes are the point — the generator
// answers with a different face on each request, so a stored URL would repaint a
// new face forever.
//
// Same narrowness as the bridge handler: HTTPS only, an image content type or
// nothing, a size cap, a timeout. Answers the raw bytes with their own content
// type, so the caller can put the response straight on a canvas.

/** Long enough for a slow generator, short enough that a picker doesn't hang. */
const TIMEOUT_MS = 15_000;
/** The largest picture worth carrying home, before it is downscaled. */
const MAX_BYTES = 8 * 1024 * 1024;

export default defineEventHandler(async (event) => {
  const { url } = getQuery<{ url?: string }>(event);
  if (!url || !url.trim()) {
    throw createError({ statusCode: 400, statusMessage: "No url" });
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Bad url" });
  }
  if (target.protocol !== "https:") {
    throw createError({ statusCode: 400, statusMessage: "https only" });
  }

  let response: Response;
  try {
    response = await fetch(target, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "image/*" },
    });
  } catch {
    throw createError({ statusCode: 502, statusMessage: "Fetch failed" });
  }
  if (!response.ok) {
    throw createError({ statusCode: 502, statusMessage: "Source declined" });
  }

  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!mime.startsWith("image/")) {
    throw createError({ statusCode: 502, statusMessage: "Not an image" });
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) {
    throw createError({ statusCode: 502, statusMessage: "Nothing usable" });
  }

  setResponseHeader(event, "content-type", mime);
  // A generated face is a one-off: caching it would hand the same one back to
  // the next agent, which is the opposite of what the picker is for.
  setResponseHeader(event, "cache-control", "no-store");
  return new Uint8Array(buffer);
});

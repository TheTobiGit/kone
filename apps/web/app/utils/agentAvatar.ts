/**
 * Getting a picture for an agent.
 *
 * The picture is stored by value — a data URL on the agent's row — and that is
 * forced by the source rather than chosen: the generator answers with a
 * different face on every request, so keeping the URL would give the agent a new
 * face on every paint. The one thing an identity cannot do is change.
 *
 * Which means the bytes have to come home, and they cannot come home through the
 * renderer alone: a cross-origin image can be *displayed* but not *read* — a
 * canvas that has drawn one refuses to hand back its pixels. So both paths here
 * go through something that is allowed to read them. The packaged app goes over
 * the bridge, because it loads from `app://` and has no server of its own; a
 * browser `nuxt dev` goes to a nitro route, which is the only reason that route
 * exists. Bridge first, route second, the same arrangement `agentStore` uses.
 *
 * A picture off the maker's own disk takes the second half of this and none of
 * the first — no network, but the same downscale, so every source lands on the
 * row at the same size. Drawn portraits live in `agentDicebear`, which is loaded
 * on demand because it carries libraries of parts with it.
 *
 * What lands on the row is downscaled and re-encoded here rather than stored as
 * fetched. A megabyte per agent would be an expensive thing to carry in a row
 * that is read on every paint — and in browser dev, where rows live in
 * localStorage, a couple of them would fill it.
 */
import type { AgentAvatar } from "~/utils/agents";

/** Where a face with nobody behind it comes from. The image itself, not the page
 *  around it — the site's root answers with HTML, and the picture is what we are
 *  here for. The only source today; the others the picker will grow — an upload,
 *  a generated pattern — land on the same stored shape, so nothing downstream has
 *  to learn about them. */
export const GENERATED_AVATAR_URL = "https://thispersondoesnotexist.com/random-person.jpeg";

/**
 * How large a stored picture is, in pixels a side.
 *
 * Sized for the largest place one is drawn with room to spare on a dense
 * display, and no larger: everything above that is bytes carried in a row to
 * paint detail nothing shows. 256 lands around 25KB as JPEG.
 */
const SIZE = 256;

/** JPEG rather than PNG, and at this quality, because a photographed face is
 *  exactly what JPEG is good at — the same picture as PNG costs several times
 *  more, and the artefacts are invisible at this size. */
const MIME = "image/jpeg";
const QUALITY = 0.82;

function bridge() {
  return import.meta.client ? window.koneDesktop?.avatars : undefined;
}

/** The picture's bytes, whichever path can reach them. Null for every failure —
 *  offline, refused, an answer that wasn't an image — because the caller's
 *  answer is the same in each case: no picture this time. */
async function fetchImage(url: string): Promise<Blob | null> {
  const api = bridge();
  if (api) {
    const answer = await api.fetch({ url });
    if (!answer) return null;
    // Copied out of the transferred view rather than wrapped: what crosses the
    // bridge may sit in a buffer the structured clone owns, and a Blob has to
    // hold bytes of its own.
    return new Blob([new Uint8Array(answer.bytes)], { type: answer.mime });
  }

  try {
    const response = await fetch(`/api/avatar?url=${encodeURIComponent(url)}`);
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

/**
 * A picture, squared off and shrunk to the stored size.
 *
 * Cropped to the centre square before scaling, never squashed to fit: a face
 * stretched to a square stops being a picture of anybody. The source is square
 * already today, so this only matters for the sources the picker will grow.
 */
async function downscale(blob: Blob): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      SIZE,
      SIZE,
    );
    const dataUrl = canvas.toDataURL(MIME, QUALITY);
    // A canvas that could not encode answers with a bare "data:," rather than
    // throwing, which would store as a picture that paints nothing.
    return dataUrl.startsWith(`data:${MIME}`) ? dataUrl : null;
  } finally {
    bitmap.close();
  }
}

/**
 * Fetch a face and give it back ready to store, or null if there was none to be
 * had.
 *
 * Null is not an error to report loudly: the picker's answer to it is to leave
 * the agent as it was, which is a face it already has.
 */
export async function generateAvatar(): Promise<AgentAvatar | null> {
  if (!import.meta.client) return null;
  const blob = await fetchImage(GENERATED_AVATAR_URL);
  if (!blob) return null;
  const src = await downscale(blob);
  return src ? { source: "generated", src } : null;
}

/**
 * The largest file worth reading off disk.
 *
 * Generous, since everything above the stored size is thrown away a moment
 * later — this only exists so a maker who picked a video or a RAW file by
 * mistake gets an answer instead of a stalled tab.
 */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * A picture the maker chose themselves, put through the same mill.
 *
 * Downscaled and re-encoded exactly like a fetched one, which is the point of
 * doing it there rather than at the fetch: what lands on the row is the same
 * shape and the same size whatever the maker started from, and a photo off a
 * phone doesn't put four megabytes into a row that is read on every paint.
 */
export async function uploadAvatar(file: File): Promise<AgentAvatar | null> {
  if (!import.meta.client) return null;
  if (!file.type.startsWith("image/")) return null;
  if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) return null;
  const src = await downscale(file);
  return src ? { source: "upload", src } : null;
}

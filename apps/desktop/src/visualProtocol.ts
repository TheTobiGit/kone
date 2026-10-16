import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  injectVisualBootstrap,
  VISUAL_CONTENT_SECURITY_POLICY,
  VISUAL_SCHEME,
  VISUAL_UNAVAILABLE_HTML,
} from "@kone/protocol/visual-render";

// The scheme agents' visuals are served on: `kone-visual://<attachmentId>/` for a
// visual shown in a thread, `kone-visual://preview-<token>/` for one being
// previewed off screen. A visual gets its own scheme rather than riding the
// attachment one, so the frame it runs in shares an origin with nothing —
// and every response carries a sandboxing policy of its own, so it stays
// walled off even if something loads it outside that frame.

export type VisualTarget = { kind: "stored"; attachmentId: string } | { kind: "preview"; token: string };

const SAFE_ATTACHMENT_ID = /^att_[0-9a-f-]+$/;
const PREVIEW_HOST = /^preview-([0-9a-f-]+)$/;

/** What a visual URL names, or null. Only the document itself is served: a visual
 *  is self-contained, and a relative path inside one must not resolve to
 *  anything. */
export function resolveVisualTarget(requestUrl: string): VisualTarget | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${VISUAL_SCHEME}:` || (url.pathname !== "/" && url.pathname !== "")) return null;
  const host = url.hostname.toLowerCase();
  const preview = PREVIEW_HOST.exec(host);
  if (preview) return { kind: "preview", token: preview[1]! };
  return SAFE_ATTACHMENT_ID.test(host) ? { kind: "stored", attachmentId: host } : null;
}

/** A visual as served: the agent's document behind the bootstrap, under the
 *  policy that sandboxes it. */
export function visualResponse(html: string): Response {
  return new Response(injectVisualBootstrap(html), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": VISUAL_CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

// Previews are never stored: each is held here for exactly as long as its
// off-screen render needs it.
const previews = new Map<string, string>();

/** A visual held for one preview: where it is served, and how to drop it. */
export interface HeldPreview {
  url: string;
  release: () => void;
}

/** Hold a visual for one preview; the returned release drops it. */
export function holdPreviewVisual(html: string): HeldPreview {
  const token = randomUUID();
  previews.set(token, html);
  return {
    url: `${VISUAL_SCHEME}://preview-${token}/`,
    release: () => {
      previews.delete(token);
    },
  };
}

export function previewVisualHtml(token: string): string | null {
  return previews.get(token) ?? null;
}

/** A shown visual's document, or null when the id names no stored visual. Only an
 *  .html attachment is a visual; anything else the thread holds is not served
 *  here. */
export async function readStoredVisual(attachmentId: string): Promise<string | null> {
  // Runtime import, as for the attachment scheme: the store reaches SQLite,
  // which is only there once the main process has set it up.
  const { getAttachmentStore } = await import("@kone/agent-core/AttachmentStore.js");
  const abs = getAttachmentStore().resolveAbsPath(attachmentId);
  if (!abs || !abs.toLowerCase().endsWith(".html")) return null;
  try {
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

/** The document a visual URL names. A stored visual whose file is gone gets
 *  the stand-in that tells its frame so — the address was a real visual's, and
 *  the thread shows that it is missing rather than an empty box. */
export async function visualHtml(
  target: VisualTarget | null,
  readStored: (attachmentId: string) => Promise<string | null> = readStoredVisual,
): Promise<string | null> {
  if (target === null) return null;
  if (target.kind === "preview") return previewVisualHtml(target.token);
  return (await readStored(target.attachmentId)) ?? VISUAL_UNAVAILABLE_HTML;
}

/** The scheme's whole answer to a request: the visual it names, served under
 *  its sandbox, or a 404 for anything else. */
export async function serveVisual(requestUrl: string): Promise<Response> {
  const html = await visualHtml(resolveVisualTarget(requestUrl));
  return html === null ? new Response("Not found", { status: 404 }) : visualResponse(html);
}

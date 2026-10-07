import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  injectPageBootstrap,
  PAGE_CONTENT_SECURITY_POLICY,
  PAGE_SCHEME,
} from "@kone/protocol/page-render";

// The scheme agents' pages are served on: `kone-page://<attachmentId>/` for a
// page shown in a thread, `kone-page://preview-<token>/` for one being
// previewed off screen. A page gets its own scheme rather than riding the
// attachment one, so the frame it runs in shares an origin with nothing —
// and every response carries a sandboxing policy of its own, so it stays
// walled off even if something loads it outside that frame.

export type PageTarget = { kind: "stored"; attachmentId: string } | { kind: "preview"; token: string };

const SAFE_ATTACHMENT_ID = /^att_[0-9a-f-]+$/;
const PREVIEW_HOST = /^preview-([0-9a-f-]+)$/;

/** What a page URL names, or null. Only the document itself is served: a page
 *  is self-contained, and a relative path inside one must not resolve to
 *  anything. */
export function resolvePageTarget(requestUrl: string): PageTarget | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${PAGE_SCHEME}:` || (url.pathname !== "/" && url.pathname !== "")) return null;
  const host = url.hostname.toLowerCase();
  const preview = PREVIEW_HOST.exec(host);
  if (preview) return { kind: "preview", token: preview[1]! };
  return SAFE_ATTACHMENT_ID.test(host) ? { kind: "stored", attachmentId: host } : null;
}

/** A page as served: the agent's document behind the bootstrap, under the
 *  policy that sandboxes it. */
export function pageResponse(html: string): Response {
  return new Response(injectPageBootstrap(html), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PAGE_CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

// Previews are never stored: each is held here for exactly as long as its
// off-screen render needs it.
const previews = new Map<string, string>();

/** A page held for one preview: where it is served, and how to drop it. */
export interface HeldPreview {
  url: string;
  release: () => void;
}

/** Hold a page for one preview; the returned release drops it. */
export function holdPreviewPage(html: string): HeldPreview {
  const token = randomUUID();
  previews.set(token, html);
  return {
    url: `${PAGE_SCHEME}://preview-${token}/`,
    release: () => {
      previews.delete(token);
    },
  };
}

export function previewPageHtml(token: string): string | null {
  return previews.get(token) ?? null;
}

/** A shown page's document, or null when the id names no stored page. Only an
 *  .html attachment is a page; anything else the thread holds is not served
 *  here. */
export async function readStoredPage(attachmentId: string): Promise<string | null> {
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

/** The document a page URL names. */
async function pageHtml(target: PageTarget | null): Promise<string | null> {
  if (target === null) return null;
  if (target.kind === "preview") return previewPageHtml(target.token);
  return readStoredPage(target.attachmentId);
}

/** The scheme's whole answer to a request: the page it names, served under
 *  its sandbox, or a 404 for anything else. */
export async function servePage(requestUrl: string): Promise<Response> {
  const html = await pageHtml(resolvePageTarget(requestUrl));
  return html === null ? new Response("Not found", { status: 404 }) : pageResponse(html);
}

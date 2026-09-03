const SAFE_ATTACHMENT_ID = /^att_[0-9a-fA-F-]+$/;

/**
 * Resolve an `attachment://<attachmentId>` or `attachment://<attachmentId>/<fileName>`
 * URL to an absolute file path on disk, or null if the URL is malformed, unrecognized,
 * or fails validation.
 *
 * Traversal-safe: delegates resolution to `AttachmentStore.resolveAbsPath`, which
 * verifies the attachment row exists in SQLite and guarantees the on-disk path
 * remains strictly contained within the user attachments directory.
 */
export async function resolveAttachmentProtocolPath(
  requestUrl: string,
  resolver?: (id: string) => string | null | Promise<string | null>,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "attachment:") {
    return null;
  }

  // Support both standard `attachment://att_xxx` (hostname) and `attachment:///att_xxx` (pathname).
  const rawId = url.hostname || url.pathname.split("/").filter((seg) => seg.length > 0)[0] || "";
  let attachmentId: string;
  try {
    attachmentId = decodeURIComponent(rawId);
  } catch {
    return null;
  }

  if (!SAFE_ATTACHMENT_ID.test(attachmentId)) {
    return null;
  }

  if (resolver) {
    return resolver(attachmentId);
  }

  // Runtime exception: AttachmentStore transitively imports node:sqlite which is only
  // available inside Electron main or after runtime database injection has initialized.
  const { getAttachmentStore } = await import("@kone/agent-core/AttachmentStore.js");
  return getAttachmentStore().resolveAbsPath(attachmentId);
}

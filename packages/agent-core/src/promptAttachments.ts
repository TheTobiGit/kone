import { getAttachmentStore } from "./AttachmentStore.js";
import { pathToFileURL } from "node:url";
import { CLAUDE_NATIVE_IMAGE_MIME_TYPES, type ChatAttachment } from "./types.js";

// Turns the bytes-free ChatAttachment metadata that rides a turn into the
// per-provider prompt payload each adapter needs — reading the actual bytes
// back off disk (AttachmentStore) at dispatch. Images go to vision-capable
// providers as native blocks (a Codex
// data-URL item / a Claude base64 block), while every other file — and any
// image a provider can't render — is handed over as an <attached_files> text
// block naming its on-disk path, which the agent reads with its own tools.

/** A Codex app-server image input item (a `data:` URL). */
export type CodexImageItem = { type: "image"; url: string };

/** The image mime types Claude's SDK types as a native base64 source. Narrower
 *  than a bare string so the block is assignable to the SDK's ImageBlockParam;
 *  the builder only ever produces one of these (see the gating below). */
type ClaudeImageMediaType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

/** An Anthropic image content block (base64 source). */
export type ClaudeImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: ClaudeImageMediaType; data: string };
};

export type OpenCodeFilePart = {
  type: "file";
  mime: string;
  filename: string;
  url: string;
};

/** An ACP image content block — Cursor advertises `promptCapabilities.image: true`. */
export type CursorImageBlock = { type: "image"; mimeType: string; data: string };

type FileEntry = { name: string; mimeType: string; sizeBytes: number; absPath: string };

/** Compact human byte size for the path block (e.g. "1.2 MB"). */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** One attachment located on disk, with its bytes already read when the
 *  builder asked for them. */
type ResolvedAttachment = { att: ChatAttachment; absPath: string; bytes: Buffer | null };

/** Locate every attachment on disk and read the bytes of the ones `wantsBytes`
 *  selects, concurrently — the reads are independent, and a turn carrying
 *  several images should pay one disk wait rather than one per file. The
 *  result keeps the attachment order the caller gave, because that order is
 *  the order the user attached them in and the prompt has to read the same
 *  way.
 *
 *  Attachments that resolve to no path are dropped here — never uploaded, or
 *  garbage-collected since — so a caller only ever sees one it can name. A
 *  null `bytes` therefore means one thing to every caller: the file was
 *  wanted natively and could not be read, so it belongs in the path block. */
async function resolveAttachments(
  attachments: ChatAttachment[] | undefined,
  wantsBytes: (att: ChatAttachment) => boolean,
): Promise<ResolvedAttachment[]> {
  const store = getAttachmentStore();
  const located = (attachments ?? []).flatMap((att) => {
    const absPath = store.resolveAbsPath(att.id);
    return absPath ? [{ att, absPath }] : [];
  });
  return Promise.all(
    located.map(async ({ att, absPath }) => ({
      att,
      absPath,
      bytes: wantsBytes(att) ? await store.readBytes(att.id) : null,
    })),
  );
}

/** The `<attached_files>` prompt block naming each file's on-disk path, or ""
 *  when there are none. */
function fileBlock(entries: FileEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map(
    (e) => `- "${e.name}" — ${e.mimeType} — ${humanSize(e.sizeBytes)} — ${e.absPath}`,
  );
  return [
    "<attached_files>",
    "The user attached the following file(s), saved on disk. Read or extract them with your tools as needed:",
    ...lines,
    "</attached_files>",
  ].join("\n");
}

/** Build a path block naming every attached file (including images) on disk.
 *  Used by CLI / text-only adapters (such as Antigravity print mode) where
 *  all attachments — visual or text — are read off disk by the agent's tools. */
export async function buildTextAttachmentBlock(
  attachments: ChatAttachment[] | undefined,
): Promise<string> {
  const resolved = await resolveAttachments(attachments, () => false);
  return fileBlock(
    resolved.map(({ att, absPath }) => ({
      name: att.name,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
      absPath,
    })),
  );
}

/** Build Codex's image input items + a path block for everything else. Codex
 *  renders any `image/*` natively, so only unreadable images fall through to
 *  the file block. */
export async function buildCodexAttachmentInput(
  attachments: ChatAttachment[] | undefined,
): Promise<{ imageItems: CodexImageItem[]; fileBlock: string }> {
  const resolved = await resolveAttachments(attachments, (att) => att.type === "image");
  const imageItems: CodexImageItem[] = [];
  const files: FileEntry[] = [];
  for (const { att, absPath, bytes } of resolved) {
    if (bytes) {
      imageItems.push({ type: "image", url: `data:${att.mimeType};base64,${bytes.toString("base64")}` });
      continue;
    }
    files.push({ name: att.name, mimeType: att.mimeType, sizeBytes: att.sizeBytes, absPath });
  }

  return { imageItems, fileBlock: fileBlock(files) };
}

/** Build Claude's image content blocks + a path block for everything else.
 *  Claude only renders gif/jpeg/png/webp natively (see
 *  CLAUDE_NATIVE_IMAGE_MIME_TYPES); other images join the file block. */
export async function buildClaudeAttachmentContent(
  attachments: ChatAttachment[] | undefined,
): Promise<{ imageBlocks: ClaudeImageBlock[]; fileBlock: string }> {
  const resolved = await resolveAttachments(
    attachments,
    (att) => att.type === "image" && CLAUDE_NATIVE_IMAGE_MIME_TYPES.has(att.mimeType.toLowerCase()),
  );
  const imageBlocks: ClaudeImageBlock[] = [];
  const files: FileEntry[] = [];

  for (const { att, absPath, bytes } of resolved) {
    if (bytes) {
      imageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          // SAFETY: bytes is non-null only for an attachment the predicate
          // above accepted, which tested this same lowercased mime type for
          // membership in CLAUDE_NATIVE_IMAGE_MIME_TYPES.
          media_type: att.mimeType.toLowerCase() as ClaudeImageMediaType,
          data: bytes.toString("base64"),
        },
      });
      continue;
    }
    files.push({ name: att.name, mimeType: att.mimeType, sizeBytes: att.sizeBytes, absPath });
  }

  return { imageBlocks, fileBlock: fileBlock(files) };
}

/** OpenCode accepts attachments as file parts addressed by file:// URLs. */
export async function buildOpenCodeAttachmentParts(
  attachments: ChatAttachment[] | undefined,
): Promise<OpenCodeFilePart[]> {
  const resolved = await resolveAttachments(attachments, () => false);
  return resolved.map(({ att, absPath }) => ({
    type: "file" as const,
    mime: att.mimeType,
    filename: att.name,
    url: pathToFileURL(absPath).href,
  }));
}

/** Build Cursor's ACP image blocks + a path block for everything else. Like
 *  Codex, Cursor renders any `image/*` natively, so only unreadable images fall
 *  through to the file block. */
export async function buildCursorAttachmentInput(
  attachments: ChatAttachment[] | undefined,
): Promise<{ imageBlocks: CursorImageBlock[]; fileBlock?: string }> {
  const resolved = await resolveAttachments(attachments, (att) => att.type === "image");
  const imageBlocks: CursorImageBlock[] = [];
  const files: FileEntry[] = [];

  for (const { att, absPath, bytes } of resolved) {
    if (bytes) {
      imageBlocks.push({ type: "image", mimeType: att.mimeType, data: bytes.toString("base64") });
      continue;
    }
    files.push({ name: att.name, mimeType: att.mimeType, sizeBytes: att.sizeBytes, absPath });
  }

  return { imageBlocks, fileBlock: fileBlock(files) };
}

/** Join the prompt text with an `<attached_files>` block (either may be empty). */
export function composePromptText(text: string, block: string): string {
  if (!block) return text;
  return text ? `${text}\n\n${block}` : block;
}

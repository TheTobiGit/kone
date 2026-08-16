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
  const store = getAttachmentStore();
  const files: FileEntry[] = [];

  for (const att of attachments ?? []) {
    const absPath = store.resolveAbsPath(att.id);
    if (!absPath) continue; // never uploaded / GC'd — nothing to attach
    files.push({ name: att.name, mimeType: att.mimeType, sizeBytes: att.sizeBytes, absPath });
  }

  return fileBlock(files);
}

/** Build Codex's image input items + a path block for everything else. Codex
 *  renders any `image/*` natively, so only unreadable images fall through to
 *  the file block. */
export async function buildCodexAttachmentInput(
  attachments: ChatAttachment[] | undefined,
): Promise<{ imageItems: CodexImageItem[]; fileBlock: string }> {
  const store = getAttachmentStore();
  const imageItems: CodexImageItem[] = [];
  const files: FileEntry[] = [];

  for (const att of attachments ?? []) {
    const absPath = store.resolveAbsPath(att.id);
    if (!absPath) continue; // never uploaded / GC'd — nothing to attach
    if (att.type === "image") {
      const bytes = await store.readBytes(att.id);
      if (bytes) {
        imageItems.push({ type: "image", url: `data:${att.mimeType};base64,${bytes.toString("base64")}` });
        continue;
      }
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
  const store = getAttachmentStore();
  const imageBlocks: ClaudeImageBlock[] = [];
  const files: FileEntry[] = [];

  for (const att of attachments ?? []) {
    const absPath = store.resolveAbsPath(att.id);
    if (!absPath) continue;
    if (att.type === "image" && CLAUDE_NATIVE_IMAGE_MIME_TYPES.has(att.mimeType.toLowerCase())) {
      const bytes = await store.readBytes(att.id);
      if (bytes) {
        imageBlocks.push({
          type: "image",
          source: {
            type: "base64",
            // Safe: this branch only runs for a mime in the native set above.
            media_type: att.mimeType.toLowerCase() as ClaudeImageMediaType,
            data: bytes.toString("base64"),
          },
        });
        continue;
      }
    }
    files.push({ name: att.name, mimeType: att.mimeType, sizeBytes: att.sizeBytes, absPath });
  }

  return { imageBlocks, fileBlock: fileBlock(files) };
}

/** OpenCode accepts attachments as file parts addressed by file:// URLs. */
export async function buildOpenCodeAttachmentParts(
  attachments: ChatAttachment[] | undefined,
): Promise<OpenCodeFilePart[]> {
  const store = getAttachmentStore();
  const parts: OpenCodeFilePart[] = [];
  for (const att of attachments ?? []) {
    const absPath = store.resolveAbsPath(att.id);
    if (!absPath) continue;
    parts.push({ type: "file", mime: att.mimeType, filename: att.name, url: pathToFileURL(absPath).href });
  }
  return parts;
}

/** Build Cursor's ACP image blocks + a path block for everything else. Like
 *  Codex, Cursor renders any `image/*` natively, so only unreadable images fall
 *  through to the file block. */
export async function buildCursorAttachmentInput(
  attachments: ChatAttachment[] | undefined,
): Promise<{ imageBlocks: CursorImageBlock[]; fileBlock?: string }> {
  const store = getAttachmentStore();
  const imageBlocks: CursorImageBlock[] = [];
  const files: FileEntry[] = [];

  for (const att of attachments ?? []) {
    const absPath = store.resolveAbsPath(att.id);
    if (!absPath) continue; // never uploaded / GC'd — nothing to attach
    if (att.type === "image") {
      const bytes = await store.readBytes(att.id);
      if (bytes) {
        imageBlocks.push({ type: "image", mimeType: att.mimeType, data: bytes.toString("base64") });
        continue;
      }
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

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { getConversationStore, type StoredAttachment } from "./ConversationStore.js";
import {
  MAX_FILE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  type AttachmentKind,
  type ChatAttachment,
  type UploadAttachmentInput,
} from "./types.js";
import { getUserDataDir } from "./userDataDir.js";

/** The ConversationStore slice this module reads. Tests pass a fake so they
 *  do not have to replace the store module for the whole bun worker. */
export type AttachmentRegistry = {
  listSubtreeAttachments(threadId: string): StoredAttachment[];
  listAllAttachments(): StoredAttachment[];
  getAttachment(id: string): StoredAttachment | null;
  registerAttachment(row: StoredAttachment): void;
  forgetAttachment(attachmentId: string): void;
};

// Filesystem side of prompt attachments. The renderer uploads a file's bytes
// once (base64 over IPC); we validate, decode, and write them to a per-user
// attachments dir, then register the bytes-free metadata + on-disk path in the
// ConversationStore so adapters can resolve `id → file` at dispatch (even after
// a reload). The turn itself only ever carries the ChatAttachment metadata.
//
// The design: bytes on disk (never SQLite blobs, never in the turn payload), a
// minted id that doubles as the filename stem, and a traversal-safe path
// resolver. Simplified for kone's scale — a flat `<id><ext>` layout and no
// staged→claimed state machine (we write straight to the final file).

/** Original file name → extension, when it's a sane short alnum ext. */
function extFromName(name: string): string | null {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : null;
}

/** Mime → file extension, for uploads whose name carried no usable extension.
 *  Covers the common image + document types; anything else falls back to
 *  `.bin` (the file still round-trips — only the on-disk suffix is generic). */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

function inferExt(name: string, mimeType: string): string {
  return extFromName(name) ?? EXT_BY_MIME[mimeType.toLowerCase()] ?? ".bin";
}

/** Strip control chars and clamp to a sane display length. Empty → a default. */
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 255);
  return cleaned.length > 0 ? cleaned : "attachment";
}

export class AttachmentStore {
  private dirPath: string | null = null;

  /** @param userDataDir per-user state dir; defaults to the one the host
   *  injected at startup (see userDataDir.ts). Tests pass a temp dir.
   *  @param registry optional store stand-in; production omits it and uses
   *  the process ConversationStore. */
  constructor(
    private readonly userDataDir?: string,
    private readonly registry?: AttachmentRegistry,
  ) {}

  private conv(): AttachmentRegistry {
    return this.registry ?? getConversationStore();
  }

  /** The attachments directory under the per-user state dir, created once. */
  private dir(): string {
    if (this.dirPath) return this.dirPath;
    const dir = path.join(this.userDataDir ?? getUserDataDir(), "attachments");
    mkdirSync(dir, { recursive: true });
    this.dirPath = dir;
    return dir;
  }

  /** Validate + persist an uploaded file's bytes, returning the bytes-free
   *  ChatAttachment the composer carries on its turn. Throws on an unusable
   *  upload (empty, oversized) — the renderer surfaces the message. */
  async save(input: UploadAttachmentInput): Promise<ChatAttachment> {
    const name = cleanName(input.name);
    const mimeType = (input.mimeType || "application/octet-stream").trim().slice(0, 100);
    const type: AttachmentKind = mimeType.toLowerCase().startsWith("image/") ? "image" : "file";

    const bytes = Buffer.from(input.data ?? "", "base64");
    if (bytes.length === 0) throw new Error("Attachment is empty.");
    const limit = type === "image" ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_FILE_ATTACHMENT_BYTES;
    if (bytes.length > limit) {
      const mb = Math.round(limit / (1024 * 1024));
      throw new Error(`Attachment is too large (max ${mb} MB for a ${type}).`);
    }

    const id = `att_${randomUUID()}`;
    const relPath = `${id}${inferExt(name, mimeType)}`;
    const dir = this.dir();
    const finalPath = path.join(dir, relPath);
    const tempPath = path.join(dir, `${id}.part`);

    // Write to a temp file then rename, so a resolvable path never points at a
    // half-written file (atomic on the same filesystem).
    await writeFile(tempPath, bytes, { mode: 0o600 });
    await rename(tempPath, finalPath);

    const stored: StoredAttachment = {
      id,
      threadId: input.threadId,
      type,
      name,
      mimeType,
      sizeBytes: bytes.length,
      relPath,
      createdAt: Date.now(),
    };
    this.conv().registerAttachment(stored);

    return { type, id, name, mimeType, sizeBytes: bytes.length };
  }

  /** Resolve an attachment's on-disk absolute path via its registry row.
   *  Returns null when unknown or if the resolved path escapes the dir. */
  resolveAbsPath(id: string): string | null {
    const row = this.conv().getAttachment(id);
    if (!row) return null;
    const dir = this.dir();
    const abs = path.resolve(dir, row.relPath);
    // Traversal guard: the resolved path must stay inside the attachments dir.
    if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
    return abs;
  }

  /** Read an attachment's bytes off disk (null if it can't be resolved/read). */
  async readBytes(id: string): Promise<Buffer | null> {
    const abs = this.resolveAbsPath(id);
    if (!abs) return null;
    try {
      return await readFile(abs);
    } catch (err) {
      console.error("[attachment-store] readBytes failed:", err);
      return null;
    }
  }

  /** Unlink every on-disk file for a thread and its spawned descendants —
   *  call before deleting a thread so no orphaned bytes are left behind for
   *  child threads' files either. Best-effort per file: one retry on a
   *  transient failure; if the file still won't go (locked/in-use), the
   *  registry row is dropped anyway so the file becomes orphan-eligible for
   *  {@link sweepOrphans} instead of being claimed forever by a thread that no
   *  longer exists. */
  async deleteThreadFiles(threadId: string): Promise<void> {
    const rows = this.conv().listSubtreeAttachments(threadId);
    const dir = this.dir();
    await Promise.all(
      rows.map(async (row) => {
        const abs = path.resolve(dir, row.relPath);
        if (abs !== dir && !abs.startsWith(dir + path.sep)) return;
        let unlinked = false;
        for (let attempt = 0; attempt < 2 && !unlinked; attempt++) {
          try {
            await unlink(abs);
            unlinked = true;
          } catch {
            /* transient failure (locked, EMFILE…) — retry once, then give up */
          }
        }
        if (!unlinked) this.conv().forgetAttachment(row.id);
      }),
    );
  }

  /** Startup sweep: delete files under the attachments dir that no registry
   *  row references — a crash between the temp-write and registerAttachment,
   *  a failed thread deletion, or a forgotten row all leave orphaned bytes.
   *  Run once at IPC registration, best-effort, never on the hot path. A
   *  `.part` file is an in-flight upload's temp file: only swept when it is
   *  old enough to be a crash remnant, never mid-write. */
  async sweepOrphans(): Promise<void> {
    const dir = this.dir();
    try {
      const referenced = new Set(
        this.conv().listAllAttachments().map((a) => a.relPath),
      );
      const entries = await readdir(dir, { withFileTypes: true });
      const now = Date.now();
      const PART_MAX_AGE_MS = 60 * 60 * 1000;
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isFile()) return;
          const name = entry.name;
          if (referenced.has(name)) return;
          try {
            if (name.endsWith(".part")) {
              const info = await stat(path.join(dir, name));
              if (now - info.mtimeMs < PART_MAX_AGE_MS) return;
            }
            await unlink(path.join(dir, name));
          } catch (err) {
            // Already gone, or a race with an upload — never fail the sweep.
            console.error(`[attachment-store] sweep could not remove ${name}:`, err);
          }
        }),
      );
    } catch (err) {
      console.error("[attachment-store] orphan sweep failed:", err);
    }
  }
}

let store: AttachmentStore | null = null;

/** The single AttachmentStore instance (lazily created). */
export function getAttachmentStore(): AttachmentStore {
  if (!store) store = new AttachmentStore();
  return store;
}

/** Drop the module-level singleton so tests start from a clean instance. */
export function resetAttachmentStoreForTests(): void {
  store = null;
}

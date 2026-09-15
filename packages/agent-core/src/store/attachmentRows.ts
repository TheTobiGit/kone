import type { ConversationDb } from "./ConversationDb.js";
import { DatabaseSync } from "../sqlite.js";
import { rowToAttachment, type AttachmentRow, type StoredAttachment } from "../conversationStoreTypes.js";

/** Subtree reader owned by the lifecycle repo, injected so this module never imports it. */
export type AttachmentRowDeps = {
  subtreeIds(db: DatabaseSync, threadId: string): string[];
};

export class AttachmentRowRepo {
  constructor(
    private readonly dbh: ConversationDb,
    private readonly deps: AttachmentRowDeps,
  ) {}

  /** Register an uploaded attachment's bytes-free metadata + on-disk path, so
   *  adapters can resolve `id → file` at dispatch (even after a reload) and a
   *  future GC pass can find orphaned files. Called by AttachmentStore right
   *  after the bytes are written. */
  registerAttachment(row: StoredAttachment): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO attachments
           (attachment_id, thread_id, type, name, mime_type, size_bytes, rel_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attachment_id) DO UPDATE SET
           thread_id  = excluded.thread_id,
           type       = excluded.type,
           name       = excluded.name,
           mime_type  = excluded.mime_type,
           size_bytes = excluded.size_bytes,
           rel_path   = excluded.rel_path`,
      ).run(
        row.id,
        row.threadId,
        row.type,
        row.name,
        row.mimeType,
        row.sizeBytes,
        row.relPath,
        row.createdAt ?? Date.now(),
      );
    } catch (err) {
      console.error("[conversation-store] registerAttachment failed:", err);
    }
  }

  /** Every attachment registered under a single thread, not its descendants. */
  listThreadAttachments(threadId: string): StoredAttachment[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `SELECT *` of attachments is exactly AttachmentRow — the
      // columns this schema creates.
      const rows = db
        .prepare(`SELECT * FROM attachments WHERE thread_id = ?`)
        .all(threadId) as AttachmentRow[];
      return rows.map(rowToAttachment);
    } catch (err) {
      console.error("[conversation-store] listThreadAttachments failed:", err);
      return [];
    }
  }

  /** Every attachment registered under a thread and its spawned descendants —
   *  used to unlink on-disk files when the thread is destroyed. Delete drops
   *  the whole subtree's rows in one transaction; the files must go first
   *  while the registry can still resolve their paths, including children. */
  listSubtreeAttachments(threadId: string): StoredAttachment[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      const ids = this.deps.subtreeIds(db, threadId);
      const placeholders = ids.map(() => "?").join(",");
      // SAFETY: `SELECT *` of attachments is exactly AttachmentRow — the
      // columns this schema creates.
      const rows = db
        .prepare(`SELECT * FROM attachments WHERE thread_id IN (${placeholders})`)
        .all(...ids) as AttachmentRow[];
      return rows.map(rowToAttachment);
    } catch (err) {
      console.error("[conversation-store] listSubtreeAttachments failed:", err);
      return [];
    }
  }

  /** Resolve an attachment id back to its metadata + on-disk relative path.
   *  Null when unknown (never uploaded, or GC'd). */
  getAttachment(id: string): StoredAttachment | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: `SELECT *` of attachments keyed on the primary key is at most
      // one row of exactly AttachmentRow.
      const row = db
        .prepare(`SELECT * FROM attachments WHERE attachment_id = ?`)
        .get(id) as AttachmentRow | undefined;
      return row ? rowToAttachment(row) : null;
    } catch (err) {
      console.error("[conversation-store] getAttachment failed:", err);
      return null;
    }
  }

  /** Every attachment row in the registry, across all threads — the GC sweep's
   *  "referenced set" (orphaned on-disk files are anything NOT in this set). */
  listAllAttachments(): StoredAttachment[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `SELECT *` of attachments is exactly AttachmentRow — the
      // columns this schema creates.
      const rows = db.prepare(`SELECT * FROM attachments`).all() as AttachmentRow[];
      return rows.map(rowToAttachment);
    } catch (err) {
      console.error("[conversation-store] listAllAttachments failed:", err);
      return [];
    }
  }

  /** Drop one attachment's registry row. Used by AttachmentStore when unlinking
   *  its bytes failed — the row must not keep claiming a file that GC will
   *  otherwise sweep (the file becomes orphan-eligible instead of owned). */
  forgetAttachment(attachmentId: string): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(`DELETE FROM attachments WHERE attachment_id = ?`).run(attachmentId);
    } catch (err) {
      console.error("[conversation-store] forgetAttachment failed:", err);
    }
  }
}

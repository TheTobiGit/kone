import { computed, ref } from "vue";
import type { AttachmentKind, ChatAttachment } from "~/types/desktop";
import { useSound } from "./useSound";

export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type PendingAttachment = {
  id: number;
  file: File;
  name: string;
  kind: AttachmentKind;
  sizeBytes: number;
  /** A short uppercase badge for non-image files, e.g. "PDF", "MD". */
  ext: string;
  /** An object URL for image previews; revoked on remove / unmount. */
  previewUrl?: string;
};

export function useComposerAttachments(deps: {
  isOpen: () => boolean;
  wake: () => Promise<void>;
  syncSoon: () => void;
}) {
  const { isOpen, wake, syncSoon } = deps;
  const { cue } = useSound();

  let attachSeq = 0;
  const attachments = ref<PendingAttachment[]>([]);
  const notice = ref("");
  let noticeTimer: number | undefined;

  function flash(msg: string) {
    notice.value = msg;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => (notice.value = ""), 3200);
  }

  const fileInput = ref<HTMLInputElement | null>(null);
  const dragging = ref(false);
  let dragDepth = 0;

  function extFor(file: File): string {
    const dot = file.name.lastIndexOf(".");
    const raw = dot > 0 ? file.name.slice(dot + 1) : "";
    return (raw || "FILE").slice(0, 4).toUpperCase();
  }

  function kindOf(file: File): AttachmentKind {
    return file.type.startsWith("image/") ? "image" : "file";
  }

  function push(file: File): void {
    const kind = kindOf(file);
    attachments.value.push({
      id: ++attachSeq,
      file,
      name: file.name,
      kind,
      sizeBytes: file.size,
      ext: extFor(file),
      previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
    });
  }

  function settleAdded(added: number): void {
    if (added === 0) return;
    cue("toggle");
    if (!isOpen()) void wake();
    syncSoon();
  }

  function addFiles(list: FileList | File[] | null | undefined) {
    if (!list) return;
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    let added = 0;
    for (const file of incoming) {
      if (attachments.value.length >= MAX_ATTACHMENTS) {
        flash(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
        break;
      }
      const cap = kindOf(file) === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (file.size > cap) {
        flash(`"${file.name}" is too large (max ${Math.round(cap / (1024 * 1024))} MB).`);
        continue;
      }
      push(file);
      added++;
    }
    settleAdded(added);
  }

  function openFilePicker() {
    fileInput.value?.click();
  }

  function onFilePicked(e: Event) {
    // SAFETY: this is the @change handler of the hidden <input type="file">
    // in AgentComposer, whose target is that input element itself.
    const input = e.target as HTMLInputElement;
    addFiles(input.files);
    input.value = "";
  }

  function removeAttachment(id: number) {
    const at = attachments.value.find((a) => a.id === id);
    if (at?.previewUrl) URL.revokeObjectURL(at.previewUrl);
    attachments.value = attachments.value.filter((a) => a.id !== id);
    cue("toggle");
    syncSoon();
  }

  function clearAttachments() {
    for (const at of attachments.value) {
      if (at.previewUrl) URL.revokeObjectURL(at.previewUrl);
    }
    attachments.value = [];
  }

  function hasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function onDragEnter(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dragging.value = true;
  }

  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging.value = false;
  }

  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dragging.value = false;
    addFiles(e.dataTransfer?.files);
  }

  /** Put files that were already sent once back on the draft — a queued
   *  message handed back by Edit or Stop. Their bytes are read back from the
   *  attachment store (`attachment://`), so the draft holds ordinary files
   *  again and the next send uploads them like any other. They passed the
   *  count and size caps when they were picked, so they aren't held to them
   *  again: a Stop can hand back several messages' files at once, and those
   *  rows are already cancelled, so a file turned away here would be lost.
   *  Over the count the picker refuses more until some are removed. One that
   *  can no longer be read is skipped, and the notice says so. */
  async function restoreUploaded(list: readonly ChatAttachment[]): Promise<void> {
    const files: File[] = [];
    let missing = 0;
    for (const att of list) {
      try {
        const res = await fetch(`attachment://${att.id}`);
        if (!res.ok) throw new Error(String(res.status));
        files.push(new File([await res.blob()], att.name, { type: att.mimeType }));
      } catch {
        missing++;
      }
    }
    for (const file of files) push(file);
    settleAdded(files.length);
    if (missing > 0) flash(`${missing} attachment${missing > 1 ? "s" : ""} could not be brought back.`);
  }

  const hasAttachments = computed(() => attachments.value.length > 0);

  return {
    attachments,
    notice,
    fileInput,
    dragging,
    hasAttachments,
    flash,
    addFiles,
    restoreUploaded,
    openFilePicker,
    onFilePicked,
    removeAttachment,
    clearAttachments,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}

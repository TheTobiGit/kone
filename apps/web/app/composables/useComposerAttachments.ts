import { computed, ref } from "vue";
import type { AttachmentKind } from "~/types/desktop";
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
      const kind: AttachmentKind = file.type.startsWith("image/") ? "image" : "file";
      const cap = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (file.size > cap) {
        flash(`"${file.name}" is too large (max ${Math.round(cap / (1024 * 1024))} MB).`);
        continue;
      }
      attachments.value.push({
        id: ++attachSeq,
        file,
        name: file.name,
        kind,
        sizeBytes: file.size,
        ext: extFor(file),
        previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
      });
      added++;
    }
    if (added > 0) {
      cue("toggle");
      if (!isOpen()) void wake();
      syncSoon();
    }
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

  const hasAttachments = computed(() => attachments.value.length > 0);

  return {
    attachments,
    notice,
    fileInput,
    dragging,
    hasAttachments,
    flash,
    addFiles,
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

import { computed, reactive, ref } from "vue";
import type {
  ChatAttachment,
  UserInputAnswerAttachments,
  UserInputQuestion,
} from "~/types/desktop";
import { USER_INPUT_ATTACHMENT_LIMIT } from "~/utils/userInputAnswers";

/** A row shown while one answer file is still being stored. */
export type UploadingAnswerFile = { key: string; name: string };

export type UserInputAttachmentDeps = {
  /** Stores one file and resolves to its metadata. Absent means the dialog
   *  has nowhere to put bytes and offers no attach affordance. */
  upload?: (file: File) => Promise<ChatAttachment>;
  /** Forgets an answer file the user removed, or one this dialog closed
   *  without sending. Absent leaves those bytes to the startup sweep. */
  discard?: (attachment: ChatAttachment) => Promise<void>;
};

/**
 * The answer files of one question dialog, from pick to outcome.
 *
 * Files start uploading as they arrive, each independently so a slow one never
 * holds the others back. The dialog's outcome is final: Send transfers every
 * landed file to the emitted answer, while Cancel or an unmount takes them
 * back. A file that was still in flight at that moment belongs to nobody, so
 * it is handed back too instead of joining a dialog that no longer exists.
 */
export function useUserInputAttachments(deps: UserInputAttachmentDeps) {
  const attachments = reactive<Record<string, ChatAttachment[]>>({});
  const uploading = reactive<Record<string, UploadingAnswerFile[]>>({});
  const uploadErrors = reactive<Record<string, string>>({});
  const dragTarget = ref<string | null>(null);

  let uploadSeq = 0;
  let settled = false;

  /** Fire-and-forget: the dialog is on its way out, and an orphaned upload is
   *  only the sweep's problem. */
  function discardUpload(attachment: ChatAttachment): void {
    void deps.discard?.(attachment).catch(() => {});
  }

  function clearLanded(): void {
    for (const [id, list] of Object.entries(attachments)) {
      for (const attachment of list) discardUpload(attachment);
      attachments[id] = [];
    }
    for (const id of Object.keys(uploading)) uploading[id] = [];
  }

  const attachedTotal = computed(
    () =>
      Object.values(attachments).reduce((sum, list) => sum + list.length, 0) +
      Object.values(uploading).reduce((sum, list) => sum + list.length, 0),
  );

  const uploadingAny = computed(() =>
    Object.values(uploading).some((list) => list.length > 0),
  );

  /** Only questions that actually carry files are sent. The backend's third
   *  argument is optional, so an empty map is left out entirely. */
  const attachmentAnswers = computed<UserInputAnswerAttachments>(() => {
    const result: UserInputAnswerAttachments = {};
    for (const [id, list] of Object.entries(attachments)) {
      if (list.length > 0) result[id] = list;
    }
    return result;
  });

  const hasAnswerAttachments = computed(
    () => Object.keys(attachmentAnswers.value).length > 0,
  );

  /** Upload every file immediately, one request each. A failure leaves the
   *  rest alone and says why in that question's error line. */
  function attachFiles(question: UserInputQuestion, files: Iterable<File>): void {
    const upload = deps.upload;
    // A fixed-choice answer is one option and nothing else: no file can ride it.
    if (!upload || question.fixedChoice || settled) return;
    for (const file of files) {
      if (attachedTotal.value >= USER_INPUT_ATTACHMENT_LIMIT) {
        uploadErrors[question.id] = `You can attach up to ${USER_INPUT_ATTACHMENT_LIMIT} files.`;
        break;
      }
      delete uploadErrors[question.id];
      const key = `upload-${++uploadSeq}`;
      const name = file.name || "attachment";
      (uploading[question.id] ??= []).push({ key, name });
      void upload(file)
        .then((attachment) => {
          uploading[question.id] = (uploading[question.id] ?? []).filter(
            (row) => row.key !== key,
          );
          // The dialog settled while this was in flight: nobody can send it now.
          if (settled) {
            discardUpload(attachment);
            return;
          }
          (attachments[question.id] ??= []).push(attachment);
        })
        .catch((error: Error) => {
          uploading[question.id] = (uploading[question.id] ?? []).filter(
            (row) => row.key !== key,
          );
          if (settled) return;
          uploadErrors[question.id] = error?.message || `Could not attach ${name}.`;
        });
    }
  }

  function removeAttachment(questionId: string, id: string): void {
    const list = attachments[questionId] ?? [];
    const gone = list.find((att) => att.id === id);
    attachments[questionId] = list.filter((att) => att.id !== id);
    if (gone) discardUpload(gone);
  }

  // Paste feeds the same list as the picker: a screenshot off the clipboard is
  // an image file, and pasted documents ride as files.
  function onPaste(question: UserInputQuestion, event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    attachFiles(question, files);
  }

  function onDragOver(question: UserInputQuestion, event: DragEvent): void {
    if (!deps.upload || question.fixedChoice || settled) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    dragTarget.value = question.id;
  }

  function onDragLeave(question: UserInputQuestion, event: DragEvent): void {
    // Crossing between the question's own children is not leaving it.
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (current instanceof Node && next instanceof Node && current.contains(next)) return;
    if (dragTarget.value === question.id) dragTarget.value = null;
  }

  function onDrop(question: UserInputQuestion, event: DragEvent): void {
    dragTarget.value = null;
    attachFiles(question, Array.from(event.dataTransfer?.files ?? []));
  }

  function clearDragTarget(): void {
    dragTarget.value = null;
  }

  /** Send owns the files from here on: an unmount must not take them back. */
  function transferToAnswer(): void {
    settled = true;
  }

  /** Cancel: nothing will be sent, so every landed file goes back. In-flight
   *  uploads are discarded as they land. */
  function discardAll(): void {
    if (settled) return;
    settled = true;
    clearLanded();
  }

  /** The dialog went away without an outcome: same as Cancel. */
  function dispose(): void {
    if (!settled) discardAll();
  }

  return {
    attachments,
    uploading,
    uploadErrors,
    dragTarget,
    attachedTotal,
    uploadingAny,
    attachmentAnswers,
    hasAnswerAttachments,
    attachFiles,
    removeAttachment,
    onPaste,
    onDragOver,
    onDragLeave,
    onDrop,
    clearDragTarget,
    transferToAnswer,
    discardAll,
    dispose,
  };
}

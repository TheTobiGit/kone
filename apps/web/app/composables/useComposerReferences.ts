// The composer's text-reference state.
//
// References are held apart from files and prose: they never enter the editable
// field, they dedupe by source/content, and they persist with the scoped draft.
// The composer renders them as compact quote chips that can be inspected and
// removed; a send merges them into the draft's attachments, where the existing
// lifecycle already carries them to the provider.

import { computed, ref } from "vue";
import type { ChatAttachment, TextReference } from "~/types/desktop";
import {
  isReferenceAttachment,
  referenceAttachmentOf,
  referenceAttachmentsOf,
  sameTextReference,
  type ReferenceChatAttachment,
} from "~/utils/composerReferences";

export function useComposerReferences() {
  const references = ref<ReferenceChatAttachment[]>([]);
  const hasReferences = computed(() => references.value.length > 0);

  /** Add one selection. Returns whether it was new — an identical source and
   *  content is already held and is not added twice. */
  function add(reference: TextReference): boolean {
    if (!reference.text) return false;
    if (references.value.some((held) => sameTextReference(held.reference, reference))) return false;
    references.value = [...references.value, referenceAttachmentOf(reference)];
    return true;
  }

  function remove(id: string): void {
    references.value = references.value.filter((held) => held.id !== id);
  }

  function clear(): void {
    references.value = [];
  }

  /** Put references back from a queue row, a refused send or a restored draft.
   *  Existing ones win, so a hand-back never duplicates what is already here. */
  function restore(attachments: readonly ChatAttachment[]): void {
    const additions: ReferenceChatAttachment[] = [];
    for (const attachment of attachments) {
      if (!isReferenceAttachment(attachment)) continue;
      const duplicate =
        references.value.some((held) => sameTextReference(held.reference, attachment.reference)) ||
        additions.some((held) => sameTextReference(held.reference, attachment.reference));
      if (!duplicate) additions.push(referenceAttachmentOf(attachment.reference));
    }
    if (additions.length > 0) references.value = [...references.value, ...additions];
  }

  /** The same restore from the draft envelope, which stores the plain
   *  references rather than their attachment wrappers. */
  function restoreReferences(list: readonly TextReference[]): void {
    const additions: ReferenceChatAttachment[] = [];
    for (const reference of list) {
      const duplicate =
        references.value.some((held) => sameTextReference(held.reference, reference)) ||
        additions.some((held) => sameTextReference(held.reference, reference));
      if (!duplicate) additions.push(referenceAttachmentOf(reference));
    }
    if (additions.length > 0) references.value = [...references.value, ...additions];
  }

  /** Replace the list from a restored draft. */
  function replace(list: readonly TextReference[]): void {
    references.value = referenceAttachmentsOf(list);
  }

  /** What the draft keeps: the provenance and exact bytes, without attachment
   *  wrappers or ids. */
  function snapshot(): TextReference[] {
    return references.value.map((held) => ({ ...held.reference }));
  }

  /** What the send carries: reference attachments in draft order. */
  function attachments(): ReferenceChatAttachment[] {
    return [...references.value];
  }

  return {
    references,
    hasReferences,
    add,
    remove,
    clear,
    restore,
    restoreReferences,
    replace,
    snapshot,
    attachments,
  };
}

import { watch } from "vue";
import type { ChatAttachment, SkillReference } from "~/types/desktop";
import type { QueueReturn } from "./agentTypes";
import { claimQueueReturn } from "./session/sessionQueue";

// Queued messages a Stop handed back go into the composer's field. The words
// land ahead of whatever is being written there, the skills ride with them and
// the files go back on the draft — and each hand-back lands once, whether it
// arrives while the composer is open or was waiting for it to mount.

export function useComposerQueueReturn(deps: {
  queueReturn: () => QueueReturn | null | undefined;
  /** The field as serialized text, its chips written as `/name`. */
  currentText: () => string;
  currentSkills: () => SkillReference[];
  /** A sent turn's words and skills as draft text (chips ahead of prose). */
  draftFromTurn: (input: string, skills: readonly SkillReference[]) => string;
  setDraft: (draft: string, skills: readonly SkillReference[]) => Promise<void>;
  restoreUploaded: (attachments: readonly ChatAttachment[]) => Promise<void>;
}) {
  /** Restore the pending hand-back, if there is one this composer (or any
   *  other) hasn't restored yet. */
  async function consume(): Promise<void> {
    const back = deps.queueReturn();
    if (!back || !claimQueueReturn(back)) return;
    const current = deps.currentText();
    // The field's text already carries its own chips; the skills list is what
    // tells the restore which of those `/name`s to re-chip.
    const draft = [deps.draftFromTurn(back.text, back.skills), current.trim() ? current : ""]
      .filter(Boolean)
      .join("\n\n");
    await deps.setDraft(draft, [...back.skills, ...deps.currentSkills()]);
    if (back.attachments.length) await deps.restoreUploaded(back.attachments);
  }

  watch(() => deps.queueReturn()?.at, () => void consume());

  return { consume };
}

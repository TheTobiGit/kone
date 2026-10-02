import { computed, watch } from "vue";
import type { KoneAgentSkillsApi, ProviderKind, SkillReference } from "~/types/desktop";
import type { SendRejection } from "./agentTypes";
import { useConversationSkills } from "./useConversationSkills";
import {
  composeSkillTurn,
  resolvePickedSkills,
  skillKey,
  type ComposerDraftPart,
} from "~/utils/composerSkills";

export type UseComposerSkillsDeps = {
  provider: () => ProviderKind | null | undefined;
  cwd: () => string | null;
  isJob: () => boolean;
  isOpen: () => boolean;
  sendRejection: () => SendRejection | null | undefined;
  currentText: () => string;
  draftParts: () => readonly ComposerDraftPart[];
  setEditorFromText: (value: string, skills?: readonly SkillReference[]) => void;
  markSkillChips: (isAvailable: (skill: SkillReference) => boolean) => void;
  getSetDraft: () => (draft: string, skills?: readonly SkillReference[]) => Promise<void>;
  cueError: () => void;
  flashNotice: (notice: string) => void;
  /** The skills slice of the bridge. Injectable so the skill list resolves in tests. */
  bridge?: () => Pick<KoneAgentSkillsApi, "listInvokable"> | undefined;
};

export type ComposedSkillTurnResult = {
  input: string;
  skills: SkillReference[];
};

function unavailableSkillsNotice(missing: readonly SkillReference[]): string {
  const names = missing.map((skill) => skill.name).join(", ");
  return missing.length === 1
    ? `${names} isn't available here — remove it to send`
    : `${names} aren't available here — remove them to send`;
}

function draftFromTurn(input: string, skills: readonly SkillReference[]): string {
  return `${skills.map((skill) => `/${skill.name} `).join("")}${input}`;
}

/** Whether two skill lists name the same invocation in the same order. Order
 *  is the field order the send read, so a different order rebuilds rather
 *  than restoring a layout the refusal did not carry. */
function sameSkills(a: readonly SkillReference[], b: readonly SkillReference[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (skillKey(left) !== skillKey(right) || left.path !== right.path) return false;
  }
  return true;
}

/** The composer's skill half: what the provider can invoke from where the
 *  turn runs, which chips still can, and what a refused send hands back. A
 *  surface with no project on disk (the assistant, an unaimed job) asks for
 *  the user's own skills only — the `cwd` getter decides that, so the
 *  component never branches on it. A job carries no skills, so the bench
 *  offers none: a chip there would be dropped at filing time, silently. */
export function useComposerSkills(deps: UseComposerSkillsDeps) {
  const bridgeOptions = deps.bridge ? { bridge: deps.bridge } : undefined;
  const conversation = useConversationSkills(deps.provider, deps.cwd, bridgeOptions);
  const invokableSkills = computed(() => (deps.isJob() ? [] : conversation.skills.value));

  /** Whether a chip's skill can still be invoked. Unknown until the list for
   *  this provider and place has answered — and unknown is not "gone", so a
   *  chip is only struck once the list says so. */
  function skillAvailable(skill: SkillReference): boolean {
    if (!conversation.ready.value) return true;
    return invokableSkills.value.some((entry) => skillKey(entry) === skillKey(skill));
  }

  /** Put saved text back in the field. The saved skills decide what re-chips —
   *  they were chips when the draft was kept, so the field rebuilds in one pass
   *  with no second run when the live list answers. Whether each chip can still
   *  run is a separate mark applied right after. */
  function restoreEditorFromText(value: string, savedSkills?: readonly SkillReference[]): void {
    deps.setEditorFromText(value, savedSkills ?? invokableSkills.value);
    deps.markSkillChips(skillAvailable);
  }

  function currentDraftSkills(): SkillReference[] {
    return composeSkillTurn(deps.draftParts()).skills;
  }

  /** A sent turn back as draft text: its skills as chips ahead of the prose,
   *  written as the `/name` a chip saves itself as so the restore re-chips them.
   *  Where a chip sat mid-sentence is gone by then — the text names it bare. */
  function draftFromSentTurn(input: string, skills: readonly SkillReference[]): string {
    return draftFromTurn(input, skills);
  }

  /** The draft as it stood when it last went out, for a refused send to hand
   *  back. The input and skills name the turn that went out; the draft is the
   *  exact serialized field, chips where they sat, so a match restores it verbatim. */
  let lastDispatched: { input: string; skills: SkillReference[]; draft: string } | null = null;

  /** Read the field as a turn and refuse it when a chip can no longer run.
   *  Null means refused — the draft stays, the struck chip says which one,
   *  and removing it is the fix. Sending the rest would run a different
   *  request from the one written. On success the dispatch is recorded, so a
   *  refused send hands the exact draft back. */
  function composeTurn(): ComposedSkillTurnResult | null {
    // The chips, not the text, say which skills run: a `/name` the user
    // typed by hand is prose to them, and stays prose.
    const turn = composeSkillTurn(deps.draftParts());
    const { resolved, missing } = resolvePickedSkills(
      turn.skills,
      // Before the list answers, a chip is taken at its word: it came from an
      // earlier answer, and the backend refuses it if that has since changed.
      conversation.ready.value ? invokableSkills.value : turn.skills,
    );
    if (missing.length > 0) {
      deps.markSkillChips(skillAvailable);
      deps.cueError();
      deps.flashNotice(unavailableSkillsNotice(missing));
      return null;
    }
    const dispatched = { input: turn.input, skills: [...resolved], draft: deps.currentText() };
    lastDispatched = dispatched;
    return { input: dispatched.input, skills: [...dispatched.skills] };
  }

  // A switched provider or project brings a different list; a chip picked from
  // the old one is re-checked against it the moment it lands.
  watch([invokableSkills, () => conversation.ready.value], () => {
    deps.markSkillChips(skillAvailable);
  });

  // Skills are installed while kone runs; opening the composer is the moment a
  // new one is worth finding, without polling for it.
  watch(
    () => deps.isOpen(),
    (isOpen) => {
      if (isOpen && !deps.isJob()) void conversation.refresh();
    },
  );

  watch(
    () => deps.sendRejection()?.at,
    async () => {
      const rejection = deps.sendRejection();
      if (!rejection) return;
      // The list may be why it was refused; refetch so a gone skill strikes.
      void conversation.refresh();
      const sent = lastDispatched;
      lastDispatched = null;
      // Never over something the user has started writing since.
      if (deps.currentText().trim()) return;
      // A match restores the exact draft this composer sent; anything else — a
      // queued row sent from the strip, a send from another surface — rebuilds
      // from what the refused turn carried. Content, not timing, decides, so a
      // slow first start still matches and a second rapid send never steals the
      // first refusal's draft.
      const ours =
        sent !== null && sent.input === rejection.input && sameSkills(sent.skills, rejection.skills);
      const draft = ours ? sent.draft : draftFromTurn(rejection.input, rejection.skills);
      const restored: readonly SkillReference[] = ours ? sent.skills : rejection.skills;
      if (draft.trim()) await deps.getSetDraft()(draft, restored);
    },
  );

  return {
    invokableSkills,
    ready: conversation.ready,
    refresh: conversation.refresh,
    skillAvailable,
    restoreEditorFromText,
    currentDraftSkills,
    composeTurn,
    draftFromTurn: draftFromSentTurn,
    unavailableSkillsNotice,
  };
}

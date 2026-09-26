import { computed } from "vue";
import { DRAFT_KEY_PREFIX, useComposerPrefs } from "~/composables/useComposerPrefs";

export function useComposerDraft(deps: {
  getProjectPath: () => string;
  getText: () => string;
  setEditorFromText: (val: string) => void;
}) {
  const { getProjectPath, getText, setEditorFromText } = deps;
  // Read live, so turning drafts off in settings stops the next save without
  // remounting the composer. The prefs store already cleared what was on disk.
  const { prefs } = useComposerPrefs();

  const draftKey = computed(() => `${DRAFT_KEY_PREFIX}${getProjectPath()}`);
  let draftSaveTimer: number | null = null;

  function scheduleDraftSave(): void {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(persistDraft, 350);
  }

  function persistDraft(): void {
    draftSaveTimer = null;
    if (!prefs.value.keepDrafts) return;
    try {
      const draft = getText().trim();
      if (draft) window.localStorage.setItem(draftKey.value, draft);
      else window.localStorage.removeItem(draftKey.value);
    } catch {
      // Storage unavailable (private mode / quota)
    }
  }

  function restoreDraft(): void {
    if (!prefs.value.keepDrafts) return;
    try {
      const saved = window.localStorage.getItem(draftKey.value);
      if (saved) setEditorFromText(saved);
    } catch {
      // Storage unavailable
    }
  }

  function clearDraft(): void {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
    try {
      window.localStorage.removeItem(draftKey.value);
    } catch {
      // Storage unavailable
    }
  }

  return {
    draftKey,
    scheduleDraftSave,
    persistDraft,
    restoreDraft,
    clearDraft,
  };
}

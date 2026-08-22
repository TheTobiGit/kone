import { computed } from "vue";

export function useComposerDraft(deps: {
  getProjectPath: () => string;
  getText: () => string;
  setEditorFromText: (val: string) => void;
}) {
  const { getProjectPath, getText, setEditorFromText } = deps;

  const draftKey = computed(() => `kone:draft:${getProjectPath()}`);
  let draftSaveTimer: number | null = null;

  function scheduleDraftSave(): void {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(persistDraft, 350);
  }

  function persistDraft(): void {
    draftSaveTimer = null;
    try {
      const draft = getText().trim();
      if (draft) window.localStorage.setItem(draftKey.value, draft);
      else window.localStorage.removeItem(draftKey.value);
    } catch {
      // Storage unavailable (private mode / quota)
    }
  }

  function restoreDraft(): void {
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

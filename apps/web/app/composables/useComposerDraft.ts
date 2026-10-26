import { computed } from "vue";
import { TextReferenceSchema } from "@kone/protocol/text-reference";
import { DRAFT_KEY_PREFIX, useComposerPrefs } from "~/composables/useComposerPrefs";
import type { SkillReference, TextReference } from "~/types/desktop";

export type PersistedComposerDraft = {
  text: string;
  skills: SkillReference[];
  /** Text selections attached to the draft, with their exact bytes. */
  references: TextReference[];
};

type DraftEnvelopeCandidate = {
  text?: unknown;
  skills?: unknown;
  references?: unknown;
};

type SkillCandidate = {
  name?: unknown;
  path?: unknown;
};

function draftTextOf(candidate: DraftEnvelopeCandidate): string | null {
  const raw = candidate.text;
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Object) return null;
  if (raw === true || raw === false) return null;
  // SAFETY: JSON primitives reaching here are strings; String restores the persisted text.
  const text = String(raw as string);
  return text;
}

function skillOf(entry: SkillCandidate | null | undefined): SkillReference | null {
  if (!entry || !(entry instanceof Object) || Array.isArray(entry)) return null;
  const name = draftTextOf({ text: entry.name });
  if (!name || !name.trim()) return null;
  let path = "";
  const rawPath = entry.path;
  if (rawPath !== null && rawPath !== undefined) {
    if (rawPath instanceof Object) return null;
    if (rawPath === true || rawPath === false) return null;
    // SAFETY: JSON primitives reaching here are strings; String restores the persisted path.
    path = String(rawPath as string);
  }
  return { name: name.trim(), path };
}

function draftSkillsOf(candidate: DraftEnvelopeCandidate): SkillReference[] {
  const raw = candidate.skills;
  if (!Array.isArray(raw)) return [];
  const out: SkillReference[] = [];
  for (const entry of raw) {
    // SAFETY: envelope entries are probed by skillOf before use.
    const skill = skillOf(entry as SkillCandidate | null | undefined);
    if (skill) out.push(skill);
  }
  return out;
}

/** Decode the persisted reference list at the boundary with the shared schema.
 *  One malformed entry is dropped; the rest of the draft survives. */
function draftReferencesOf(candidate: DraftEnvelopeCandidate): TextReference[] {
  const raw = candidate.references;
  if (!Array.isArray(raw)) return [];
  const out: TextReference[] = [];
  for (const entry of raw) {
    const parsed = TextReferenceSchema.safeParse(entry);
    if (!parsed.success) continue;
    const reference: TextReference = {
      text: parsed.data.text,
      sourcePaneId: parsed.data.sourcePaneId,
    };
    if (parsed.data.sourceThreadId) reference.sourceThreadId = parsed.data.sourceThreadId;
    if (parsed.data.sourceMessageId) reference.sourceMessageId = parsed.data.sourceMessageId;
    if (parsed.data.sourceTitle) reference.sourceTitle = parsed.data.sourceTitle;
    out.push(reference);
  }
  return out;
}

function decodeDraft(saved: string): PersistedComposerDraft | null {
  let parsed: DraftEnvelopeCandidate;
  try {
    // SAFETY: external JSON is decoded into an envelope and probed field by field below.
    parsed = JSON.parse(saved) as DraftEnvelopeCandidate;
  } catch {
    // Drafts predating the envelope were stored as bare text.
    if (!saved.trim()) return null;
    return { text: saved, skills: [], references: [] };
  }
  // A JSON primitive or array is never the envelope this module writes —
  // keep the exact bytes as bare text rather than dropping a user-typed draft.
  if (!parsed || !(parsed instanceof Object) || Array.isArray(parsed)) {
    if (!saved.trim()) return null;
    return { text: saved, skills: [], references: [] };
  }
  // An object without the envelope's text field is user-typed JSON, not a
  // saved draft — again, keep the bytes.
  if (parsed.text === null || parsed.text === undefined) {
    if (!saved.trim()) return null;
    return { text: saved, skills: [], references: [] };
  }
  const text = draftTextOf(parsed);
  if (text === null) {
    if (!saved.trim()) return null;
    return { text: saved, skills: [], references: [] };
  }
  const skills = draftSkillsOf(parsed);
  const references = draftReferencesOf(parsed);
  if (!text.trim() && skills.length === 0 && references.length === 0) return null;
  return { text, skills, references };
}

export function useComposerDraft(deps: {
  getProjectPath: () => string;
  /** Narrows the key below the project, for composers that share one. */
  getScope?: () => string | undefined;
  getText: () => string;
  getSkills: () => readonly SkillReference[];
  /** The text selections riding this draft, with their exact bytes. */
  getReferences?: () => readonly TextReference[];
  setEditorFromText: (val: string, skills?: readonly SkillReference[]) => void;
  /** Replace the composer's references from a restored draft. */
  setReferences?: (references: readonly TextReference[]) => void;
}) {
  const { getProjectPath, getScope, getText, getSkills, getReferences, setEditorFromText, setReferences } = deps;
  // Read live, so turning drafts off in settings stops the next save without
  // remounting the composer. The prefs store already cleared what was on disk.
  const { prefs } = useComposerPrefs();

  // The scope rides after the path, under the same prefix, so turning drafts
  // off in settings still sweeps the scoped ones with the rest.
  const draftKey = computed(() => {
    const scope = getScope?.();
    return `${DRAFT_KEY_PREFIX}${getProjectPath()}${scope ? `#${scope}` : ""}`;
  });
  let draftSaveTimer: number | null = null;

  function scheduleDraftSave(): void {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(persistDraft, 350);
  }

  function persistDraft(): void {
    draftSaveTimer = null;
    if (!prefs.value.keepDrafts) return;
    try {
      // The exact field bytes: a seeded selection can begin with indentation,
      // and trimming it here would rewrite the user's code on the next mount.
      // Emptiness is still judged on visible content below.
      const draft = getText();
      const skills: SkillReference[] = [];
      for (const skill of getSkills()) {
        const name = skill.name.trim();
        if (!name) continue;
        if (skills.some((kept) => kept.name.toLowerCase() === name.toLowerCase())) continue;
        skills.push({ name, path: skill.path });
      }
      const references: TextReference[] = [];
      for (const reference of getReferences?.() ?? []) {
        if (!reference.text) continue;
        const kept: TextReference = { text: reference.text, sourcePaneId: reference.sourcePaneId };
        if (reference.sourceThreadId) kept.sourceThreadId = reference.sourceThreadId;
        if (reference.sourceMessageId) kept.sourceMessageId = reference.sourceMessageId;
        if (reference.sourceTitle) kept.sourceTitle = reference.sourceTitle;
        references.push(kept);
      }
      // The text carries the `/name` tokens and the skills carry their paths,
      // so a restore re-chips what was saved without waiting for the live list.
      // References are part of the draft too; a reference-only draft is valid.
      if (draft.trim() || skills.length > 0 || references.length > 0) {
        const payload: PersistedComposerDraft = { text: draft, skills, references };
        window.localStorage.setItem(draftKey.value, JSON.stringify(payload));
      } else window.localStorage.removeItem(draftKey.value);
    } catch {
      // Storage unavailable (private mode / quota)
    }
  }

  function restoreDraft(): void {
    if (!prefs.value.keepDrafts) return;
    try {
      const saved = window.localStorage.getItem(draftKey.value);
      if (!saved) return;
      const decoded = decodeDraft(saved);
      if (!decoded) return;
      setEditorFromText(decoded.text, decoded.skills);
      setReferences?.(decoded.references);
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

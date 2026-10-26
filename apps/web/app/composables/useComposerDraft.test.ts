import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SkillReference, TextReference } from "~/types/desktop";

// useComposerDraft reads window.localStorage and the shared composer prefs;
// both are stubbed here so this suite proves the envelope itself.
type WindowHolder = { window?: unknown };

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const storage = new MemoryStorage();

beforeEach(() => {
  storage.clear();
  // SAFETY: WindowHolder names the one global slot this suite stubs; the value
  // is the storage/window surface useComposerDraft reads.
  (globalThis as WindowHolder).window = {
    localStorage: storage,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
});

afterEach(() => {
  // SAFETY: the same slot this suite set above; removing it restores the host.
  delete (globalThis as WindowHolder).window;
});

const REVIEW: SkillReference = { name: "review", path: "/skills/review/SKILL.md" };

const REFERENCE: TextReference = {
  text: "  const answer = 42;\n\n\treturn answer;\n",
  sourcePaneId: "pane-1",
  sourceThreadId: "thread-1",
  sourceMessageId: "message-1",
  sourceTitle: "A selection",
};

type DraftRestore = {
  text: string;
  skills: readonly SkillReference[] | undefined;
  references: readonly TextReference[] | undefined;
};

type DraftState = {
  text: string;
  skills: SkillReference[];
  references: TextReference[];
};

/** The composable with the editor edges captured instead of rendered. */
async function draftHarness() {
  const { useComposerDraft } = await import("./useComposerDraft");
  const state: DraftState = {
    text: "typed",
    skills: [REVIEW],
    references: [REFERENCE],
  };
  const restores: DraftRestore[] = [];
  const draft = useComposerDraft({
    getProjectPath: () => "/repo",
    getScope: () => "pane-1",
    getText: () => state.text,
    getSkills: () => state.skills,
    getReferences: () => state.references,
    setEditorFromText: (text, skills) => restores.push({ text, skills, references: undefined }),
    setReferences: (references) => {
      const last = restores[restores.length - 1];
      if (last) last.references = references;
      state.references = [...references];
    },
  });
  return { draft, state, restores };
}

describe("a scoped composer draft", () => {
  test("persists the exact reference bytes beside the text and skills", async () => {
    const { draft } = await draftHarness();
    draft.persistDraft();

    const raw = storage.getItem("kone:draft:/repo#pane-1");
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw ?? "{}");
    expect(saved.text).toBe("typed");
    expect(saved.skills).toEqual([REVIEW]);
    expect(saved.references).toEqual([REFERENCE]);
    // The selection is stored byte-for-byte, not trimmed or re-wrapped.
    expect(saved.references[0].text).toBe(REFERENCE.text);
  });

  test("keeps the draft's leading indentation and trailing bytes", async () => {
    const { draft, state } = await draftHarness();
    // A New Thread selection is often an indented code block; trimming it on
    // save would silently rewrite the user's text on the next remount.
    state.text = "    const answer = 42;\n\n\treturn answer;\n\n";
    draft.persistDraft();

    const saved = JSON.parse(storage.getItem("kone:draft:/repo#pane-1") ?? "{}");
    expect(saved.text).toBe(state.text);

    const restored = await draftHarness();
    restored.draft.restoreDraft();
    expect(restored.restores.at(-1)?.text).toBe(state.text);
  });

  test("restores references with the draft", async () => {
    storage.setItem(
      "kone:draft:/repo#pane-1",
      JSON.stringify({ text: "typed", skills: [REVIEW], references: [REFERENCE] }),
    );
    const { draft, restores } = await draftHarness();
    draft.restoreDraft();

    expect(restores).toEqual([{ text: "typed", skills: [REVIEW], references: [REFERENCE] }]);
  });

  test("a reference-only draft survives, because it can be sent alone", async () => {
    const { draft, state } = await draftHarness();
    state.text = "";
    state.skills = [];
    draft.persistDraft();

    const saved = JSON.parse(storage.getItem("kone:draft:/repo#pane-1") ?? "{}");
    expect(saved).toEqual({ text: "", skills: [], references: [REFERENCE] });
  });

  test("malformed or empty references are dropped while a good one survives", async () => {
    storage.setItem(
      "kone:draft:/repo#pane-1",
      JSON.stringify({
        text: "typed",
        skills: [],
        references: [
          { ...REFERENCE, text: "" },
          { text: 42, sourcePaneId: "pane-1" },
          { text: "no pane" },
          null,
          REFERENCE,
        ],
      }),
    );
    const { draft, restores } = await draftHarness();
    draft.restoreDraft();

    expect(restores[0]?.references).toEqual([REFERENCE]);
  });

  test("a draft saved before references existed still restores", async () => {
    storage.setItem(
      "kone:draft:/repo#pane-1",
      JSON.stringify({ text: "old words", skills: [REVIEW] }),
    );
    const { draft, restores } = await draftHarness();
    draft.restoreDraft();

    expect(restores).toEqual([{ text: "old words", skills: [REVIEW], references: [] }]);
  });

  test("bare text from before the envelope still restores unchanged", async () => {
    storage.setItem("kone:draft:/repo#pane-1", "just some words");
    const { draft, restores } = await draftHarness();
    draft.restoreDraft();

    expect(restores).toEqual([{ text: "just some words", skills: [], references: [] }]);
  });
});

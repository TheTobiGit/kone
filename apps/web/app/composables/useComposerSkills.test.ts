import { describe, expect, test } from "bun:test";
import { nextTick, ref } from "vue";
import type { InvokableSkill, ProviderKind, SkillReference } from "~/types/desktop";
import type { SendRejection } from "./agentTypes";
import type { ComposerDraftPart } from "~/utils/composerSkills";
import { useComposerSkills, type UseComposerSkillsDeps } from "./useComposerSkills";

function skill(name: string, path?: string): InvokableSkill {
  return {
    name,
    description: null,
    path: path ?? `/s/${name}/SKILL.md`,
    shortDescription: null,
    scope: "user",
    origin: "claude",
  };
}

function refOf(name: string, path?: string): SkillReference {
  return { name, path: path ?? `/s/${name}/SKILL.md` };
}

const settle = async () => {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
};

type DraftPartsHolder = { current: readonly ComposerDraftPart[] };
type DraftTextHolder = { current: string };

type Harness = {
  api: ReturnType<typeof useComposerSkills>;
  parts: DraftPartsHolder;
  text: DraftTextHolder;
  restored: { draft: string; skills: readonly SkillReference[] }[];
  errorCues: { count: number };
  notices: string[];
  marks: { count: number };
  editorRestores: { value: string; skills: readonly SkillReference[] | undefined }[];
  setRejection: (rejection: SendRejection | null) => void;
};

/** The composable with every editor edge as an injectable — no DOM, no sound. */
function harness(
  list: InvokableSkill[],
  opts: { isJob?: boolean; provider?: ProviderKind | null } = {},
): Harness {
  const parts: DraftPartsHolder = { current: [] };
  const text: DraftTextHolder = { current: "" };
  const restored: { draft: string; skills: readonly SkillReference[] }[] = [];
  const errorCues = { count: 0 };
  const notices: string[] = [];
  const marks = { count: 0 };
  const editorRestores: { value: string; skills: readonly SkillReference[] | undefined }[] = [];
  const rejection = ref<SendRejection | null | undefined>(null);
  const deps: UseComposerSkillsDeps = {
    provider: () => opts.provider ?? "claudeAgent",
    cwd: () => "/repo",
    isJob: () => opts.isJob ?? false,
    isOpen: () => false,
    sendRejection: () => rejection.value,
    currentText: () => text.current,
    draftParts: () => parts.current,
    setEditorFromText: (value, saved) => {
      editorRestores.push({ value, skills: saved });
    },
    markSkillChips: () => {
      marks.count += 1;
    },
    getSetDraft: () => async (draft, saved) => {
      restored.push({ draft, skills: saved ?? [] });
    },
    cueError: () => {
      errorCues.count += 1;
    },
    flashNotice: (notice) => {
      notices.push(notice);
    },
    bridge: () => ({ listInvokable: () => Promise.resolve(list) }),
  };
  const api = useComposerSkills(deps);
  return {
    api,
    parts,
    text,
    restored,
    errorCues,
    notices,
    marks,
    editorRestores,
    setRejection: (next) => {
      rejection.value = next;
    },
  };
}

const chip = (name: string): ComposerDraftPart => ({ type: "skill", skill: refOf(name) });
const prose = (value: string): ComposerDraftPart => ({ type: "text", text: value });

describe("useComposerSkills", () => {
  test("composeTurn resolves picked chips against the live list", async () => {
    const h = harness([skill("tdd"), skill("animate-text")]);
    await settle();
    h.parts.current = [chip("TDD"), prose(" fix the heading ")];
    h.text.current = "/TDD fix the heading ";
    const turn = h.api.composeTurn();
    expect(turn).toEqual({ input: "fix the heading", skills: [refOf("tdd")] });
    expect(h.errorCues.count).toBe(0);
    expect(h.notices).toEqual([]);
  });

  test("composeTurn takes chips at their word before the list answers", () => {
    const h = harness([skill("tdd")]);
    // No settle: the list has not answered, so readiness is still false.
    h.parts.current = [chip("tdd"), prose(" go")];
    h.text.current = "/tdd go";
    expect(h.api.ready.value).toBe(false);
    expect(h.api.composeTurn()).toEqual({ input: "go", skills: [refOf("tdd")] });
  });

  test("composeTurn refuses when a chip can no longer run, and the draft stays", async () => {
    const h = harness([skill("tdd")]);
    await settle();
    h.parts.current = [chip("tdd"), chip("gone"), prose(" go")];
    h.text.current = "/tdd /gone go";
    expect(h.api.composeTurn()).toBeNull();
    expect(h.errorCues.count).toBe(1);
    expect(h.notices).toEqual(["gone isn't available here — remove it to send"]);
    expect(h.marks.count).toBeGreaterThan(0);
  });

  test("the missing notice names every gone skill", async () => {
    const h = harness([]);
    await settle();
    h.parts.current = [chip("one"), chip("two"), prose(" go")];
    expect(h.api.composeTurn()).toBeNull();
    expect(h.notices).toEqual(["one, two aren't available here — remove them to send"]);
  });

  test("a job offers no skills, so every chip is missing", async () => {
    const h = harness([skill("tdd")], { isJob: true });
    await settle();
    expect(h.api.invokableSkills.value).toEqual([]);
    h.parts.current = [chip("tdd"), prose(" go")];
    expect(h.api.composeTurn()).toBeNull();
  });

  test("skillAvailable is true until the list answers, then follows it", async () => {
    const h = harness([skill("tdd")]);
    expect(h.api.skillAvailable(refOf("gone"))).toBe(true);
    await settle();
    expect(h.api.skillAvailable(refOf("TDD"))).toBe(true);
    expect(h.api.skillAvailable(refOf("gone"))).toBe(false);
  });

  test("restoreEditorFromText falls back to the live list and re-marks", async () => {
    const h = harness([skill("tdd")]);
    await settle();
    h.api.restoreEditorFromText("/tdd go");
    expect(h.editorRestores).toEqual([{ value: "/tdd go", skills: [skill("tdd")] }]);
    expect(h.marks.count).toBeGreaterThan(0);
  });

  test("a refused send restores the exact draft this composer sent", async () => {
    const h = harness([skill("tdd")]);
    await settle();
    h.parts.current = [chip("tdd"), prose("fix it")];
    h.text.current = "/tdd fix it";
    const turn = h.api.composeTurn();
    expect(turn).not.toBeNull();
    // The field is empty by the time the refusal lands.
    h.text.current = "";
    h.setRejection({ at: 1, message: "refused", input: "fix it", skills: [refOf("tdd")] });
    await settle();
    expect(h.restored).toEqual([{ draft: "/tdd fix it", skills: [refOf("tdd")] }]);
  });

  test("a refusal for another surface's turn rebuilds from what it carried", async () => {
    const h = harness([skill("tdd")]);
    await settle();
    h.text.current = "";
    h.setRejection({ at: 1, message: "refused", input: "fix it", skills: [refOf("tdd")] });
    await settle();
    expect(h.restored).toEqual([{ draft: "/tdd fix it", skills: [refOf("tdd")] }]);
  });

  test("a refusal never overwrites what the user started writing since", async () => {
    const h = harness([skill("tdd")]);
    await settle();
    h.parts.current = [chip("tdd"), prose("fix it")];
    h.text.current = "/tdd fix it";
    h.api.composeTurn();
    h.text.current = "something new";
    h.setRejection({ at: 1, message: "refused", input: "fix it", skills: [refOf("tdd")] });
    await settle();
    expect(h.restored).toEqual([]);
  });

  test("draftFromTurn writes chips ahead of the prose", () => {
    const h = harness([]);
    expect(h.api.draftFromTurn("fix it", [refOf("tdd"), refOf("animate-text")])).toBe(
      "/tdd /animate-text fix it",
    );
    expect(h.api.draftFromTurn("fix it", [])).toBe("fix it");
  });

  test("unavailableSkillsNotice reads singular and plural", () => {
    const h = harness([]);
    expect(h.api.unavailableSkillsNotice([refOf("gone")])).toBe(
      "gone isn't available here — remove it to send",
    );
    expect(h.api.unavailableSkillsNotice([refOf("a"), refOf("b")])).toBe(
      "a, b aren't available here — remove them to send",
    );
  });
});

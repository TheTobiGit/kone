import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { nextTick, ref } from "vue";
import type { ChatAttachment, SkillReference } from "~/types/desktop";
import type { QueueReturn } from "./agentTypes";
import { MAX_ATTACHMENTS, useComposerAttachments } from "./useComposerAttachments";
import { useComposerQueueReturn } from "./useComposerQueueReturn";

const REVIEW: SkillReference = { name: "review", path: "/skills/review/SKILL.md" };
const TYPO: SkillReference = { name: "typo", path: "/skills/typo/SKILL.md" };

function files(n: number, prefix = "f"): ChatAttachment[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "file" as const,
    id: `att_${prefix}${i}`,
    name: `${prefix}${i}.txt`,
    mimeType: "text/plain",
    sizeBytes: 1,
  }));
}

/** A composer field reduced to what the hand-back touches. */
function field(initial: string, skills: SkillReference[] = []) {
  const text = ref(initial);
  const picked = ref<readonly SkillReference[]>(skills);
  const restored: ChatAttachment[][] = [];
  return {
    text,
    picked,
    restored,
    deps: (queueReturn: () => QueueReturn | null) => ({
      queueReturn,
      currentText: () => text.value,
      currentSkills: () => [...picked.value],
      draftFromTurn: (input: string, skills: readonly SkillReference[]) =>
        `${skills.map((s) => `/${s.name} `).join("")}${input}`,
      setDraft: async (draft: string, skills: readonly SkillReference[]) => {
        text.value = draft;
        picked.value = skills;
      },
      restoreUploaded: async (list: readonly ChatAttachment[]) => {
        restored.push([...list]);
      },
    }),
  };
}

describe("a Stop's hand-back in the composer", () => {
  test("a hand-back waiting at mount lands ahead of the restored draft, once", async () => {
    const back: QueueReturn = { at: 1, text: "first\n\nsecond", attachments: files(2), skills: [REVIEW] };
    // The composer mounts with the user's saved draft already back in the field.
    const f = field("/typo half-written idea", [TYPO]);
    const { consume } = useComposerQueueReturn(f.deps(() => back));

    await consume();
    expect(f.text.value).toBe("/review first\n\nsecond\n\n/typo half-written idea");
    expect(f.picked.value).toEqual([REVIEW, TYPO]);
    expect(f.restored).toEqual([files(2)]);

    // Remounting, or another composer on the same thread, restores nothing again.
    const again = field("");
    await useComposerQueueReturn(again.deps(() => back)).consume();
    expect(again.text.value).toBe("");
  });

  test("a hand-back arriving while mounted is restored as it lands", async () => {
    const pending = ref<QueueReturn | null>(null);
    const f = field("");
    useComposerQueueReturn(f.deps(() => pending.value));
    pending.value = { at: 2, text: "queued words", attachments: [], skills: [] };
    await nextTick();
    await Promise.resolve();
    expect(f.text.value).toBe("queued words");
  });
});

type WindowHolder = { window?: unknown };

describe("restoring handed-back files", () => {
  const realFetch = globalThis.fetch;
  // SAFETY: WindowHolder names the one global slot this suite borrows (the
  // picker's notice timer reads window); it is put back after each test.
  const holder = globalThis as WindowHolder;
  const hadWindow = "window" in globalThis;
  const savedWindow = holder.window;
  beforeEach(() => {
    holder.window = globalThis;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (hadWindow) holder.window = savedWindow;
    else delete holder.window;
  });

  test("keeps every file even past the per-message cap, and the picker then refuses more", async () => {
    // SAFETY: the stub answers only the attachment:// reads under test.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    globalThis.fetch = (async () => new Response(new Blob(["x"]))) as unknown as typeof fetch;
    const { attachments, restoreUploaded, addFiles } = useComposerAttachments({
      isOpen: () => true,
      wake: async () => {},
      syncSoon: () => {},
    });

    // Two queued messages of five files each come back from one Stop.
    await restoreUploaded([...files(5, "a"), ...files(5, "b")]);
    expect(attachments.value).toHaveLength(10);
    expect(attachments.value.length).toBeGreaterThan(MAX_ATTACHMENTS);

    addFiles([new File(["y"], "extra.txt", { type: "text/plain" })]);
    expect(attachments.value).toHaveLength(10);
  });
});

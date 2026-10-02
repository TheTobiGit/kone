import { describe, expect, test } from "bun:test";
import { nextTick, ref } from "vue";
import type { InvokableSkill, ProviderKind } from "~/types/desktop";
import { useConversationSkills } from "./useConversationSkills";

function skill(name: string): InvokableSkill {
  return {
    name,
    description: null,
    path: `/s/${name}/SKILL.md`,
    shortDescription: null,
    scope: "user",
    origin: "claude",
  };
}

/** A listInvokable whose answers the test releases by hand, in any order. */
function deferredBridge() {
  const calls: { provider: ProviderKind; cwd: string | null; resolve: (list: InvokableSkill[]) => void }[] = [];
  const api = {
    listInvokable: (provider: ProviderKind, cwd: string | null) =>
      new Promise<InvokableSkill[]>((resolve) => calls.push({ provider, cwd, resolve })),
  };
  return { calls, bridge: () => api };
}

const settle = async () => {
  await Promise.resolve();
  await nextTick();
};

describe("useConversationSkills", () => {
  test("asks for the provider and place, and is ready once answered", async () => {
    const { calls, bridge } = deferredBridge();
    const result = useConversationSkills(() => "claudeAgent", () => "/repo", { bridge });
    expect(result.ready.value).toBe(false);
    expect(calls.map((c) => [c.provider, c.cwd])).toEqual([["claudeAgent", "/repo"]]);
    calls[0]!.resolve([skill("tdd")]);
    await settle();
    expect(result.ready.value).toBe(true);
    expect(result.skills.value.map((s) => s.name)).toEqual(["tdd"]);
  });

  test("passes a null cwd through for a surface with no project", () => {
    const { calls, bridge } = deferredBridge();
    useConversationSkills(() => "codex", () => null, { bridge });
    expect(calls[0]?.cwd).toBeNull();
  });

  test("a provider switch drops readiness, and a stale answer never lands", async () => {
    const { calls, bridge } = deferredBridge();
    const provider = ref<ProviderKind>("claudeAgent");
    const result = useConversationSkills(() => provider.value, () => "/repo", { bridge });
    calls[0]!.resolve([skill("claude-only")]);
    await settle();
    expect(result.ready.value).toBe(true);

    provider.value = "codex";
    await nextTick();
    expect(result.ready.value).toBe(false);
    provider.value = "cursor";
    await nextTick();
    // The codex answer arrives after cursor was asked for — it is dropped.
    calls[1]!.resolve([skill("codex-only")]);
    await settle();
    expect(result.ready.value).toBe(false);
    calls[2]!.resolve([]);
    await settle();
    expect(result.ready.value).toBe(true);
    expect(result.skills.value).toEqual([]);
  });

  test("no provider, or no bridge, invokes nothing and is ready at once", () => {
    const none = useConversationSkills(() => null, () => "/repo", { bridge: deferredBridge().bridge });
    expect(none.ready.value).toBe(true);
    expect(none.skills.value).toEqual([]);
    const bare = useConversationSkills(() => "claudeAgent", () => "/repo", { bridge: () => undefined });
    expect(bare.ready.value).toBe(true);
  });

  test("a throwing bridge reads as no skills rather than an error", async () => {
    const result = useConversationSkills(() => "claudeAgent", () => "/repo", {
      bridge: () => ({ listInvokable: () => Promise.reject(new Error("old bridge")) }),
    });
    await settle();
    expect(result.ready.value).toBe(true);
    expect(result.skills.value).toEqual([]);
  });
});

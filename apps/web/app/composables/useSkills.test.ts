import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
  KoneAgentSkillsApi,
  PluginEntry,
  SkillEntry,
  SkillState,
  SkillStateQuery,
  SkillStateResult,
  StateWriteResult,
  WritableSkillState,
} from "~/types/desktop";
import { isKoneEnabled, isKonePluginEnabled, useSkills } from "./useSkills";
import type { UseSkillsBridge } from "./useSkills";

function makeSkill(overrides?: Partial<SkillEntry>): SkillEntry {
  return {
    name: "test-skill",
    displayName: "Test Skill",
    description: "A skill for testing",
    shortDescription: "Testing",
    path: "/mock/home/.claude/skills/test-skill/SKILL.md",
    directory: "/mock/home/.claude/skills/test-skill",
    origin: "claude",
    scope: "user",
    author: null,
    modifiedAt: 1000,
    shadowedBy: [],
    manualOnly: false,
    enabled: true,
    ...overrides,
  };
}

function makePlugin(overrides?: Partial<PluginEntry>): PluginEntry {
  return {
    name: "test-plugin",
    description: "A plugin for testing",
    path: "/mock/home/.claude/plugins/test-plugin",
    origin: "claude",
    scope: "user",
    skills: [],
    ...overrides,
  };
}

function bridgeWith(skills: Partial<KoneAgentSkillsApi>): () => UseSkillsBridge | undefined {
  return () => ({ skills });
}

function testSkills(skillsApi: Partial<KoneAgentSkillsApi>) {
  return useSkills(() => null, { bridge: bridgeWith(skillsApi) });
}

type WindowHolder = { window?: unknown };

describe("useSkills CLI state management", () => {
  // The composable reads the bridge through its injected seam, never through
  // a shared global, so no test touches globalThis.window. The snapshot below
  // only guards the SSR test's deliberate delete against leaking into the
  // next file in the same process.
  let savedWindow: unknown;
  let hadWindow: boolean;

  // The module-level state cache is keyed by skill path and every test below
  // uses its own path namespace, so entries from an earlier test never match
  // a later test's lookups and no reset is needed.
  beforeEach(() => {
    // SAFETY: WindowHolder names the one global slot this suite snapshots.
    const holder = globalThis as WindowHolder;
    hadWindow = "window" in globalThis;
    savedWindow = holder.window;
  });

  afterEach(() => {
    // SAFETY: writes back the exact slot captured above and nothing else.
    const holder = globalThis as WindowHolder;
    if (hadWindow) {
      holder.window = savedWindow;
    } else {
      delete holder.window;
    }
  });

  it("reads and loads skill states via desktop bridge", async () => {
    const skill = makeSkill();

    const skills = testSkills({
      writeState: async (): Promise<StateWriteResult> => ({
        ok: true,
        wrotePath: null,
        reason: "Wrote override",
      }),
      readState: async (): Promise<SkillStateResult> => ({
        state: "enabled",
        reason: "Active in settings",
        source: "/mock/home/.claude/settings.json",
      }),
    });
    await skills.loadStates([skill]);

    const state = skills.stateOf(skill);
    expect(state).toBeDefined();
    expect(state?.state).toBe("enabled");
    expect(state?.source).toBe("/mock/home/.claude/settings.json");
  });

  it("writes CLI state, re-reads fresh, and leaves the kone gate untouched", async () => {
    let writtenState: string | null = null;
    let currentState: SkillState = "enabled";
    let internalWrites = 0;
    const skill = makeSkill({ path: "/mock/cli-only/SKILL.md" });

    const skills = testSkills({
      writeState: async (
        _query: SkillStateQuery,
        state: WritableSkillState,
      ): Promise<StateWriteResult> => {
        writtenState = state;
        currentState = state;
        return { ok: true, wrotePath: null, reason: "Updated config" };
      },
      readState: async (): Promise<SkillStateResult> => ({
        state: currentState,
        reason: `Now ${currentState}`,
        source: "/mock/home/.claude/settings.json",
      }),
      setSkillInternalState: async () => {
        internalWrites += 1;
        return { disabled: [], disabledPlugins: [] };
      },
    });
    await skills.loadStates([skill]);
    expect(skills.stateOf(skill)?.state).toBe("enabled");

    const res = await skills.setState(skill, "disabled");
    expect(res.ok).toBe(true);
    expect<string | null>(writtenState).toBe("disabled");
    expect(skills.stateOf(skill)?.state).toBe("disabled");
    // The CLI toggle owns the CLI switch only — no cascading internal write.
    expect(internalWrites).toBe(0);
  });

  it("reads the kone gate from the inventory annotation, never by matching", () => {
    expect(isKoneEnabled(makeSkill({ internalEnabled: true }))).toBe(true);
    expect(isKoneEnabled(makeSkill({ internalEnabled: false }))).toBe(false);
    // Absent annotation (older scan payload) falls back to the discovery default.
    expect(isKoneEnabled(makeSkill({ internalEnabled: undefined }))).toBe(true);
    expect(isKonePluginEnabled(makePlugin({ internalEnabled: false }))).toBe(false);
    expect(isKonePluginEnabled(makePlugin({ internalEnabled: undefined }))).toBe(true);
  });

  it("folds the CLI state into the effective flag", async () => {
    const skill = makeSkill({ path: "/mock/effective/SKILL.md", internalEnabled: true });

    const skills = testSkills({
      writeState: async (): Promise<StateWriteResult> => ({
        ok: true,
        wrotePath: null,
        reason: "ok",
      }),
      readState: async (): Promise<SkillStateResult> => ({
        state: "disabled",
        reason: "off",
        source: "mock",
      }),
    });
    // No CLI read yet: discovery flag (enabled) plus annotation (on) reads on.
    expect(skills.isEffectiveEnabled(skill)).toBe(true);
    await skills.loadStates([skill]);
    expect(skills.isEffectiveEnabled(skill)).toBe(false);
  });

  it("enabling restores the CLI switch before opening the kone gate, in order", async () => {
    const order: string[] = [];
    let cliState: SkillState = "disabled";
    const skill = makeSkill({ path: "/mock/ordered/SKILL.md", internalEnabled: false });

    const skills = testSkills({
      writeState: async (
        _query: SkillStateQuery,
        state: WritableSkillState,
      ): Promise<StateWriteResult> => {
        order.push(`cli:${state}`);
        cliState = state;
        return { ok: true, wrotePath: null, reason: "Updated config" };
      },
      readState: async (): Promise<SkillStateResult> => ({
        state: cliState,
        reason: "mock",
        source: "mock",
      }),
      setSkillInternalState: async () => {
        order.push("internal:true");
        return { disabled: [], disabledPlugins: [] };
      },
    });
    await skills.loadStates([skill]);

    const res = await skills.setEffectiveEnabled(skill, true);
    expect(res.ok).toBe(true);
    expect(order).toEqual(["cli:enabled", "internal:true"]);
    expect(skill.internalEnabled).toBe(true);
    expect(skills.internalSettings.value).toEqual({ disabled: [], disabledPlugins: [] });
  });

  it("disabling writes only the kone gate and leaves CLI config alone", async () => {
    let cliWrites = 0;
    const skill = makeSkill({ path: "/mock/disable-only/SKILL.md", internalEnabled: true });

    const skills = testSkills({
      writeState: async (): Promise<StateWriteResult> => {
        cliWrites += 1;
        return { ok: true, wrotePath: null, reason: "ok" };
      },
      readState: async (): Promise<SkillStateResult> => ({
        state: "enabled",
        reason: "mock",
        source: "mock",
      }),
      setSkillInternalState: async () => ({ disabled: [skill.path], disabledPlugins: [] }),
    });
    await skills.loadStates([skill]);

    const res = await skills.setEffectiveEnabled(skill, false);
    expect(res.ok).toBe(true);
    expect(cliWrites).toBe(0);
    expect(skill.internalEnabled).toBe(false);
    expect(skills.internalSettings.value.disabled).toContain(skill.path);
  });

  it("a failed CLI restore aborts the kone write and refreshes the CLI read", async () => {
    let reads = 0;
    let internalWrites = 0;
    const skill = makeSkill({ path: "/mock/cli-fails/SKILL.md", internalEnabled: false });

    const skills = testSkills({
      writeState: async (): Promise<StateWriteResult> => ({
        ok: false,
        wrotePath: null,
        reason: "Disk is read-only",
      }),
      readState: async (): Promise<SkillStateResult> => {
        reads += 1;
        return { state: "disabled", reason: "mock", source: "mock" };
      },
      setSkillInternalState: async () => {
        internalWrites += 1;
        return { disabled: [], disabledPlugins: [] };
      },
    });
    await skills.loadStates([skill]);
    const readsBefore = reads;

    const res = await skills.setEffectiveEnabled(skill, true);
    expect(res.ok).toBe(false);
    expect(internalWrites).toBe(0);
    // Failure path re-reads instead of leaving the hoped-for state behind.
    expect(reads).toBeGreaterThan(readsBefore);
    expect(skill.internalEnabled).toBe(false);
  });

  it("a failed kone write refreshes and leaves the annotation alone", async () => {
    let reads = 0;
    const skill = makeSkill({ path: "/mock/internal-fails/SKILL.md", internalEnabled: true });

    const skills = testSkills({
      writeState: async (): Promise<StateWriteResult> => ({
        ok: true,
        wrotePath: null,
        reason: "ok",
      }),
      readState: async (): Promise<SkillStateResult> => {
        reads += 1;
        return { state: "enabled", reason: "mock", source: "mock" };
      },
      setSkillInternalState: async () => {
        throw new Error("IPC blew up");
      },
    });
    await skills.loadStates([skill]);
    const readsBefore = reads;

    const res = await skills.setEffectiveEnabled(skill, false);
    expect(res.ok).toBe(false);
    expect(reads).toBeGreaterThan(readsBefore);
    expect(skill.internalEnabled).toBe(true);
  });

  it("per-key busy lets parallel toggles proceed but refuses a double toggle", async () => {
    const gateA = Promise.withResolvers<{ disabled: string[]; disabledPlugins: string[] }>();
    const gateB = Promise.withResolvers<{ disabled: string[]; disabledPlugins: string[] }>();
    const skillA = makeSkill({
      name: "skill-a",
      path: "/mock/parallel/a/SKILL.md",
      internalEnabled: true,
    });
    const skillB = makeSkill({
      name: "skill-b",
      path: "/mock/parallel/b/SKILL.md",
      internalEnabled: true,
    });

    const skills = testSkills({
      writeState: async (): Promise<StateWriteResult> => ({
        ok: true,
        wrotePath: null,
        reason: "ok",
      }),
      readState: async (): Promise<SkillStateResult> => ({
        state: "enabled",
        reason: "mock",
        source: "mock",
      }),
      setSkillInternalState: async (target) => {
        if (target.name === "skill-a") return gateA.promise;
        return gateB.promise;
      },
    });
    await skills.loadStates([skillA, skillB]);

    const pendingA = skills.setEffectiveEnabled(skillA, false);
    const pendingB = skills.setEffectiveEnabled(skillB, false);
    // Both rows are in flight at once — no global serialization.
    expect(skills.isSkillBusy(skillA)).toBe(true);
    expect(skills.isSkillBusy(skillB)).toBe(true);

    const refused = await skills.setEffectiveEnabled(skillA, false);
    expect(refused.ok).toBe(false);

    gateB.resolve({ disabled: [], disabledPlugins: [] });
    const resB = await pendingB;
    expect(resB.ok).toBe(true);
    expect(skills.isSkillBusy(skillB)).toBe(false);
    expect(skills.isSkillBusy(skillA)).toBe(true);

    gateA.resolve({ disabled: [skillA.path], disabledPlugins: [] });
    const resA = await pendingA;
    expect(resA.ok).toBe(true);
    expect(skills.isSkillBusy(skillA)).toBe(false);
  });

  it("toggles a plugin gate through IPC and adopts the returned settings", async () => {
    const plugin = makePlugin({ internalEnabled: true });
    let written: { id: string; on: boolean } | null = null;

    const skills = testSkills({
      writeState: async (): Promise<StateWriteResult> => ({
        ok: true,
        wrotePath: null,
        reason: "ok",
      }),
      readState: async (): Promise<SkillStateResult> => ({
        state: "enabled",
        reason: "mock",
        source: "mock",
      }),
      setPluginInternalState: async (id: string, on: boolean) => {
        written = { id, on };
        return { disabled: [], disabledPlugins: on ? [] : [id] };
      },
    });
    const res = await skills.setPluginEnabled(plugin, false);
    expect(res.ok).toBe(true);
    expect<{ id: string; on: boolean } | null>(written).toEqual({ id: plugin.name, on: false });
    expect(plugin.internalEnabled).toBe(false);
    expect(skills.internalSettings.value.disabledPlugins).toContain(plugin.name);
  });

  it("without a bridge loadStates stays inert and setState reports the absence", async () => {
    const skill = makeSkill({ path: "/mock/ssr-explicit/SKILL.md" });
    const skills = useSkills(() => null, { bridge: () => undefined });

    await skills.loadStates([skill]);
    expect(skills.stateOf(skill)).toBeUndefined();
    expect(skills.reading.value).toBe(false);

    const res = await skills.setState(skill, "enabled");
    expect(res.ok).toBe(false);
    expect(res.wrotePath).toBeNull();
  });

  it("the default bridge stays inert when there is no client window", async () => {
    // SAFETY: removes only the harness-owned window slot; afterEach restores it.
    delete (globalThis as WindowHolder).window;
    const skill = makeSkill({ path: "/mock/ssr-default/SKILL.md" });
    const skills = useSkills(() => null);

    await skills.loadStates([skill]);
    expect(skills.stateOf(skill)).toBeUndefined();
    expect(skills.reading.value).toBe(false);

    const res = await skills.setState(skill, "enabled");
    expect(res.ok).toBe(false);
    expect(res.wrotePath).toBeNull();
  });
});

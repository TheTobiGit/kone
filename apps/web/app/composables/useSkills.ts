import { computed, ref, shallowRef } from "vue";
import type {
  SkillEntry,
  SkillMutateResult,
  SkillRootTarget,
  SkillState,
  SkillStateResult,
  WritableSkillState,
} from "~/types/desktop";

// The state half of the skills surface. The inventory scan (useAgentSettings) says
// what is on disk; this says whether each one is actually switched on — a
// separate read per skill, because the answer lives in whichever settings file
// that skill's own CLI keeps, not in the skill folder.
//
// Two things follow from that and shape everything here. First, a list of forty
// skills is forty reads, so they run through a small pool rather than all at
// once — a settings pane must not open forty file handles the moment it paints.
// Second, no CLI offers a way to be told when its settings file changes, so a
// state is only ever as fresh as the last read; a write updates the row from the
// result kone got back, never from what kone hoped it wrote.

/** How many state reads are in flight at once. Small enough that opening the
 *  pane never stalls the render, large enough that forty skills settle in one
 *  visible beat. */
const POOL = 8;

/** Last-good state per skill, keyed by path so two skills sharing a name (the
 *  shadowing case) never collide. Module-level so reopening the pane paints the
 *  states it already knows instead of flashing every row back to "reading". */
const stateCache = new Map<string, SkillStateResult>();

/** A skill whose CLI offers no switch at all. Drawn as a stated fact, never as
 *  a control that would write nothing. */
export function isUnsupported(state: SkillState | undefined): boolean {
  return state === "unsupported";
}

/** True when the skill is reachable by the model on its own — the only state
 *  the list treats as "nothing to say". */
export function isLive(state: SkillState | undefined): boolean {
  return state === "enabled" || state === undefined;
}

/** v1 stable — t3 parity: on/off only. Claude's four-value override
 *  (on/name-only/user-invocable-only/off) is kept in the backend for compat,
 *  but the UI only offers enabled/disabled. The backend maps the two middle
 *  values to enabled, so a v1 toggle never leaves a skill in a half-state.
 *  Codex/opencode already are boolean; others have no switch. */
const WRITABLE_BY_ORIGIN: Record<string, WritableSkillState[]> = {
  claude: ["enabled", "disabled"],
  codex: ["enabled", "disabled"],
  opencode: ["enabled", "disabled"],
};

export function writableStates(origin: string): WritableSkillState[] {
  return WRITABLE_BY_ORIGIN[origin] ?? [];
}

export function useSkills(projectPath: () => string | string[] | null) {
  const bridge = () => (import.meta.client ? window.koneDesktop?.agent : undefined);

  function firstPath(): string | null {
    const p = projectPath();
    if (!p) return null;
    if (Array.isArray(p)) return p[0] ?? null;
    return p;
  }

  /** Path → state. Shallow: the map is replaced wholesale on each settle, which
   *  is one render for a batch instead of one per row. */
  const states = shallowRef<Map<string, SkillStateResult>>(new Map(stateCache));
  const reading = ref(false);

  function stateOf(skill: SkillEntry): SkillStateResult | undefined {
    return states.value.get(skill.path);
  }

  /** Read one skill's state, passing every fact the scan already holds —
   *  Codex selects by path and Claude's project-scope answer depends on the
   *  project, so a partial query is how a row ends up confidently wrong. */
  async function readOne(skill: SkillEntry): Promise<SkillStateResult | null> {
    const api = bridge()?.skills;
    if (!api?.readState) return null;
    try {
      return await api.readState({
        origin: skill.origin,
        skillName: skill.name,
        skillPath: skill.path,
        scope: skill.scope,
        projectPath: firstPath(),
      });
    } catch {
      // A state kone cannot read is left absent rather than guessed at — an
      // absent state draws as "reading…" and never as "on".
      return null;
    }
  }

  /** Fill in states for a list of skills, oldest answer first, in pool-sized
   *  waves. Skills already in the cache are re-read too: the user may have
   *  edited the settings file by hand since. */
  async function loadStates(skills: SkillEntry[]): Promise<void> {
    if (!bridge()?.skills?.readState || skills.length === 0) return;
    reading.value = true;
    const queue = [...skills];
    const next = new Map(states.value);

    async function worker(): Promise<void> {
      for (;;) {
        const skill = queue.shift();
        if (!skill) return;
        const result = await readOne(skill);
        if (result) {
          next.set(skill.path, result);
          stateCache.set(skill.path, result);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, worker));
    states.value = next;
    reading.value = false;
  }

  /** Write a state and adopt whatever kone reads back afterwards. The write's
   *  own result says only that a file changed; the row's truth is the re-read,
   *  so a settings file that ignored the write can never leave the UI claiming
   *  a state the CLI will not honour. */
  async function setState(
    skill: SkillEntry,
    state: WritableSkillState,
  ): Promise<{ ok: boolean; reason: string }> {
    const api = bridge()?.skills;
    if (!api?.writeState) return { ok: false, reason: "No desktop bridge is available." };

    const query = {
      origin: skill.origin,
      skillName: skill.name,
      skillPath: skill.path,
      scope: skill.scope,
      projectPath: firstPath(),
    };

    let result;
    try {
      result = await api.writeState(query, state);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "The write failed." };
    }

    const fresh = await readOne(skill);
    if (fresh) {
      const next = new Map(states.value);
      next.set(skill.path, fresh);
      stateCache.set(skill.path, fresh);
      states.value = next;
    }
    return { ok: result.ok, reason: result.reason };
  }

  // v1 list-only — no detail/lint/signals wiring. Stubs kept so
  // SkillDetailView.vue (orphaned for v2) still typechecks.
  const detail = ref<any>(null);
  const findings = ref<any[]>([]);
  const signals = ref<any>(null);
  const detailLoading = ref(false);
  const blockingFindings = computed<any[]>(() => []);
  async function openSkill(_skill: SkillEntry): Promise<void> {}

  // ── adding and removing ────────────────────────────────────────────────────
  // Where a skill can go is a separate question from what is installed: a
  // machine with no skills at all still has a folder per CLI, and that is
  // exactly the machine most in need of somewhere to put the first one.

  const roots = ref<SkillRootTarget[]>([]);

  async function loadRoots(): Promise<void> {
    const api = bridge()?.skills;
    if (!api?.roots) return;
    try {
      roots.value = await api.roots(projectPath());
    } catch {
      roots.value = [];
    }
  }

  /** Every mutation answers the same way: the backend's own finished sentence,
   *  said back to the user unchanged. Composing wording here would mean guessing
   *  at what happened on disk from a boolean. */
  function failed(action: string, cause: unknown): SkillMutateResult {
    return {
      ok: false,
      action,
      path: null,
      detail: cause instanceof Error ? cause.message : "The action failed.",
    };
  }

  async function scaffold(
    root: string,
    name: string,
    description: string,
  ): Promise<SkillMutateResult> {
    const api = bridge()?.skills;
    if (!api?.scaffold) return failed("scaffold", null);
    try {
      return await api.scaffold(root, name, description);
    } catch (error) {
      return failed("scaffold", error);
    }
  }

  async function installFromGit(url: string, destRoot: string): Promise<SkillMutateResult> {
    const api = bridge()?.skills;
    if (!api?.installFromGit) return failed("install", null);
    try {
      return await api.installFromGit(url, destRoot);
    } catch (error) {
      return failed("install", error);
    }
  }

  async function remove(skillDir: string): Promise<SkillMutateResult> {
    const api = bridge()?.skills;
    if (!api?.remove) return failed("remove", null);
    try {
      return await api.remove(skillDir);
    } catch (error) {
      return failed("remove", error);
    }
  }

  return {
    roots,
    loadRoots,
    scaffold,
    installFromGit,
    remove,
    states,
    reading,
    stateOf,
    loadStates,
    setState,
    detail,
    findings,
    blockingFindings,
    signals,
    detailLoading,
    openSkill,
  };
}

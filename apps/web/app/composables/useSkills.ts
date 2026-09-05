import { computed, ref, shallowRef } from "vue";
import type {
  InternalSkillsSettings,
  KoneAgentInventoryApi,
  KoneAgentSkillsApi,
  PluginEntry,
  SkillDetail,
  SkillEntry,
  SkillMutateResult,
  SkillRootTarget,
  SkillState,
  SkillStateResult,
  StateWriteResult,
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

/** Kone's own visibility gate for a skill, exactly as the inventory scan
 *  annotated it — no local matching against the disabled list, which the
 *  backend already evaluated. Absent means an older scan payload, and the
 *  discovery default is enabled. */
export function isKoneEnabled(skill: Pick<SkillEntry, "internalEnabled">): boolean {
  return skill.internalEnabled ?? true;
}

/** Same gate for a plugin container. */
export function isKonePluginEnabled(plugin: Pick<PluginEntry, "internalEnabled">): boolean {
  return plugin.internalEnabled ?? true;
}

/** Busy keys namespace skills vs plugins so a skill and a plugin sharing a
 *  path-shaped string never guard each other. */
export function skillBusyKey(skill: Pick<SkillEntry, "path">): string {
  return `skill:${skill.path}`;
}

export function pluginBusyKey(plugin: Pick<PluginEntry, "name" | "path">): string {
  return `plugin:${plugin.name || plugin.path}`;
}

/** The slice of the desktop bridge this composable reaches for. Partial so a
 *  caller can hand over only the surface its test exercises; the default is
 *  the full agent bridge and every read still guards for an absent method. */
export type UseSkillsBridge = {
  skills?: Partial<KoneAgentSkillsApi>;
  inventory?: Partial<KoneAgentInventoryApi>;
};

export type UseSkillsOptions = {
  bridge?: () => UseSkillsBridge | undefined;
};

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

export function useSkills(
  projectPath: () => string | string[] | null,
  options?: UseSkillsOptions,
) {
  const defaultBridge = (): UseSkillsBridge | undefined =>
    import.meta.client ? window.koneDesktop?.agent : undefined;
  const bridge: () => UseSkillsBridge | undefined = options?.bridge ?? defaultBridge;

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

  // Last settings object the backend returned from a write, adopted verbatim —
  // the backend owns the disabled-list matching, so kone never reconstructs
  // the list locally. Reads come from the inventory scan's per-entry
  // `internalEnabled` annotation (see isKoneEnabled), not from here.
  const internalSettings = ref<InternalSkillsSettings>({ disabled: [], disabledPlugins: [] });

  // One in-flight toggle per skill/plugin, keyed so two rows never serialize
  // behind each other. A Set (not a single string) is what lets parallel
  // toggles proceed independently.
  const busyKeys = ref<Set<string>>(new Set());

  function isSkillBusy(skill: Pick<SkillEntry, "path">): boolean {
    return busyKeys.value.has(skillBusyKey(skill));
  }

  function isPluginBusy(plugin: Pick<PluginEntry, "name" | "path">): boolean {
    return busyKeys.value.has(pluginBusyKey(plugin));
  }

  /** Whether the skill is effectively on: reachable in its CLI *and* visible
   *  in kone. The CLI half comes from the per-skill state reads; the kone
   *  half from the scan annotation. Unknown CLI state falls back to the
   *  discovery flag, matching the detail view's CLI row. */
  function isEffectiveEnabled(skill: SkillEntry): boolean {
    const cliState = states.value.get(skill.path)?.state;
    const cliOn = cliState === undefined ? skill.enabled : cliState !== "disabled";
    return cliOn && isKoneEnabled(skill);
  }

  /** Intent-only write of one skill's kone gate. The backend evaluates and
   *  persists; kone adopts whatever comes back. Null when there is no bridge
   *  or the write threw — never a guess. */
  async function writeSkillInternal(
    skill: Pick<SkillEntry, "path" | "name">,
    enabled: boolean,
  ): Promise<InternalSkillsSettings | null> {
    const api = bridge()?.skills;
    if (!api?.setSkillInternalState) return null;
    try {
      const updated = await api.setSkillInternalState(
        { path: skill.path, name: skill.name },
        enabled,
      );
      if (updated) internalSettings.value = updated;
      return updated ?? null;
    } catch {
      return null;
    }
  }

  async function writePluginInternal(
    plugin: Pick<PluginEntry, "name" | "path">,
    enabled: boolean,
  ): Promise<InternalSkillsSettings | null> {
    const api = bridge()?.skills;
    if (!api?.setPluginInternalState) return null;
    try {
      const updated = await api.setPluginInternalState(plugin.name || plugin.path, enabled);
      if (updated) internalSettings.value = updated;
      return updated ?? null;
    } catch {
      return null;
    }
  }

  /** Re-read one skill's CLI state into the map. Success paths already do
   *  this; failure paths call it so the row falls back to what the settings
   *  file actually says instead of what the failed write hoped. */
  async function refreshState(skill: SkillEntry): Promise<void> {
    const fresh = await readOne(skill);
    if (fresh) {
      const next = new Map(states.value);
      next.set(skill.path, fresh);
      stateCache.set(skill.path, fresh);
      states.value = next;
    }
  }

  function toggleRefused(path: string | null, what: string): SkillMutateResult {
    return { ok: false, action: "toggle", path, detail: `Already updating this ${what}.` };
  }

  /** The single coordinated toggle for a skill's effective state. Enabling
   *  restores the CLI switch first (when writable and off) and only then
   *  opens the kone gate; disabling closes the kone gate and leaves the
   *  user's CLI config untouched. Either write failing aborts the sequence
   *  and refreshes the CLI read, so the UI can never strand a row
   *  half-toggled. The passed entry's annotation is patched on success — it
   *  is the same object the inventory list renders, so the row settles
   *  without waiting for a rescan. */
  async function setEffectiveEnabled(skill: SkillEntry, on: boolean): Promise<SkillMutateResult> {
    const key = skillBusyKey(skill);
    if (busyKeys.value.has(key)) return toggleRefused(skill.path, "skill");
    busyKeys.value.add(key);
    try {
      if (on) {
        const cliState = states.value.get(skill.path)?.state;
        if (cliState === "disabled" && writableStates(skill.origin).length > 0) {
          const cli = await setState(skill, "enabled");
          if (!cli.ok) {
            await refreshState(skill);
            return { ok: false, action: "toggle", path: skill.path, detail: cli.reason };
          }
        }
      }
      const updated = await writeSkillInternal(skill, on);
      if (!updated) {
        await refreshState(skill);
        return {
          ok: false,
          action: "toggle",
          path: skill.path,
          detail: "Kone could not save the visibility setting.",
        };
      }
      skill.internalEnabled = on;
      return {
        ok: true,
        action: "toggle",
        path: skill.path,
        detail: on ? "The skill is visible in Kone." : "The skill is hidden in Kone.",
      };
    } finally {
      busyKeys.value.delete(key);
    }
  }

  /** Plugin containers have no CLI switch — one internal write, same per-key
   *  guard and same optimistic annotation patch as the skill path. */
  async function setPluginEnabled(plugin: PluginEntry, on: boolean): Promise<SkillMutateResult> {
    const key = pluginBusyKey(plugin);
    if (busyKeys.value.has(key)) return toggleRefused(plugin.path, "plugin");
    busyKeys.value.add(key);
    try {
      const updated = await writePluginInternal(plugin, on);
      if (!updated) {
        return {
          ok: false,
          action: "toggle",
          path: plugin.path,
          detail: "Kone could not save the plugin setting.",
        };
      }
      plugin.internalEnabled = on;
      return {
        ok: true,
        action: "toggle",
        path: plugin.path,
        detail: on ? "The plugin is visible in Kone." : "The plugin is hidden in Kone.",
      };
    } finally {
      busyKeys.value.delete(key);
    }
  }

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
   *  the skill is on. Returns the gateway result as-is — no translation. */
  async function setState(
    skill: SkillEntry,
    state: WritableSkillState,
  ): Promise<StateWriteResult> {
    const api = bridge()?.skills;
    if (!api?.writeState) return { ok: false, wrotePath: null, reason: "No desktop bridge is available." };

    const query = {
      origin: skill.origin,
      skillName: skill.name,
      skillPath: skill.path,
      scope: skill.scope,
      projectPath: firstPath(),
    };

    let result: StateWriteResult;
    try {
      result = await api.writeState(query, state);
    } catch (error) {
      return { ok: false, wrotePath: null, reason: error instanceof Error ? error.message : "The write failed." };
    }

    // The CLI toggle owns the CLI switch only — kone-gate coordination lives
    // in setEffectiveEnabled, so a CLI write never drags a second write
    // along with it.
    await refreshState(skill);

    return result;
  }

  // Detail pane — table + file content
  const detail = ref<SkillDetail | null>(null);
  const detailLoading = ref(false);
  // kept for compat with old detail view imports
  const findings = ref<any[]>([]);
  const signals = ref<any>(null);
  const blockingFindings = computed<any[]>(() => []);

  async function openSkill(skill: SkillEntry): Promise<void> {
    const api = bridge()?.inventory;
    if (!api?.readSkill) return;
    detail.value = null;
    detailLoading.value = true;
    try {
      detail.value = await api.readSkill(skill.path);
    } catch {
      detail.value = null;
    } finally {
      detailLoading.value = false;
    }
  }

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
    internalSettings,
    busyKeys,
    isSkillBusy,
    isPluginBusy,
    isEffectiveEnabled,
    setEffectiveEnabled,
    setPluginEnabled,
  };
}

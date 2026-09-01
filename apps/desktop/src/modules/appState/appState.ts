/**
 * What the renderer knows about itself and the shell does not — mirrored here so
 * the agent gateway can read it.
 *
 * The gateway lives in the main process and the app the user is looking at lives
 * in the renderer, so an agent tool that wants to describe the interface has to
 * be told about it. The appearance mirror in `../system/system.ts` was the first
 * of these; this is the same arrangement for the two surfaces that came next:
 *
 * - the **agent roster** — who a thread can be handed to. The agents kone ships
 *   are prose in the renderer's bundle and a stored row is a delta against one,
 *   so the *resolved* roster exists nowhere else.
 * - the **thread strip settings** — how the strip scrolls, and how wide a new
 *   pane opens. Per-install feel knobs the renderer holds in its own storage,
 *   which the main process has no way to read.
 *
 * Nothing here is authoritative: the renderer pushes, this remembers the last
 * push, and a write from an agent goes back the other way as a runtime event the
 * renderer applies. Null before the first push, which is the honest answer for
 * anything that asks while the window is still loading — naming a default the
 * user may have changed would have the agent report a roster and a layout that
 * are not the ones on screen.
 */
import { ipcMain } from "electron";

/** One agent in the renderer's roster, resolved: every field is what the roster
 *  actually shows rather than a row's half-answer. Flatter than the renderer's
 *  own `Agent` — a drawn face and a sort order say nothing to a model. */
export type AgentRosterEntry = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  face: { body: string; ink: string };
  model: { provider: string; model: string; label?: string } | null;
  skills: string[];
  /** True for an agent kone ships. Worth mirroring: clearing a field on a
   *  built-in hands it back to the shipped value and on a user-made agent unsets
   *  it, so the same tool call means two different things. */
  builtIn: boolean;
  /** True for the agent the user's next turn is handed to. */
  active: boolean;
  /** The project paths whose team this agent is on. */
  teams: string[];
};

/** Where the strip lands when a column takes focus. */
export type StripCentering = "never" | "on-overflow" | "always";

export type StripPaneKind = "thread" | "terminal" | "scratchpad";

/** The strip settings as the renderer reports them. `ladder` rides along because
 *  a width is a rung index rather than a size — without it an agent asked for
 *  "one wider" has no way to know which rungs exist. */
export type StripSettingsState = {
  centering: StripCentering;
  defaultWidths: Record<StripPaneKind, number>;
  ladder: number[];
};

/** What `app:state` carries. Each half is optional and independent: the roster
 *  and the strip change for unrelated reasons, and a push about one must not be
 *  read as "the other is now empty". */
export type AppStatePush = {
  agents?: AgentRosterEntry[];
  strip?: StripSettingsState;
};

const CENTERINGS = new Set<StripCentering>(["never", "on-overflow", "always"]);
const PANE_KINDS: readonly StripPaneKind[] = ["thread", "terminal", "scratchpad"];

let agentRoster: AgentRosterEntry[] | null = null;
let stripSettings: StripSettingsState | null = null;

/** The agent roster the renderer last reported, or null before its first push.
 *  Read by the agent gateway so `app_list_agents` names the agents this install
 *  actually holds. */
export function currentAgentRoster(): readonly AgentRosterEntry[] | null {
  return agentRoster;
}

/** The thread strip settings the renderer last reported, or null before its
 *  first push. Read by the agent gateway so the strip tools describe and change
 *  the board the user is looking at. */
export function currentStripSettings(): StripSettingsState | null {
  return stripSettings;
}

/** A present, non-blank string, or undefined. The push crosses IPC, so an empty
 *  name is as good as a missing one. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** One model ref, or null if the payload isn't one. A ref missing either half
 *  names no model, and "no model" is a real answer here — the agent then runs
 *  wherever the turn does. */
function readModelRef(
  value: AgentRosterEntry["model"] | undefined,
): AgentRosterEntry["model"] {
  if (!value || !(value instanceof Object)) return null;
  const provider = nonEmpty(value.provider);
  const model = nonEmpty(value.model);
  if (!provider || !model) return null;
  const label = nonEmpty(value.label);
  return label === undefined ? { provider, model } : { provider, model, label };
}

/** One roster entry, or null if the payload isn't one. The renderer builds these
 *  from its own roster so they arrive well-formed; this is the guard for a
 *  renderer of a different vintage than the shell it is talking to. */
function readAgentEntry(
  value: Partial<AgentRosterEntry> | null | undefined,
): AgentRosterEntry | null {
  if (!value || !(value instanceof Object)) return null;
  const id = nonEmpty(value.id);
  if (!id) return null;
  const body = nonEmpty(value.face?.body) ?? "";
  const ink = nonEmpty(value.face?.ink) ?? "";
  return {
    id,
    // An agent with no readable name is still in the roster and still takes
    // work, so it answers to its id rather than being dropped.
    name: nonEmpty(value.name) ?? id,
    role: nonEmpty(value.role) ?? "",
    instructions: nonEmpty(value.instructions) ?? "",
    face: { body, ink },
    model: readModelRef(value.model ?? null),
    skills: Array.isArray(value.skills)
      ? value.skills.map((skill) => nonEmpty(skill)).filter((skill): skill is string => !!skill)
      : [],
    builtIn: value.builtIn === true,
    active: value.active === true,
    teams: Array.isArray(value.teams)
      ? value.teams.map((path) => nonEmpty(path)).filter((path): path is string => !!path)
      : [],
  };
}

/** A rung index, or null if the payload isn't one. Bounded by the ladder the
 *  same push carried: a rung past the end would have the gateway offer a width
 *  the board cannot lay out. */
function readRung(value: number | undefined, rungs: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(Number(value));
  if (rounded < 0 || rounded >= rungs) return null;
  return rounded;
}

/** The strip settings, or null if the payload isn't a readable set. Partial is
 *  not accepted: these are read together to describe one board, and a mirror
 *  half-filled from a malformed push would have the agent report a centering
 *  mode next to widths from an older one. */
function readStripSettings(
  value: Partial<StripSettingsState> | null | undefined,
): StripSettingsState | null {
  if (!value || !(value instanceof Object)) return null;
  const centering = value.centering;
  if (!centering || !CENTERINGS.has(centering)) return null;
  const ladder = Array.isArray(value.ladder)
    ? value.ladder.filter((px): px is number => Number.isFinite(px) && px > 0)
    : [];
  if (ladder.length === 0) return null;

  const widths = {
    thread: 0,
    terminal: 0,
    scratchpad: 0,
  } satisfies Record<StripPaneKind, number>;
  for (const kind of PANE_KINDS) {
    // A kind the push doesn't mention, or names out of range, opens at the
    // narrowest rung — which is what the board itself falls back to.
    widths[kind] = readRung(value.defaultWidths?.[kind], ladder.length) ?? 0;
  }

  return { centering, defaultWidths: widths, ladder };
}

/**
 * Take one push from the renderer.
 *
 * Each half is applied only when it arrives and only when something in it
 * survives validation. A push carrying nothing usable leaves the last good
 * answer standing: an agent reading a stale roster is wrong about one agent,
 * while an agent reading an empty one is wrong about the whole app.
 */
export function setAppState(state: AppStatePush | undefined): void {
  if (!state || !(state instanceof Object)) return;
  if (Array.isArray(state.agents)) {
    const entries = state.agents
      .map(readAgentEntry)
      .filter((entry): entry is AgentRosterEntry => entry !== null);
    if (entries.length > 0) agentRoster = entries;
  }
  const strip = readStripSettings(state.strip);
  if (strip) stripSettings = strip;
}

/** Register the app:state handler. Call once, before creating the window. */
export function registerAppStateIpc(): void {
  ipcMain.handle("app:state", (_event, state?: AppStatePush) => setAppState(state));
}

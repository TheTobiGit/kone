import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ipcMain, nativeTheme, shell } from "electron";

// Host facts for the sandboxed renderer. Mirror changes in apps/web/app/types/desktop.d.ts.

export type ThemeMode = "light" | "dark" | "system";

/** What the renderer knows about its own appearance and the shell does not:
 *  which theme is painted, and the scheme that theme actually resolved to. The
 *  mode alone can't answer either — a fixed theme overrides it. */
export type AppearanceState = {
  themeId: string;
  themeLabel: string;
  mode: ThemeMode;
  /** The scheme on screen right now, after a locked theme or the OS has had
   *  its say. */
  scheme: "light" | "dark";
  /** True when the theme pins its own scheme and the mode is inert. */
  locked: boolean;
};

/** One theme in the renderer's library, as it reports it. The shell keeps no
 *  theme list of its own — this install's library is whatever the user has
 *  imported and authored on top of the built-ins, and only the renderer knows
 *  it. Mirrored here so the agent gateway can list and resolve against the
 *  real thing instead of a copy that has to be kept in step by hand. */
export type ThemeRosterEntry = {
  id: string;
  label: string;
  blurb: string;
  kind: "system" | "adaptive" | "fixed";
  appearance: "light" | "dark";
  /** Every scheme the theme ships — one for a fixed theme, both otherwise. */
  schemes: ("light" | "dark")[];
  accent: string;
  ground: string;
  origin: "built-in" | "custom" | "imported";
};

/** What `theme:set` carries beyond the mode. Every field is optional across
 *  IPC and validated here; a payload missing the roster leaves the last one
 *  standing rather than emptying the library on an ordinary mode toggle. */
export type AppearancePush = Partial<AppearanceState> & {
  themes?: ThemeRosterEntry[];
};

const THEME_MODES = new Set<ThemeMode>(["light", "dark", "system"]);

function isThemeMode(value: string | null | undefined): value is ThemeMode {
  // SAFETY: value is a string here; THEME_MODES membership is itself the runtime check.
  return Boolean(value && THEME_MODES.has(value as ThemeMode));
}

/** A present, non-blank string, or undefined. The renderer's payload crosses
 *  IPC, so an empty label is as good as a missing one. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// The renderer owns the appearance; the shell only ever mirrors it. Null until
// the first push, which is the honest answer for anything that asks before the
// renderer has booted — better than naming a default that may not be on screen.
let appearance: AppearanceState | null = null;
let themeRoster: ThemeRosterEntry[] | null = null;

/** The appearance the renderer last reported, or null if it has yet to report
 *  one. Read by the agent gateway so `app_get_theme_state` describes the window
 *  the user is looking at instead of a remembered guess. */
export function currentAppearance(): AppearanceState | null {
  return appearance;
}

/** The theme library the renderer last reported, or null before its first push.
 *  Read by the agent gateway so the themes it offers are the ones this install
 *  actually holds, imports and user-authored themes included. */
export function currentThemeRoster(): readonly ThemeRosterEntry[] | null {
  return themeRoster;
}

/** One roster entry, or null if the payload isn't one. The renderer builds
 *  these from its own library so they arrive well-formed; this is the guard for
 *  a renderer of a different vintage than the shell it is talking to. */
function readRosterEntry(value: Partial<ThemeRosterEntry> | null | undefined): ThemeRosterEntry | null {
  if (!value || !(value instanceof Object)) return null;
  const id = nonEmpty(value.id);
  if (!id) return null;
  if (value.kind !== "system" && value.kind !== "adaptive" && value.kind !== "fixed") return null;
  if (value.appearance !== "light" && value.appearance !== "dark") return null;
  const schemes = Array.isArray(value.schemes)
    ? value.schemes.filter((s): s is "light" | "dark" => s === "light" || s === "dark")
    : [];
  return {
    id,
    label: nonEmpty(value.label) ?? id,
    blurb: nonEmpty(value.blurb) ?? "",
    kind: value.kind,
    appearance: value.appearance,
    // A theme with no readable schemes still paints the one it is designed as,
    // so falling back to that keeps it findable rather than dropping it.
    schemes: schemes.length > 0 ? schemes : [value.appearance],
    accent: nonEmpty(value.accent) ?? "",
    ground: nonEmpty(value.ground) ?? "",
    origin:
      value.origin === "custom" || value.origin === "imported" ? value.origin : "built-in",
  };
}

export function username(): string | null {
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
}

/** Reveal `target` in the file manager. Directories are opened as a folder;
 *  files are selected in their parent folder rather than launched with the
 *  default app. A missing path or a non-string IPC payload is a hard error
 *  so the renderer can fall through to its own fallback instead of
 *  swallowing a no-op. */
export async function reveal(target: string): Promise<void> {
  if (!target || !target.trim()) {
    throw new Error("Missing path.");
  }
  const resolved = path.resolve(target);
  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new Error(`Path not found: ${resolved}`);
  }
  if (stats.isDirectory()) {
    const errorMessage = await shell.openPath(resolved);
    if (errorMessage && errorMessage.trim().length > 0) {
      throw new Error(errorMessage);
    }
    return;
  }
  shell.showItemInFolder(resolved);
}

// Apply the renderer's appearance choice. "system" defers to the OS. Values
// outside the known modes are ignored so a stale renderer can't wedge the
// theme into an unknown state.
//
// `state` carries what the shell can't derive on its own: which theme, the
// scheme it resolved to, and the library it was chosen from. It is optional so
// an older renderer that pushes only a mode still dresses the window correctly;
// it just leaves the mirror empty.
export function setTheme(mode: ThemeMode | string, state?: AppearancePush): void {
  if (!isThemeMode(mode)) return;
  nativeTheme.themeSource = mode;
  if (!state) return;
  if (Array.isArray(state.themes)) {
    const entries = state.themes
      .map(readRosterEntry)
      .filter((entry): entry is ThemeRosterEntry => entry !== null);
    // An empty array after validation means the push carried nothing usable,
    // and replacing a good roster with an empty one would take the whole
    // library away from the agent until the next push.
    if (entries.length > 0) themeRoster = entries;
  }
  const themeId = nonEmpty(state.themeId);
  if (!themeId) return;
  appearance = {
    themeId,
    themeLabel: nonEmpty(state.themeLabel) ?? themeId,
    mode: isThemeMode(state.mode) ? state.mode : mode,
    // The renderer resolves "system" against the browser media query; trust its
    // answer and fall back to the shell's own read of the OS only if it omits one.
    scheme:
      state.scheme === "light" || state.scheme === "dark"
        ? state.scheme
        : nativeTheme.shouldUseDarkColors
          ? "dark"
          : "light",
    locked: state.locked === true,
  };
}

export function registerSystemIpc(): void {
  ipcMain.handle("system:username", () => username());
  ipcMain.handle("system:reveal", (_event, target: string) => reveal(target));
  ipcMain.handle("theme:set", (_event, mode: ThemeMode, state?: AppearancePush) =>
    setTheme(mode, state),
  );
}

import { computed } from "vue";
import { useStorage } from "@vueuse/core";

// kone's keyboard shortcuts: a small, declarative registry of the app's app-level
// actions, their default bindings, and any user overrides. The settings drawer
// lists every entry and lets the user rebind the ones marked `rebindable`;
// existing handlers (the launcher's ⌘, the project cycler's Ctrl+Tab, …) consult
// the same registry through `matches()` so a rebind takes effect everywhere.
//
// Bindings are stored as normalized strings of `+`-joined tokens, e.g.
// "mod+," / "ctrl+tab" / "mod+shift+d". The `mod` token resolves to ⌘ on macOS
// and Ctrl elsewhere (the Electron preload exposes `platform`; we fall back to
// `navigator.platform` in the browser). Pure-modifier "bindings" are not
// representable on purpose — every binding must end in a concrete key.

export interface ShortcutAction {
  id: string;
  label: string;
  hint?: string;
  /** One-line sub-line under the label in the Shortcuts pane (why/when to
      reach for the gesture). Falls back to `hint` when unset. */
  description?: string;
  /** Visual grouping in the settings list ("Navigation", "Conversation", …). */
  group: string;
  /** Default binding, normalized. */
  default: string;
  /** When false the row is shown read-only in the list (e.g. Escape to close). */
  rebindable: boolean;
  /**
   * Show this action in the Personalization → Shortcuts pane. When absent/false
   * the binding still lives in the registry (handlers consult it) but the UI
   * hides it — used for OS-convention keys (⌘, / ⌘K), dev gestures (play-demo),
   * and fixed keys (Esc / Enter / type-to-compose) that carry no meaning to
   * rebind.
   */
  personalize?: boolean;
}

// The canonical list. Order is the display order within a group; groups render in
// the order they first appear here. Keep this deliberately small — only app-wide
// gestures that already have a real handler somewhere in the app. Personalizable
// actions (shown in the settings pane) lead, in pane order: Navigation first,
// then General.
const ACTIONS: ShortcutAction[] = [
  {
    id: "cycle-projects",
    label: "Switch project",
    hint: "Hold the modifier and tap to step through recent projects; release to commit.",
    description: "Step through recent projects without leaving the keyboard.",
    group: "Navigation",
    default: "ctrl+tab",
    rebindable: true,
    personalize: true,
  },
  {
    id: "open-board",
    label: "Open project board",
    hint: "Leave the working-tree home and reveal the thread strip.",
    description: "Open the project's board — threads, terminals, and scratchpads on the strip.",
    group: "Navigation",
    default: "mod+b",
    rebindable: true,
    personalize: true,
  },
  {
    id: "toggle-settings",
    label: "Open settings drawer",
    hint: "Open or close the personalization drawer.",
    description: "Open or close this settings drawer.",
    group: "General",
    default: "mod+,",
    rebindable: true,
    personalize: true,
  },
  {
    id: "focus-search",
    label: "Focus project search",
    hint: "Move keyboard focus to the launcher's project search field.",
    group: "General",
    default: "mod+k",
    rebindable: true,
  },
  {
    id: "play-demo",
    label: "Play demo thread",
    hint: "Run a scripted conversation so the thread UI can be reviewed without a live agent.",
    group: "Conversation",
    default: "mod+shift+d",
    rebindable: true,
  },
  {
    id: "new-thread",
    label: "New thread",
    hint: "Start a fresh, empty conversation in the active project.",
    description: "Start a fresh, empty conversation in the active project.",
    group: "Conversation",
    default: "mod+n",
    rebindable: true,
    personalize: true,
  },
  {
    id: "new-terminal",
    label: "New terminal",
    hint: "Open a terminal column in the active project's strip.",
    description: "Open a shell as a new column on the thread strip.",
    group: "Conversation",
    default: "mod+shift+t",
    rebindable: true,
    personalize: true,
  },
  {
    id: "new-scratchpad",
    label: "New scratchpad column",
    hint: "Open a scratchpad column in the active project's strip.",
    description: "Open a notes column on the thread strip.",
    group: "Conversation",
    default: "mod+shift+n",
    rebindable: true,
    personalize: true,
  },
  {
    id: "send-selection-to-scratchpad",
    label: "Send selection to scratchpad",
    hint: "Append the current text selection to a scratchpad.",
    description: "Send highlighted thread text to the scratchpad.",
    group: "Conversation",
    default: "mod+shift+s",
    rebindable: true,
    personalize: true,
  },

  // ── the thread strip ──────────────────────────────────────────────────────
  // A project's live threads tile as columns on one horizontally scrollable
  // strip (a scrollable-tiling window manager, niri-style). These step focus
  // along it and rearrange it, mirroring niri's own focus-column-left/right and
  // move-column-left/right. Arrow keys rather than letters on purpose: on macOS
  // Alt+letter composes a different character (⌥R → "®"), which no longer
  // matches the binding — Alt+Arrow is layout-safe.
  {
    id: "focus-thread-left",
    label: "Focus thread left",
    hint: "Move focus one column left along the project's thread strip.",
    description: "Step to the thread column on the left.",
    group: "Threads",
    default: "mod+alt+left",
    rebindable: true,
    personalize: true,
  },
  {
    id: "focus-thread-right",
    label: "Focus thread right",
    hint: "Move focus one column right along the project's thread strip.",
    description: "Step to the thread column on the right.",
    group: "Threads",
    default: "mod+alt+right",
    rebindable: true,
    personalize: true,
  },
  {
    id: "move-thread-left",
    label: "Move thread left",
    hint: "Carry the focused thread one place left along the strip.",
    description: "Rearrange the strip — the focused thread keeps focus.",
    group: "Threads",
    default: "mod+alt+shift+left",
    rebindable: true,
    personalize: true,
  },
  {
    id: "move-thread-right",
    label: "Move thread right",
    hint: "Carry the focused thread one place right along the strip.",
    description: "Rearrange the strip — the focused thread keeps focus.",
    group: "Threads",
    default: "mod+alt+shift+right",
    rebindable: true,
    personalize: true,
  },
  {
    id: "cycle-thread-width",
    label: "Cycle thread width",
    hint: "Step the focused thread column through its fixed width presets (840px … 1240px).",
    description: "Trade peripheral threads for reading room.",
    group: "Threads",
    default: "mod+shift+r",
    rebindable: true,
    personalize: true,
  },
  {
    id: "grow-thread-width",
    label: "Widen thread",
    hint: "Grow the focused thread column one width step (toward 1240px).",
    description: "Give the focused thread more reading room.",
    group: "Threads",
    default: "mod+alt+up",
    rebindable: true,
    personalize: true,
  },
  {
    id: "shrink-thread-width",
    label: "Narrow thread",
    hint: "Shrink the focused thread column one width step (toward 840px).",
    description: "Pull the focused thread narrower so more neighbours peek in.",
    group: "Threads",
    default: "mod+alt+down",
    rebindable: true,
    personalize: true,
  },

  // ── fixed (always available, not rebindable) ─────────────────────────────
  {
    id: "close-overlay",
    label: "Close dialog",
    hint: "Dismiss whatever modal or drawer is on screen.",
    group: "Always available",
    default: "escape",
    rebindable: false,
  },
  {
    id: "send-message",
    label: "Send message",
    hint: "Submit the composer; Shift+Enter inserts a newline instead.",
    group: "Always available",
    default: "enter",
    rebindable: false,
  },
  {
    id: "type-to-compose",
    label: "Type to compose",
    hint: "Typing any character on the project page focuses the message field.",
    group: "Always available",
    default: "any-character",
    rebindable: false,
  },
];

const ACTIONS_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

// Persisted user overrides: { [actionId]: normalizedBinding }. Survives quit via
// localStorage (kone.* namespace, same shelf as the sound mute). Module scope so
// every caller shares one reactive source of truth, mirroring useSound.
const overrides = useStorage<Record<string, string>>(
  "kone.shortcuts.bindings",
  {},
  // Sync across tabs/windows of the same origin so a rebind in one is picked up
  // by the other without a reload.
  undefined,
  { listenToStorageChanges: true },
);

// ── platform ──────────────────────────────────────────────────────────────────
// `mod` resolves to ⌘ on darwin and Ctrl everywhere else. The Electron preload
// sets `window.koneDesktop.platform`; in the browser we read `navigator.platform`.
function platform(): string {
  if (import.meta.client) {
    const bridge = window.koneDesktop?.platform;
    if (bridge) return bridge;
    return navigator.platform;
  }
  return "";
}

function isMac(): boolean {
  return /mac|darwin|iphone|ipad|ipod/i.test(platform());
}

// ── normalization …────────────────────────────────────────────────────────────
// Modifiers, in canonical order: mod, ctrl, alt, shift. `mod` is platform-aware
// (⌘ on mac, Ctrl elsewhere) and so never coexists with `ctrl` on mac — but on
// win/linux users can bind Ctrl explicitly too, so we keep both tokens distinct.
const MOD_ORDER = ["mod", "ctrl", "alt", "shift"] as const;
type ModToken = (typeof MOD_ORDER)[number];

// Translate a KeyboardEvent's modifier state into the binding tokens it should
// contribute. `mod` is reported when metaKey is held on mac, or ctrlKey on
// non-mac (so the default ⌘, also works as Ctrl+, on win/linux without the user
// having to think about it). `ctrl` is only reported when ctrl is held and the
// platform isn't mac — Cmd+Ctrl combos on mac aren't a thing kone claims.
function modsFromEvent(e: KeyboardEvent): ModToken[] {
  const out: ModToken[] = [];
  if (isMac()) {
    if (e.metaKey) out.push("mod");
    if (e.ctrlKey) out.push("ctrl");
  } else {
    if (e.ctrlKey) out.push("mod");
    // "ctrl" is intentionally not also reported on win/linux — `mod` already
    // means Ctrl there, and we never want the same key to appear twice.
  }
  if (e.altKey) out.push("alt");
  if (e.shiftKey) out.push("shift");
  return out;
}

function modsFromBinding(binding: string): ModToken[] {
  const parts = binding.split("+");
  const out: ModToken[] = [];
  for (const p of parts.slice(0, -1)) {
    if ((MOD_ORDER as readonly string[]).includes(p)) {
      out.push(p as ModToken);
    }
  }
  return out;
}

// KeyboardEvent.key reports "ArrowLeft"/"ArrowUp"/… but bindings are stored as
// the short names ("left", "up", …) the default ACTIONS use. Fold them here so a
// captured press tokenizes to the same string a binding does — otherwise capture,
// conflict detection, and default-equality all miss on arrow keys.
const ARROW_KEYS: Record<string, string> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

// Normalize the "key" segment: lowercase letters, map a few Display-name quirks
// ("Esc" → "escape", "Spacebar" ⟶ "space") so presses and bindings comparable.
function keyToken(e: KeyboardEvent): string {
  const k = e.key;
  if (k === "Meta" || k === "Control" || k === "Alt" || k === "Shift") {
    return "";
  }
  if (k === " ") return "space";
  const arrow = ARROW_KEYS[k];
  if (arrow) return arrow;
  return k.toLowerCase();
}

function bindingFromEvent(e: KeyboardEvent): string {
  const mods = modsFromEvent(e).slice().sort(byModOrder);
  const key = keyToken(e);
  if (!key) return "";
  return [...mods, key].join("+");
}

function byModOrder(a: ModToken, b: ModToken): number {
  return MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b);
}

function normalizeStored(binding: string): string {
  const parts = binding.split("+");
  if (parts.length < 2) return binding.toLowerCase();
  const last = parts[parts.length - 1] ?? "";
  const key = last.toLowerCase();
  const mods = parts
    .slice(0, -1)
    .filter((p) => (MOD_ORDER as readonly string[]).includes(p))
    .map((p) => p as ModToken)
    .sort(byModOrder);
  return [...mods, key].join("+");
}

// Arrow bindings are stored as short names ("left", "up", …) but KeyboardEvent.key
// reports "ArrowLeft", "ArrowUp", … — treat them as equivalent when matching.
const KEY_ALIASES: Record<string, readonly string[]> = {
  left: ["arrowleft"],
  right: ["arrowright"],
  up: ["arrowup"],
  down: ["arrowdown"],
};

function keysMatch(bindingKey: string, eventKey: string): boolean {
  if (bindingKey === eventKey) return true;
  return KEY_ALIASES[bindingKey]?.includes(eventKey) ?? false;
}

// ── matching ──────────────────────────────────────────────────────────────────
function sameMods(a: ModToken[], b: ModToken[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m === b[i]);
}

// Does this KeyboardEvent satisfy `binding`? Used by every handler so the user's
// overrides take effect automatically. Returns false for bare modifier keys.
export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  if (!binding) return false;
  const eventMods = modsFromEvent(e).sort(byModOrder);
  const bindMods = modsFromBinding(binding);
  const key = binding.split("+").pop()!;
  if (!sameMods(eventMods, bindMods)) return false;
  if (!keysMatch(key, keyToken(e))) return false;
  return true;
}

function bindingFor(id: string): string {
  const action = ACTIONS_BY_ID.get(id);
  if (!action) return "";
  const override = (overrides.value as Record<string, string | undefined>)[id];
  if (override && typeof override === "string") {
    return normalizeStored(override);
  }
  return action.default;
}

// Does this event satisfy this action's *current* binding?
export function matchesShortcut(id: string, e: KeyboardEvent): boolean {
  return matchesBinding(e, bindingFor(id));
}

// ── display ────────────────────────────────────────────────────────────────────
const MAC_MOD_GLYPH: Record<ModToken, string> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};
const OTHER_MOD_LABEL: Record<ModToken, string> = {
  mod: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

// Pretty key labels for a binding's last token — used by the kbd chips in the
// settings list.
function keyLabel(key: string): string {
  const map: Record<string, string> = {
    enter: "Return",
    escape: "Esc",
    tab: "Tab",
    space: "Space",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    backspace: "⌫",
  };
  if (map[key]) return map[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

// Split a binding into the ordered display tokens the settings row renders as
// chips. The first entry of a rebindable row carries the modifiers; the rest are
// the key. On mac the modifiers show as glyphs, elsewhere as words.
export function displayTokens(binding: string): string[] {
  if (!binding) return [];
  const mods = modsFromBinding(binding).map((m) =>
    isMac() ? MAC_MOD_GLYPH[m] : OTHER_MOD_LABEL[m],
  );
  const key = keyLabel(binding.split("+").pop()!);
  return [...mods, key];
}

// ── capture (for the rebind UI) ─────────────────────────────────────────────────
// Translate a real keydown into the binding string we'd store, or `null` to
// ignore the press (bare modifier, or Escape while capturing, which cancels).
export type CaptureResult =
  | { ok: true; binding: string }
  | { ok: false; reason: "escape" | "modifier-only" | "unrepresentable" };

export function captureFromEvent(e: KeyboardEvent): CaptureResult {
  if (e.key === "Escape") return { ok: false, reason: "escape" };
  const binding = bindingFromEvent(e);
  if (!binding) {
    // A lone modifier press, or a key we couldn't tokenize.
    return e.key === "Meta" || e.key === "Control" || e.key === "Alt" ||
      e.key === "Shift"
      ? { ok: false, reason: "modifier-only" }
      : { ok: false, reason: "unrepresentable" };
  }
  return { ok: true, binding };
}

function bindingModsFor(id: string): ModToken[] {
  return modsFromBinding(bindingFor(id));
}

// ── public API ──────────────────────────────────────────────────────────────────
export function useShortcuts() {
  // A reactive view of every action with its *resolved* binding — what the
  // settings list renders against. Re-computes when overrides change.
  type ResolvedAction = ShortcutAction & { binding: string };
  const resolved = computed<ResolvedAction[]>(() =>
    ACTIONS.map(
      (a): ResolvedAction => ({ ...a, binding: bindingFor(a.id) }),
    ),
  );

  // Actions grouped for the settings list, preserving declaration order.
  const groups = computed(() => {
    const order: string[] = [];
    const byGroup = new Map<string, ResolvedAction[]>();
    for (const a of resolved.value) {
      if (!byGroup.has(a.group)) {
        byGroup.set(a.group, []);
        order.push(a.group);
      }
      byGroup.get(a.group)!.push(a);
    }
    return order.map((g) => ({ group: g, items: byGroup.get(g)! }));
  });

  // Actions surfaced in the Personalization → Shortcuts pane. Deliberately a
  // subset: only genuinely app-defined, rebind-worthy gestures. Today: Switch
  // project. Add more later by flipping `personalize: true` on an action — the
  // UI picks it up automatically, no template edits.
  const personalizable = computed<ResolvedAction[]>(() =>
    resolved.value.filter((a) => a.personalize),
  );

  // Personalizable actions grouped for the Shortcuts pane — same order as `groups`,
  // but only rows the user can rebind.
  const personalizableGroups = computed(() => {
    const order: string[] = [];
    const byGroup = new Map<string, ResolvedAction[]>();
    for (const a of personalizable.value) {
      if (!byGroup.has(a.group)) {
        byGroup.set(a.group, []);
        order.push(a.group);
      }
      byGroup.get(a.group)!.push(a);
    }
    return order.map((g) => ({ group: g, items: byGroup.get(g)! }));
  });

  const hasOverrides = computed(
    () => Object.keys(overrides.value as Record<string, string>).length > 0,
  );

  // Cast helper so we can index a RemovableRef<Record<…>> without TS guessing the
  // default branch and widening to `undefined` everywhere.
  function store(): Record<string, string> {
    return overrides.value as Record<string, string>;
  }

  function isCustomized(id: string): boolean {
    return Boolean(store()[id]);
  }

  // Find another action that already owns `binding`, if any. Used to warn/block
  // in the rebind UI. Ignores fixed actions (which can't be displaced).
  function conflictFor(
    binding: string,
    exceptId?: string,
  ): ShortcutAction | null {
    const norm = normalizeStored(binding);
    for (const a of ACTIONS) {
      if (a.id === exceptId) continue;
      if (!a.rebindable) continue;
      if (bindingFor(a.id) === norm) return a;
    }
    return null;
  }

  function rebind(id: string, binding: string): boolean {
    const action = ACTIONS_BY_ID.get(id);
    if (!action || !action.rebindable) return false;
    const norm = normalizeStored(binding);
    if (conflictFor(norm, id)) return false;
    const next: Record<string, string> = { ...store() };
    if (norm === action.default) {
      delete next[id];
    } else {
      next[id] = norm;
    }
    overrides.value = next;
    return true;
  }

  function reset(id: string): void {
    if (!ACTIONS_BY_ID.has(id)) return;
    const next: Record<string, string> = { ...store() };
    delete next[id];
    overrides.value = next;
  }

  function resetAll(): void {
    overrides.value = {};
  }

  return {
    actions: ACTIONS,
    resolved,
    groups,
    personalizable,
    personalizableGroups,
    hasOverrides,
    isCustomized,
    conflictFor,
    rebind,
    reset,
    resetAll,
    bindingFor,
    bindingModsFor,
    matchesShortcut,
    captureFromEvent,
    displayTokens,
    isMacPlatform: isMac,
  };
}

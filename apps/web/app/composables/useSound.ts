import { watch } from "vue";
import { useStorage } from "@vueuse/core";
import type { ApprovalDecision } from "~/types/desktop";

// Interaction sound for the app — a thin wrapper over `cuelume` (synthesized
// Web Audio cues, no files). kone is a calm surface, so sound is deliberately
// restrained: it fires from real user gestures and from the few agent moments
// worth hearing from across the room (a reply landed, an agent is waiting on
// you), which also means we never trip the browser's autoplay block. It's
// opt-out, and the preference persists across quits.
//
// Where sound does NOT belong: hover, text selection, scroll and wheel steps,
// held-key repeats, streamed tokens, and per-tool-call progress inside a turn.
// Those fire in bursts and wear any sound out until the user mutes all of it.
//
// cuelume touches Web Audio, so it's never imported at module top level — we
// lazy-load it on the first cue (client only) and cache the module. That keeps
// SSR and first paint clean, and means the audio graph is only built once the
// user has actually done something worth hearing.

// The vocabulary is semantic, not literal: a caller says what happened, and this
// layer decides how it should sound. That keeps intent readable at the call site
// and lets the whole palette be re-tuned in one place — the map below is the
// single source of that mapping.
export type Cue =
  // Foreground gestures — the sounds you make things happen with.
  | "press" // a plain button / pointer commit
  | "toggle" // a switch, checkbox, or on/off flip (pass `off` when switching off)
  | "select" // choosing an item, option, tab, or value from a set
  | "expand" // revealing a fold, menu, popover, or disclosure
  | "collapse" // folding it away again
  | "show" // a dialog, drawer, or full-surface modal coming up
  | "dismiss" // that dialog, drawer, or modal going away
  | "open" // entering a project, thread, or surface (a context change)
  | "leave" // backing out of one — to the launcher, out of a surface
  | "step" // moving focus between rows or columns from the keyboard
  | "send" // dispatching a message to an agent
  | "stop" // interrupting a running agent turn
  | "discard" // a destructive commit: delete, forget, throw away
  // Outcomes — how a finished thing lands.
  | "copy" // something went onto the clipboard
  | "saved" // a small confirmation: a preference kept, a note captured
  | "success" // an action that mattered succeeded (commit, create, apply)
  | "warning" // done, but it needs a look
  | "refuse" // a soft no: an edge reached, a gesture with nowhere to go
  | "error" // a real, recoverable failure
  // Agent lifecycle — they reach the user when they aren't looking.
  | "ready" // an agent turn has settled and its reply is there
  | "attention"; // an agent is parked until the user answers it

// cuelume's cue names — the voices we draw from.
type SoundName =
  | "tap"
  | "select"
  | "toggle"
  | "open"
  | "close"
  | "navigate"
  | "success"
  | "warning"
  | "error"
  | "ready"
  | "attention";

type Emphasis = "subtle" | "normal" | "strong";
type Direction = "forward" | "back";

// Each semantic cue → its cuelume voice, its emphasis (how much the moment
// matters — `subtle` strips ornament, `strong` adds a layer only it plays), and
// an optional fixed direction. Emphasis is not loudness: the ambient cues sit
// low through `volume`, separately.
type Voice = {
  sound: SoundName;
  emphasis?: Emphasis;
  direction?: Direction;
  volume?: number;
  /** Emphasis follows whether the user is looking: `subtle` when they are,
   *  `strong` when kone is behind another window. Overrides `emphasis`. */
  reachesAway?: true;
};
const VOICES = {
  press: { sound: "tap" },
  toggle: { sound: "toggle" },
  select: { sound: "select" },
  // Folds and menus open dozens of times an hour, so they speak softly; a
  // dialog is a bigger change of place and gets the full air of the voice.
  expand: { sound: "open", emphasis: "subtle" },
  collapse: { sound: "close", emphasis: "subtle" },
  show: { sound: "open" },
  dismiss: { sound: "close" },
  open: { sound: "navigate" },
  leave: { sound: "navigate", direction: "back" },
  // Row and column steps repeat as fast as the user can press, so the whoosh is
  // kept small; the direction still tells which way the camera went.
  step: { sound: "navigate", emphasis: "subtle" },
  // Sending is the gesture the whole app exists for — the strong tap carries a
  // bigger glass than any other button.
  send: { sound: "tap", emphasis: "strong" },
  stop: { sound: "close" },
  discard: { sound: "close", emphasis: "strong" },
  copy: { sound: "success", emphasis: "subtle", volume: 0.8 },
  saved: { sound: "success", emphasis: "subtle" },
  success: { sound: "success" },
  warning: { sound: "warning" },
  refuse: { sound: "error", emphasis: "subtle", volume: 0.8 },
  error: { sound: "error" },
  // A reply landing under the user's eyes only needs to nod; one landing while
  // they're in another window has to reach them from across the room.
  ready: { sound: "ready", volume: 0.8, reachesAway: true },
  attention: { sound: "attention", volume: 0.9 },
} satisfies Record<Cue, Voice>;

/** What a call site can tell the cue about this particular play. */
export type CueContext = {
  /** Which way a step, choice, or move went — `back` plays it falling. */
  direction?: Direction;
  /** For a `toggle`: the switch is going off, so it plays its glide backwards. */
  off?: boolean;
};

// A calm ceiling on the whole layer — the recipes are already gentle, and this
// keeps the softest gestures from ever feeling loud on top of that.
const GLOBAL_VOLUME = 0.85;

// Persisted mute preference (survives quit). Module scope so every caller and the
// settings drawer's sound switch share one source of truth.
const muted = useStorage("kone.sound.muted", false);

type CuelumeModule = typeof import("cuelume");
let modulePromise: Promise<CuelumeModule> | null = null;

function load(): Promise<CuelumeModule> {
  if (!modulePromise) {
    modulePromise = import("cuelume").then((mod) => {
      // Keep the engine's own gates in step with our preferences, as a backstop
      // to the guard in `cue()`.
      mod.setEnabled(!muted.value);
      mod.setVolume(GLOBAL_VOLUME);
      return mod;
    });
  }
  return modulePromise;
}

// Reflect later mute changes into the engine once it's been loaded.
if (import.meta.client) {
  watch(muted, (isMuted) => {
    if (modulePromise) void modulePromise.then((mod) => mod.setEnabled(!isMuted));
  });
}

/** Whether the user is looking at kone right now — its window shown and
 *  focused. Client only. */
export function userIsHere(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function emphasisFor(voice: Voice): Emphasis | undefined {
  if (voice.reachesAway) return userIsHere() ? "subtle" : "strong";
  return voice.emphasis;
}

/** How an answer to an agent's permission ask sounds, wherever it's given. A
 *  go-ahead is a plain commit; a refusal sends the ask away; refusing and
 *  stopping ends the turn, so it sounds like the composer's own stop. */
export function approvalCue(decision: ApprovalDecision): Cue {
  if (decision === "reject-and-stop") return "stop";
  if (decision === "reject-once") return "dismiss";
  return "press";
}

function directionFor(voice: Voice, context: CueContext | undefined): Direction | undefined {
  if (context?.off) return "back";
  return context?.direction ?? voice.direction;
}

export function useSound() {
  // Play a cue. No-op on the server or when muted; a sound failure must never
  // surface into the UI, so anything that goes wrong is swallowed quietly.
  function cue(name: Cue, context?: CueContext): void {
    if (!import.meta.client || muted.value) return;
    const voice: Voice = VOICES[name];
    const options = {
      volume: voice.volume,
      emphasis: emphasisFor(voice),
      direction: directionFor(voice, context),
    };
    void load()
      .then((mod) => mod.play(voice.sound, options))
      .catch((err) => console.debug("[sound] cue failed", name, err));
  }

  function toggleMuted(): void {
    muted.value = !muted.value;
  }

  return { cue, muted, toggleMuted };
}

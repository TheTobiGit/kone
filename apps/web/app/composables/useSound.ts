import { watch } from "vue";
import { useStorage } from "@vueuse/core";

// Interaction sound for the app — a thin wrapper over `cuelume` (synthesized
// Web Audio cues, no files). kone is a calm surface, so sound is deliberately
// restrained: it fires from real user gestures and a couple of agent-lifecycle
// moments, which also means we never trip the browser's autoplay block. It's
// opt-out, and the preference persists across quits.
//
// cuelume touches Web Audio, so it's never imported at module top level — we
// lazy-load it on the first cue (client only) and cache the module. That keeps
// SSR and first paint clean, and means the audio graph is only built once the
// user has actually done something worth hearing.

// The vocabulary is semantic, not literal: a caller says what happened, and this
// layer decides how it should sound. That keeps intent readable at the call site
// and lets the whole palette be re-tuned in one place. Each cue maps to a
// distinct cuelume voice so the app never sounds like one click repeated — the
// map below is the single source of that mapping.
export type Cue =
  // Foreground gestures — the sounds you make things happen with.
  | "press" // a plain button / pointer commit
  | "toggle" // a switch, checkbox, or discrete state flip
  | "select" // choosing an item, row, tab, or file from a set
  | "expand" // revealing a fold, panel, detail, or drawer
  | "collapse" // dismissing a fold, panel, modal, or drawer
  | "send" // dispatching a message into a running/idle agent thread
  | "open" // entering a project, thread, or place (a context change)
  // Outcomes — how a finished thing lands.
  | "success" // an action succeeded (commit, apply, save)
  | "error" // a recoverable failure
  // Agent lifecycle — quieter, ambient; they sit under the foreground clicks.
  | "working" // an agent turn has begun
  | "ready"; // an agent turn has settled / its reply is ready

// cuelume's own sound names — the voices we draw from.
type SoundName =
  | "press"
  | "toggle"
  | "tick"
  | "bloom"
  | "droplet"
  | "pulse"
  | "arrival"
  | "success"
  | "error"
  | "loading"
  | "ready";

// Each semantic cue → its cuelume voice, and an optional per-play volume so the
// ambient lifecycle cues sit softly beneath the foreground gestures rather than
// competing with them. Volume defaults to 1 (the global multiplier below still
// applies on top).
const VOICES: Record<Cue, { sound: SoundName; volume?: number }> = {
  press: { sound: "press" },
  toggle: { sound: "toggle" },
  select: { sound: "tick" },
  expand: { sound: "bloom", volume: 0.85 },
  collapse: { sound: "droplet", volume: 0.85 },
  send: { sound: "pulse" },
  open: { sound: "arrival", volume: 0.9 },
  success: { sound: "success" },
  error: { sound: "error" },
  working: { sound: "loading", volume: 0.6 },
  ready: { sound: "ready", volume: 0.7 },
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

export function useSound() {
  // Play a cue. No-op on the server or when muted; a sound failure must never
  // surface into the UI, so anything that goes wrong is swallowed quietly.
  function cue(name: Cue): void {
    if (!import.meta.client || muted.value) return;
    const voice = VOICES[name];
    void load()
      .then((mod) => mod.play(voice.sound, voice.volume != null ? { volume: voice.volume } : undefined))
      .catch((err) => console.debug("[sound] cue failed", name, err));
  }

  function toggleMuted(): void {
    muted.value = !muted.value;
  }

  return { cue, muted, toggleMuted };
}

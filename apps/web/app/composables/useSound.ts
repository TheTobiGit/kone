import { watch } from "vue";
import { useStorage } from "@vueuse/core";

// Interaction sound for the launcher — a thin wrapper over `cuelume` (synthesized
// Web Audio cues, no files). kone is a calm surface, so sound is deliberately
// sparing: it fires only from real user gestures (a click, a toggle), which also
// means we never trip the browser's autoplay block. It's opt-out, and the
// preference persists across quits.
//
// cuelume touches Web Audio, so it's never imported at module top level — we
// lazy-load it on the first cue (client only) and cache the module. That keeps
// SSR and first paint clean, and means the audio graph is only built once the
// user has actually done something worth hearing.

// The narrow set of cues the app actually uses — see the wiring in pages/index.vue
// and GitHubCloneModal.vue. Kept deliberately small.
export type Cue = "press" | "toggle" | "success" | "error";

// Persisted mute preference (survives quit). Module scope so every caller and the
// SoundToggle share one source of truth.
const muted = useStorage("kone.sound.muted", false);

type CuelumeModule = typeof import("cuelume");
let modulePromise: Promise<CuelumeModule> | null = null;

function load(): Promise<CuelumeModule> {
  if (!modulePromise) {
    modulePromise = import("cuelume").then((mod) => {
      // Keep the engine's own gate in step with our preference, as a backstop to
      // the guard in `cue()`.
      mod.setEnabled(!muted.value);
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
    void load()
      .then((mod) => mod.play(name))
      .catch((err) => console.debug("[sound] cue failed", name, err));
  }

  function toggleMuted(): void {
    muted.value = !muted.value;
  }

  return { cue, muted, toggleMuted };
}

import { computed, onMounted } from "vue";
import {
  hydratePresets,
  insertPreset,
  patchPreset,
  presetRows,
  removePreset,
  seedExamplePresets,
} from "~/utils/presetStore";
import type { SubagentPresetCreateInput } from "~/types/desktop";

// The preset sub-agents surface's view of the store: the reusable definitions
// an agent cuts a spawn from (§3.4). Named for the presets, not for a session —
// `useSubagentPresets` next to `useAgentRoster` keeps the two straight, one
// being standing definitions and the other the people you hand a thread to.

/**
 * The example presets a fresh install opens on, so the surface teaches what a
 * preset is by showing four rather than an empty page.
 *
 * Each ships with no model — a null model means "run where the caller runs", so
 * an example always plans and never refuses on a model nobody has installed.
 * Naming a model is left to whoever adapts the example.
 */
const SEED_PRESETS: readonly SubagentPresetCreateInput[] = [
  {
    name: "Explorer",
    instructions:
      "Read-only. Map the code and report what you find — the files that matter, the call sites, how the data flows. Do not edit anything; the answer is the deliverable.",
    model: null,
  },
  {
    name: "Code Reviewer",
    instructions:
      "Review the change for correctness bugs and risky edge cases. Report findings ranked most-serious first, each with the concrete input that triggers it. Do not change the code.",
    model: null,
  },
  {
    name: "PR Handler",
    instructions:
      "Open, update, and describe pull requests. Say what the change does, why it was made, and how it was verified — no more than that fits on one screen.",
    model: null,
  },
  {
    name: "Git Handler",
    instructions:
      "Handle git operations — branches, commits, history. Never force-push a shared branch or discard work you didn't just create; when unsure, stop and report rather than rewrite.",
    model: null,
  },
];

export function useSubagentPresets() {
  // The presets live in the store, so reading them means asking. On mount, not
  // at call time: this runs during setup on the server too, where there is no
  // bridge and nothing to read. The examples are laid down once, behind the
  // first hydrate, so a fresh install opens on four rather than nothing.
  onMounted(() => {
    void hydratePresets().then(() => seedExamplePresets(SEED_PRESETS));
  });

  const presets = computed(() => presetRows.value);

  return {
    presets,
    createPreset: insertPreset,
    updatePreset: patchPreset,
    deletePreset: removePreset,
  };
}

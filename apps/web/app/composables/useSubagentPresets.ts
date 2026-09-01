import { computed, onMounted } from "vue";
import { BUILTIN_SUBAGENT_PRESETS } from "@kone/protocol/subagent-presets";
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
 * Seeded from the one shared list the spawn gateway folds the same definitions
 * in from, so the presets the user sees here are exactly the ones the AI can
 * invoke. They seed as real, editable rows — dropping the shipped id so each
 * mints its own — rather than the read-only fallbacks the gateway carries.
 *
 * Each ships with no model — a null model means "run where the caller runs", so
 * an example always plans and never refuses on a model nobody has installed.
 * Naming a model is left to whoever adapts the example.
 */
const SEED_PRESETS: readonly SubagentPresetCreateInput[] = BUILTIN_SUBAGENT_PRESETS.map(
  (preset) => ({ name: preset.name, instructions: preset.instructions, model: null }),
);

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

import { computed, onMounted, ref } from "vue";
import { BUILTIN_SUBAGENT_PRESETS } from "@kone/protocol/subagent-presets";
import {
  hydratePresets,
  insertPreset,
  patchPreset,
  presetRows,
  removePreset,
  seedExamplePresets,
} from "~/utils/presetStore";
import type { NativeSubagentConfig, NativeSubagentConfigPatch } from "~/types/desktop";

// The preset sub-agents surface's view of the store: the reusable definitions
// an agent cuts a spawn from (§3.4). Named for the presets, not for a session —
// `useSubagentPresets` next to `useAgentRoster` keeps the two straight, one
// being standing definitions and the other the people you hand a thread to.

/**
 * The shipped presets, as the pane's native section draws them: the definition
 * (name, instructions) joined with the user's config (enabled, model chain).
 * The definitions come from the shared list the spawn gateway folds in from,
 * so what the pane shows is exactly what an agent can invoke; the config lives
 * in the store, so a toggle reaches the next spawn without a restart.
 */
export function useSubagentPresets() {
  // The presets live in the store, so reading them means asking. On mount, not
  // at call time: this runs during setup on the server too, where there is no
  // bridge and nothing to read.
  const nativeConfigs = ref<NativeSubagentConfig[]>(
    BUILTIN_SUBAGENT_PRESETS.map((preset) => ({
      presetId: preset.presetId,
      enabled: true,
      model: null,
      modelFallbacks: null,
      updatedAt: 0,
    })),
  );

  onMounted(async () => {
    await hydratePresets().then(() => seedExamplePresets());
    const bridge = import.meta.client ? window.koneDesktop?.presets : undefined;
    if (bridge) nativeConfigs.value = await bridge.nativeList();
  });

  /** Write one native's config through the bridge and mirror it locally, so the
   *  toggle flips on the click rather than on the round trip. With no bridge
   *  the local mirror stands alone — the browser dev surface still toggles,
   *  it just doesn't survive a reload. */
  const configureNative = async (
    presetId: string,
    patch: NativeSubagentConfigPatch,
  ): Promise<void> => {
    const bridge = import.meta.client ? window.koneDesktop?.presets : undefined;
    if (!bridge) {
      const current = nativeConfigs.value.find((config) => config.presetId === presetId);
      if (!current) return;
      nativeConfigs.value = nativeConfigs.value.map((config) =>
        config.presetId === presetId
          ? {
              ...config,
              enabled: patch.enabled !== undefined ? patch.enabled : config.enabled,
              model: patch.model !== undefined ? patch.model : config.model,
              modelFallbacks:
                patch.model !== undefined
                  ? patch.model
                    ? (patch.modelFallbacks ?? [])
                    : null
                  : config.modelFallbacks,
              updatedAt: Date.now(),
            }
          : config,
      );
      return;
    }
    const stored = await bridge.nativeConfig({ presetId, patch });
    if (stored) {
      nativeConfigs.value = nativeConfigs.value.map((config) =>
        config.presetId === presetId ? stored : config,
      );
    }
  };

  const presets = computed(() => presetRows.value);

  return {
    presets,
    nativeConfigs,
    configureNative,
    createPreset: insertPreset,
    updatePreset: patchPreset,
    deletePreset: removePreset,
  };
}

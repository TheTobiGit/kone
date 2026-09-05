import { watch } from "vue";
import { initTypography, useTypography } from "~/composables/useTypography";
import { resolveTypographyPrefs } from "~/theme/typography";
import type { KoneTypographySettings } from "~/types/desktop";

export default defineNuxtPlugin(() => {
  initTypography();

  const bridge = window.koneDesktop;
  if (!bridge?.setAppState) return;

  const { prefs } = useTypography();

  const snapshot = (): KoneTypographySettings => {
    const resolved = resolveTypographyPrefs(prefs.value);
    return {
      sans: resolved.sans,
      serif: resolved.serif,
      mono: resolved.mono,
      composer: resolved.composer,
      sizeInterface: resolved.sizeInterface,
      sizeComposer: resolved.sizeComposer,
      sizeCode: resolved.sizeCode,
      lineHeightBody: resolved.lineHeightBody,
      measure: resolved.measure,
      smoothing: resolved.smoothing,
    };
  };

  const push = () => {
    void bridge.setAppState({ typography: snapshot() });
  };

  push();
  watch(prefs, push, { deep: true });
});

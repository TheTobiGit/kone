import { watch } from "vue";
import { initTheme, useTheme } from "~/composables/useTheme";

export default defineNuxtPlugin(() => {
  initTheme();

  // In the browser there is no shell to tell; only the desktop build carries the
  // bridge, so the push is conditional rather than assumed.
  const bridge = window.koneDesktop;
  if (!bridge?.setTheme) return;

  const { mode, modeLocked, scheme } = useTheme();

  // The shell needs the appearance it should actually dress the window in. That
  // is the mode while the theme follows it, but a fixed theme overrides the mode
  // — pushing `mode` there would leave a light titlebar over a dark interface,
  // so a locked theme reports its concrete scheme instead.
  const push = () => {
    void bridge.setTheme(modeLocked.value ? scheme.value : mode.value);
  };

  push();
  watch([mode, modeLocked, scheme], push);
});

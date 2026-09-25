import { installDevBridge } from "~/utils/desktopBridge";

// `nuxt dev` stands in for the Electron bridge with the demo world, so every
// surface that reads the filesystem, git, the provider surface or the thread
// list has something to show in a plain browser. Numbered to run before any
// plugin that reads the bridge.
//
// The stand-in is imported behind `import.meta.dev`, which a production build
// replaces with `false` — the branch, and the whole demo world it would load,
// are dropped from the bundle.
export default defineNuxtPlugin({
  name: "dev-bridge",
  enforce: "pre",
  async setup() {
    if (import.meta.dev) {
      const { createDevBridge } = await import("~/lib/devBridge");
      installDevBridge(createDevBridge());
    }
  },
});

import tailwindcss from "@tailwindcss/vite";
import { BOOT_ROLES, themeBootTable } from "./app/theme/themes";

const isDesktop =
  process.env.KONE_DESKTOP === "1" || process.env.NUXT_DESKTOP === "1";

// First-paint theme: a blocking inline head script that runs before the bundle,
// so frame one is already the right theme *and* the right scheme. Inline in the
// head, it executes synchronously while the parser builds the document, ahead of
// any deferred bundle script.
//
// The colour table is generated from the shipped themes at config time rather
// than transcribed here. That matters more than it looks: a hand-copied table
// silently goes stale the moment a theme is added, and the symptom is a flash of
// the wrong palette on every cold start — the one bug the script exists to
// prevent. It also has to know each theme's *kind*, because a fixed theme's first
// frame must ignore the stored appearance the same way the running app does.
//
// On any failure (no storage, an unknown preference, no matchMedia) it falls back
// to the default theme following the OS.
const themeBootScript = {
  innerHTML: `(function () {
  var root = document.documentElement;
  var themes = ${JSON.stringify(themeBootTable())};
  var names = ${JSON.stringify(BOOT_ROLES.map((role) => `--${role}`))};
  var themeId = "kone";
  var appearance = "system";
  try {
    var storedTheme = localStorage.getItem("kone:theme");
    var storedMode = localStorage.getItem("kone:appearance");
    if (storedMode === "light" || storedMode === "dark") appearance = storedMode;
    // Imported themes keep a runtime boot table (built at import time, not at
    // config time) so their first frame is their own too.
    var storedImports = localStorage.getItem("kone:theme-boot");
    if (storedImports) {
      var imported = JSON.parse(storedImports);
      for (var importId in imported) themes[importId] = imported[importId];
    }
    if (storedTheme && themes[storedTheme]) themeId = storedTheme;
  } catch (e) {}
  var entry = themes[themeId] || themes.kone;
  var scheme;
  if (entry.kind === "fixed") scheme = entry.appearance;
  else if (appearance !== "system") scheme = appearance;
  else {
    try {
      scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) {
      scheme = "light";
    }
  }
  var palette = entry[scheme] || entry[entry.appearance];
  root.setAttribute("data-theme", themeId);
  root.setAttribute("data-scheme", scheme);
  root.classList.toggle("dark", scheme === "dark");
  for (var i = 0; i < names.length; i++) root.style.setProperty(names[i], palette[i]);
  root.style.backgroundColor = palette[0];
})();`,
  tagPosition: "head",
} as const;

const appConfig = isDesktop
  ? { head: { script: [themeBootScript] }, baseURL: "./", buildAssetsDir: "_nuxt/" }
  : { head: { script: [themeBootScript] } };

export default defineNuxtConfig({
  compatibilityDate: "latest",
  devtools: { enabled: false },
  modules: ["@nuxt/fonts"],
  // Ignore nxui barrels so Nuxt only auto-registers the `.vue` files.
  components: [
    {
      path: "~/components",
      pathPrefix: true,
      ignore: ["**/index.ts", "**/types.ts"],
    },
  ],
  css: ["~/assets/css/main.css"],
  vite: {
    plugins: [tailwindcss()],
  },
  devServer: {
    port: 3001,
  },
  ssr: isDesktop ? false : undefined,
  app: appConfig,
  runtimeConfig: {
    public: {
      isDesktop,
    },
  },
  nitro: isDesktop
    ? {
        preset: "static",
        prerender: {
          crawlLinks: true,
        },
      }
    : undefined,
});

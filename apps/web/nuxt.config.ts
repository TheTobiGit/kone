import tailwindcss from "@tailwindcss/vite";

const isDesktop =
  process.env.KONE_DESKTOP === "1" || process.env.NUXT_DESKTOP === "1";

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
  app: isDesktop
    ? {
        baseURL: "./",
        buildAssetsDir: "_nuxt/",
      }
    : undefined,
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

import tailwindcss from "@tailwindcss/vite";

const isDesktop =
  process.env.KONE_DESKTOP === "1" || process.env.NUXT_DESKTOP === "1";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "latest",
  devtools: { enabled: false },
  modules: ["@nuxt/fonts"],
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

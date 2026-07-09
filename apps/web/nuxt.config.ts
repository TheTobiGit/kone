import "@kone/env/web";

const isDesktop =
  process.env.KONE_DESKTOP === "1" || process.env.NUXT_DESKTOP === "1";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "latest",
  colorMode: {
    preference: "system",
    fallback: "light",
  },
  devtools: { enabled: false },
  experimental: {
    payloadExtraction: "client",
  },
  modules: ["@nuxt/ui"],
  css: ["~/assets/css/main.css"],
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
      bridgeWsUrl: process.env.NUXT_PUBLIC_BRIDGE_WS_URL ?? "",
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

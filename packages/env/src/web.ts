import { createEnv } from "@t3-oss/env-nuxt";
import { z } from "zod";

/**
 * Nuxt env validation - validates at build time when imported in nuxt.config.ts
 * For runtime access in components/plugins, use useRuntimeConfig() instead:
 *   const config = useRuntimeConfig()
 *   config.public.serverUrl (NUXT_PUBLIC_SERVER_URL maps to serverUrl)
 */
export const env = createEnv({
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});

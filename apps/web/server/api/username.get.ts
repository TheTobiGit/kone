import os from "node:os";

// Dev/browser fallback for the machine username. In `nuxt dev` the Nitro server
// runs on the user's own machine, so this returns their real account name — the
// packaged desktop app reads it over the Electron bridge instead (no Nitro at
// runtime there), see composables/useUser.ts.
export default defineEventHandler(() => {
  try {
    return { username: os.userInfo().username || null };
  } catch {
    return { username: null };
  }
});

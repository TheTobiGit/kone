import type { DirListing } from "~/types/desktop";

// Reads the local filesystem through the Electron bridge for the in-app folder
// browser. Directory reads need a real filesystem, so in `nuxt dev` (no bridge)
// we fall back to the shared dev-world tree (see lib/devMocks) — enough to
// exercise the picker UI. The tree is loaded only under `import.meta.dev`, so a
// production build doesn't ship it; there an absent bridge reads as empty.
export function useFileSystem() {
  const bridge = import.meta.client ? window.koneDesktop : undefined;
  const fs = bridge?.fs;

  return {
    available: Boolean(fs),

    home(): Promise<string> {
      if (fs) return fs.home();
      if (import.meta.dev) return import("~/lib/devMocks").then((m) => m.MOCK_HOME);
      return Promise.resolve("/");
    },
    listDir(dir: string): Promise<DirListing> {
      if (fs) return fs.listDir(dir);
      if (import.meta.dev) return import("~/lib/devMocks").then((m) => m.mockListDir(dir));
      return Promise.resolve({ path: dir, name: dir, parent: null, repo: false, entries: [] });
    },
  };
}

import type { DirListing } from "~/types/desktop";
import { MOCK_HOME, mockListDir } from "~/lib/devMocks";

// Reads the local filesystem through the Electron bridge for the in-app folder
// browser. Directory reads need a real filesystem, so in `nuxt dev` (no bridge)
// we fall back to the shared dev-world tree (see lib/devMocks) — enough to
// exercise the picker UI.
export function useFileSystem() {
  const bridge = import.meta.client ? window.koneDesktop : undefined;
  const fs = bridge?.fs;

  return {
    available: Boolean(fs),

    home(): Promise<string> {
      return fs ? fs.home() : Promise.resolve(MOCK_HOME);
    },
    listDir(dir: string): Promise<DirListing> {
      return fs ? fs.listDir(dir) : Promise.resolve(mockListDir(dir));
    },
  };
}

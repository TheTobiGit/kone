import type { DirListing } from "~/types/desktop";
import { desktopBridge } from "~/utils/desktopBridge";

// Reads the local filesystem through the bridge for the in-app folder browser.
// With no bridge there is no filesystem to read, so the home is the root and
// every directory reads as empty.
export function useFileSystem() {
  const fs = desktopBridge()?.fs;

  return {
    available: Boolean(fs),

    home(): Promise<string> {
      return fs ? fs.home() : Promise.resolve("/");
    },
    listDir(dir: string): Promise<DirListing> {
      if (fs) return fs.listDir(dir);
      return Promise.resolve({ path: dir, name: dir, parent: null, repo: false, entries: [] });
    },
  };
}

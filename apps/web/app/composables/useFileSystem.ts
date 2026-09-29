import type { DirListing, ProjectDirListing, ProjectFileText } from "~/types/desktop";
import { desktopBridge, needsDesktop } from "~/utils/desktopBridge";

// Reads the local filesystem through the bridge for the in-app folder browser
// and the project Files tab. With no bridge there is no filesystem to read, so
// the home is the root, every directory reads as empty, and a file read rejects
// with the reason.
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
    listProjectDir(root: string, dir: string): Promise<ProjectDirListing> {
      if (fs) return fs.listProjectDir(root, dir);
      return Promise.resolve({ dir, entries: [], truncated: false });
    },
    readProjectFile(root: string, path: string): Promise<ProjectFileText> {
      if (fs) return fs.readProjectFile(root, path);
      return Promise.reject(new Error(needsDesktop("Reading files")));
    },
    writeProjectFile(root: string, path: string, content: string): Promise<void> {
      if (fs) return fs.writeProjectFile(root, path, content);
      return Promise.reject(new Error(needsDesktop("Writing files")));
    },
  };
}

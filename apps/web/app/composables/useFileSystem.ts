import type { DirListing } from "~/types/desktop";

// Reads the local filesystem through the Electron bridge for the in-app folder
// browser. Directory reads need a real filesystem, so in `nuxt dev` (no bridge)
// we fall back to a small in-memory tree — enough to exercise the picker UI.
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

// ── dev fallback ──────────────────────────────────────────────────────────────
// A plausible slice of a home directory so the picker is demoable in the browser.

const MOCK_HOME = "/Users/you";

const MOCK_TREE: Record<string, string[]> = {
  "/Users/you": [
    "Applications",
    "Desktop",
    "Developer",
    "Documents",
    "Downloads",
    "Library",
    "Movies",
    "Music",
    "Pictures",
    "Projects",
    "Public",
    "Sites",
    "Workspace",
  ],
  "/Users/you/Developer": ["kone", "nxui", "playground", "sandbox"],
  "/Users/you/Developer/kone": ["apps", "packages", "node_modules"],
  "/Users/you/Developer/kone/apps": ["desktop", "web"],
  "/Users/you/Developer/nxui": ["src", "docs"],
  "/Users/you/Documents": ["Notes", "Invoices"],
  "/Users/you/Downloads": [],
};

// Absolute paths the mock treats as git repo roots — so the picker's repo
// indicator is demoable in `nuxt dev`, without a real filesystem.
const MOCK_REPOS = new Set([
  "/Users/you/Developer/kone",
  "/Users/you/Developer/nxui",
  "/Users/you/Developer/sandbox",
]);

function mockListDir(dir: string): DirListing {
  const names = MOCK_TREE[dir] ?? [];
  const parts = dir.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? dir;
  const parent = parts.length > 0 ? "/" + parts.slice(0, -1).join("/") : null;
  return {
    path: dir,
    name,
    parent: parent === "" ? "/" : parent,
    repo: MOCK_REPOS.has(dir),
    entries: names.map((n) => {
      const p = `${dir}/${n}`;
      return { name: n, path: p, repo: MOCK_REPOS.has(p) };
    }),
  };
}

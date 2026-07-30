// useBoardPersistence — the board layout's durable storage, bridge-or-localStorage.
//
// The desktop bridge (window.koneDesktop.board) writes the layout to the SQLite
// `project_boards` blob; standalone `nuxt dev` has no bridge, so we mirror
// useScratchpad's fallback and read/write `localStorage` under
// `kone:board:<projectPath>`. Same shape either way — a BoardLayout or null.

import type { BoardLayout } from "~/types/board";

function storageKey(projectPath: string): string {
  return `kone:board:${projectPath}`;
}

export function useBoardPersistence(projectPath: string | (() => string)) {
  const resolvePath = () =>
    typeof projectPath === "function" ? projectPath() : projectPath;
  const bridge = () => (import.meta.client ? window.koneDesktop?.board : undefined);

  function readLocal(path: string): BoardLayout | null {
    if (!import.meta.client) return null;
    try {
      const raw = localStorage.getItem(storageKey(path));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { version?: unknown }).version !== 1 ||
        !Array.isArray((parsed as { panes?: unknown }).panes)
      ) {
        return null;
      }
      return parsed as BoardLayout;
    } catch {
      return null;
    }
  }

  function writeLocal(path: string, layout: BoardLayout): void {
    if (!import.meta.client) return;
    try {
      localStorage.setItem(storageKey(path), JSON.stringify(layout));
    } catch {
      // best effort — a full/blocked store just loses the layout, never throws.
    }
  }

  async function load(): Promise<BoardLayout | null> {
    const path = resolvePath();
    const api = bridge();
    if (api) {
      try {
        return await api.load({ projectPath: path });
      } catch {
        return null;
      }
    }
    return readLocal(path);
  }

  function save(layout: BoardLayout): void {
    const path = resolvePath();
    const api = bridge();
    if (api) {
      void api.save({ projectPath: path, layout }).catch(() => {
        // best effort, exactly like the store's guarded writes.
      });
      return;
    }
    writeLocal(path, layout);
  }

  return { load, save };
}

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

// Last known layout per project path, module-scoped so it outlives the
// <ProjectView> that read it. ProjectView is keyed on the path, so switching
// projects unmounts the whole subtree and re-entering one re-ran this load
// against SQLite every time — a round-trip the user waits on before any pane
// can paint. This app is the only writer, and `save()` writes through below, so
// once we've seen a path's layout the in-memory copy is authoritative and the
// second visit costs nothing. Bounded by the number of projects opened in one
// run, holding a small JSON each.
const layoutCache = new Map<string, BoardLayout | null>();

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
    // Second and later visits to a project in this run answer from memory.
    if (layoutCache.has(path)) return layoutCache.get(path) ?? null;
    const api = bridge();
    let layout: BoardLayout | null;
    if (api) {
      try {
        layout = await api.load({ projectPath: path });
      } catch {
        // Don't cache a failed read — a transient IPC error shouldn't pin this
        // project to an empty desktop for the rest of the run.
        return null;
      }
    } else {
      layout = readLocal(path);
    }
    layoutCache.set(path, layout);
    return layout;
  }

  function save(layout: BoardLayout): void {
    const path = resolvePath();
    // Write through, so the cache never serves a layout older than the last
    // gesture — including the flush ProjectView does on unmount, which is
    // exactly the state the next visit should come back to.
    layoutCache.set(path, layout);
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

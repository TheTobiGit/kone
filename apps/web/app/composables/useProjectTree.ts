import { computed, ref, shallowRef, toValue, type MaybeRefOrGetter } from "vue";
import type { ProjectDirListing, ProjectEntry } from "~/types/desktop";

// The Files tab's tree: a project read one directory at a time. Nothing is
// walked up front — a folder is listed the first time it is opened, and its
// listing is kept so closing and reopening it costs nothing. `rows` flattens
// whatever is open into the list the sidebar renders, depth-first, so the
// template is one v-for with an indent rather than a recursive component.

export type TreeRow =
  | { kind: "entry"; entry: ProjectEntry; depth: number; open: boolean }
  | { kind: "loading"; dir: string; depth: number }
  | { kind: "error"; dir: string; depth: number; message: string }
  | { kind: "more"; dir: string; depth: number };

type DirState =
  | { state: "loading" }
  | { state: "ready"; listing: ProjectDirListing }
  | { state: "error"; message: string };

function parentsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

export function useProjectTree(root: MaybeRefOrGetter<string>) {
  const fs = useFileSystem();
  // Replaced wholesale on every change so `rows` recomputes; the maps stay small
  // (one entry per folder the user has opened).
  const dirs = shallowRef(new Map<string, DirState>());
  const expanded = shallowRef(new Set<string>());
  // A read that lands after a newer one for the same folder is dropped.
  const seq = new Map<string, number>();
  const rootLoaded = computed(() => dirs.value.get("")?.state === "ready");
  const rootError = computed(() => {
    const s = dirs.value.get("");
    return s?.state === "error" ? s.message : null;
  });
  const busy = ref(false);

  function setDir(dir: string, state: DirState): void {
    const next = new Map(dirs.value);
    next.set(dir, state);
    dirs.value = next;
  }

  /** List `dir`. A folder already on screen keeps its old rows until the new
   *  listing lands (a refresh never flashes a spinner); a first read shows one. */
  async function load(dir: string): Promise<void> {
    const mine = (seq.get(dir) ?? 0) + 1;
    seq.set(dir, mine);
    if (dirs.value.get(dir)?.state !== "ready") setDir(dir, { state: "loading" });
    try {
      const listing = await fs.listProjectDir(toValue(root), dir);
      if (seq.get(dir) !== mine) return;
      setDir(dir, { state: "ready", listing });
    } catch (error) {
      if (seq.get(dir) !== mine) return;
      setDir(dir, {
        state: "error",
        message: error instanceof Error ? error.message : "Couldn’t read this folder.",
      });
    }
  }

  function isOpen(dir: string): boolean {
    return expanded.value.has(dir);
  }

  function setOpen(dir: string, open: boolean): void {
    if (isOpen(dir) === open) return;
    const next = new Set(expanded.value);
    if (open) next.add(dir);
    else next.delete(dir);
    expanded.value = next;
    if (open && !dirs.value.has(dir)) void load(dir);
  }

  function toggle(dir: string): void {
    setOpen(dir, !isOpen(dir));
  }

  /** Open every folder above `path`, so a file picked from search shows in
   *  place in the tree. */
  function reveal(path: string): void {
    for (const dir of parentsOf(path)) setOpen(dir, true);
  }

  function collapseAll(): void {
    expanded.value = new Set();
  }

  /** Re-read every folder that has been listed, keeping what is open. Folders
   *  that were listed but are now closed are forgotten instead, so they read
   *  fresh the next time they open. */
  async function refresh(): Promise<void> {
    busy.value = true;
    const keep = [...dirs.value.keys()].filter((d) => d === "" || isOpen(d));
    const next = new Map<string, DirState>();
    for (const d of keep) {
      const s = dirs.value.get(d);
      if (s) next.set(d, s);
    }
    dirs.value = next;
    try {
      await Promise.all(keep.map((d) => load(d)));
    } finally {
      busy.value = false;
    }
  }

  const rows = computed<TreeRow[]>(() => {
    const out: TreeRow[] = [];
    const walk = (dir: string, depth: number) => {
      const s = dirs.value.get(dir);
      if (!s || s.state === "loading") {
        // The root has its own empty state; nested folders get an inline row.
        if (dir !== "") out.push({ kind: "loading", dir, depth });
        return;
      }
      if (s.state === "error") {
        if (dir !== "") out.push({ kind: "error", dir, depth, message: s.message });
        return;
      }
      for (const entry of s.listing.entries) {
        const open = entry.kind === "dir" && expanded.value.has(entry.path);
        out.push({ kind: "entry", entry, depth, open });
        if (open) walk(entry.path, depth + 1);
      }
      if (s.listing.truncated) out.push({ kind: "more", dir, depth });
    };
    walk("", 0);
    return out;
  });

  return {
    rows,
    rootLoaded,
    rootError,
    busy,
    load,
    toggle,
    reveal,
    isOpen,
    collapseAll,
    refresh,
  };
}

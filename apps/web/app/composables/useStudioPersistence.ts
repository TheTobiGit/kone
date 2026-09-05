// useStudioPersistence — the studio plane's durable storage, bridge-or-localStorage.
//
// The desktop bridge (window.koneDesktop.studio) writes the plane to the SQLite
// `studio` blob; standalone `nuxt dev` has no bridge, so we mirror
// useScratchpad's fallback and read/write `localStorage` under `kone:studio`.
// Same shape either way — a StudioLayout or null.
//
// The plane is one document, but its consumers are row-scoped: a caller works in
// one project and wants that project's row, not the whole plane. So the module
// owns the document and hands out row-level reads and writes, folding each write
// back into the document before it goes to disk. That keeps the "read and write
// whole" contract the store is built on while nothing upstream has to carry rows
// it does not own.

import { shallowRef } from "vue";
import type { ShallowRef } from "vue";
import type { StudioLayout, StudioRow } from "~/types/studio";
import { foldThreadPanes } from "~/utils/panes";

const STORAGE_KEY = "kone:studio";

// The plane as last read or written, module-scoped so it outlives any component
// that touched it. Consumers mount and unmount per project — <ProjectView> is
// keyed on the path, so switching projects unmounts the whole subtree — and
// re-entering one used to re-run the load against SQLite every time, a
// round-trip the user waits on before any pane can paint. This app is the only
// writer and every write goes through `writeThrough()` below, so once the document has
// been read the in-memory copy is authoritative.
const planeRef = shallowRef<StudioLayout | null>(null);
let docRead = false;

/** The plane itself, for consumers that work across rows rather than within one
 *  (the vertical axis and the row rail). Read-only on purpose: every write goes
 *  through `saveRow`, so the row set can never disagree with the work on it. */
export function studioPlane(): Readonly<ShallowRef<StudioLayout | null>> {
  return planeRef;
}

/** Focus a row without otherwise touching it, so travelling the vertical axis
 *  is remembered across a relaunch. A path with no row is ignored — focus is
 *  not a way to bring a row into being. */
export function setFocusedRow(projectPath: string): void {
  const plane = planeRef.value;
  if (!plane) return;
  if (plane.focusedRow === projectPath) return;
  if (!plane.rows.some((r) => r.projectPath === projectPath)) return;
  writeThrough({ ...plane, focusedRow: projectPath });
}

/** Drop the in-memory plane so the next read goes back to the store. For a
 *  store replaced underneath a running app, and for tests that need to start
 *  from an empty plane. */
export function resetStudioPlane(): void {
  planeRef.value = null;
  docRead = false;
}

/** The one place the plane is written. Kept at module scope because the two
 *  functions above are not row-scoped and so cannot reach a closure's copy. */
function writeThrough(next: StudioLayout): void {
  // Write through, so the cache never serves a plane older than the last
  // gesture — including the flush a caller does on unmount, which is exactly
  // the state the next visit should come back to.
  planeRef.value = next;
  docRead = true;
  const api = import.meta.client ? window.koneDesktop?.studio : undefined;
  if (api) {
    void api.save({ layout: next }).catch(() => {
      // best effort, exactly like the store's guarded writes.
    });
    return;
  }
  if (!import.meta.client) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best effort — a full/blocked store just loses the layout, never throws.
  }
}

/** An empty plane. The shape a first run, a cleared store, and a rejected read
 *  all normalise to, so no caller has to tell those apart. */
function emptyPlane(): StudioLayout {
  return { version: 2, rows: [], focusedRow: null };
}

export function useStudioPersistence(projectPath: string | (() => string)) {
  const resolvePath = () =>
    projectPath instanceof Function ? projectPath() : projectPath;
  const bridge = () => (import.meta.client ? window.koneDesktop?.studio : undefined);

  function readLocal(): StudioLayout | null {
    if (!import.meta.client) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      // The key is written only by this module's writeThrough; the version gate is
      // the contract check on whatever comes back.
      const parsed: StudioLayout | null = JSON.parse(raw);
      if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.rows)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** The whole plane, read once per run. */
  async function loadPlane(): Promise<StudioLayout> {
    if (docRead) return planeRef.value ?? emptyPlane();
    const api = bridge();
    if (api) {
      try {
        planeRef.value = await api.load();
      } catch {
        // Don't mark the document read on a failed IPC call — a transient error
        // shouldn't pin the whole app to an empty plane for the rest of the run.
        return emptyPlane();
      }
    } else {
      planeRef.value = readLocal();
    }
    docRead = true;
    return planeRef.value ?? emptyPlane();
  }

  /** This project's row, or null when the plane has none for it — a project
   *  with no work on it. */
  async function loadRow(): Promise<StudioRow | null> {
    const path = resolvePath();
    const plane = await loadPlane();
    return plane.rows.find((r) => r.projectPath === path) ?? null;
  }

  /** Fold this project's row into the plane and write it through.
   *
   *  A row with no panes is *removed* rather than stored empty: a row exists
   *  only where work does, so persisting an empty one would bring back a row you
   *  can travel to and find nothing in. Saving a row is also what focuses it —
   *  the row being written is the one being worked in.
   *
   *  One conversation is hosted by exactly one pane, and this is the choke
   *  point every persisted row passes through — so a row carrying two panes
   *  for the same thread id is folded here (keep the leftmost), whatever race
   *  produced it. Without this a duplicate would resurrect as twin columns on
   *  every relaunch. */
  function saveRow(row: StudioRow): void {
    const panes = foldThreadPanes(row.panes);
    const folded: StudioRow = panes.length === row.panes.length ? row : { ...row, panes };
    const plane = planeRef.value ?? emptyPlane();
    const at = plane.rows.findIndex((r) => r.projectPath === folded.projectPath);
    const rows = [...plane.rows];
    if (folded.panes.length === 0) {
      // Its last pane closed, so the row goes with it.
      if (at >= 0) rows.splice(at, 1);
    } else if (at >= 0) {
      // An existing row keeps its place on the vertical axis. Dropping it and
      // pushing it back would reorder the plane every time a row saved — and
      // two rows restoring on boot would race for the bottom.
      rows[at] = folded;
    } else {
      // A newly-born row joins at the bottom, where the eye last was.
      rows.push(folded);
    }
    // A newly-born row is where work just started, so it takes focus; an
    // existing one keeps whatever the plane was already looking at, because a
    // background row's teardown flush must not drag the camera onto it.
    const isNew = !plane.rows.some((r) => r.projectPath === folded.projectPath);
    const focusedRow =
      folded.panes.length > 0 && (isNew || plane.focusedRow === null)
        ? folded.projectPath
        : plane.focusedRow;
    writeThrough({ version: 2, rows, focusedRow });
  }

  /** Synchronous write-through of the freshest row, past any debounce — the
   *  unload/visibility flush a caller performs on teardown. Callers pass the
   *  live serialization (a gesture inside the debounce window has not reached
   *  saveRow() yet, so the cached document alone could be a tick stale); the
   *  document as it stands is the fallback. The IPC send happens at call time
   *  (the promise is fire-and-forget), so even a renderer that dies this tick
   *  has already enqueued the message. */
  function flushRow(row?: StudioRow): void {
    if (row) {
      saveRow(row);
      return;
    }
    if (planeRef.value) writeThrough(planeRef.value);
  }

  return { loadPlane, loadRow, saveRow, flushRow };
}

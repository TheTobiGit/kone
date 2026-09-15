import { ref, shallowRef, type Ref, type ShallowRef } from "vue";
import type { ThreadSession } from "../useAgent";

/** How many idle, settled background threads to keep resident. Busy threads are
 *  never evicted; this only bounds the settled backlog so the registry (and the
 *  pill stack) can't grow without end. Matches the board's restored-pane cap so
 *  a saved strip of conversations doesn't immediately go dormant on open. */
export const MAX_RESIDENT_THREADS = 8;
/** How long a started session may sit without any activity before the sweep
 *  hibernates it — stops the provider process (and releases the gateway token)
 *  while keeping the thread resident, so the pane stays and the next send
 *  kone's board keeps the pane, so 30 min of genuinely-unused process is the
 *  same tradeoff here. */
export const IDLE_HIBERNATE_MS = 30 * 60_000;
/** Sweep cadence. Cheap pass (a handful of sessions); runs forever because the
 *  registry outlives any one <ProjectView> — the sweep is what bounds process
 *  counts while a project is away. */
export const SWEEP_INTERVAL_MS = 60_000;

/** One project's live-session registry, hoisted to module scope. <ProjectView>
 * is keyed on project.path (index.vue), so a per-instance registry would
 * dispose every session — and with it kill every provider process, which the
 * renderer's dispose() is the only thing tearing down — the moment the user
 * switches projects. Keeping the registry per project path at module scope
 * makes a project switch a swap of registries: background turns keep folding
 * (the single event listener is also hoisted), and re-entering the project
 * re-attaches the same live sessions — the board re-attaches dormant panes on
 * focus, and openThreadHandle reuses resident sessions by id. Sessions are
 * still disposed on explicit thread close; the sweep hibernates idle ones so
 * processes don't pile up across the run. Bounded by the number of projects
 * opened in one run, like useStudioPersistence's plane cache. */
export type ProjectRegistry = {
  sessions: ShallowRef<ThreadSession[]>;
  opening: Map<string, { key: string; promise: Promise<void> }>;
  activeKey: Ref<string>;
  listenerAttached: boolean;
  unsubscribeListener: (() => void) | null;
  sweepTimer: ReturnType<typeof setInterval> | null;
  // Session keys currently bound to a live studio pane, across every column in
  // the strip (not just the focused one). The board is the one thing that
  // knows this — it owns the PaneId → session-key join — so it reports in
  // here via pinToPane/unpinFromPane. Plain Set, not a ref: nothing renders
  // off it, the sweep just reads it on its own tick.
  paneBoundKeys: Set<string>;
};
export const registries = new Map<string, ProjectRegistry>();

/** True when the id belongs to a spawned child of any resident parent session.
 *  The event router uses this to tell a genuine headless child's ask (which
 *  belongs in the registry inbox the parent's dock reads) apart from a
 *  top-level thread that simply has no session yet (which belongs in the
 *  orphan pen until claimed). */
export function isKnownSpawnedChild(threadId: string): boolean {
  for (const r of registries.values()) {
    for (const s of r.sessions.value) {
      for (const k of s.spawnedChildren.value) {
        if (k.threadId === threadId) return true;
      }
    }
  }
  return false;
}

/** Bumped whenever the *set* of registries changes. The Map itself is plain —
 *  the sessions inside it are refs, so a computed that walks it tracks their
 *  contents, but not a project appearing or going away. Anything reading across
 *  every project (see liveTurns) touches this so a newly-opened project's
 *  threads are not invisible until something else happens to invalidate. */
export const registryVersion = ref(0);

export function registryFor(projectPath: string): ProjectRegistry {
  let r = registries.get(projectPath);
  if (!r) {
    r = {
      sessions: shallowRef<ThreadSession[]>([]),
      opening: new Map(),
      activeKey: ref(""),
      listenerAttached: false,
      unsubscribeListener: null,
      sweepTimer: null,
      paneBoundKeys: new Set(),
    };
    registries.set(projectPath, r);
    registryVersion.value++;
  }
  return r;
}

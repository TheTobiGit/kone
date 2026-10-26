import { computed, getCurrentInstance, onBeforeUnmount, readonly, ref } from "vue";
import type { ComputedRef, Ref } from "vue";
import { useSound } from "./useSound";
import type { Cue } from "./useSound";

// usePortals — the handoff orchestrator for the app's full-viewport portals.
//
// Each portal covers the whole viewport, so moving between them is a handoff,
// never independent toggles. Portals stack: summoning keeps everything below
// the arrival open underneath it, so leaving the frontmost portal always
// reveals wherever the user came from rather than the page. Going up the
// stack, the arrival simply fades in over what is already opaque below it;
// going down, the arrival appears instantly underneath (it drops its fade
// while covered) and the portals above it fade out over it on the next frame,
// so visible progress starts in one frame rather than one fade.
//
// Which portals stay and which leave comes from PORTAL_STACK, not from naming
// the pair. That is the whole reason the order is data: another portal is an
// entry in the list, and the handoff it gets is decided by where it sits
// rather than by another branch in here.
//
// Going down closes the cover, so the stack alone forgets where the user came
// from — a trail of visited portals remembers instead, and dismissing the
// frontmost portal with nothing underneath reopens the last one rather than
// dropping to the page.
//
// One pending switch at most: every new intent abandons the previous one, so a
// frame from a switch the user already moved past can never carry through —
// dismissing mid-handoff lands on the still-open portal instead.

export type PortalId = "studio" | "inbox";

/** Painting order, bottom first. The studio is the work surface, so the inbox
 *  paints over it: the inbox is another way of looking at the work the studio
 *  is doing, and the order is what makes every switch between them a definite
 *  direction. */
export const PORTAL_STACK: readonly PortalId[] = ["studio", "inbox"];

/** Which portals are wired into the app right now. The studio is the one being
 *  finished, so the inbox is parked: its components, state and tests stay, and
 *  moving it back is adding the id here. A portal that is not in this set
 *  cannot be summoned — the gate in `summon` below is the only place that
 *  decides, so a stale entry point can never open a surface that is not built
 *  yet. The stack above keeps the full order either way, so the handoff needs
 *  no re-derivation.
 *
 *  Bringing the inbox back: add "inbox" above. These follow on their own —
 *  the page's mount and its state binding, the intent menu's "Go to Inbox"
 *  rows, the settings pane itself, the attention bots' jump (instead of the
 *  project-page fallback) and the jump gate in jumpToThread. Two things were
 *  parked by hand and have to come back by hand: the ⌘I action in useShortcuts
 *  (with its handler in pages/index.vue) and the Inbox row in SettingsDrawer.
 *  Each carries a comment pointing here. */
export const ENABLED_PORTALS: ReadonlySet<PortalId> = new Set<PortalId>(["studio"]);

/** Whether a portal is live. Read by the page (whether to mount the surface)
 *  and by the menus (whether to offer a way there). */
export function isPortalEnabled(portal: PortalId): boolean {
  return ENABLED_PORTALS.has(portal);
}

/** Where a portal sits in the painting order.
 *
 *  A lookup built once from PORTAL_STACK rather than an `indexOf` per call. The
 *  difference that matters is not the scan: `indexOf` answers -1 for an id it
 *  does not hold, and -1 is a *valid depth* to every comparison here — it sorts
 *  below the studio and passes the "above" filter silently. A missing id is a
 *  portal that was added to the union and left out of the painting order, and
 *  that has to be loud at the boundary instead of quietly ordering the stack
 *  wrong. */
const PORTAL_DEPTH = new Map<PortalId, number>(PORTAL_STACK.map((p, i) => [p, i]));

function depth(portal: PortalId): number {
  const at = PORTAL_DEPTH.get(portal);

  if (at === undefined) throw new Error(`portal "${portal}" is not in PORTAL_STACK`);

  return at;
}

/** Where a portal sits in the stack. `hidden` is away, `active` is the
 *  frontmost layer, `covered` is open underneath another portal. Both
 *  portals render from this one contract. */
export type PortalState = "active" | "covered" | "hidden";

// The fade itself, and the only place its length is stated: it drives the CSS
// fades through --portal-fade-ms (see fadeStyle). The stylesheet names the
// same length as a fallback for layers rendered outside the page wrapper.
export const PORTAL_FADE_MS = 220;

// The clock the handoff runs on. Production waits out the real next frame;
// tests hand in a manual one and drive it by hand.
export interface PortalClock {
  /** Run `run` on the next frame; the returned function cancels it. */
  frame: (run: () => void) => () => void;
}

const browserClock: PortalClock = {
  frame(run: () => void): () => void {
    // Outside the client there is no frame to wait for, so the cover step
    // falls back to a zero wait — the ordering is preserved, only the paint
    // wait collapses.
    if (import.meta.client && window.requestAnimationFrame instanceof Function) {
      const id = window.requestAnimationFrame(() => run());

      return () => window.cancelAnimationFrame(id);
    }

    const id = setTimeout(run, 0);

    return () => clearTimeout(id);
  },
};

export interface UsePortalsOptions {
  /** Sound for a summon. Defaults to the app's cue layer; tests hand in a spy. */
  cue?: (name: Cue) => void;
  /** Handoff clock. Defaults to real frames; tests hand in a manual one. */
  clock?: PortalClock;
  /** Which portals may open. Defaults to ENABLED_PORTALS; tests hand in a set
   *  naming the portal under test, so the parked ones stay exercisable. */
  enabled?: ReadonlySet<PortalId>;
}

/** A parked thread in some project asking to be read in the inbox. Plain data,
 *  so a jump is state the inbox reacts to rather than a method call on it. */
export interface ThreadJumpTarget {
  projectPath: string;
  threadId: string;
  projectName?: string;
}

export interface UsePortals {
  studioOpen: Readonly<Ref<boolean>>;
  inboxOpen: Readonly<Ref<boolean>>;
  /** The frontmost open portal, if any. The inbox paints over the plane. */
  activePortal: ComputedRef<PortalId | null>;
  /** The --portal-fade-ms binding for the page wrapper, read from the same
   *  constant as the CSS fallback. */
  fadeStyle: ComputedRef<{ "--portal-fade-ms": string }>;
  summon: (portal: PortalId) => void;
  /** Dismiss one portal (default: the frontmost), revealing whatever portal
   *  stands open underneath it — or, with nothing underneath, reopening where
   *  the user came from. Abandons the pending switch first, so a mid-handoff
   *  dismissal lands on the still-open portal. */
  dismiss: (portal?: PortalId) => void;
  toggleStudio: () => void;
  toggleInbox: () => void;
  /** Whether the portal is open but painted under another one. */
  isCovered: (portal: PortalId) => boolean;
  /** The surface contract every portal renders from. */
  portalState: (portal: PortalId) => PortalState;
  /** A cross-portal jump waiting to be read. Set by jumpToThread, cleared once
   *  the inbox has taken it — the inbox watches this, never a component ref. */
  pendingThreadJump: Ref<ThreadJumpTarget | null>;
  /** Summon the inbox onto a parked thread: records the jump for the inbox to
   *  route, then runs the ordinary inbox summon so the handoff applies. */
  jumpToThread: (target: ThreadJumpTarget) => void;
  /** Drop a jump without routing it. The inbox calls for this once it takes one. */
  clearThreadJump: () => void;
  /** Cancel any pending switch. Runs on unmount; tests call it by hand. */
  dispose: () => void;
}

function defaultCue(name: Cue): void {
  if (!import.meta.client) return;
  useSound().cue(name);
}

export function usePortals(options: UsePortalsOptions = {}): UsePortals {
  // One ref per portal rather than a reactive record: the public surface hands
  // both of them out individually, and a record would have to be unwrapped at
  // every one of those boundaries.
  const openRefs = {
    studio: ref(false),
    inbox: ref(false),
  } satisfies Record<PortalId, Ref<boolean>>;

  const pendingThreadJump = ref<ThreadJumpTarget | null>(null);

  const cue = options.cue ?? defaultCue;
  const clock = options.clock ?? browserClock;
  const enabled = options.enabled ?? ENABLED_PORTALS;

  let cancelPending: (() => void) | null = null;

  // Where dismissing the frontmost portal goes when nothing stands open
  // underneath it. Going down the stack closes the cover to reveal a portal
  // that was shut, so the stack alone cannot say where the user came from —
  // the trail does. The back entry reopens; entries still open underneath are
  // revealed instead and simply consumed. Plain data, never read by the
  // template: it only steers summon and dismiss.
  let trail: PortalId[] = [];

  function forget(portal: PortalId): void {
    trail = trail.filter((p) => p !== portal);
  }

  function abandon(): void {
    if (cancelPending) {
      cancelPending();
      cancelPending = null;
    }
  }

  function dispose(): void {
    abandon();
  }

  if (getCurrentInstance()) onBeforeUnmount(dispose);

  /** The frontmost open portal: the last one in painting order that is up. */
  const activePortal = computed<PortalId | null>(() => {
    for (let i = PORTAL_STACK.length - 1; i >= 0; i--) {
      const portal = PORTAL_STACK[i];

      if (portal && openRefs[portal].value) return portal;
    }

    return null;
  });

  const fadeStyle = computed(() => ({ "--portal-fade-ms": `${PORTAL_FADE_MS}ms` }));

  function isOpen(portal: PortalId): boolean {
    return openRefs[portal].value;
  }

  function portalState(portal: PortalId): PortalState {
    if (!isOpen(portal)) return "hidden";

    return activePortal.value === portal ? "active" : "covered";
  }

  function isCovered(portal: PortalId): boolean {
    return portalState(portal) === "covered";
  }

  function summon(portal: PortalId): void {
    // Parked portal: no surface to arrive on, so nothing happens — the same
    // answer as pressing a summon for something that is not built yet. Guarding
    // here rather than at each caller keeps the keyboard, the menus and the
    // cross-portal jumps honest with one check.
    if (!enabled.has(portal)) return;

    // Already frontmost: nothing to hand off, and re-cueing a portal the user
    // is looking at would sound like something happened. Abandon first so an
    // explicit re-summon settles a pending downward close instead of letting
    // it carry through and take the portal away.
    if (activePortal.value === portal) {
      abandon();

      return;
    }

    abandon();
    cue("open");
    const wasOpen = openRefs[portal].value;

    if (!wasOpen) {
      // A fresh arrival: the frontmost portal is where the user came from, so
      // it becomes the way back. A stale trail entry for the arrival itself is
      // dropped first, or dismissing later would reopen somewhere already
      // left behind.
      forget(portal);
      const from = activePortal.value;

      if (from && trail[trail.length - 1] !== from) trail.push(from);
    } else {
      // Already open underneath: travelling back within the stack, so the
      // trail is cut back to the arrival and the covers being left are
      // discarded with it rather than reopening later.
      const at = trail.lastIndexOf(portal);

      if (at >= 0) trail = trail.slice(0, at);
    }

    openRefs[portal].value = true;

    // Everything below stays open underneath; everything above has to leave
    // for the arrival to be seen. Going up there is never anything above, so
    // the arrival just fades in over what is already there.
    const above = PORTAL_STACK.filter((p) => depth(p) > depth(portal) && openRefs[p].value);

    if (above.length === 0) return;

    const closeAbove = (): void => {
      cancelPending = null;

      for (const other of above) openRefs[other].value = false;
    };

    if (wasOpen) {
      // Already painted underneath, so the cover can fade out over it at once.
      closeAbove();

      return;
    }

    // Just opened underneath: it paints opaque while still covered (its fade
    // is cut while covered), and the cover fades out over it on the next
    // frame, so the fade composites over work rather than over the page.
    cancelPending = clock.frame(closeAbove);
  }

  function dismiss(portal?: PortalId): void {
    const target = portal ?? activePortal.value;

    if (!target) return;

    const wasActive = activePortal.value === target;
    abandon();
    openRefs[target].value = false;
    forget(target);

    if (!wasActive) return;

    // Leaving the frontmost portal reveals whatever stands open underneath;
    // with nothing underneath, the trail reopens where the user came from
    // instead of dropping to the page.
    const under = activePortal.value;

    if (under !== null) {
      if (trail[trail.length - 1] === under) trail.pop();

      return;
    }

    const back = trail.pop();

    // Silent: whatever dismissed the portal already sounded the way back, and
    // the reopening is the same step, not a second one.
    if (back !== undefined) {
      openRefs[back].value = true;
    }
  }

  /** A portal's own key. Pressing it while that portal is frontmost puts it
   *  away; pressing it from anywhere else goes there. Mid-handoff the portal
   *  being left is still painted, so this lands back on it rather than letting
   *  the pending switch carry through to the page. */
  function toggle(portal: PortalId): void {
    if (openRefs[portal].value && activePortal.value === portal) {
      cue("leave");
      dismiss(portal);
    } else summon(portal);
  }

  function toggleStudio(): void {
    toggle("studio");
  }

  function toggleInbox(): void {
    toggle("inbox");
  }

  function jumpToThread(target: ThreadJumpTarget): void {
    // A jump is a summon of the inbox, so a parked inbox takes no jumps: a
    // recorded target with nowhere to land would sit in state forever.
    if (!enabled.has("inbox")) return;

    // Recorded first so the inbox already has the thread when the summon
    // brings it forward; the inbox clears it once taken, so a second jump is
    // a fresh object and always re-triggers its watcher.
    pendingThreadJump.value = {
      projectPath: target.projectPath,
      threadId: target.threadId,
      projectName: target.projectName,
    };
    summon("inbox");
  }

  function clearThreadJump(): void {
    pendingThreadJump.value = null;
  }

  return {
    studioOpen: readonly(openRefs.studio),
    inboxOpen: readonly(openRefs.inbox),
    activePortal,
    fadeStyle,
    summon,
    dismiss,
    toggleStudio,
    toggleInbox,
    isCovered,
    portalState,
    pendingThreadJump,
    jumpToThread,
    clearThreadJump,
    dispose,
  };
}

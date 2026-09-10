import { computed, getCurrentInstance, onBeforeUnmount, readonly, ref } from "vue";
import type { ComputedRef, Ref } from "vue";
import { usePreferredReducedMotion } from "@vueuse/core";
import { useSound } from "./useSound";
import type { Cue } from "./useSound";

// usePortals — the handoff orchestrator for the app's full-viewport portals.
//
// The studio plane and the inbox each cover the whole viewport, and the inbox
// paints over the plane — so moving between them is a handoff, never two
// independent toggles. Both directions keep the page covered for the whole
// switch: going up, the inbox fades in over the still-opaque plane and the
// plane only leaves once the inbox is opaque; going down, the plane appears
// instantly underneath (it drops its fade while covered) and the inbox fades
// out over it on the next frame, so visible progress starts in one frame
// rather than one fade.
//
// One pending switch at most: every new intent abandons the previous one, so a
// timer from a switch the user already moved past can never carry through to
// the page — dismissing mid-handoff lands on the still-open portal instead.

export type PortalId = "studio" | "inbox";

/** Where a portal sits in the stack. `hidden` is away, `active` is the
 *  frontmost layer, `covered` is open underneath another portal. Both
 *  portals render from this one contract. */
export type PortalState = "active" | "covered" | "hidden";

// The fade itself, and the only place its length is stated: it drives the CSS
// fades through --portal-fade-ms (see fadeStyle), so the timer and the fade
// cannot drift. The stylesheet names the same length as a fallback for layers
// rendered outside the page wrapper.
export const PORTAL_FADE_MS = 220;

// The upward handoff waits a frame past the fade so the plane only leaves once
// the inbox is fully opaque. Waiting a shade long only leaves an invisible
// layer briefly, while firing early would flash the page.
const PORTAL_HANDOFF_SLACK_MS = 10;
export const PORTAL_HANDOFF_MS = PORTAL_FADE_MS + PORTAL_HANDOFF_SLACK_MS;

// The clock the handoff runs on. Production waits out the real fade and the
// real next frame; tests hand in a manual one and drive time by hand.
export interface PortalClock {
  /** Run `run` after `ms`; the returned function cancels it. */
  after: (run: () => void, ms: number) => () => void;
  /** Run `run` on the next frame; the returned function cancels it. */
  frame: (run: () => void) => () => void;
}

const browserClock: PortalClock = {
  after(run: () => void, ms: number): () => void {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
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
  /** Handoff clock. Defaults to real timers; tests hand in a manual one. */
  clock?: PortalClock;
  /** Reduced-motion flag. Defaults to the OS preference; tests hand in a ref. */
  reducedMotion?: Ref<boolean>;
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
   *  constant as the handoff timer. */
  fadeStyle: ComputedRef<{ "--portal-fade-ms": string }>;
  summon: (portal: PortalId) => void;
  /** Dismiss one portal (default: the frontmost). Abandons the pending switch
   *  first, so a mid-handoff dismissal lands on the still-open portal. */
  dismiss: (portal?: PortalId) => void;
  toggleStudio: () => void;
  toggleInbox: () => void;
  /** Whether the portal is open but painted under another one. */
  isCovered: (portal: PortalId) => boolean;
  /** The surface contract both portals render from. */
  portalState: (portal: PortalId) => PortalState;
  /** A cross-portal jump waiting to be read. Set by jumpToThread, cleared once
   *  the inbox has taken it — the inbox watches this, never a component ref. */
  pendingThreadJump: Ref<ThreadJumpTarget | null>;
  /** Summon the inbox onto a parked thread: records the jump for the inbox to
   *  route, then runs the ordinary inbox summon so the handoff timers apply. */
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
  const studioOpen = ref(false);
  const inboxOpen = ref(false);
  const pendingThreadJump = ref<ThreadJumpTarget | null>(null);

  const cue = options.cue ?? defaultCue;
  const clock = options.clock ?? browserClock;
  const overrideMotion = options.reducedMotion;
  // The media query is only subscribed when no override is handed in, so tests
  // (and any caller pinning the flag) never touch matchMedia. The branch is
  // fixed for the life of this setup call, so hook order cannot shift.
  const mediaMotion = overrideMotion ? null : usePreferredReducedMotion();
  function reducedMotionOn(): boolean {
    if (overrideMotion) return overrideMotion.value;
    return mediaMotion !== null && mediaMotion.value === "reduce";
  }

  let cancelPending: (() => void) | null = null;
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

  const activePortal = computed<PortalId | null>(() => {
    if (inboxOpen.value) return "inbox";
    if (studioOpen.value) return "studio";
    return null;
  });

  const fadeStyle = computed(() => ({ "--portal-fade-ms": `${PORTAL_FADE_MS}ms` }));

  function isOpen(portal: PortalId): boolean {
    return portal === "studio" ? studioOpen.value : inboxOpen.value;
  }

  function portalState(portal: PortalId): PortalState {
    if (!isOpen(portal)) return "hidden";
    return activePortal.value === portal ? "active" : "covered";
  }

  function isCovered(portal: PortalId): boolean {
    return portalState(portal) === "covered";
  }

  function summon(portal: PortalId): void {
    if (portal === "studio") {
      if (studioOpen.value && !inboxOpen.value) return;
      abandon();
      cue("expand");
      if (inboxOpen.value) {
        // Instant underneath, fading inbox over it on the next frame: the plane
        // paints opaque while still covered, so the inbox fade composites over
        // work rather than over the page — and over a paint, not a timer.
        studioOpen.value = true;
        cancelPending = clock.frame(() => {
          cancelPending = null;
          inboxOpen.value = false;
        });
      } else {
        studioOpen.value = true;
      }
      return;
    }
    if (inboxOpen.value && !studioOpen.value) return;
    abandon();
    cue("expand");
    if (studioOpen.value) {
      // The inbox fades in over the still-opaque plane; sending the plane away
      // once the inbox is opaque hides it underneath, out of sight. Without
      // motion there is no fade to wait out, so the plane leaves at once.
      inboxOpen.value = true;
      const wait = reducedMotionOn() ? 0 : PORTAL_HANDOFF_MS;
      cancelPending = clock.after(() => {
        cancelPending = null;
        studioOpen.value = false;
      }, wait);
    } else {
      inboxOpen.value = true;
    }
  }

  function dismiss(portal?: PortalId): void {
    const target = portal ?? activePortal.value;
    if (!target) return;
    abandon();
    if (target === "studio") studioOpen.value = false;
    else inboxOpen.value = false;
  }

  function toggleStudio(): void {
    // While the inbox is up it is the frontmost thing, so the studio key means
    // "go to the studio" rather than toggling a plane nobody can see.
    if (studioOpen.value && !inboxOpen.value) dismiss("studio");
    else summon("studio");
  }

  function toggleInbox(): void {
    // Dismissing mid-handoff (both flags up) lands back on the still-open plane
    // rather than letting the handoff carry through to the page.
    if (inboxOpen.value) dismiss("inbox");
    else summon("inbox");
  }

  function jumpToThread(target: ThreadJumpTarget): void {
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
    studioOpen: readonly(studioOpen),
    inboxOpen: readonly(inboxOpen),
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

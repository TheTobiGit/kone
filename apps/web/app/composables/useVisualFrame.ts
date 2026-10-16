import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import {
  VisualFrameMessageSchema,
  visualThemeFragment,
  visualThemeMessage,
  visualUrl,
  type VisualKeyPress,
  type VisualTheme,
} from "@kone/protocol/visual-render";
import { isAppChord } from "~/composables/useShortcuts";
import { readRootVisualTheme } from "~/utils/visualTheme";

// The app's half of an agent's visual: the frame's address, the theme it is
// handed, and the messages it sends back.
//
// The visual runs sandboxed in an opaque origin, so everything crosses as a
// message. It reports its height, asks for links and images to be opened (it
// cannot open a window itself), passes on keys it did not use, and — when its
// stored document is gone — says so. The app hands it the theme: once in the
// address, so its first paint is already right, and again whenever the
// window's own colours change — a theme switch, the light/dark flip, a live
// preview of a theme. Watching the root element catches every one of those
// without knowing which of them happened.

/** A computed colour that paints nothing. */
const CLEAR_COLOUR = /^transparent$|^rgba\(.*,\s*0\)$|\/\s*0\)$/;

/** How often a height the visual reports reaches the thread. A visual that
 *  animates in reports a new height every frame, and each one re-lays-out
 *  the thread under it; ten a second still reads as following the visual. */
const HEIGHT_INTERVAL_MS = 100;

/** The colour actually behind the frame: the first painted surface above it.
 *  The thread, the assistant panel and the full-size card each sit on a
 *  different surface, and a visual that paints the window's ground on a raised
 *  panel shows up as a dark slab instead of part of the reply. */
function surfaceBehind(element: Element | null): string | undefined {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const colour = getComputedStyle(node).backgroundColor;
    if (!CLEAR_COLOUR.test(colour)) return colour;
  }
  return undefined;
}

/** The theme on screen right now, as the visual's variables, with --ground set
 *  to whatever the frame really sits on. */
function readVisualTheme(frame: HTMLIFrameElement | null): VisualTheme {
  const theme = readRootVisualTheme();
  const surface = surfaceBehind(frame);
  if (surface) theme.variables["--ground"] = surface;
  return theme;
}

/** A chord the visual passed on, as the key press the app's own handlers read. */
function keyEvent(press: VisualKeyPress): KeyboardEvent {
  return new KeyboardEvent("keydown", { ...press, bubbles: true, cancelable: true });
}

export interface VisualFrameHandlers {
  /** The height the visual reports, at most every HEIGHT_INTERVAL_MS. */
  onHeight: (height: number) => void;
  /** The visual has something to show: it loaded, or reported its height. */
  onReady?: () => void;
  /** An Escape pressed inside the visual that the visual left alone. */
  onEscape?: () => void;
  /** An image in the visual the reader clicked. */
  onImage?: (src: string, alt: string) => void;
  /** The stored visual is gone. */
  onUnavailable?: () => void;
}

export function useVisualFrame(
  attachmentId: string,
  frame: Ref<HTMLIFrameElement | null>,
  handlers: VisualFrameHandlers,
) {
  // Set on mount, where the window's colours can be read: the address is the
  // frame's identity, and changing it would reload the visual and lose
  // whatever the reader had done in it. Later themes arrive as messages; only
  // a reload sets it again.
  const src = ref<string | undefined>(undefined);
  let loads = 0;

  let heightTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingHeight: number | undefined;
  let sentHeight = false;
  function reportHeight(height: number): void {
    // The first height goes at once, so the frame fits the visual on its first
    // paint; the rest are paced.
    if (!sentHeight) {
      sentHeight = true;
      handlers.onHeight(height);
      return;
    }
    pendingHeight = height;
    heightTimer ??= setTimeout(() => {
      heightTimer = undefined;
      if (pendingHeight !== undefined) handlers.onHeight(pendingHeight);
    }, HEIGHT_INTERVAL_MS);
  }

  function onMessage(event: MessageEvent): void {
    const target = frame.value?.contentWindow;
    if (!target || event.source !== target) return;
    const parsed = VisualFrameMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.kind) {
      case "size":
        reportHeight(message.height);
        handlers.onReady?.();
        return;
      case "escape":
        handlers.onEscape?.();
        return;
      case "key": {
        // Played on the frame, so it bubbles through the app as a key pressed
        // there would have.
        const press = keyEvent(message.press);
        if (isAppChord(press)) frame.value?.dispatchEvent(press);
        return;
      }
      case "image":
        if (message.src) handlers.onImage?.(message.src, message.alt);
        return;
      case "unavailable":
        handlers.onUnavailable?.();
        return;
      case "link":
        // The shell's window-open gate sends an http(s) URL to the browser.
        if (message.url) window.open(message.url, "_blank", "noopener");
    }
  }

  let observer: MutationObserver | null = null;
  let pending = 0;
  function sendTheme(): void {
    pending = 0;
    // An opaque origin matches no target origin but "*"; what goes out is
    // colours, which any visual may see.
    frame.value?.contentWindow?.postMessage(visualThemeMessage(readVisualTheme(frame.value)), "*");
  }

  // The address carries the theme of the moment it was set, and a lazy frame
  // may load long after: a theme switch in between went out as a message to a
  // visual that wasn't there yet. Each load is handed the theme as it is now.
  function onLoad(): void {
    sendTheme();
    handlers.onReady?.();
  }
  let loaded: HTMLIFrameElement | null = null;

  function address(): string {
    // A reload needs an address the frame has not loaded yet; the scheme serves
    // the visual whatever the query says.
    return visualUrl(attachmentId) + (loads ? `?load=${loads}` : "") + visualThemeFragment(readVisualTheme(frame.value));
  }

  /** Load the visual afresh, as it was first shown. */
  function reload(): void {
    loads += 1;
    sentHeight = false;
    src.value = address();
  }

  onMounted(() => {
    src.value = address();
    loaded = frame.value;
    loaded?.addEventListener("load", onLoad);
    window.addEventListener("message", onMessage);
    observer = new MutationObserver(() => {
      if (!pending) pending = requestAnimationFrame(sendTheme);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme", "data-scheme"],
    });
  });

  onBeforeUnmount(() => {
    loaded?.removeEventListener("load", onLoad);
    window.removeEventListener("message", onMessage);
    observer?.disconnect();
    if (pending) cancelAnimationFrame(pending);
    if (heightTimer) clearTimeout(heightTimer);
  });

  return { src, reload };
}

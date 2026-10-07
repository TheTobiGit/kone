import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import {
  PageFrameMessageSchema,
  pageThemeFragment,
  pageThemeMessage,
  pageUrl,
  type PageTheme,
} from "@kone/protocol/page-render";
import { readRootPageTheme } from "~/utils/pageTheme";

// The app's half of an agent's page: the frame's address, the theme it is
// handed, and the messages it sends back.
//
// The page runs sandboxed in an opaque origin, so everything crosses as a
// message. It reports its height, asks for links to be opened (it cannot open
// a window itself), and passes on an Escape it did not use. The app hands it the theme: once in the address, so
// its first paint is already right, and again whenever the window's own
// colours change — a theme switch, the light/dark flip, a live preview of a
// theme. Watching the root element catches every one of those without knowing
// which of them happened.

/** A computed colour that paints nothing. */
const CLEAR_COLOUR = /^transparent$|^rgba\(.*,\s*0\)$|\/\s*0\)$/;

/** The colour actually behind the frame: the first painted surface above it.
 *  The thread, the assistant panel and the full-size card each sit on a
 *  different surface, and a page that paints the window's ground on a raised
 *  panel shows up as a dark slab instead of part of the reply. */
function surfaceBehind(element: Element | null): string | undefined {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const colour = getComputedStyle(node).backgroundColor;
    if (!CLEAR_COLOUR.test(colour)) return colour;
  }
  return undefined;
}

/** The theme on screen right now, as the page's variables, with --ground set
 *  to whatever the frame really sits on. */
function readPageTheme(frame: HTMLIFrameElement | null): PageTheme {
  const theme = readRootPageTheme();
  const surface = surfaceBehind(frame);
  if (surface) theme.variables["--ground"] = surface;
  return theme;
}

export function usePageFrame(
  attachmentId: string,
  frame: Ref<HTMLIFrameElement | null>,
  onHeight: (height: number) => void,
  /** An Escape pressed inside the page that the page left alone. */
  onEscape?: () => void,
) {
  // Set once, on mount, where the window's colours can be read: the address is
  // the frame's identity, and changing it would reload the page and lose
  // whatever the reader had done in it. Later themes arrive as messages.
  const src = ref<string | undefined>(undefined);

  function onMessage(event: MessageEvent): void {
    const target = frame.value?.contentWindow;
    if (!target || event.source !== target) return;
    const parsed = PageFrameMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.kind === "size") onHeight(message.height);
    else if (message.kind === "escape") onEscape?.();
    // The shell's window-open gate sends an http(s) URL to the browser.
    else if (message.url) window.open(message.url, "_blank", "noopener");
  }

  let observer: MutationObserver | null = null;
  let pending = 0;
  function sendTheme(): void {
    pending = 0;
    // An opaque origin matches no target origin but "*"; what goes out is
    // colours, which any page may see.
    frame.value?.contentWindow?.postMessage(pageThemeMessage(readPageTheme(frame.value)), "*");
  }

  // The address carries the theme of the moment it was set, and a lazy frame
  // may load long after: a theme switch in between went out as a message to a
  // page that wasn't there yet. Each load is handed the theme as it is now.
  let loaded: HTMLIFrameElement | null = null;

  onMounted(() => {
    src.value = pageUrl(attachmentId) + pageThemeFragment(readPageTheme(frame.value));
    loaded = frame.value;
    loaded?.addEventListener("load", sendTheme);
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
    loaded?.removeEventListener("load", sendTheme);
    window.removeEventListener("message", onMessage);
    observer?.disconnect();
    if (pending) cancelAnimationFrame(pending);
  });

  return { src };
}

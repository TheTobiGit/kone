<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { useResizeObserver } from "@vueuse/core";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "~/composables/useTheme";
import { useTypography } from "~/composables/useTypography";
import type { TerminalSession } from "~/composables/useTerminal";

const props = defineProps<{
  session: TerminalSession;
}>();

const emit = defineEmits<{
  write: [data: string];
  resize: [cols: number, rows: number];
}>();

const container = ref<HTMLElement | null>(null);
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let webgl: WebglAddon | null = null;
let detachSink: (() => void) | null = null;
let noticeShown = false;
let visibilityObserver: IntersectionObserver | null = null;
const { scheme, extras } = useTheme();
const { prefs: typography } = useTypography();

// The terminal is one more code surface: a point over Typography's code size,
// in the code face. xterm takes both as options rather than CSS, so they're
// read off the root — after the typography layer has painted it.
function monoFamily(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  );
}
function codeSize(): number {
  return typography.value.sizeCode + 1;
}

// ── Theme ────────────────────────────────────────────────────────────────────
// The terminal is NOT hardcoded dark. The 16-colour ANSI set comes from the
// active theme's `extras` (one table per scheme), and foreground / background /
// cursor / selection are read live from the terminal roles (--term-ink,
// --term-bg, --term-cursor, --term-selection) so a theme's designed terminal
// comes through as-is. The theme is rebuilt when the resolved scheme flips.

type ColorResolver = {
  resolve: (expr: string, fallback: string) => string;
  dispose: () => void;
};

/** Resolve a CSS colour expression (a token ref or color-mix) to a concrete
 *  rgb()/rgba() string xterm accepts, by reading it back off a probe element —
 *  this handles var(), color-mix(), and the active theme automatically. */
function makeResolver(): ColorResolver {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  return {
    resolve(expr, fallback) {
      probe.style.color = "";
      probe.style.color = expr;
      const value = getComputedStyle(probe).color;
      return value || fallback;
    },
    dispose() {
      probe.remove();
    },
  };
}

function buildTheme(): ITheme {
  const dark = scheme.value === "dark";
  const ansi = extras.value.ansi;
  const r = makeResolver();
  const theme: ITheme = {
    background: r.resolve("var(--term-bg)", dark ? "#000000" : "#ffffff"),
    foreground: r.resolve("var(--term-ink)", dark ? "#ffffff" : "#000000"),
    cursor: r.resolve("var(--term-cursor)", dark ? "#ffffff" : "#000000"),
    cursorAccent: r.resolve("var(--term-bg)", dark ? "#000000" : "#ffffff"),
    selectionBackground: r.resolve(
      "var(--term-selection)",
      dark ? "rgba(255,255,255,0.24)" : "rgba(0,0,0,0.24)",
    ),
    ...ansi,
  };
  r.dispose();
  return theme;
}

/** Fit to the container, but only once it actually has a size, and clamp the
 *  result — a fit before fonts/layout settle can otherwise produce a wild
 *  value. View fit is immediate (cheap, local); the backend PTY resize is
 *  debounced below so a window drag doesn't re-spawn the PTY per pixel. */
function fitSafely(): void {
  if (!term || !fitAddon || !container.value) return;
  const { clientWidth, clientHeight } = container.value;
  if (clientWidth <= 0 || clientHeight <= 0) return;
  try {
    fitAddon.fit();
  } catch {
    return;
  }
  scheduleBackendResize();
}

/** Backend PTY resizes are debounced: each one is an IPC round-trip plus a
 *  SIGWINCH + shell reflow, so a live window drag would otherwise storm the
 *  main process. 120ms is below a perceptible reflow lag but coalesces a
 *  drag's burst of frames into a handful of resizes. */
let backendResizeTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBackendResize(): void {
  if (!term) return;
  if (backendResizeTimer) clearTimeout(backendResizeTimer);
  backendResizeTimer = setTimeout(() => {
    backendResizeTimer = null;
    if (!term) return;
    const cols = Math.max(2, Math.min(1000, term.cols));
    const rows = Math.max(1, Math.min(500, term.rows));
    emit("resize", cols, rows);
  }, 120);
}

// Rebuild the terminal theme when the resolved scheme flips. Guarded: before
// the terminal exists (or after it's disposed) there's nothing to re-theme.
watch(scheme, () => {
  if (term) term.options.theme = buildTheme();
});

// A face or size change reaches an open terminal too: new metrics, then a
// refit so the grid and the shell's idea of it agree again.
watch(
  () => [typography.value.mono, typography.value.sizeCode] as const,
  () => {
    if (!term) return;
    term.options.fontFamily = monoFamily();
    term.options.fontSize = codeSize();
    fitSafely();
  },
  { flush: "post" },
);

onMounted(() => {
  if (!container.value) return;

  term = new Terminal({
    fontFamily: monoFamily(),
    fontSize: codeSize(),
    lineHeight: 1.2,
    fontWeight: 400,
    fontWeightBold: 600,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 1,
    theme: buildTheme(),
    scrollback: 10000,
    // Opaque background (matched to the app ground) keeps glyph edges crisp —
    // a transparent background otherwise renders as black on the DOM renderer.
    allowTransparency: false,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container.value);

  term.onData((data) => emit("write", data));

  // Fit once layout settles (double rAF: lay out, then measure), then attach the
  // live sink so replay wraps at the real width. The composable owns replay.
  // WebGL loads idle (not mid-paint) and only when visible.
  const onVisibility = (visible: boolean): void => {
    if (!term) return;
    if (visible) loadWebgl();
    else parkWebgl();
  };
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!term) return;
      fitSafely();
      detachSink = props.session.attach({
        write: (data) => term?.write(data),
        reset: () => term?.reset(),
      });
      maybeShowExitNotice(props.session.status);
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => loadWebgl());
      } else {
        setTimeout(() => loadWebgl(), 0);
      }
    }),
  );

  // Park the GPU context while the pane is off-screen; reload on return.
  if ("IntersectionObserver" in window && container.value) {
    visibilityObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) onVisibility(entry.isIntersecting);
      },
      { threshold: 0 },
    );
    visibilityObserver.observe(container.value);
  }

  useResizeObserver(container, () => fitSafely());
});

/** Load the WebGL renderer for crisp text (once the container is sized and
 *  visible). Lazy + visibility-gated: on Linux/software GL a hidden terminal
 *  must not hold a GPU context, and an eager load during first paint competes
 *  with hydration. If the GPU context is unavailable or later lost, dispose it
 *  and let xterm fall back to the DOM renderer. */
/** Page-cached WebGL2 availability: one throwaway context per page, not one
 *  per show/hide cycle. */
let webglAvailable: boolean | null = null;
function isWebglAvailable(): boolean {
  if (webglAvailable !== null) return webglAvailable;
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (!gl) {
      webglAvailable = false;
      return false;
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    probe.remove();
  } catch {
    webglAvailable = false;
    return false;
  }
  webglAvailable = true;
  return true;
}

function loadWebgl(): void {
  if (!term || webgl || !container.value) return;
  // Hidden tab/panel: skip — the IntersectionObserver below retries on show.
  if (container.value.clientWidth <= 0 || container.value.clientHeight <= 0) return;
  if (typeof document !== "undefined" && document.hidden) return;
  // Probe before paying for the addon: no WebGL2 (headless/software GL) means
  // the DOM renderer stays, with no context to create and lose.
  if (!isWebglAvailable()) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      webgl = null;
    });
    term.loadAddon(addon);
    webgl = addon;
  } catch {
    // No WebGL (headless/software GL) — the DOM renderer stays.
  }
}

/** Drop the WebGL context while hidden so background terminals hold no GPU
 *  resources; re-created on next show via loadWebgl(). */
function parkWebgl(): void {
  try {
    webgl?.dispose();
  } catch {
    // Disposal is best-effort; the DOM renderer continues regardless.
  }
  webgl = null;
}

/** Once, when the PTY exits/errors, print a dim closing line so a dead shell
 *  reads as intentional rather than frozen. */
function maybeShowExitNotice(status: TerminalSession["status"]): void {
  if (noticeShown || !term) return;
  if (status === "exited") {
    noticeShown = true;
    term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
  } else if (status === "error") {
    noticeShown = true;
    term.write("\r\n\x1b[31m[terminal error]\x1b[0m\r\n");
  }
}

watch(() => props.session.status, (status) => maybeShowExitNotice(status));

onBeforeUnmount(() => {
  detachSink?.();
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  if (backendResizeTimer) clearTimeout(backendResizeTimer);
  backendResizeTimer = null;
  webgl?.dispose();
  fitAddon?.dispose();
  term?.dispose();
  term = null;
  fitAddon = null;
  webgl = null;
});
</script>

<template>
  <div class="terminal-pane" ref="container" />
</template>

<style scoped>
.terminal-pane {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.terminal-pane :deep(.xterm) {
  height: 100%;
  padding: 0;
}
/* Invisible scrollbars, matching the rest of kone. */
.terminal-pane :deep(.xterm-viewport) {
  scrollbar-width: none;
  background-color: transparent !important;
}
.terminal-pane :deep(.xterm-viewport::-webkit-scrollbar) {
  width: 0;
  height: 0;
}
</style>

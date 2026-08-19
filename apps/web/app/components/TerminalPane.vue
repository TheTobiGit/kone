<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { useResizeObserver } from "@vueuse/core";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "~/composables/useTheme";
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
const { scheme, extras } = useTheme();

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
 */
function fitSafely(): void {
  if (!term || !fitAddon || !container.value) return;
  const { clientWidth, clientHeight } = container.value;
  if (clientWidth <= 0 || clientHeight <= 0) return;
  try {
    fitAddon.fit();
  } catch {
    return;
  }
  const cols = Math.max(2, Math.min(1000, term.cols));
  const rows = Math.max(1, Math.min(500, term.rows));
  emit("resize", cols, rows);
}

// Rebuild the terminal theme when the resolved scheme flips. Guarded: before
// the terminal exists (or after it's disposed) there's nothing to re-theme.
watch(scheme, () => {
  if (term) term.options.theme = buildTheme();
});

onMounted(() => {
  if (!container.value) return;

  // The app's mono token (SF Mono on macOS), so the terminal matches kone's
  // other monospaced surfaces.
  const fontFamily =
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  term = new Terminal({
    fontFamily,
    fontSize: 13,
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
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!term) return;
      fitSafely();
      loadWebgl();
      detachSink = props.session.attach({
        write: (data) => term?.write(data),
        reset: () => term?.reset(),
      });
      maybeShowExitNotice(props.session.status);
    }),
  );

  useResizeObserver(container, () => fitSafely());
});

/** Load the WebGL renderer for crisp text (once the container is sized). If the
 *  GPU context is unavailable or later lost, dispose it and let xterm fall back
 *  to the DOM renderer. */
function loadWebgl(): void {
  if (!term || webgl) return;
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

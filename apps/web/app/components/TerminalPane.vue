<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { useResizeObserver } from "@vueuse/core";
import "@xterm/xterm/css/xterm.css";
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
let darkQuery: MediaQueryList | null = null;
let onSchemeChange: (() => void) | null = null;

// ── Theme ────────────────────────────────────────────────────────────────────
// The terminal is NOT hardcoded dark. Foreground /
// background / cursor / selection are read live from kone's design tokens
// (--ground, --ink, --accent) so the terminal reads correctly in both light and
// dark, and the ANSI-16 palette is a calm, kone-tinted set chosen per scheme
// (diff-add/diff-del for green/red, muted blues/purples). Rebuilt when the OS
// colour-scheme flips.

// ANSI palettes tuned to sit calmly on kone's grounds (#f6f5f3 / #070708).
const ANSI_DARK = {
  black: "#3b3b42", red: "#f2726f", green: "#4ec9a6", yellow: "#e5b567",
  blue: "#7aa2f7", magenta: "#c9a2f0", cyan: "#6bd6c6", white: "#d4d4d8",
  brightBlack: "#5b5b63", brightRed: "#ff8f8b", brightGreen: "#79e3c0",
  brightYellow: "#f2cd88", brightBlue: "#9cb8ff", brightMagenta: "#dcb8ff",
  brightCyan: "#8ce8da", brightWhite: "#ffffff",
};
const ANSI_LIGHT = {
  black: "#3f3f46", red: "#c81e3a", green: "#0f8a5f", yellow: "#b45309",
  blue: "#2563eb", magenta: "#9333ea", cyan: "#0e7490", white: "#52525b",
  brightBlack: "#71717a", brightRed: "#e11d48", brightGreen: "#059669",
  brightYellow: "#d97706", brightBlue: "#3b82f6", brightMagenta: "#a855f7",
  brightCyan: "#0891b2", brightWhite: "#27272a",
};

/** Resolve a CSS colour expression (a token ref or color-mix) to a concrete
 *  rgb()/rgba() string xterm accepts, by reading it back off a probe element —
 *  this handles var(), color-mix(), and the active theme automatically. */
function makeResolver(): { resolve: (expr: string, fallback: string) => string; dispose: () => void } {
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
  const dark = !!darkQuery?.matches;
  const ansi = dark ? ANSI_DARK : ANSI_LIGHT;
  const r = makeResolver();
  const theme: ITheme = {
    background: r.resolve("var(--ground)", dark ? "#070708" : "#f6f5f3"),
    foreground: r.resolve("var(--ink)", dark ? "#f4f4f5" : "#27272a"),
    cursor: r.resolve("var(--accent)", "#d97757"),
    cursorAccent: r.resolve("var(--ground)", dark ? "#070708" : "#f6f5f3"),
    selectionBackground: r.resolve(
      "color-mix(in oklab, var(--accent) 24%, transparent)",
      "rgba(217,119,87,0.24)",
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

onMounted(() => {
  if (!container.value) return;

  darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

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

  // Rebuild the theme when the OS light/dark preference flips.
  onSchemeChange = () => {
    if (term) term.options.theme = buildTheme();
  };
  darkQuery.addEventListener("change", onSchemeChange);

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
  if (darkQuery && onSchemeChange) darkQuery.removeEventListener("change", onSchemeChange);
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

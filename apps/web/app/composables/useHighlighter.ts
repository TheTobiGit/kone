import { useTheme } from "~/composables/useTheme";
import { bundledLanguages, bundledThemes } from "shiki";
import type { BundledLanguage, BundledTheme, Highlighter, ThemedToken } from "shiki";

// Syntax highlighting for the file-detail preview, using Shiki with TextMate
// grammars. The active theme's `extras` names the Shiki theme (one per scheme),
// so syntax colours track the app's appearance the way the terminal's ANSI set
// does.
//
// One highlighter is created for the whole app (module-level singleton): making
// it loads the WASM engine once. Themes and grammars load on demand (the
// current scheme's syntax theme first), and `warm()` preloads the grammars a
// project's changes need the moment it opens, so the first file a user clicks
// paints instantly instead of loading on demand.

// Extension → Shiki language id. Anything unmapped is plaintext (one default-
// coloured token per line), so an unknown file still renders cleanly.
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  vue: "vue", css: "css", scss: "scss", sass: "sass", less: "less",
  html: "html", json: "json", jsonc: "jsonc", md: "markdown", mdx: "mdx",
  py: "python", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin",
  swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", php: "php", sh: "shellscript", bash: "shellscript",
  zsh: "shellscript", sql: "sql", yml: "yaml", yaml: "yaml", toml: "toml",
  xml: "xml", svg: "xml",
};

// Past this the file stays plain — highlighting a huge blob would jank the open.
const MAX_HIGHLIGHT = 150_000;

// Live-stream throttling for code inside an agent reply: short snippets re-tint
// quickly as chunks land, while very large blocks cost real time per pass and
// so update progressively less often. Linear from FAST at LIGHT up to SLOW at
// MAX_HIGHLIGHT (the point where highlighting gives up entirely).
const THROTTLE_FAST_MS = 40;
const THROTTLE_SLOW_MS = 240;
const THROTTLE_LIGHT_AT = 8_000;
/** Interval between highlight passes for a code block of `codeLength` chars
 *  while it is still streaming. */
export function highlightThrottleMs(codeLength: number): number {
  if (codeLength <= THROTTLE_LIGHT_AT) return THROTTLE_FAST_MS;
  const t = Math.min(1, (codeLength - THROTTLE_LIGHT_AT) / (MAX_HIGHLIGHT - THROTTLE_LIGHT_AT));
  return Math.round(THROTTLE_FAST_MS + t * (THROTTLE_SLOW_MS - THROTTLE_FAST_MS));
}

export type CodeLine = ThemedToken[];

// ── singleton state (shared across every useHighlighter() call) ────────────────
let highlighterPromise: Promise<Highlighter> | null = null;
const failed = new Set<string>(); // grammars that wouldn't load — don't retry
const inflight = new Map<string, Promise<void>>(); // in-progress grammar loads

// Shiki's loaders take literal union ids, but the names we hold are free-form
// strings from file extensions and fence info strings. Resolving against the
// shipped catalogue turns a bad name into plain data ("skip it") instead of a
// thrown error.
const BUNDLED_LANG_IDS: ReadonlySet<string> = new Set(Object.keys(bundledLanguages));
const BUNDLED_THEME_IDS: ReadonlySet<string> = new Set(Object.keys(bundledThemes));

function isBundledLang(lang: string): lang is BundledLanguage {
  return BUNDLED_LANG_IDS.has(lang);
}

function isBundledTheme(theme: string): theme is BundledTheme {
  return BUNDLED_THEME_IDS.has(theme);
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({ themes: [], langs: [] }),
    );
  }
  return highlighterPromise;
}

/** Make sure `theme` (the active scheme's syntax name) is loaded, so
 *  `codeToTokens` can colour with it. Skips once loaded; false when the name
 *  can't be resolved to a theme Shiki ships. */
async function ensureTheme(hl: Highlighter, theme: string): Promise<boolean> {
  if (hl.getLoadedThemes().includes(theme)) return true;
  if (!isBundledTheme(theme)) return false;
  try {
    await hl.loadTheme(theme);
    return true;
  } catch {
    return false;
  }
}

function langFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

// A fenced code block carries a free-form info string — ```ts, ```sh, ```jsonc,
// ```zsh — not an extension. Resolve those aliases to a Shiki language id. The
// extension map already covers most of them; this layer adds the id-style names
// and shell/misc aliases people actually type in fences.
const LANG_ALIAS: Record<string, string> = {
  ts: "typescript", typescript: "typescript",
  js: "javascript", javascript: "javascript", node: "javascript",
  jsx: "jsx", tsx: "tsx",
  sh: "shellscript", shell: "shellscript", bash: "shellscript",
  zsh: "shellscript", console: "shellscript", shellsession: "shellscript",
  py: "python", python: "python", rb: "ruby", ruby: "ruby",
  yml: "yaml", yaml: "yaml", md: "markdown", markdown: "markdown",
  rs: "rust", rust: "rust", golang: "go", go: "go",
  "c++": "cpp", cpp: "cpp", "c#": "csharp", cs: "csharp", csharp: "csharp",
  kt: "kotlin", kotlin: "kotlin", objc: "objective-c",
  html: "html", vue: "vue", svg: "xml", xml: "xml",
  json: "json", jsonc: "jsonc", json5: "json5", toml: "toml",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto",
  dockerfile: "docker", docker: "docker", diff: "diff", patch: "diff",
  make: "make", makefile: "make", ini: "ini", env: "dotenv", dotenv: "dotenv",
  text: "plaintext", txt: "plaintext", plain: "plaintext", "": "plaintext",
};
function langForInfo(info: string): string {
  // The info string can be "ts title=foo" — take the first bareword.
  const id = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return LANG_ALIAS[id] ?? id ?? "plaintext";
}

/** Make sure `lang`'s grammar is loaded, de-duping concurrent loads. Returns the
 *  usable lang id — the original once loaded, or "plaintext" if it can't be. */
async function ensureLang(hl: Highlighter, lang: string): Promise<string> {
  if (lang === "plaintext") return "plaintext";
  if (hl.getLoadedLanguages().includes(lang)) return lang;
  if (failed.has(lang)) return "plaintext";
  if (!isBundledLang(lang)) {
    void failed.add(lang);
    return "plaintext";
  }
  let load = inflight.get(lang);
  if (!load) {
    load = hl.loadLanguage(lang).then(
      () => {},
      () => void failed.add(lang),
    );
    inflight.set(lang, load);
  }
  await load;
  inflight.delete(lang);
  return failed.has(lang) ? "plaintext" : lang;
}

export function useHighlighter() {
  const { extras } = useTheme();

  /** Preload the current scheme's syntax theme plus the grammars a set of
   *  files will need (and the engine), so opening any of them later is
   *  instant. Safe to call repeatedly — already loaded / failed grammars are
   *  skipped. */
  async function warm(paths: string[]): Promise<void> {
    if (import.meta.server) return;
    const hl = await getHighlighter();
    await ensureTheme(hl, extras.value.syntax);
    const langs = new Set<string>();
    for (const p of paths) {
      const l = langFor(p);
      if (l !== "plaintext") langs.add(l);
    }
    await Promise.all([...langs].map((l) => ensureLang(hl, l)));
  }

  /** Tokenize `code` for `path` in the active scheme's syntax theme, or null to
   *  fall back to plain text (server render, oversize file, or an unknown
   *  grammar). `_dark` is retained for the existing callers; the theme name is
   *  always taken from the theme system's resolved scheme. */
  async function highlight(
    code: string,
    path: string,
    _dark: boolean,
  ): Promise<CodeLine[] | null> {
    if (import.meta.server || code.length > MAX_HIGHLIGHT) return null;
    try {
      const hl = await getHighlighter();
      if (!(await ensureTheme(hl, extras.value.syntax))) return null;
      const lang = await ensureLang(hl, langFor(path));
      if (!isBundledLang(lang)) return null;
      const { tokens } = hl.codeToTokens(code, {
        lang,
        theme: extras.value.syntax,
      });
      return tokens;
    } catch {
      return null;
    }
  }

  /** Like `highlight`, but keyed off a fenced block's info string (```ts) rather
   *  than a file path — for code inside an agent's Markdown reply. Also returns
   *  the resolved Shiki language id so the block can label itself. */
  async function highlightCode(
    code: string,
    info: string,
    _dark: boolean,
  ): Promise<{ lines: CodeLine[] | null; lang: string }> {
    const resolved = langForInfo(info);
    if (import.meta.server || code.length > MAX_HIGHLIGHT) return { lines: null, lang: resolved };
    try {
      const hl = await getHighlighter();
      if (!(await ensureTheme(hl, extras.value.syntax))) return { lines: null, lang: resolved };
      const lang = await ensureLang(hl, resolved);
      if (!isBundledLang(lang)) return { lines: null, lang: resolved };
      const { tokens } = hl.codeToTokens(code, {
        lang,
        theme: extras.value.syntax,
      });
      return { lines: tokens, lang: resolved };
    } catch {
      return { lines: null, lang: resolved };
    }
  }

  return { warm, highlight, highlightCode };
}

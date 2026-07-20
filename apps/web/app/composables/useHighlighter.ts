import type { BundledLanguage, Highlighter, ThemedToken } from "shiki";

// Syntax highlighting for the file-detail preview, using Shiki with VSCode's own
// default themes (light-plus / dark-plus) and TextMate grammars — so the colours
// read exactly like VSCode.
//
// One highlighter is created for the whole app (module-level singleton): making
// it loads the WASM engine and both themes once. Grammars load per language, and
// `warm()` preloads the ones a project's changes need the moment it opens, so the
// first file a user clicks paints instantly instead of loading on demand.

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

/** One code line as coloured tokens. */
export type CodeLine = ThemedToken[];

// ── singleton state (shared across every useHighlighter() call) ────────────────
let highlighterPromise: Promise<Highlighter> | null = null;
const failed = new Set<string>(); // grammars that wouldn't load — don't retry
const inflight = new Map<string, Promise<void>>(); // in-progress grammar loads

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({ themes: ["light-plus", "dark-plus"], langs: [] }),
    );
  }
  return highlighterPromise;
}

function langFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

/** Make sure `lang`'s grammar is loaded, de-duping concurrent loads. Returns the
 *  usable lang id — the original once loaded, or "plaintext" if it can't be. */
async function ensureLang(hl: Highlighter, lang: string): Promise<string> {
  if (lang === "plaintext") return "plaintext";
  if (hl.getLoadedLanguages().includes(lang)) return lang;
  if (failed.has(lang)) return "plaintext";
  let load = inflight.get(lang);
  if (!load) {
    load = hl.loadLanguage(lang as BundledLanguage).then(
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
  /** Preload the grammars a set of files will need (plus the engine + themes),
   *  so opening any of them later is instant. Safe to call repeatedly — already
   *  loaded / failed grammars are skipped. */
  async function warm(paths: string[]): Promise<void> {
    if (import.meta.server) return;
    const hl = await getHighlighter();
    const langs = new Set<string>();
    for (const p of paths) {
      const l = langFor(p);
      if (l !== "plaintext") langs.add(l);
    }
    await Promise.all([...langs].map((l) => ensureLang(hl, l)));
  }

  /** Tokenize `code` for `path` in the given theme, or null to fall back to
   *  plain text (server render, oversize file, or an unknown grammar). */
  async function highlight(
    code: string,
    path: string,
    dark: boolean,
  ): Promise<CodeLine[] | null> {
    if (import.meta.server || code.length > MAX_HIGHLIGHT) return null;
    try {
      const hl = await getHighlighter();
      const lang = await ensureLang(hl, langFor(path));
      const { tokens } = hl.codeToTokens(code, {
        lang: lang as BundledLanguage,
        theme: dark ? "dark-plus" : "light-plus",
      });
      return tokens;
    } catch {
      return null;
    }
  }

  return { warm, highlight };
}

// Single source of truth for the little coloured chip that heads each change /
// folder-paper card. Resolve a path to a language, and a language to its badge —
// one curated entry per common language (a brand-ish colour + a 1–3 char mark),
// with a neutral fallback so an unrecognized file still reads as a plain file
// rather than everything defaulting to "TS". Vue is drawn as its logo in the
// components, so its `label` here is only a fallback.

export type FileLang =
  | "ts"
  | "js"
  | "vue"
  | "md"
  | "json"
  | "css"
  | "html"
  | "yaml"
  | "shell"
  | "py"
  | "rust"
  | "go"
  | "file";

export interface LangBadge {
  /** 1–3 char mark shown in the chip. */
  label: string;
  bg: string;
  fg: string;
}

// Extension → language; aliases collapse onto one canonical lang.
const EXT_LANG: Record<string, FileLang> = {
  ts: "ts", mts: "ts", cts: "ts", tsx: "ts",
  js: "js", mjs: "js", cjs: "js", jsx: "js",
  vue: "vue",
  md: "md", mdx: "md", markdown: "md",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", sass: "css", less: "css", pcss: "css",
  html: "html", htm: "html",
  yml: "yaml", yaml: "yaml",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  py: "py", pyi: "py",
  rs: "rust",
  go: "go",
};

const BADGE: Record<FileLang, LangBadge> = {
  ts:    { label: "TS",  bg: "#3178c6", fg: "#ffffff" },
  js:    { label: "JS",  bg: "#f7df1e", fg: "#1a1a1a" },
  vue:   { label: "VUE", bg: "#41b883", fg: "#ffffff" },
  md:    { label: "MD",  bg: "#64748b", fg: "#ffffff" },
  json:  { label: "{}",  bg: "#c99a3f", fg: "#1a1a1a" },
  css:   { label: "CSS", bg: "#1572b6", fg: "#ffffff" },
  html:  { label: "<>",  bg: "#e34f26", fg: "#ffffff" },
  yaml:  { label: "YML", bg: "#cb171e", fg: "#ffffff" },
  shell: { label: "SH",  bg: "#4eaa25", fg: "#ffffff" },
  py:    { label: "PY",  bg: "#3776ab", fg: "#ffffff" },
  rust:  { label: "RS",  bg: "#dea584", fg: "#1a1a1a" },
  go:    { label: "GO",  bg: "#00add8", fg: "#ffffff" },
  file:  { label: "•",   bg: "#9ca3af", fg: "#ffffff" },
};

/** Lowercased extension of a path (no dot), or "" when there is none. Leading-
 *  dot names like `.gitignore` have no extension — they read as plain files. */
function extOf(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Best-guess language for a path, by extension. Unknown → "file". */
export function langOf(path: string): FileLang {
  return EXT_LANG[extOf(path)] ?? "file";
}

/** The badge (mark + colours) for a language. */
export function badgeFor(lang: FileLang): LangBadge {
  return BADGE[lang];
}

// ── real file-type logos (VS Code icon set) ──────────────────────────────────
// The curated chips above are our own; this is the alternative: the actual
// VS Code file icons, resolved automatically from the filename. `vscode-icons-js`
// carries the extension/filename → icon mapping (hundreds of types, incl.
// Dockerfile, lockfiles, dotfiles), and the matching SVGs ship offline via the
// `@iconify-json/vscode-icons` collection (registered in a client plugin), so
// nothing is fetched at runtime. Names differ between the two — vscode-icons-js
// returns `file_type_typescript.svg`, Iconify wants `file-type-typescript` — so
// we normalize across.

// Named import: the package is CJS with named exports and no default — a bare
// default import resolves to `undefined` under Vite (it honours `__esModule`).
import { getIconForFile } from "vscode-icons-js";

// vscode-icons-js resolves a filename to an icon *name*; the SVGs ship in the
// Iconify `vscode-icons` set. The two occasionally disagree, and vscode-icons-js
// leaves (or mislabels) some brand files — a few small maps close the gap.

// A resolved name the offline set spells differently (would otherwise render
// blank). Keep in sync with what the set actually ships.
const NAME_FIXUPS: Record<string, string> = {
  "file-type-pdf": "file-type-pdf2",
};

// Curated brand overrides — these win over vscode-icons-js, correcting files it
// leaves generic (Dockerfile, Gemfile…) or labels blandly (Cargo.toml → TOML,
// turbo.json → JSON, .env → config). Exact filename first…
const BRAND_BY_NAME: Record<string, string> = {
  dockerfile: "file-type-docker",
  ".dockerignore": "file-type-docker",
  gemfile: "file-type-bundler",
  "gemfile.lock": "file-type-bundler",
  "cargo.toml": "file-type-cargo",
  "cargo.lock": "file-type-cargo",
  "bun.lock": "file-type-bun",
  "bun.lockb": "file-type-bun",
  "poetry.lock": "file-type-poetry",
  "requirements.txt": "file-type-pip",
  "turbo.json": "file-type-turbo",
  "svelte.config.js": "file-type-svelte",
  license: "file-type-license",
};
// …then by extension.
const BRAND_BY_EXT: Record<string, string> = {
  graphql: "file-type-graphql",
  gql: "file-type-graphql",
  proto: "file-type-protobuf",
};

/** A curated brand override for a filename, or undefined to defer to vscode-icons-js. */
function brandOverride(lower: string): string | undefined {
  if (lower in BRAND_BY_NAME) return BRAND_BY_NAME[lower];
  // Every `.env` flavour (.env.local, .env.production…) reads as one dotenv icon.
  if (lower.startsWith(".env")) return "file-type-dotenv";
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  return BRAND_BY_EXT[ext];
}

/** Iconify icon id (e.g. `vscode-icons:file-type-typescript`) for a path's file
 *  type — the real VS Code logo. Unknown types resolve to the generic file. */
export function iconForFile(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? path;
  const override = brandOverride(base.toLowerCase());
  if (override) return `vscode-icons:${override}`;
  const raw = getIconForFile(base) ?? "default_file.svg";
  const name = raw.replace(/\.svg$/, "").replace(/_/g, "-");
  return `vscode-icons:${NAME_FIXUPS[name] ?? name}`;
}

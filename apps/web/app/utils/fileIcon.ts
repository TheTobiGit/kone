// Resolve a file path to its real VS Code file-type logo. `vscode-icons-js`
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

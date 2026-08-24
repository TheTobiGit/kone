// FILE: frontmatter.ts
// Purpose: a dependency-free YAML-frontmatter SCALAR parser for SKILL.md
// files. Deliberately not a general YAML parser — Agent Skills frontmatter is
// just `---`-delimited `key: value` lines (docs/skills-mcp-research.md §3),
// so pulling in a YAML dependency for this would be adding a package to parse
// six known field names. Modeled on the technique in
// minus its boolean coercion — every value here comes back as a plain
// string; callers coerce/compare what they need.
// Exports: parseFrontmatter

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/** Parses the `---`-delimited frontmatter block at the top of a markdown file
 *  into a flat string map. A file with no frontmatter block returns `{}`.
 *
 *  A line is split only on its FIRST colon, so Claude-style unquoted values
 *  that themselves contain a colon — e.g.
 *  `description: Use this when doing X: run the Y step` — keep everything
 *  after the field name intact instead of truncating at the inner colon. */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = FRONTMATTER_PATTERN.exec(normalized);
  if (!match) return {};

  const record: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) continue;

    record[key] = stripSurroundingQuotes(value);
  }
  return record;
}

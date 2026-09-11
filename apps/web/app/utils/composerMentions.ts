import type { GitProjectFile } from "~/types/desktop";

export type FileMentionTrigger = {
  query: string;
  rangeStart: number;
  rangeEnd: number;
};

/** What a chip names: a document in the project, or a project itself. */
export type MentionKind = "file" | "project";

/** A project the @ picker may name — recents in the assistant modal, where
 *  there is no project on disk to search for files. */
export type MentionProject = { path: string; name: string };

/** One @ picker row. Projects lead files — the ordering lives in
 *  buildMentionItems below and nowhere else, so the composable and the menu
 *  never do index arithmetic to bridge two lists. */
export type MentionItem =
  | { kind: "project"; path: string; name: string; detail: string }
  | { kind: "file"; path: string; name: string; detail: string };

/** Dedupe project rows by path, first wins, order kept. The assistant offers
 *  the open project plus recents, which overlap — without this the picker
 *  would list the same project twice and the kind resolver would still agree
 *  with itself, just noisily. */
export function dedupeMentionProjects(projects: readonly MentionProject[]): MentionProject[] {
  const seen = new Set<string>();
  const out: MentionProject[] = [];
  for (const p of projects) {
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    out.push(p);
  }
  return out;
}

/** Set-backed kind lookup for restored @path chips. Drafts persist as text,
 *  so a path re-entering the field would otherwise always come back a file
 *  chip — paths offered as projects answer "project". Built once per project
 *  list so restores stay O(1) instead of scanning on every chip. */
export function createMentionKindResolver(
  projects: readonly MentionProject[],
): (path: string) => MentionKind {
  const paths = new Set<string>();
  for (const p of projects) paths.add(p.path);
  return (path: string): MentionKind => (paths.has(path) ? "project" : "file");
}

/** One keyboard list across both sections: projects first, then files. The
 *  menu renders this array verbatim — index N in the list is index N on the
 *  keyboard, with no offset to add or subtract on either side. */
export function buildMentionItems(
  projects: readonly MentionProject[],
  files: readonly GitProjectFile[],
): MentionItem[] {
  const items: MentionItem[] = [];
  for (const p of projects) items.push({ kind: "project", path: p.path, name: p.name, detail: p.path });
  for (const f of files) items.push({ kind: "file", path: f.path, name: f.name, detail: f.parent });
  return items;
}

export type ComposerMentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; path: string; source: string };

function isBoundary(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

/** Find the active `@...` token at a textarea cursor. The token stays open
 * while the user types, but only starts after whitespace so email addresses and
 * ordinary prose are not hijacked. */
export function detectFileMentionTrigger(
  text: string,
  cursorInput: number,
): FileMentionTrigger | null {
  const cursor = Math.max(0, Math.min(text.length, Math.floor(cursorInput)));
  let start = cursor - 1;
  while (start >= 0 && !isBoundary(text[start])) start -= 1;
  start += 1;

  const token = text.slice(start, cursor);
  if (!token.startsWith("@") || !isBoundary(text[start - 1])) return null;
  return { query: token.slice(1), rangeStart: start, rangeEnd: cursor };
}

/** Format a selected project path as a stable, editable mention token. */
export function formatFileMention(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^@/, "");
  if (!/[\s()@"'`$\\]/.test(normalized)) return `@${normalized}`;
  return `@"${normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** A `/...` token at the composer cursor — the slash-command trigger. Like the
 *  @ token it only starts after whitespace, so paths (`src/a/b`), urls
 *  (`https://…`) and `//` comments are never hijacked. */
export type SlashCommandTrigger = {
  query: string;
  rangeStart: number;
  rangeEnd: number;
};

/** Find the active `/...` token at a textarea cursor. The token stays open
 *  while the user types the command name; a space ends it, so `/model` matches
 *  but `/model foo` no longer does. */
export function detectSlashCommandTrigger(
  text: string,
  cursorInput: number,
): SlashCommandTrigger | null {
  const cursor = Math.max(0, Math.min(text.length, Math.floor(cursorInput)));
  let start = cursor - 1;
  while (start >= 0 && !isBoundary(text[start])) start -= 1;
  start += 1;

  const token = text.slice(start, cursor);
  if (!token.startsWith("/") || token.startsWith("//") || !isBoundary(text[start - 1])) {
    return null;
  }
  return { query: token.slice(1), rangeStart: start, rangeEnd: cursor };
}

/** A leading `/name focus…` draft — the send-time slash parse. Runs on the
 *  trimmed draft so `/compact focus` still reads after the menu has closed
 *  (the trigger ends at the space). The name folds to lowercase for the
 *  switch; the focus keeps its casing, trimmed. */
export type LeadingSlashCommand = {
  name: string;
  focus: string;
};

export function parseLeadingSlashCommand(text: string): LeadingSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const match = /^\/(\S+)(?:\s+(.*))?/.exec(trimmed);
  const raw = match?.[1] ?? "";
  if (!raw) return null;
  return { name: raw.toLowerCase(), focus: (match?.[2] ?? "").trim() };
}

/** One row in the composer's `/` picker. */
export type SlashCommandItem = {
  name: string;
  title: string;
  description: string;
};

/** Prefix-filter slash rows by the trigger query — the same first-wins,
 *  projects-first spirit as the mention list, reduced to one section. An empty
 *  query offers everything, so a bare `/` already names what it can do. */
export function filterSlashCommandItems(
  items: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) => item.name.toLowerCase().startsWith(q));
}

/** A composer buffer after a range replacement, plus the caret position that
 *  follows the inserted text. */
export type ComposerTextReplacement = {
  text: string;
  cursor: number;
};

export function replaceComposerTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): ComposerTextReplacement {
  const start = Math.max(0, Math.min(text.length, rangeStart));
  const end = Math.max(start, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  return { text: nextText, cursor: start + replacement.length };
}

// The quoted body is bounded rather than `*`. Unbounded, every `@"` with no
// closing quote makes the engine scan the rest of the text from each candidate
// for `[label](file)` links in composerInlineTokens. A cap makes each
// attempt constant-bounded. Only paths that need quoting are ever written by
// formatFileMention, and no real filesystem path approaches this: the longest
// component any common filesystem allows is 255 chars.
const MAX_QUOTED_MENTION_LENGTH = 512;
const COMPLETED_MENTION_REGEX = new RegExp(
  `(^|\\s)@(?:"((?:\\\\.|[^"\\\\]){0,${MAX_QUOTED_MENTION_LENGTH}})"|([^\\s@"]+))(?=\\s)`,
  "g",
);

/** Split completed @path tokens for the composer's visual layer. A trailing
 * delimiter is intentional: it prevents an in-progress token from turning
 * into a chip while the user is still typing. */
export function splitComposerMentionSegments(text: string): ComposerMentionSegment[] {
  if (!text) return [];

  const segments: ComposerMentionSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(COMPLETED_MENTION_REGEX)) {
    const prefix = match[1] ?? "";
    const matchStart = (match.index ?? 0) + prefix.length;
    const source = text.slice(matchStart, matchStart + match[0].length - prefix.length);
    if (matchStart > cursor) segments.push({ type: "text", text: text.slice(cursor, matchStart) });

    const quotedPath = match[2];
    const path = quotedPath === undefined
      ? (match[3] ?? "")
      : quotedPath.replace(/\\(["\\])/g, "$1");
    if (path) segments.push({ type: "mention", path, source });
    cursor = matchStart + source.length;
  }

  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  return segments;
}

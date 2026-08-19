export type FileMentionTrigger = {
  query: string;
  rangeStart: number;
  rangeEnd: number;
};

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

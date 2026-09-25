// Markdown that is still being written, made to render the way it will once it
// is finished — so the reply doesn't reshape itself under the reader as each
// chunk lands.
//
// A stream stops at arbitrary characters, and markdown-it renders exactly what
// it is given. Cut mid-construct, that means:
//
//   · a line that so far is only a block marker — `#`, `-`, `1.`, `>` — renders
//     as a stray paragraph, then snaps into a heading or a list a moment later
//     (a different size, a different indent: the lines below jump);
//   · an opened `**` or backtick renders as literal punctuation, and the words
//     after it shift sideways when the closer arrives and the marks vanish.
//
// So, for a live reply only: a trailing line that is nothing but a block marker
// is held back until it has content, and an unclosed inline mark in the last
// block is closed provisionally — the words read bold (or as code) from their
// first letter. A mark with nothing after it yet is held back instead, since
// closing it would render an empty pair. Inside an open code fence nothing is
// touched: the fence renders its body as code to the end, which is already
// the finished shape.

/** A line made only of a block marker, with no content after it yet. */
const BARE_BLOCK_MARKER = /(^|\n)[ \t]*(#{1,6}|[-*+]|\d{1,9}[.)]|>|\|)[ \t]*$/;
/** A fence opening line — backticks or tildes, optionally with an info string. */
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function insideOpenFence(src: string): boolean {
  let open: string | null = null;
  for (const line of src.split("\n")) {
    const m = FENCE_LINE.exec(line);
    if (!m) continue;
    const fence = m[1]!;
    if (open === null) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = null;
  }
  return open !== null;
}

function count(text: string, needle: RegExp): number {
  return text.match(needle)?.length ?? 0;
}

export function stabilizeStreamingMarkdown(src: string): string {
  if (!src || insideOpenFence(src)) return src;

  let out = src.replace(BARE_BLOCK_MARKER, "$1");

  // Only the block being written can have a mark still open.
  const blockStart = out.lastIndexOf("\n\n") + 1;
  const block = out.slice(blockStart);

  // Inline code first: inside it, asterisks are literal.
  if (count(block, /(?<!`)`(?!`)/g) % 2 === 1) {
    if (/`\s*$/.test(out)) return out.replace(/`\s*$/, "");
    return `${out}\``;
  }
  const outsideCode = block.replace(/`[^`]*`/g, "");
  if (count(outsideCode, /\*\*/g) % 2 === 1) {
    if (/\*\*\s*$/.test(out)) return out.replace(/\*\*\s*$/, "");
    return `${out.trimEnd()}**`;
  }
  return out;
}

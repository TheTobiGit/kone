import { diffWordsWithSpace } from "diff";
import type { GitFileDiff } from "~/types/desktop";
import type { CodeLine } from "~/composables/useHighlighter";

// Turns a parsed unified diff into rows the file-detail view renders: a single
// (unified) column, each line syntax-highlighted like the file itself, with
// add/del lines carrying word-level emphasis over the exact spans that changed.
//
// Highlighting keeps intra-hunk context: rather than colour each line alone
// (which mis-tokenises things like an unterminated string or a block comment),
// we reconstruct each hunk's old side (context + deletions) and new side
// (context + additions), tokenise each as a block, then map every diff line
// back to its tokenised line. Word emphasis pairs each deletion with the
// addition below it and diffs the two, so only the changed words light up.

/** One rendered span: coloured by syntax, optionally emphasised (the changed
 *  part of a changed line). */
export type DiffChunk = { text: string; color?: string; emph: boolean };

export type DiffRow =
  | { kind: "context" | "add" | "del"; oldNo: number | null; newNo: number | null; chunks: DiffChunk[] }
  /** A quiet break between non-adjacent hunks (skipped lines). */
  | { kind: "gap" };

// Plain single-token fallback when highlighting is unavailable (unknown grammar,
// oversize, SSR) — one uncoloured token per line.
function plainLines(text: string): CodeLine[] {
  return text.split("\n").map((l) => {
    // SAFETY: one whole-line token with an unset colour satisfies CodeLine's
    // per-line shape; plainLines runs only where highlighting produced nothing.
    return [{ content: l, color: undefined } as CodeLine[number]];
  });
}

// Split a tokenised line into chunks, breaking tokens where the emphasis mask
// flips so a changed span can be tinted mid-token. Indexing is UTF-16 to stay
// aligned with the token substrings (and the mask, built the same way).
function toChunks(tokens: CodeLine, mask: boolean[] | null): DiffChunk[] {
  const out: DiffChunk[] = [];
  let i = 0;
  for (const t of tokens) {
    if (!mask) {
      out.push({ text: t.content, color: t.color, emph: false });
      i += t.content.length;
      continue;
    }
    let buf = "";
    let bufEmph = false;
    let started = false;
    for (let k = 0; k < t.content.length; k++, i++) {
      const e = mask[i] ?? false;
      if (!started) {
        bufEmph = e;
        started = true;
      } else if (e !== bufEmph) {
        out.push({ text: buf, color: t.color, emph: bufEmph });
        buf = "";
        bufEmph = e;
      }
      buf += t.content[k];
    }
    if (buf) out.push({ text: buf, color: t.color, emph: bufEmph });
  }
  if (out.length === 0) out.push({ text: " ", emph: false });
  return out;
}

// Which UTF-16 units of each side of a deletion/addition pair fall inside a
// changed span — `del` for the old string, `add` for the new.
type WordMasks = { del: boolean[]; add: boolean[] };

// Word-level masks for a deletion/addition pair: which UTF-16 units of each side
// belong to a changed (added/removed) span. Whitespace is kept so code aligns.
function wordMasks(oldStr: string, newStr: string): WordMasks {
  const del: boolean[] = [];
  const add: boolean[] = [];
  for (const part of diffWordsWithSpace(oldStr, newStr)) {
    const n = part.value.length;
    if (part.added) for (let k = 0; k < n; k++) add.push(true);
    else if (part.removed) for (let k = 0; k < n; k++) del.push(true);
    else {
      for (let k = 0; k < n; k++) {
        del.push(false);
        add.push(false);
      }
    }
  }
  return { del, add };
}

export function useDiff() {
  const { highlight } = useHighlighter();

  /** Build the rows for a diff, or an empty list when there's nothing to show
   *  (no diff, binary, or no hunks) — callers just check `.length`. */
  async function buildRows(diff: GitFileDiff | null, dark: boolean): Promise<DiffRow[]> {
    if (!diff || diff.binary || diff.hunks.length === 0) return [];
    const rows: DiffRow[] = [];
    for (let h = 0; h < diff.hunks.length; h++) {
      const hunk = diff.hunks[h]!;
      if (h > 0) rows.push({ kind: "gap" });

      const oldSrc = hunk.lines.filter((l) => l.kind !== "add").map((l) => l.text).join("\n");
      const newSrc = hunk.lines.filter((l) => l.kind !== "del").map((l) => l.text).join("\n");
      const [oldHl, newHl] = await Promise.all([
        highlight(oldSrc, diff.path, dark),
        highlight(newSrc, diff.path, dark),
      ]);
      const oldTok = oldHl ?? plainLines(oldSrc);
      const newTok = newHl ?? plainLines(newSrc);

      // Pre-compute word masks: pair each run of deletions with the run of
      // additions that immediately follows, line by line.
      const masks = new Map<number, boolean[]>(); // line index → mask
      const lines = hunk.lines;
      for (let i = 0; i < lines.length; ) {
        if (lines[i]!.kind === "del") {
          let d = i;
          while (d < lines.length && lines[d]!.kind === "del") d++;
          let a = d;
          while (a < lines.length && lines[a]!.kind === "add") a++;
          const dels = d - i;
          const adds = a - d;
          const pairs = Math.min(dels, adds);
          for (let p = 0; p < pairs; p++) {
            const wm = wordMasks(lines[i + p]!.text, lines[d + p]!.text);
            masks.set(i + p, wm.del);
            masks.set(d + p, wm.add);
          }
          i = a;
        } else {
          i++;
        }
      }

      let oi = 0;
      let ni = 0;
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!;
        if (line.kind === "context") {
          rows.push({ kind: "context", oldNo: line.oldNo, newNo: line.newNo, chunks: toChunks(newTok[ni] ?? [], null) });
          oi++;
          ni++;
        } else if (line.kind === "del") {
          rows.push({ kind: "del", oldNo: line.oldNo, newNo: null, chunks: toChunks(oldTok[oi] ?? [], masks.get(li) ?? null) });
          oi++;
        } else {
          rows.push({ kind: "add", oldNo: null, newNo: line.newNo, chunks: toChunks(newTok[ni] ?? [], masks.get(li) ?? null) });
          ni++;
        }
      }
    }
    return rows;
  }

  return { buildRows };
}

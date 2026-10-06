export type DiffLine = {
  kind: "add" | "del" | "context" | "hunk";
  text: string;
  oldNo?: number;
  newNo?: number;
};

/** Only numbered hunks supply line numbers and diff statistics. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]); newNo = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      out.push({ kind: "hunk", text: line });
    } else if (line.startsWith("\\ No newline")) {
      continue;
    } else if (line.startsWith("+") && newLeft > 0) {
      out.push({ kind: "add", text: line.slice(1), newNo: newNo++ }); newLeft--;
    } else if (line.startsWith("-") && oldLeft > 0) {
      out.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ }); oldLeft--;
    } else if (line.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
      out.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      oldLeft--; newLeft--;
    } else if (/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |rename (from|to) )/.test(line)) {
      oldLeft = 0; newLeft = 0;
    } else if (line) {
      out.push({ kind: "context", text: line });
    }
  }
  return out;
}

export function diffStats(diff?: string) {
  let added = 0; let removed = 0;
  for (const line of parseUnifiedDiff(diff ?? "")) {
    if (line.kind === "add") added++;
    if (line.kind === "del") removed++;
  }
  return { added, removed };
}

type Edit = { op: "keep" | "del" | "add"; line: string };

/** Beyond this many changed lines the shortest edit script stops being worth
 *  its O(D²) memory; the pair reads as a whole-file replacement instead. */
const MAX_EDIT_DISTANCE = 2_000;

function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

/** Myers' shortest edit script between two line lists, or undefined when the
 *  distance passes MAX_EDIT_DISTANCE. */
function editScript(a: string[], b: string[]): Edit[] | undefined {
  const max = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= a.length && y >= b.length) return backtrack(trace, a, b, offset, d);
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, distance: number): Edit[] {
  const edits: Edit[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = distance; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ op: "keep", line: a[--x]! });
      y--;
    }
    if (down) edits.push({ op: "add", line: b[--y]! });
    else edits.push({ op: "del", line: a[--x]! });
  }
  while (x > 0 && y > 0) {
    edits.push({ op: "keep", line: a[--x]! });
    y--;
  }
  return edits.reverse();
}

/** A unified diff between two texts: numbered hunks with `context` lines
 *  around each change. A pair too different to diff cheaply reads as one
 *  hunk that removes every old line and adds every new one. Empty when the
 *  texts are equal. */
export function unifiedDiffFromTexts(before: string, after: string, context = 3): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const edits = editScript(a, b) ?? [
    ...a.map((line): Edit => ({ op: "del", line })),
    ...b.map((line): Edit => ({ op: "add", line })),
  ];
  const out: string[] = [];
  let i = 0;
  // Old/new line numbers (1-based) of the edit at index i.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let n = 1;
  for (const e of edits) {
    oldAt.push(o);
    newAt.push(n);
    if (e.op !== "add") o++;
    if (e.op !== "del") n++;
  }
  while (i < edits.length) {
    if (edits[i]!.op === "keep") { i++; continue; }
    let start = Math.max(0, i - context);
    let end = i;
    // Extend the hunk while the next change sits within 2×context of this one.
    for (;;) {
      while (end < edits.length && edits[end]!.op !== "keep") end++;
      let gap = end;
      while (gap < edits.length && edits[gap]!.op === "keep" && gap - end < 2 * context) gap++;
      if (gap < edits.length && edits[gap]!.op !== "keep") { end = gap; continue; }
      end = Math.min(edits.length, end + context);
      break;
    }
    const slice = edits.slice(start, end);
    const oldLines = slice.filter((e) => e.op !== "add").length;
    const newLines = slice.filter((e) => e.op !== "del").length;
    const oldStart = oldLines === 0 ? oldAt[start]! - 1 : oldAt[start]!;
    const newStart = newLines === 0 ? newAt[start]! - 1 : newAt[start]!;
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    for (const e of slice) out.push(`${e.op === "keep" ? " " : e.op === "del" ? "-" : "+"}${e.line}`);
    i = end;
    start = end;
  }
  return out.join("\n");
}

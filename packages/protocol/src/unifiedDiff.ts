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

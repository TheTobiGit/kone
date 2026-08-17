import { git } from "./core.js";

// The one place that knows the shape of `git diff --numstat`, because reading it
// correctly takes two things that have to agree: the `-z` on the command and the
// NUL split on the output. Assembling the argv at the call site makes it easy to
// leave the flag off, and the resulting breakage is silent — git C-quotes any
// path holding a non-ASCII byte, a quote or a backslash (`café.txt` comes back
// as `"caf\303\251.txt"`), so those paths quietly stop matching anything the
// caller looks them up against and the file reads as having changed no lines.

/** One `--numstat` record: a file's line delta, plus the path it came from when
 *  the entry is a rename or copy. Binary files report no counts, which reads as
 *  0/0 with `binary` set rather than NaN. */
export interface NumstatEntry {
  path: string;
  from?: string;
  added: number;
  removed: number;
  binary: boolean;
}

/** Parse `git diff --numstat -z` output.
 *
 *  A plain entry is a single record, `<added>\t<removed>\t<path>`. A rename or
 *  copy spans three: a head whose path slot is empty, then the from-path and the
 *  to-path as records of their own. Splitting on NUL rather than on newline is
 *  also what lets a path containing a newline survive intact. */
export function parseNumstat(out: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    const tab1 = record.indexOf("\t");
    const tab2 = tab1 < 0 ? -1 : record.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const addedRaw = record.slice(0, tab1);
    const removedRaw = record.slice(tab1 + 1, tab2);
    let filePath = record.slice(tab2 + 1);
    let from: string | undefined;
    if (filePath.length === 0) {
      from = fields[i + 1] ?? undefined;
      filePath = fields[i + 2] ?? "";
      i += 2;
    }
    if (!filePath) continue;
    const binary = addedRaw === "-" && removedRaw === "-";
    entries.push({
      path: filePath,
      ...(from !== undefined ? { from } : {}),
      added: binary ? 0 : Number(addedRaw) || 0,
      removed: binary ? 0 : Number(removedRaw) || 0,
      binary,
    });
  }
  return entries;
}

/** Run `git diff --numstat` over `args` — revisions, pathspecs, `--cached`,
 *  `--find-renames` — and parse what comes back. The flag and the parsing travel
 *  together so that no caller has to remember `-z`.
 *
 *  Ordinary two-tree diffs only. A combined diff (`-c` or `-m`, for a merge
 *  against all its parents at once) carries one pair of counts per parent
 *  instead of one, which the parser above would read as a path. Diff a merge
 *  against a single parent — `numstat(root, ["HEAD^", "HEAD"])` — rather than
 *  reaching for those flags. */
export async function numstat(
  root: string,
  args: string[],
): Promise<NumstatEntry[]> {
  return parseNumstat(await git(root, ["diff", "--numstat", "-z", ...args]));
}

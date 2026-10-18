// Reading the result bodies of the agent's code tools (edits, searches, shell
// commands) into the few facts a step can show without being opened: how much
// an edit changed and its first lines, which files a search landed in, how a
// test run came out. Every reader gives up quietly on a body it doesn't
// recognise, and the step falls back to its plain row.

export type DiffLine = { sign: "+" | "-"; text: string };
export type DiffSummary = { added: number; removed: number; preview: DiffLine[] };

export type SearchMatch = { line: number | null; text: string };
/** `count` is set when the search printed only a per-file tally (`path:N`). */
export type SearchFile = { path: string; matches: SearchMatch[]; count?: number };

/** How many matches a search found in a file, whether it listed them or counted them. */
export function matchCount(f: SearchFile): number {
  return f.count ?? f.matches.length;
}

export type TestTally = { passed: number; failed: number; skipped: number; time: string | null };

const PREVIEW_LINES = 3;

/** Some providers stream a call's input (a JSON object) into its body until it
 *  lands. A diff or a search never parses as one; a command's output can, so
 *  only the caller, which knows whether the call is still running, can tell. */
export function isToolInput(body: string | undefined): boolean {
  const text = body?.trim();
  if (!text?.startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(text);
    return value instanceof Object && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** A shell call's own input (`{"command": …}`), left as its body when the
 *  command finished without printing anything. Real stdout that happens to be
 *  JSON (`cat package.json`) has no top-level `command` string. */
export function isCommandInput(body: string | undefined): boolean {
  if (!isToolInput(body)) return false;
  const value: unknown = JSON.parse(body!.trim());
  return value instanceof Object && "command" in value && String(value.command) === value.command;
}

function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** An edit's diff — unified, or Claude's bare `+`/`-`/space hunk lines — as its
 *  size and its first changed lines. */
export function parseDiffSummary(detail: string | undefined): DiffSummary | null {
  // Only blank lines come off the ends: the first line's leading space is its
  // context marker (` - item` is an unchanged list item, not a removal).
  const body = detail?.replace(/^\s*\n|\n\s*$/g, "");
  if (!body || isToolInput(body)) return null;
  // Codex's whole-text fallback (`--- before` / `+++ after`) isn't a diff: its
  // lines say nothing about what changed, so it keeps the plain row. A one-sided
  // fallback (a created or deleted file) can look exactly like a bare hunk, so
  // the marker decides; a bare hunk whose first removed line is `-- before`
  // loses its trail, which is the rarer case.
  const unified = /^(diff --git |@@ )/m.test(body);
  if (/^(--- before|\+\+\+ after)\n/.test(body) && !unified) return null;
  // A bare hunk has no headers to skip: every line in it is content.
  let added = 0;
  let removed = 0;
  const preview: DiffLine[] = [];
  const lines = body.split("\n");
  // Lines still owed to the current `@@` hunk: inside one, every line is
  // content, even a `--- `/`+++ ` pair that would read as a file header.
  let oldLeft = 0;
  let newLeft = 0;
  for (const [i, line] of lines.entries()) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      continue;
    }
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (unified && !inHunk) {
      if (/^(diff --git |index [0-9a-f]+\.\.|@@ )/.test(line)) continue;
      // Outside a hunk, a file header is a `--- ` line followed by a `+++ `
      // one; a lone changed line starting `--` or `++` is still a change.
      if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) continue;
      if (line.startsWith("+++ ") && lines[i - 1]?.startsWith("--- ")) continue;
    }
    const sign = line[0];
    if (sign === "-") oldLeft--;
    else if (sign === "+") newLeft--;
    else if (sign === " " || line === "") {
      oldLeft--;
      newLeft--;
    }
    if (sign !== "+" && sign !== "-") continue;
    if (sign === "+") added++;
    else removed++;
    const text = line.slice(1).replace(/\s+$/, "");
    if (text && preview.length < PREVIEW_LINES) preview.push({ sign, text });
  }
  if (!added && !removed) return null;
  // Drop the indent the preview's lines share, so they start at the margin.
  const indent = Math.min(...preview.map((l) => /^\s*/.exec(l.text)![0].length));
  return { added, removed, preview: preview.map((l) => ({ ...l, text: l.text.slice(indent) })) };
}

/** A glob's result line: any path a filesystem allows (`Dockerfile`,
 *  `app/[id]/page.tsx`, `src/My Component.vue`), but not the summary or
 *  "nothing found" prose a tool prints around them. */
function isBarePath(line: string): boolean {
  if (!line || /^\s/.test(line) || /: |\t/.test(line) || /[.!?]$/.test(line)) return false;
  if (/^(?:(?:no|found|showing|searched)\b|\(|\d+\s+(?:files?|matches|results?)\b)/i.test(line)) return false;
  // A spaced line is a path when it has a directory or ends in an extension;
  // a lone word is a filename.
  return /[/\\]/.test(line) || !/\s/.test(line) || /\.[\w-]+$/.test(line);
}

/** A search's `file:line:text` results (or a glob's bare paths), grouped by file
 *  in the order the files first appear. */
export function parseSearchMatches(detail: string | undefined): SearchFile[] {
  const body = detail?.trim();
  if (!body || isToolInput(body)) return [];
  const files = new Map<string, SearchFile>();
  const fileOf = (path: string): SearchFile => {
    let f = files.get(path);
    if (!f) files.set(path, (f = { path, matches: [] }));
    return f;
  };
  // `rg --heading` prints a file's path once, then its `line:text` rows under it
  // until a blank line.
  let heading: SearchFile | null = null;
  const lines = body.split("\n").map((raw) => stripAnsi(raw).trimEnd());
  // Context rows can come before their file's first hit, so every hit's path
  // is known up front.
  const hitPaths = new Set(lines.map((l) => /^((?:[A-Za-z]:[\\/])?[^\s:][^:]*?):\d+:/.exec(l)?.[1]).filter((p) => p !== undefined));
  const clusterHasRow = (from: number): boolean => {
    for (let j = from - 1; j >= 0 && lines[j]; j--) if (/^\d+:/.test(lines[j]!)) return true;
    for (let j = from + 1; j < lines.length && lines[j]; j++) if (/^\d+:/.test(lines[j]!)) return true;
    return false;
  };
  for (const [i, line] of lines.entries()) {
    if (!line) {
      heading = null;
      continue;
    }
    // `-C` context: `--` between clusters, and `N-text` (or `path-N-text`
    // without headings) around the matches. Neither is a file or a match.
    if (line === "--") continue;
    // Under a heading, `N-text` is context only if the cluster has a match row;
    // a glob's list can hold a `2024-report.md` of its own.
    if (heading && /^\d+-/.test(line) && clusterHasRow(i)) continue;
    // Matched against the known paths, since a path can hold `-N-` itself.
    if ([...hitPaths].some((p) => line.startsWith(`${p}-`) && /^\d+-/.test(line.slice(p.length + 1)))) continue;
    const row = heading ? /^(\d+):(.*)$/.exec(line) : null;
    if (heading && row) {
      heading.matches.push({ line: Number(row[1]), text: row[2]!.trim() });
      continue;
    }
    // A Windows path's drive letter (`C:\\repo\\a.ts:12:…`) isn't the separator.
    const hit = /^((?:[A-Za-z]:[\\/])?[^\s:][^:]*?):(\d+):(.*)$/.exec(line);
    if (hit) {
      fileOf(hit[1]!).matches.push({ line: Number(hit[2]), text: hit[3]!.trim() });
      heading = null;
    } else if (isBarePath(line)) {
      // A count-mode search prints `path:N`: the path is the file, N its matches.
      const tally = /^(.*):(\d+)$/.exec(line);
      heading = fileOf(tally ? tally[1]! : line);
      if (tally) heading.count = (heading.count ?? 0) + Number(tally[2]);
    }
  }
  return [...files.values()];
}

/** A test run's tally, from whichever runner's summary is in the output. */
export function parseTestTally(output: string | undefined): TestTally | null {
  const body = output ? stripAnsi(output) : "";
  if (!body.trim()) return null;
  // Jest and Vitest print a suite or file line (`Test Suites:`, `Test Files`)
  // before their `Tests` line; the tests are the tally.
  // Cargo prints one `test result:` line per test binary (unit, integration,
  // doc), so the run's tally is all of them added up.
  const cargo = body.match(/^test result:.*$/gm);
  const summaries = cargo ?? [/^\s*Tests:?\s.*$/m.exec(body)?.[0] ?? body];
  // The first count `re` finds in each summary (every one, with `every`),
  // added up; null when no summary has one.
  const sum = (re: RegExp, every = false): number | null => {
    let total: number | null = null;
    for (const text of summaries) {
      const found = every ? [...text.matchAll(new RegExp(re.source, "gi"))] : [re.exec(text)].filter((m) => m !== null);
      for (const m of found) total = (total ?? 0) + Number(m[1]);
    }
    return total;
  };
  const add = (...counts: (number | null)[]): number | null =>
    counts.every((n) => n === null) ? null : counts.reduce<number>((t, n) => t + (n ?? 0), 0);
  // pytest's `xpassed` ran and passed; its `xfailed` failed as expected, so it
  // isn't a failure, and counts with the tests that didn't count.
  const passed = add(sum(/\b(\d+)\s+(?:pass|passed|passing)\b/i), sum(/\b(\d+)\s+xpassed\b/i));
  // pytest counts setup and collection errors apart from failures, on its
  // summary line; an `N errors` anywhere else is a compiler's, not a test's.
  // A run stopped in collection prints only `1 error in 0.16s`, so the timing
  // marks the line too.
  const errorLine = /^.*\b\d+\s+(?:passed|failed|errors?\b.*\bin \d+(?:\.\d+)?s)\b.*$/m.exec(summaries.join("\n"))?.[0];
  const errored = errorLine ? /\b(\d+)\s+errors?\b/i.exec(errorLine) : null;
  const failed = add(sum(/\b(\d+)\s+(?:fail|failed|failing)\b/i), errored ? Number(errored[1]) : null);
  // Jest can print `1 skipped, 2 todo` on one line; neither ran, so both count.
  const skipped = add(sum(/\b(\d+)\s+(?:skip|skipped|pending|todo|ignored)\b/i, true), sum(/\b(\d+)\s+xfailed\b/i));
  if (passed === null && failed === null && skipped === null) return null;
  // The run's own time comes last; a runner prints each test's time before it.
  // Jest writes `Time:        2.1 s`, with a space before the unit; Vitest
  // writes `Duration  1.20s`.
  const times = [
    ...body.matchAll(/\[(\d+(?:\.\d+)?m?s)\]|\bin (\d+(?:\.\d+)?m?s)\b|^\s*(?:Time:|Duration)\s+(\d+(?:\.\d+)?) ?(m?s)\b/gm),
  ];
  const time = times.at(-1);
  return { passed: passed ?? 0, failed: failed ?? 0, skipped: skipped ?? 0, time: time ? (time[1] ?? time[2] ?? `${time[3]}${time[4]}`) : null };
}

/** The last few lines a command printed. */
export function outputTail(output: string | undefined, n = 2): string[] {
  const body = output ? stripAnsi(output).trim() : "";
  if (!body) return [];
  return body
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}

/** What went wrong, as the lines that say so: the first that name an error,
 *  else the tail. */
export function errorLines(output: string | undefined, n = 2): string[] {
  const body = output ? stripAnsi(output).trim() : "";
  if (!body) return [];
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => /\berror\b|✖|✗|\bfailed\b|^E\s/i.test(l));
  return (errors.length ? errors : lines.slice(-n)).slice(0, n);
}

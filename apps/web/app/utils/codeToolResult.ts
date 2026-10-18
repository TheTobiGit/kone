// Reading the result bodies of the agent's code tools (edits, searches, shell
// commands) into the few facts a step can show without being opened: how much
// an edit changed and its first lines, which files a search landed in, how a
// test run came out. Every reader gives up quietly on a body it doesn't
// recognise, and the step falls back to its plain row.

export type DiffLine = { sign: "+" | "-"; text: string };
export type DiffSummary = { added: number; removed: number; preview: DiffLine[] };

export type SearchMatch = { line: number | null; text: string };
export type SearchFile = { path: string; matches: SearchMatch[] };

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

function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** An edit's diff — unified, or Claude's bare `+`/`-`/space hunk lines — as its
 *  size and its first changed lines. */
export function parseDiffSummary(detail: string | undefined): DiffSummary | null {
  const body = detail?.trim();
  if (!body || isToolInput(body)) return null;
  // Codex's whole-text fallback (`--- before` / `+++ after`) isn't a diff: its
  // lines say nothing about what changed, so it keeps the plain row.
  if (/^(--- before|\+\+\+ after)\n/.test(body) && !/^(diff --git |@@ )/m.test(body)) return null;
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
    if (!inHunk) {
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
  if (/^(no|found|showing|searched|\(|\d+\s+(files?|matches|results?)\b)/i.test(line)) return false;
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
  for (const raw of body.split("\n")) {
    const line = stripAnsi(raw).trimEnd();
    // A Windows path's drive letter (`C:\\repo\\a.ts:12:…`) isn't the separator.
    const hit = /^((?:[A-Za-z]:[\\/])?[^\s:][^:]*?):(\d+):(.*)$/.exec(line);
    if (hit) {
      fileOf(hit[1]!).matches.push({ line: Number(hit[2]), text: hit[3]!.trim() });
    } else if (isBarePath(line)) {
      // A count-mode search prints `path:N`; the path is the file.
      fileOf(line.replace(/:\d+$/, ""));
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
  const summary = /^\s*Tests:?\s.*$/m.exec(body)?.[0] ?? body;
  const count = (re: RegExp): number | null => {
    const m = re.exec(summary);
    return m ? Number(m[1]) : null;
  };
  const passed = count(/\b(\d+)\s+(?:pass|passed|passing)\b/i);
  const failed = count(/\b(\d+)\s+(?:fail|failed|failing)\b/i);
  const skipped = count(/\b(\d+)\s+(?:skip|skipped|pending)\b/i);
  if (passed === null && failed === null && skipped === null) return null;
  // The run's own time comes last; a runner prints each test's time before it.
  // Jest writes `Time:        2.1 s`, with a space before the unit.
  const times = [
    ...body.matchAll(/\[(\d+(?:\.\d+)?m?s)\]|\bin (\d+(?:\.\d+)?m?s)\b|^\s*Time:\s+(\d+(?:\.\d+)?) ?(m?s)\b/gm),
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

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
  let added = 0;
  let removed = 0;
  const preview: DiffLine[] = [];
  const lines = body.split("\n");
  for (const [i, line] of lines.entries()) {
    if (/^(diff --git |index [0-9a-f]+\.\.|@@ )/.test(line)) continue;
    // A file header is a `--- ` line followed by a `+++ ` one. A changed line
    // whose own text starts with `--` or `++` (a markdown rule) is still a change.
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) continue;
    if (line.startsWith("+++ ") && lines[i - 1]?.startsWith("--- ")) continue;
    const sign = line[0];
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
    const hit = /^([^\s:][^:]*?):(\d+):(.*)$/.exec(line);
    if (hit) {
      fileOf(hit[1]!).matches.push({ line: Number(hit[2]), text: hit[3]!.trim() });
    } else if (/^[\w@.~/-]+\.[\w-]+$/.test(line)) {
      fileOf(line);
    }
  }
  return [...files.values()];
}

/** A test run's tally, from whichever runner's summary is in the output. */
export function parseTestTally(output: string | undefined): TestTally | null {
  const body = output ? stripAnsi(output) : "";
  if (!body.trim()) return null;
  // Jest prints a `Test Suites:` line before `Tests:`; the tests are the tally.
  const summary = /^\s*Tests:.*$/m.exec(body)?.[0] ?? body;
  const count = (re: RegExp): number | null => {
    const m = re.exec(summary);
    return m ? Number(m[1]) : null;
  };
  const passed = count(/\b(\d+)\s+(?:pass|passed|passing)\b/i);
  const failed = count(/\b(\d+)\s+(?:fail|failed|failing)\b/i);
  if (passed === null && failed === null) return null;
  const skipped = count(/\b(\d+)\s+(?:skip|skipped|pending)\b/i) ?? 0;
  // The run's own time comes last; a runner prints each test's time before it.
  const times = [...body.matchAll(/\[(\d+(?:\.\d+)?m?s)\]|\bin (\d+(?:\.\d+)?m?s)\b/g)];
  const time = times.at(-1);
  return { passed: passed ?? 0, failed: failed ?? 0, skipped, time: time ? (time[1] ?? time[2]!) : null };
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

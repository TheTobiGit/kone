// ── process tree ────────────────────────────────────────────────────────────
// Full-system process snapshots and bounded descendant walks, for two gaps in
// the terminal: closing a tab must kill everything below the PTY pid (a bare
// pty.kill() leaves `npm run dev` or vim running), and the UI needs to know
// whether a subprocess is actually busy under the shell (tab busy labels, kill
// confirmations). The model is both reference repos' — one snapshot per
// capture, a children-by-ppid map, a visited-capped descendant walk, and a
// tree kill that re-captures at signal time so reparented children are caught.
// A failed snapshot is "unproven" (captureComplete: false), never a throw.

import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CapturedProcess = { pid: number; command: string };

export type ProcessChildrenMap = Map<number, Array<CapturedProcess>>;

export type ProcessTreeCapture = {
  descendants: Array<CapturedProcess>;
  /** False when the platform process snapshot failed and descendant absence is
   *  unproven — the pid may still have children we could not see. */
  captureComplete: boolean;
};

export type SubprocessActivityInspection = {
  hasRunningSubprocess: boolean;
  /** Normalised first token of the deepest real child, for tab labels. */
  childCommandLabel: string | null;
  descendantPids: number[];
  /** False when the snapshot failed — "no subprocess" is unproven, so a poller
   *  should preserve the previous busy state rather than clear it. */
  captureComplete: boolean;
};

export type TerminalKillSignal = "SIGTERM" | "SIGKILL";

/** Shell-like names that never count as "a real subprocess" on their own — a
 *  nested interactive shell is activity only when IT has non-shell children. */
export const SHELL_LIKE_PROCESS_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "cmd",
  "dash",
  "fish",
  "ksh",
  "login",
  "nu",
  "powershell",
  "pwsh",
  "screen",
  "sh",
  "tcsh",
  "tmux",
  "zellij",
  "zsh",
]);

// Full-system `ps` output scales with host process count; an undersized cap
// makes snapshot failure routine on busy machines (both references use 8MB).
const PROCESS_TREE_SCAN_TIMEOUT_MS = 1_000;
const PROCESS_TREE_SCAN_MAX_BUFFER_BYTES = 8_388_608;
// PowerShell pays interpreter startup per invocation, so its one-shot table
// scan gets a slower timeout than `ps`.
const WINDOWS_PROCESS_SCAN_TIMEOUT_MS = 3_000;
const WINDOWS_PROCESS_SCAN_MAX_BUFFER_BYTES = 8_388_608;
const WINDOWS_KILL_TIMEOUT_MS = 10_000;
// Bound for pathological trees (pid loops, wide fan-out) so a walk can never
// starve the main process. Both references cap at 256 visited nodes.
const MAX_TREE_WALK_VISITED = 256;

// One powershell.exe invocation owns the whole table, pid|ppid|command per
// line. Spawned directly, never through cmd.exe shell mode — a shell would
// re-tokenize the `-Command` payload (pipes, semicolons) before PowerShell
// ever sees it. Command lines containing `|` survive because the parse splits
// on the first two separators only. CommandLine beats Name so scripts keep
// their real argv[0]; UTF-8 is pinned because PowerShell's default pipe
// encoding is the OEM codepage.
const WINDOWS_PROCESS_TABLE_SCRIPT =
  "$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { " +
  "$cmd = if ($_.CommandLine) { [string]$_.CommandLine } else { [string]$_.Name }; " +
  "Write-Output ('{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $cmd) }";

/** `ps -eo pid=,ppid=,comm=` lines -> children-by-ppid map. Skips malformed
 *  lines and empty commands rather than failing the whole snapshot. */
function parseProcessChildrenMap(psOutput: string): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, ...commandParts] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const command = commandParts.join(" ").trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (command.length === 0) continue;
    const siblings = childrenByParentPid.get(ppid) ?? [];
    siblings.push({ pid, command });
    childrenByParentPid.set(ppid, siblings);
  }
  return childrenByParentPid;
}

/** Windows snapshot lines (pid|ppid|command) -> children-by-ppid map. */
function parseWindowsProcessTable(stdout: string): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const line of stdout.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, commandRaw] = line.trim().split("|", 3);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const command = commandRaw?.trim() ?? "";
    if (command.length === 0) continue;
    const siblings = childrenByParentPid.get(ppid) ?? [];
    siblings.push({ pid, command });
    childrenByParentPid.set(ppid, siblings);
  }
  return childrenByParentPid;
}

/** Iterative descendant walk below `rootPid` in capture order, bounded to
 *  MAX_TREE_WALK_VISITED collected nodes so pathological trees cannot starve
 *  the main process. */
function collectDescendantProcesses(
  rootPid: number,
  childrenByParentPid: ProcessChildrenMap,
): Array<CapturedProcess> {
  const descendants: Array<CapturedProcess> = [];
  const visited = new Set<number>([rootPid]);
  const stack: Array<CapturedProcess> = [];
  for (const child of childrenByParentPid.get(rootPid) ?? []) {
    stack.push(child);
  }
  while (stack.length > 0 && descendants.length < MAX_TREE_WALK_VISITED) {
    const current = stack.pop();
    if (!current || visited.has(current.pid)) continue;
    visited.add(current.pid);
    descendants.push(current);
    const nested = childrenByParentPid.get(current.pid) ?? [];
    for (const grandchild of [...nested].reverse()) {
      stack.push(grandchild);
    }
  }
  return descendants;
}

/** Basename of the command's first token with a Windows executable extension
 *  stripped (`C:\Program Files\Git\bin\bash.exe` -> `bash`), so shell-like
 *  matching and labels see the same short name on every platform. */
function processExecutableName(command: string): string {
  const firstToken = /^\s*"([^"]+)"/.exec(command)?.[1] ?? command.trim().split(/\s+/g)[0] ?? "";
  const normalizedPath = firstToken.replaceAll("\\", "/");
  return path.basename(normalizedPath).replace(/\.(?:cmd|com|exe)$/i, "");
}

/** Signal one pid, swallowing per-pid errors — an already-dead pid is normal
 *  in the kill race, never something to surface. */
function signalPid(pid: number, signal: TerminalKillSignal): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already dead or gone — nothing to signal.
  }
}

/** Full-system children-by-ppid snapshot. Returns null when the platform
 *  process table cannot be read — "unproven", never an empty map. POSIX uses
 *  one `ps -eo pid=,ppid=,comm=`; Windows one `Get-CimInstance` via
 *  powershell.exe. */
export function captureProcessChildrenMap(): ProcessChildrenMap | null {
  try {
    if (process.platform === "win32") {
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TABLE_SCRIPT],
        {
          encoding: "utf8",
          maxBuffer: WINDOWS_PROCESS_SCAN_MAX_BUFFER_BYTES,
          timeout: WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
        },
      );
      if (result.error || result.status !== 0) return null;
      return parseWindowsProcessTable(result.stdout);
    }
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,comm="], {
      encoding: "utf8",
      maxBuffer: PROCESS_TREE_SCAN_MAX_BUFFER_BYTES,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return null;
    return parseProcessChildrenMap(result.stdout);
  } catch {
    return null;
  }
}

/** Capture every descendant of `rootPid` from a fresh snapshot. Empty
 *  descendants with captureComplete: true means the pid simply has no children
 *  (it may already be gone). */
export function captureProcessTree(rootPid: number): ProcessTreeCapture {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { descendants: [], captureComplete: false };
  }
  const childrenByParentPid = captureProcessChildrenMap();
  if (childrenByParentPid === null) {
    return { descendants: [], captureComplete: false };
  }
  return {
    descendants: collectDescendantProcesses(rootPid, childrenByParentPid),
    captureComplete: true,
  };
}

function walkSubprocessActivity(
  rootPid: number,
  childrenByParentPid: ProcessChildrenMap | null,
): SubprocessActivityInspection {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || childrenByParentPid === null) {
    return { hasRunningSubprocess: false, childCommandLabel: null, descendantPids: [], captureComplete: false };
  }
  const descendantPids: number[] = [];
  let hasRunningSubprocess = false;
  let deepest: { label: string; depth: number } | null = null;
  const stack: Array<{ pid: number; command: string; depth: number }> = [];
  for (const child of childrenByParentPid.get(rootPid) ?? []) {
    stack.push({ pid: child.pid, command: child.command, depth: 1 });
  }
  let visited = 0;
  while (stack.length > 0 && visited < MAX_TREE_WALK_VISITED) {
    const entry = stack.pop();
    if (!entry) continue;
    visited += 1;
    descendantPids.push(entry.pid);
    const name = processExecutableName(entry.command);
    if (!SHELL_LIKE_PROCESS_NAMES.has(name.toLowerCase())) {
      hasRunningSubprocess = true;
      if (name.length > 0 && (deepest === null || entry.depth > deepest.depth)) {
        deepest = { label: name, depth: entry.depth };
      }
    }
    const nested = childrenByParentPid.get(entry.pid) ?? [];
    for (const grandchild of [...nested].reverse()) {
      stack.push({ pid: grandchild.pid, command: grandchild.command, depth: entry.depth + 1 });
    }
  }
  return {
    hasRunningSubprocess,
    childCommandLabel: deepest?.label ?? null,
    descendantPids,
    captureComplete: true,
  };
}

/** Full-system children-by-ppid snapshot (async). Runs `execFile` off the main
 *  thread so platform scans (especially Windows powershell.exe) do not block
 *  the Electron event loop. */
export async function captureProcessChildrenMapAsync(): Promise<ProcessChildrenMap | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TABLE_SCRIPT],
        {
          encoding: "utf8",
          maxBuffer: WINDOWS_PROCESS_SCAN_MAX_BUFFER_BYTES,
          timeout: WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
        },
      );
      return parseWindowsProcessTable(stdout);
    }
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm="], {
      encoding: "utf8",
      maxBuffer: PROCESS_TREE_SCAN_MAX_BUFFER_BYTES,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
    });
    return parseProcessChildrenMap(stdout);
  } catch {
    return null;
  }
}

/** Whether anything is actually running below `rootPid`, for tab busy labels
 *  and kill confirmations. Walks the tree from a fresh snapshot, skips
 *  shell-like names (a nested interactive shell counts only when IT has real
 *  children), and labels the deepest real child. */
export function inspectSubprocessActivity(rootPid: number): SubprocessActivityInspection {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { hasRunningSubprocess: false, childCommandLabel: null, descendantPids: [], captureComplete: false };
  }
  const childrenByParentPid = captureProcessChildrenMap();
  return walkSubprocessActivity(rootPid, childrenByParentPid);
}

/** Asynchronous variant of `inspectSubprocessActivity` for the 1s poller loop. */
export async function inspectSubprocessActivityAsync(rootPid: number): Promise<SubprocessActivityInspection> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { hasRunningSubprocess: false, childCommandLabel: null, descendantPids: [], captureComplete: false };
  }
  const childrenByParentPid = await captureProcessChildrenMapAsync();
  return walkSubprocessActivity(rootPid, childrenByParentPid);
}

/** Kill `rootPid` and every descendant, captured fresh at signal time so
 *  children reparented after an earlier snapshot are caught too. POSIX signals
 *  each pid (deepest first, then the root); Windows hands the tree to
 *  `taskkill /T /F`, which owns descendant traversal natively. Per-pid errors
 *  (already dead) are swallowed. */
export function killProcessTree(rootPid: number, signal: TerminalKillSignal): void {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], {
        encoding: "utf8",
        timeout: WINDOWS_KILL_TIMEOUT_MS,
      });
    } catch {
      // Already dead, or taskkill unavailable — nothing else to do.
    }
    return;
  }
  const { descendants } = captureProcessTree(rootPid);
  for (const descendant of descendants.toReversed()) {
    signalPid(descendant.pid, signal);
  }
  signalPid(rootPid, signal);
}

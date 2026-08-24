// ── process tree ────────────────────────────────────────────────────────────
// Full-system process snapshots and bounded descendant walks, for two gaps in
// the terminal: closing a tab must kill everything below the PTY pid (a bare
// pty.kill() leaves `npm run dev` or vim running), and the UI needs to know
// whether a subprocess is actually busy under the shell (tab busy labels, kill
// confirmations). The model: one snapshot per capture, a children-by-ppid
// map, a visited-capped descendant walk, and a tree kill that keeps the
// SIGTERM-time capture for the follow-up SIGKILL — children which ignore
// SIGTERM are reparented to init once the root dies, so a fresh capture from
// the dead root sees nothing. A failed snapshot is "unproven"
// (captureComplete: false), never a throw.

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
  /** Command of the root at capture time. Null when the snapshot could not
   *  name it — SIGKILL must then refuse the root pid rather than risk a reuse. */
  rootCommand: string | null;
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

export type ProcessCommandMap = Map<number, string>;

export type CapturedProcessTreeInspection = {
  /** True when every descendant's current command still matches its capture —
   *  the tree is exactly what was captured, nothing recycled. */
  verified: boolean;
  /** Descendants still alive and command-identical to capture. */
  survivors: Array<CapturedProcess>;
};

export type ProcessTreeKillerDependencies = {
  captureChildrenMap: () => ProcessChildrenMap | null;
  readCurrentCommands: (pids: readonly number[]) => ProcessCommandMap | null;
  signalPid: (pid: number, signal: TerminalKillSignal) => void;
};

export type ProcessTreeKiller = {
  capture(rootPid: number): ProcessTreeCapture;
  inspect(tree: ProcessTreeCapture): CapturedProcessTreeInspection;
  signal(input: {
    rootPid: number;
    signal: TerminalKillSignal;
    tree: ProcessTreeCapture;
    includeRoot?: boolean;
  }): void;
};

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
// makes snapshot failure routine on busy machines.
const PROCESS_TREE_SCAN_TIMEOUT_MS = 1_000;
const PROCESS_TREE_SCAN_MAX_BUFFER_BYTES = 8_388_608;
// PowerShell pays interpreter startup per invocation, so its one-shot table
// scan gets a slower timeout than `ps`.
const WINDOWS_PROCESS_SCAN_TIMEOUT_MS = 3_000;
const WINDOWS_PROCESS_SCAN_MAX_BUFFER_BYTES = 8_388_608;
const WINDOWS_KILL_TIMEOUT_MS = 10_000;
// Bound for pathological trees (pid loops, wide fan-out) so a walk can never
// starve the main process.
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

/** `ps -eo pid=,ppid=,command=` lines -> children-by-ppid map. Skips malformed
 *  lines and empty commands rather than failing the whole snapshot. The full
 *  command column (not a short comm) is what lets a kill-time identity re-read
 *  match the whole argv. */
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
 *  one `ps -eo pid=,ppid=,command=`; Windows one `Get-CimInstance` via
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
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,command="], {
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

/** Parse `ps -o pid=,command=` lines into a pid -> command map. Lines that do
 *  not carry a pid and command are skipped. Internal runs of whitespace are
 *  collapsed to single spaces so a re-read command compares equal to the
 *  token-joined command captured via parseProcessChildrenMap. */
export function parseProcessCommandMap(psOutput: string): ProcessCommandMap {
  const commands: ProcessCommandMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const command = match[2];
    if (command === undefined) continue;
    commands.set(pid, command.split(/\s+/g).join(" "));
  }
  return commands;
}

/** Re-read the current command line of each pid from the live process table.
 *  Null means the read itself failed and the pids are unproven — callers must
 *  not signal anything they could not identify. An empty map means every pid
 *  is gone (ps exits non-zero when none of the requested pids exist). */
export function readCurrentCommands(pids: readonly number[]): ProcessCommandMap | null {
  const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (unique.length === 0) return new Map();
  try {
    const result = spawnSync("ps", ["-p", unique.join(","), "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: PROCESS_TREE_SCAN_MAX_BUFFER_BYTES,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
    });
    if (result.error) return null;
    if (result.status !== 0) {
      const parsed = parseProcessCommandMap(result.stdout);
      if (parsed.size > 0) return parsed;
      return new Map();
    }
    return parseProcessCommandMap(result.stdout);
  } catch {
    return null;
  }
}

/** Whether a captured process may still be signalled. SIGTERM is always safe to
 *  send again. SIGKILL is not: a pid recycled between capture and kill now
 *  names a different command, so it is only signalled while its current command
 *  still matches the capture — and never when the re-read failed (null). */
export function shouldSignalCapturedProcess(
  proc: CapturedProcess,
  signal: TerminalKillSignal,
  currentCommands: ProcessCommandMap | null,
): boolean {
  if (signal !== "SIGKILL") return true;
  return currentCommands?.get(proc.pid) === proc.command;
}

/** Factory for the tree killer with injectable scan/signal primitives, so the
 *  remember-and-reuse and identity-check behaviour can be exercised against
 *  deterministic fakes. */
export function createProcessTreeKiller(
  deps: Partial<ProcessTreeKillerDependencies> = {},
): ProcessTreeKiller {
  const captureChildrenMap = deps.captureChildrenMap ?? captureProcessChildrenMap;
  const readCommands = deps.readCurrentCommands ?? readCurrentCommands;
  const sendSignal = deps.signalPid ?? signalPid;

  function capture(rootPid: number): ProcessTreeCapture {
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
      return { descendants: [], captureComplete: false, rootCommand: null };
    }
    const childrenByParentPid = captureChildrenMap();
    if (childrenByParentPid === null) {
      return { descendants: [], captureComplete: false, rootCommand: null };
    }
    const descendants = collectDescendantProcesses(rootPid, childrenByParentPid);
    let rootCommand: string | null = null;
    for (const children of childrenByParentPid.values()) {
      const root = children.find((entry) => entry.pid === rootPid);
      if (root !== undefined) {
        rootCommand = root.command;
        break;
      }
    }
    return { descendants, captureComplete: true, rootCommand };
  }

  function inspect(tree: ProcessTreeCapture): CapturedProcessTreeInspection {
    if (tree.descendants.length === 0) {
      return { verified: true, survivors: [] };
    }
    const currentCommands = readCommands(tree.descendants.map((descendant) => descendant.pid));
    if (currentCommands === null) {
      return { verified: false, survivors: [...tree.descendants] };
    }
    return {
      verified: true,
      survivors: tree.descendants.filter(
        (descendant) => currentCommands.get(descendant.pid) === descendant.command,
      ),
    };
  }

  function signal(input: {
    rootPid: number;
    signal: TerminalKillSignal;
    tree: ProcessTreeCapture;
    includeRoot?: boolean;
  }): void {
    const { rootPid, tree, includeRoot = true } = input;
    const killSignal = input.signal;
    const currentCommands =
      killSignal === "SIGKILL"
        ? readCommands([...tree.descendants.map((descendant) => descendant.pid), rootPid])
        : null;
    for (const descendant of tree.descendants.toReversed()) {
      if (shouldSignalCapturedProcess(descendant, killSignal, currentCommands)) {
        sendSignal(descendant.pid, killSignal);
      }
    }
    if (includeRoot !== false) {
      if (killSignal === "SIGKILL") {
        // Descendants fail closed when identity is unknowable, because any one
        // of them may be a recycled pid nobody here owns. The root is not in
        // that position: it is the pid the caller spawned and is escalating on,
        // so when there is nothing to compare against — the capture never read
        // its command, or the re-read itself failed — it is still signalled.
        // Otherwise a force kill on a host without a usable `ps` would quietly
        // do nothing at all.
        const identityUnknown = tree.rootCommand === null || currentCommands === null;
        if (identityUnknown || currentCommands.get(rootPid) === tree.rootCommand) {
          sendSignal(rootPid, killSignal);
        }
      } else {
        sendSignal(rootPid, killSignal);
      }
    }
  }

  return { capture, inspect, signal };
}

/** Union of a remembered SIGTERM-time capture and a fresh one, for the escalating
 *  SIGKILL — neither alone is the whole tree. The remembered capture holds
 *  descendants that outlived the root and were reparented to init, which a fresh
 *  snapshot taken from the dead root cannot see. The fresh capture holds
 *  descendants that did not exist yet at SIGTERM: a shell handed a grace period
 *  goes on working through it, and anything it starts in that window is absent
 *  from the older capture and would be left running.
 *
 *  A pid in both keeps the fresh command: a pid sitting under the root in the
 *  live table belongs to this tree however it got there, while the older reading
 *  may name a command that has since been replaced. The root's identity is the
 *  remembered one — that is the process the caller decided to escalate on, and
 *  comparing it against the live table is what catches a root pid recycled
 *  during the grace period. */
export function mergeProcessTreeCaptures(
  remembered: ProcessTreeCapture | undefined,
  fresh: ProcessTreeCapture,
): ProcessTreeCapture {
  if (remembered === undefined) return fresh;
  const byPid = new Map<number, CapturedProcess>();
  for (const descendant of remembered.descendants) byPid.set(descendant.pid, descendant);
  for (const descendant of fresh.descendants) byPid.set(descendant.pid, descendant);
  return {
    descendants: [...byPid.values()],
    captureComplete: remembered.captureComplete && fresh.captureComplete,
    rootCommand: remembered.rootCommand ?? fresh.rootCommand,
  };
}

// SIGTERM captures are kept so the follow-up SIGKILL can find descendants that
// survived and got reparented to init — re-capturing from the now-dead root
// sees nothing. Capped so a series of SIGTERMs without SIGKILLs cannot grow
// without bound; the oldest is dropped first because its escalation is the
// least likely to still be pending.
const MAX_PENDING_TREES = 256;
const pendingTrees = new Map<number, ProcessTreeCapture>();
const defaultProcessTreeKiller = createProcessTreeKiller();

/** Clear remembered SIGTERM captures — test teardown only. */
export function resetProcessTreeKillStateForTests(): void {
  pendingTrees.clear();
}

/** Capture every descendant of `rootPid` from a fresh snapshot. Empty
 *  descendants with captureComplete: true means the pid simply has no children
 *  (it may already be gone). */
export function captureProcessTree(rootPid: number): ProcessTreeCapture {
  return defaultProcessTreeKiller.capture(rootPid);
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
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,command="], {
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

/** Kill `rootPid` and every descendant. SIGTERM captures the tree and remembers
 *  it; the follow-up SIGKILL kills the union of that capture and a fresh one,
 *  because each holds descendants the other cannot see — children which ignored
 *  SIGTERM have been reparented to init, so a fresh snapshot taken from the dead
 *  root misses them, while anything the root started during its grace period is
 *  missing from the older capture. SIGKILL re-reads current commands and only
 *  signals pids whose command still matches, so a recycled pid running a
 *  different command is never killed. Windows hands the tree to
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
  if (signal === "SIGTERM") {
    const tree = defaultProcessTreeKiller.capture(rootPid);
    if (pendingTrees.size >= MAX_PENDING_TREES) {
      const oldestKey = pendingTrees.keys().next().value;
      if (oldestKey !== undefined) pendingTrees.delete(oldestKey);
    }
    pendingTrees.set(rootPid, tree);
    defaultProcessTreeKiller.signal({ rootPid, signal: "SIGTERM", tree, includeRoot: true });
    return;
  }
  const remembered = pendingTrees.get(rootPid);
  pendingTrees.delete(rootPid);
  const tree = mergeProcessTreeCaptures(
    remembered,
    defaultProcessTreeKiller.capture(rootPid),
  );
  defaultProcessTreeKiller.signal({ rootPid, signal: "SIGKILL", tree, includeRoot: true });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runStreaming } from "./spawn.js";
import type {
  ProviderInstallSource,
  ProviderKind,
  ProviderMaintenance,
  ProviderUpdateOutcome,
  VersionStanding,
} from "./types.js";

// Keeping the user's agent CLIs current — the "is this install healthy, and is
// there a newer one" half of the provider surface. Discovery (adapters/*) only
// answers *installed and logged in?*; this answers *where did it come from, and
// is it behind?*, and can run the one command that fixes it.
//
// work). Same data model and the same install-source detection, rewritten in
// kone's plain-TS main-process style (no Effect, no DI).
//
// Two rules carried over from there, because both were learned the hard way:
//
//  • Update through the channel the binary came from. `npm install -g` resolves
//    its prefix from the *node* that runs it, not from npm's own location, so a
//    bare global install can write to a different tree than the one the detected
//    binary lives in. We pin `--prefix` to the tree that owns the install and
//    put that binary's directory first on PATH.
//
//  • A CLI whose latest version kone cannot look up (self-updating channels like
//    `cursor-agent`) is permanently "unknown" — never presented as "an update is
//    waiting", or its row nags forever. Its update stays available as something
//    the user asks for, not something we claim they need.

/** ms — how long a looked-up "latest version" stays fresh. Registries move on
 *  release timescales; re-asking more often is just traffic. */
const LATEST_TTL_MS = 60 * 60 * 1_000;
/** ms — a registry lookup is a nicety, so it gets a short leash. */
const LATEST_TIMEOUT_MS = 4_000;
/** ms — an update genuinely can take minutes (npm resolving a tree, a native
 *  installer fetching a tarball), so this is generous — but bounded, because a
 *  wedged installer must not leave the pane spinning forever. */
export const UPDATE_TIMEOUT_MS = 5 * 60_000;
/** Cap on the transcript we keep from an update, so a chatty installer can't
 *  push megabytes through IPC into a settings pane. */
const UPDATE_OUTPUT_LIMIT = 8_000;

/** Where kone can learn the newest published version. `null` for a CLI that
 *  owns its own update channel and publishes nowhere we can query. */
type LatestSource =
  | { kind: "npm"; name: string }
  | { kind: "homebrew"; name: string; cask: boolean };

/** Everything kone knows about how one provider's CLI is installed and updated.
 *  `binary: null` marks a provider whose runtime ships inside kone (Claude), so
 *  there is no user install to inspect or upgrade. */
type MaintenanceDefinition = {
  provider: ProviderKind;
  /** Default executable name, before the user's binary-path override. */
  binary: string | null;
  npmPackage: string | null;
  homebrew: { name: string; cask: boolean } | null;
  /** Forced source of truth for "latest", when the package channel we'd update
   *  through isn't the channel that publishes versions. */
  latestSource?: LatestSource | null;
  /** The CLI's own update command, for CLIs that update themselves. */
  native: {
    args: (source: ProviderInstallSource) => string[];
    /** `always` — the CLI's own updater is correct however it was installed.
     *  `matching-path` — only when the install actually came from that channel
     *  (an npm-installed copy must be updated through npm). */
    strategy: "always" | "matching-path";
    /** Install sources the CLI's own updater must not be used for. */
    except?: ProviderInstallSource[];
    /** Recognises the CLI's own install layout on disk. */
    ownsPath?: (commandPath: string) => boolean;
  } | null;
};

function claudeOwnsPath(commandPath: string): boolean {
  const p = normalizePath(commandPath);
  return p.endsWith("/.local/bin/claude") || p.includes("/.local/share/claude/");
}

function opencodeOwnsPath(commandPath: string): boolean {
  return normalizePath(commandPath).includes("/.opencode/bin/opencode");
}

function cursorOwnsPath(commandPath: string): boolean {
  const p = normalizePath(commandPath);
  return p.includes("/.local/share/cursor-agent/") || p.endsWith("/.local/bin/cursor-agent");
}

const DEFINITIONS = {
  codex: {
    provider: "codex",
    binary: "codex",
    npmPackage: "@openai/codex",
    homebrew: { name: "codex", cask: true },
    // `codex` has no self-update subcommand — it's whatever installed it.
    native: null,
  },
  // kone drives Claude through the Agent SDK's own bundled CLI (see
  // claudeHome.ts' resolveClaudeExecutable), not a `claude` on the user's PATH.
  // So there's nothing here for the user to repoint or upgrade: that CLI's
  // version follows kone's own releases.
  claudeAgent: {
    provider: "claudeAgent",
    binary: null,
    npmPackage: "@anthropic-ai/claude-code",
    homebrew: null,
    latestSource: null,
    native: {
      args: () => ["update"],
      strategy: "matching-path",
      ownsPath: claudeOwnsPath,
    },
  },
  cursor: {
    provider: "cursor",
    binary: "cursor-agent",
    // Cursor ships a native binary on its own channel and publishes to no
    // registry kone can read, so "latest" stays unknowable and the update is
    // only ever offered as a manual action.
    npmPackage: null,
    homebrew: null,
    latestSource: null,
    native: { args: () => ["update"], strategy: "always", ownsPath: cursorOwnsPath },
  },
  opencode: {
    provider: "opencode",
    binary: "opencode",
    npmPackage: "opencode-ai",
    homebrew: { name: "anomalyco/tap/opencode", cask: false },
    // Published to npm even when installed from the tap, so versions are read
    // from npm whichever channel the install came through.
    latestSource: { kind: "npm", name: "opencode-ai" },
    native: {
      // `opencode upgrade` knows how to update every channel it installs
      // through — it just has to be told which one.
      args: (source) =>
        source === "npm" || source === "bun" || source === "pnpm"
          ? ["upgrade", "--method", source]
          : ["upgrade"],
      strategy: "always",
      except: ["homebrew"],
      ownsPath: opencodeOwnsPath,
    },
  },
  droid: {
    provider: "droid",
    binary: "droid",
    npmPackage: "@factory/cli",
    homebrew: null,
    native: { args: () => ["update"], strategy: "always" },
  },
  antigravity: {
    provider: "antigravity",
    binary: "agy",
    // Antigravity is distributed as a native binary and owns its update
    // channel (publishes to no registry kone can read).
    npmPackage: null,
    homebrew: null,
    latestSource: null,
    native: { args: () => ["update"], strategy: "always" },
  },
} satisfies Record<ProviderKind, MaintenanceDefinition>;

// ── versions ──────────────────────────────────────────────────────────────────

type Semver = { major: number; minor: number; patch: number; pre: string[] };

const NUMERIC = /^\d+$/;

/** Trim a `v` prefix and pad a two-segment version to three, so `1.2` and
 *  `v1.2.0` compare as the same release. */
function normalizeVersion(version: string): string {
  const [main, pre] = version.trim().replace(/^v/, "").split("-", 2);
  const segments = (main ?? "")
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 2) segments.push("0");
  return pre ? `${segments.join(".")}-${pre}` : segments.join(".");
}

function parseSemver(value: string): Semver | null {
  const [main = "", pre] = normalizeVersion(value).split("-", 2);
  const [major, minor, patch] = main.split(".");
  if (!major || !minor || !patch) return null;
  if (!NUMERIC.test(major) || !NUMERIC.test(minor) || !NUMERIC.test(patch)) return null;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    pre: pre?.split(".").map((s) => s.trim()).filter(Boolean) ?? [],
  };
}

function comparePre(left: string, right: string): number {
  const ln = NUMERIC.test(left);
  const rn = NUMERIC.test(right);
  if (ln && rn) return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  if (ln) return -1;
  if (rn) return 1;
  return left.localeCompare(right);
}

/** Negative when `left` is older. Falls back to a string compare for versions
 *  that aren't semver at all (some CLIs print a date-stamped build), which at
 *  least keeps the ordering stable instead of throwing. */
export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return left.localeCompare(right);
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A prerelease sorts *before* the release it leads to (1.0.0-rc < 1.0.0).
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const l = a.pre[i];
    const r = b.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const c = comparePre(l, r);
    if (c !== 0) return c;
  }
  return 0;
}

// ── where the binary lives ────────────────────────────────────────────────────

/** Lower-cased, forward-slashed — for *matching* a path, never for showing one.
 *  Length is preserved, so indices still map onto the original string. */
function normalizePath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

function hasSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/** Candidate filenames for one PATH entry. On Windows an extensionless file
 *  still counts: we're locating an installation to report on, not something to
 *  spawn directly. */
function candidateNames(binary: string): string[] {
  if (process.platform !== "win32") return [binary];
  return [binary, `${binary}.exe`, `${binary}.cmd`, `${binary}.bat`];
}

/** Find `binary` the way a shell would: an explicit path is taken as given,
 *  a bare name is looked up across PATH. Returns the entry found and what it
 *  really points at (agent CLIs are usually a shim into a versioned directory,
 *  and the real path is what identifies the install channel). */
function locate(
  binary: string,
  env: NodeJS.ProcessEnv,
): { found: string; real: string; dir: string } | null {
  const resolve = (candidate: string) => {
    if (!fs.existsSync(candidate)) return null;
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      // A dangling symlink still tells us where the install was meant to be.
    }
    return { found: candidate, real, dir: path.dirname(candidate) };
  };

  if (hasSeparator(binary)) return resolve(path.resolve(binary));

  const separator = process.platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? "").split(separator).filter(Boolean)) {
    for (const name of candidateNames(binary)) {
      const hit = resolve(path.join(dir, name));
      if (hit) return hit;
    }
  }
  return null;
}

function isBunGlobal(p: string): boolean {
  return normalizePath(p).includes("/.bun/bin/");
}

function isPnpmGlobal(p: string): boolean {
  const n = normalizePath(p);
  return (
    n.includes("/.local/share/pnpm/") ||
    n.includes("/library/pnpm/") ||
    n.includes("/local/share/pnpm/") ||
    n.includes("/appdata/local/pnpm/") ||
    n.includes("/pnpm/global/")
  );
}

function isNpmGlobal(p: string): boolean {
  const n = normalizePath(p);
  return (
    n.includes("/node_modules/.bin/") ||
    n.includes("/lib/node_modules/") ||
    n.includes("/npm/node_modules/")
  );
}

function isHomebrew(p: string): boolean {
  const n = normalizePath(p);
  return (
    n.includes("/opt/homebrew/caskroom/") ||
    n.includes("/usr/local/caskroom/") ||
    n.includes("/opt/homebrew/cellar/") ||
    n.includes("/usr/local/cellar/") ||
    n.includes("/homebrew/cellar/") ||
    n.startsWith("/opt/homebrew/bin/") ||
    n.startsWith("/usr/local/bin/")
  );
}

function detectSource(
  definition: MaintenanceDefinition,
  commandPath: string,
): ProviderInstallSource {
  if (definition.native?.ownsPath?.(commandPath)) return "native";
  if (isBunGlobal(commandPath)) return "bun";
  if (isPnpmGlobal(commandPath)) return "pnpm";
  if (isNpmGlobal(commandPath)) return "npm";
  if (isHomebrew(commandPath)) return "homebrew";
  return "unknown";
}

/** The global install tree that owns `commandPath`, so `npm install -g` can be
 *  pinned to it with `--prefix`. See the note at the top of this file. */
export function npmPrefixFor(commandPath: string): string | null {
  const normalized = normalizePath(commandPath);
  const unix = normalized.indexOf("/lib/node_modules/");
  if (unix > 0) return commandPath.slice(0, unix);
  const win = normalized.indexOf("/npm/node_modules/");
  if (win > 0) return commandPath.slice(0, win + "/npm".length);
  return null;
}

// ── the update command ────────────────────────────────────────────────────────

type UpdateCommand = {
  executable: string;
  args: string[];
  /** Directory to put first on PATH, so the package manager that owns the
   *  install is the one that runs. */
  pathPrepend?: string;
};

function quote(part: string): string {
  return /\s/.test(part) ? `"${part}"` : part;
}

/** The shell text kone shows for a command, so the user can run it themselves
 *  (or check what we're about to run) rather than trusting a button. */
function renderCommand(command: UpdateCommand): string {
  return [command.executable, ...command.args].map(quote).join(" ");
}

function packageManagerUpdate(
  source: "npm" | "bun" | "pnpm",
  npmPackage: string,
  commandPath: string | null,
): UpdateCommand {
  if (source === "bun") return { executable: "bun", args: ["i", "-g", `${npmPackage}@latest`] };
  if (source === "pnpm") return { executable: "pnpm", args: ["add", "-g", `${npmPackage}@latest`] };
  const prefix = commandPath ? npmPrefixFor(commandPath) : null;
  return {
    executable: "npm",
    args: ["install", "-g", ...(prefix ? ["--prefix", prefix] : []), `${npmPackage}@latest`],
  };
}

function resolveUpdateCommand(input: {
  definition: MaintenanceDefinition;
  binary: string;
  source: ProviderInstallSource;
  realPath: string | null;
}): UpdateCommand | null {
  const { definition, binary, source, realPath } = input;
  const native = definition.native;
  const nativeAllowed =
    native !== null &&
    !native.except?.includes(source) &&
    (native.strategy === "always" || source === "native");
  // The CLI's own updater wins where it applies: it knows about channels kone
  // can't see, and it's the command the CLI's own docs tell people to run.
  if (nativeAllowed) {
    return { executable: binary, args: native.args(source) };
  }
  if (source === "homebrew" && definition.homebrew) {
    return {
      executable: "brew",
      args: definition.homebrew.cask
        ? ["upgrade", "--cask", definition.homebrew.name]
        : ["upgrade", definition.homebrew.name],
    };
  }
  if ((source === "npm" || source === "bun" || source === "pnpm") && definition.npmPackage) {
    return packageManagerUpdate(source, definition.npmPackage, realPath);
  }
  return null;
}

function latestSourceFor(
  definition: MaintenanceDefinition,
  source: ProviderInstallSource,
): LatestSource | null {
  if (definition.latestSource !== undefined) return definition.latestSource;
  if (source === "homebrew" && definition.homebrew) {
    return { kind: "homebrew", name: definition.homebrew.name, cask: definition.homebrew.cask };
  }
  return definition.npmPackage ? { kind: "npm", name: definition.npmPackage } : null;
}

// ── looking up "latest" ───────────────────────────────────────────────────────

const latestCache = new Map<string, { expiresAt: number; version: string | null }>();

// Fetches and decodes a JSON body; its shape is the caller's to validate, so
// this low-level helper names no domain type.
// eslint-disable-next-line anti-slop/no-unknown-returns
async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // Offline, rate-limited, DNS-blocked — all the same answer: we don't know,
    // which is a state the UI already renders.
    return null;
  }
}

function trimmed(value: string | null | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

async function fetchLatest(source: LatestSource): Promise<string | null> {
  if (source.kind === "npm") {
    const payload = await fetchJson(
      `https://registry.npmjs.org/${encodeURIComponent(source.name)}/latest`,
    );
    // SAFETY: fetchJson resolves unknown-or-null; the only field read here goes
    // through optional chaining and trimmed()'s string guard.
    return trimmed((payload as { version?: string } | null)?.version);
  }
  const kind = source.cask ? "cask" : "formula";
  // SAFETY: fetchJson resolves unknown-or-null; both fields read off the payload
  // go through optional chaining and trimmed()'s string guard.
  const payload = (await fetchJson(
    `https://formulae.brew.sh/api/${kind}/${encodeURIComponent(source.name)}.json`,
  )) as { version?: string; versions?: { stable?: string } } | null;
  return trimmed(source.cask ? payload?.version : payload?.versions?.stable);
}

async function latestVersion(source: LatestSource, force: boolean): Promise<string | null> {
  const key =
    source.kind === "npm" ? `npm:${source.name}` : `brew:${source.cask}:${source.name}`;
  const cached = latestCache.get(key);
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return cached.version;
  const version = await fetchLatest(source);
  latestCache.set(key, { expiresAt: now + LATEST_TTL_MS, version });
  return version;
}

function standingFor(current: string | null, latest: string | null): VersionStanding {
  if (!current || !latest) return "unknown";
  return compareVersions(current, latest) < 0 ? "behind" : "current";
}

// ── the public surface ────────────────────────────────────────────────────────

/** Inspect one provider's install: where it came from, what would update it,
 *  and (unless `checkLatest` is off) whether it's behind.
 *
 *  The latest-version lookup is the only part that touches the network, and it
 *  is deliberately separable: discovery must never wait on a registry, so the
 *  probe path passes `checkLatest: false` and the settings pane asks for the
 *  real answer when the user is actually looking at it. */
type InspectedInstall = {
  located: ReturnType<typeof locate>;
  source: ProviderInstallSource;
  command: UpdateCommand | null;
};

/** Everything that can be worked out about an install without touching the
 *  network: where it is, which channel owns it, and what would update it. */
function inspect(
  definition: MaintenanceDefinition,
  binary: string,
  env: NodeJS.ProcessEnv,
): InspectedInstall {
  const located = locate(binary, env);
  // Detection reads the real path first (a versioned install directory names
  // its channel), then the PATH entry that pointed at it (a `~/.bun/bin` shim
  // names its channel while its target doesn't), then the bare name.
  const candidates = [located?.real, located?.found, hasSeparator(binary) ? null : binary].filter(
    (value): value is string => Boolean(value),
  );
  let source: ProviderInstallSource = "unknown";
  let matched: string | null = null;
  for (const candidate of candidates) {
    const detected = detectSource(definition, candidate);
    if (detected !== "unknown") {
      source = detected;
      matched = candidate;
      break;
    }
  }

  const command = resolveUpdateCommand({
    definition,
    binary,
    source,
    realPath: matched ?? located?.real ?? null,
  });
  return {
    located,
    source,
    // Run the update with the found binary's directory first on PATH, so the
    // package manager that owns this install is the one that answers.
    command: command && located ? { ...command, pathPrepend: located.dir } : command,
  };
}

export async function resolveProviderMaintenance(input: {
  provider: ProviderKind;
  /** The user's binary-path override, if they set one. */
  binaryOverride?: string;
  /** The version discovery already read from the CLI — this module never
   *  re-spawns a `--version` probe of its own. */
  currentVersion?: string | null;
  env: NodeJS.ProcessEnv;
  checkLatest?: boolean;
  /** Ignore the cached "latest", e.g. the user pressed Check again. */
  force?: boolean;
}): Promise<ProviderMaintenance> {
  const definition = DEFINITIONS[input.provider];
  const currentVersion = input.currentVersion?.trim() || null;

  // A bundled runtime has no install to inspect. Saying so plainly beats
  // reporting "unknown" for a thing that is in fact perfectly known.
  if (!definition.binary) {
    return {
      provider: input.provider,
      installSource: "bundled",
      binary: null,
      resolvedPath: null,
      realPath: null,
      packageName: definition.npmPackage,
      currentVersion,
      latestVersion: null,
      latestKnowable: false,
      standing: "unknown",
      updateCommand: null,
      canUpdate: false,
      checkedAt: null,
    };
  }

  const binary = input.binaryOverride?.trim() || definition.binary;
  const { located, source, command } = inspect(definition, binary, input.env);

  const versionSource = latestSourceFor(definition, source);
  const latest =
    versionSource && input.checkLatest !== false
      ? await latestVersion(versionSource, input.force ?? false)
      : null;

  return {
    provider: input.provider,
    installSource: source,
    binary,
    resolvedPath: located?.found ?? null,
    realPath: located && located.real !== located.found ? located.real : null,
    packageName: definition.npmPackage,
    currentVersion,
    latestVersion: latest,
    // Knowable only when there's a registry to ask. A self-updating CLI never
    // becomes "behind", so its row can't nag — see the header note.
    latestKnowable: versionSource !== null,
    standing: standingFor(currentVersion, latest),
    updateCommand: command ? renderCommand(command) : null,
    canUpdate: command !== null,
    checkedAt: latest !== null ? Date.now() : null,
  };
}

/** Run the update kone resolved for `provider`. Returns the transcript so the
 *  pane can show what the installer actually said — an update that "failed" is
 *  usually a permissions or prefix problem the output names outright, and
 *  hiding it just sends the user to a terminal to run the command again. */
export async function runProviderUpdate(input: {
  provider: ProviderKind;
  binaryOverride?: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ outcome: ProviderUpdateOutcome; message: string | null; output: string | null }> {
  const definition = DEFINITIONS[input.provider];
  if (!definition.binary) {
    return {
      outcome: "unsupported",
      message: "kone bundles this provider's runtime — it updates with the app.",
      output: null,
    };
  }

  const binary = input.binaryOverride?.trim() || definition.binary;
  const { command } = inspect(definition, binary, input.env);
  if (!command) {
    return {
      outcome: "unsupported",
      message: "kone can't tell how this CLI was installed, so it won't guess an update command.",
      output: null,
    };
  }

  const separator = process.platform === "win32" ? ";" : ":";
  const env: NodeJS.ProcessEnv = command.pathPrepend
    ? { ...input.env, PATH: [command.pathPrepend, input.env.PATH].filter(Boolean).join(separator) }
    : { ...input.env };

  const run = runStreaming(command.executable, command.args, {
    // Updates are machine-wide, not project-scoped; the home directory is the
    // one cwd that always exists and belongs to nobody's repository.
    cwd: os.homedir(),
    env,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    run.kill();
  }, UPDATE_TIMEOUT_MS);
  const result = await run.done;
  clearTimeout(timer);

  // Installers habitually write progress to stderr, so both streams are the
  // transcript — stderr first, because that's where a failure explains itself.
  const output =
    [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n\n").slice(
      0,
      UPDATE_OUTPUT_LIMIT,
    ) || null;

  if (timedOut) {
    return {
      outcome: "failed",
      message: `Update timed out after ${Math.round(UPDATE_TIMEOUT_MS / 60_000)} minutes and was stopped.`,
      output,
    };
  }
  if (result.code !== 0) {
    return {
      outcome: "failed",
      message:
        result.code === null
          ? `Couldn't run ${command.executable}.`
          : `${command.executable} exited with code ${result.code}.`,
      output,
    };
  }
  return { outcome: "succeeded", message: null, output };
}

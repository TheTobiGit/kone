import { computed, ref } from "vue";
import type {
  ProviderKind,
  ProviderMaintenance,
  ProviderUpdateOutcome,
  ProviderStatus,
} from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";

// The install side of the provider surface: which channel each agent CLI came
// from, whether a newer one has been published, and running the one command that
// updates it. Companion to useAgentProviders (installed + logged in?) and
// useProviderSettings (the user's knobs).
//
// Two deliberate boundaries:
//
//  • Nothing here runs at app open. The latest-version lookup is a network call,
//    so it happens when the settings pane is actually on screen and the answer
//    is going to be read by someone.
//
//  • An update is a live process, not a request/response — so its state lives
//    per provider (`running`, then the outcome plus the installer's transcript)
//    and survives leaving the pane, because a `npm install -g` outlasts a
//    glance at another provider.
//
// Module-scope state so the pane can be unmounted and re-entered mid-update and
// still find the run it started.

/** A provider's update run, as the pane needs to render it. */
export type UpdateRun = {
  provider: ProviderKind;
  running: boolean;
  outcome: ProviderUpdateOutcome | null;
  message: string | null;
  output: string | null;
  /** ms epoch when the run finished — the pane fades a stale result. */
  finishedAt: number | null;
};

const maintenance = ref<Partial<Record<ProviderKind, ProviderMaintenance>>>({});
const runs = ref<Partial<Record<ProviderKind, UpdateRun>>>({});
const checking = ref(false);
const error = ref<string | null>(null);
/** ms epoch of the last completed check, so the pane can say how fresh it is. */
const checkedAt = ref<number | null>(null);
let checked = false;
let inFlight: Promise<void> | null = null;

/** Dev fallback (browser, no bridge): a plausible spread of install channels so
 *  the pane's states — behind, current, self-updating, bundled, unrecognised —
 *  are all exercised without an Electron shell. Never used in the app. */
const MOCK: Record<ProviderKind, ProviderMaintenance> = {
  codex: {
    provider: "codex",
    installSource: "npm",
    binary: "codex",
    resolvedPath: "/usr/local/bin/codex",
    realPath: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
    packageName: "@openai/codex",
    currentVersion: "0.48.0",
    latestVersion: "0.52.1",
    latestKnowable: true,
    standing: "behind",
    updateCommand: "npm install -g --prefix /usr/local @openai/codex@latest",
    canUpdate: true,
    checkedAt: Date.now(),
  },
  claudeAgent: {
    provider: "claudeAgent",
    installSource: "bundled",
    binary: null,
    resolvedPath: null,
    realPath: null,
    packageName: "@anthropic-ai/claude-code",
    currentVersion: "2.1.0",
    latestVersion: null,
    latestKnowable: false,
    standing: "unknown",
    updateCommand: null,
    canUpdate: false,
    checkedAt: null,
  },
  cursor: {
    provider: "cursor",
    installSource: "native",
    binary: "cursor-agent",
    resolvedPath: "~/.local/bin/cursor-agent",
    realPath: "~/.local/share/cursor-agent/versions/2026.07.23-e383d2b/cursor-agent",
    packageName: null,
    currentVersion: "1.2.0",
    latestVersion: null,
    latestKnowable: false,
    standing: "unknown",
    updateCommand: "cursor-agent update",
    canUpdate: true,
    checkedAt: null,
  },
  opencode: {
    provider: "opencode",
    installSource: "bun",
    binary: "opencode",
    resolvedPath: "~/.bun/bin/opencode",
    realPath: "~/.bun/install/global/node_modules/opencode-ai/bin/opencode",
    packageName: "opencode-ai",
    currentVersion: "1.18.10",
    latestVersion: "1.18.10",
    latestKnowable: true,
    standing: "current",
    updateCommand: "opencode upgrade --method bun",
    canUpdate: true,
    checkedAt: Date.now(),
  },
  droid: {
    provider: "droid",
    installSource: "unknown",
    binary: "droid",
    resolvedPath: "~/.local/bin/droid",
    realPath: null,
    packageName: "@factory/cli",
    currentVersion: null,
    latestVersion: "0.19.4",
    latestKnowable: true,
    standing: "unknown",
    updateCommand: "droid update",
    canUpdate: true,
    checkedAt: Date.now(),
  },
  antigravity: {
    provider: "antigravity",
    installSource: "unknown",
    binary: "agy",
    resolvedPath: "~/.local/bin/agy",
    realPath: null,
    packageName: null,
    currentVersion: "1.0.12",
    latestVersion: null,
    latestKnowable: false,
    standing: "unknown",
    updateCommand: "agy update",
    canUpdate: true,
    checkedAt: Date.now(),
  },
};

export function useProviderMaintenance() {
  const bridge = () => (import.meta.client ? window.koneDesktop?.agent : undefined);

  function forProvider(provider: ProviderKind): ProviderMaintenance | null {
    return maintenance.value[provider] ?? null;
  }

  function runFor(provider: ProviderKind): UpdateRun | null {
    return runs.value[provider] ?? null;
  }

  /** Providers kone can honestly say are out of date: behind a version it
   *  actually looked up, with a command that would fix it. A self-updating CLI
   *  is excluded by `latestKnowable` — see the composable header. */
  const outdated = computed(() =>
    Object.values(maintenance.value).filter(
      (m): m is ProviderMaintenance =>
        Boolean(m) && m.standing === "behind" && m.latestKnowable && m.canUpdate,
    ),
  );

  /** Read the install facts, and (unless told otherwise) look up latest
   *  versions. Deduped; `force` bypasses both the once-only guard and the main
   *  process's one-hour registry cache. */
  async function check(options?: { force?: boolean; checkLatest?: boolean }): Promise<void> {
    const force = options?.force ?? false;
    if (checked && !force) return;
    if (inFlight) return inFlight;
    checking.value = true;
    error.value = null;
    inFlight = (async () => {
      try {
        const api = bridge();
        const list = api
          ? await api.maintenance({ checkLatest: options?.checkLatest ?? true, force })
          : Object.values(MOCK);
        maintenance.value = Object.fromEntries(list.map((m) => [m.provider, m]));
        checked = true;
        checkedAt.value = Date.now();
      } catch (cause) {
        error.value = peelIpcError(cause, "Could not check your agent tools");
      } finally {
        checking.value = false;
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** Update one provider. Resolves when the installer exits; the run's state is
   *  readable throughout via `runFor`. `onStatuses` hands back the re-probed
   *  provider statuses so the caller can refresh its own view of readiness. */
  async function update(
    provider: ProviderKind,
    onStatuses?: (statuses: ProviderStatus[]) => void,
  ): Promise<UpdateRun> {
    const existing = runs.value[provider];
    if (existing?.running) return existing;

    const start: UpdateRun = {
      provider,
      running: true,
      outcome: null,
      message: null,
      output: null,
      finishedAt: null,
    };
    runs.value = { ...runs.value, [provider]: start };

    const api = bridge();
    if (!api) {
      // Browser dev: pretend the installer ran, so the pane's running →
      // succeeded transition can be seen without an Electron shell.
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      const mock = MOCK[provider];
      const landed: ProviderMaintenance = {
        ...mock,
        currentVersion: mock.latestVersion ?? mock.currentVersion,
        standing: mock.latestKnowable ? "current" : "unknown",
      };
      maintenance.value = { ...maintenance.value, [provider]: landed };
      const done: UpdateRun = {
        provider,
        running: false,
        outcome: "succeeded",
        message: null,
        output: null,
        finishedAt: Date.now(),
      };
      runs.value = { ...runs.value, [provider]: done };
      return done;
    }

    try {
      const result = await api.updateProvider(provider);
      maintenance.value = { ...maintenance.value, [provider]: result.maintenance };
      if (result.statuses.length) onStatuses?.(result.statuses);
      const done: UpdateRun = {
        provider,
        running: false,
        outcome: result.outcome,
        message: result.message,
        output: result.output,
        finishedAt: Date.now(),
      };
      runs.value = { ...runs.value, [provider]: done };
      return done;
    } catch (cause) {
      const failed: UpdateRun = {
        provider,
        running: false,
        outcome: "failed",
        message: peelIpcError(cause, "The update couldn't be started"),
        output: null,
        finishedAt: Date.now(),
      };
      runs.value = { ...runs.value, [provider]: failed };
      return failed;
    }
  }

  /** Clear a finished run's result (the user has read it). */
  function dismissRun(provider: ProviderKind): void {
    const run = runs.value[provider];
    if (!run || run.running) return;
    const next = { ...runs.value };
    delete next[provider];
    runs.value = next;
  }

  return {
    maintenance,
    runs,
    checking,
    checkedAt,
    error,
    outdated,
    forProvider,
    runFor,
    check,
    update,
    dismissRun,
  };
}

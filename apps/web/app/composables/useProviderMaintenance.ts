import { computed, ref } from "vue";
import type {
  ProviderKind,
  ProviderMaintenance,
  ProviderUpdateOutcome,
  ProviderStatus,
} from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";
import { desktopBridge, needsDesktop } from "~/utils/desktopBridge";

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

export function useProviderMaintenance() {
  const bridge = () => desktopBridge()?.agent;

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
          : [];
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
      const done: UpdateRun = {
        ...start,
        running: false,
        outcome: "unsupported",
        message: needsDesktop("Updating"),
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

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEventListener, usePreferredReducedMotion } from "@vueuse/core";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AiChipIcon,
  AlertCircleIcon,
  ArrowTurnBackwardIcon,
  CheckmarkCircle02Icon,
  CommandLineIcon,
  DistributeHorizontalCenterIcon,
  KeyboardIcon,
  RefreshIcon,
  Tick02Icon,
  UndoIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
} from "@hugeicons/core-free-icons";
import { Magnet } from "~/components/ui/magnet";
import type { ShortcutAction } from "~/composables/useShortcuts";
import type { CenterMode } from "~/composables/useStripPrefs";
import type { ProviderKind, ProviderStatus } from "~/types/desktop";

// The settings / personalization panel, in the spirit of X's account drawer.
// It doesn't float over the launcher — it sits pinned to the left edge, and the
// launcher itself slides aside (see index.vue's stage) to reveal it. So this is
// just the panel surface; the reveal lives upstream.
//
// The panel is a small navigable drawer: a root list of section groups (General,
// Personalization) that pushes into detail panes within the same 320px aside.
// Two detail panes today: Shortcuts, which rebinds the app's custom,
// genuinely rebind-worthy gestures (currently just Switch project); and Strip
// motion, which holds the board's scroll-feel settings. OS-convention keys
// (⌘, / ⌘K) and fixed keys (Esc / Enter / type-to-compose) stay in the shortcut
// registry — handlers still consult them — but are deliberately hidden from the
// UI; there's no meaning in rebinding those.
//
// Thread strip earns its own pane rather than sitting inline: today it's a single
// center-focused-column choice, but it's the shelf the rest of the strip's
// knobs will land on (gaps, snap feel, width steps), so it wants room to grow.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { muted, toggleMuted, cue } = useSound();
const {
  personalizableGroups,
  hasOverrides,
  isCustomized,
  conflictFor,
  rebind,
  reset,
  resetAll,
  captureFromEvent,
  displayTokens,
} = useShortcuts();

// ── thread strip (niri's center-focused-column) ─────────────────────────────────
// The same module-scope ref ThreadStrip.vue reads, so setting it here steers the
// board's scroll behaviour live — no reload, no prop threaded across. In the pane
// the three choices sit as a vertical radio list, each with a line on what it does.
const { centerMode } = useStripPrefs();
const centerOptions: { value: CenterMode; label: string; description: string }[] = [
  {
    value: "never",
    label: "Never",
    description: "Keep the strip anchored — nudge the focused column just into view.",
  },
  {
    value: "on-overflow",
    label: "When needed",
    description: "Center the focused column only when the strip has to scroll.",
  },
  {
    value: "always",
    label: "Always",
    description: "Recenter the strip on every focus change.",
  },
];

// The active option, shown trailing the root row so the current choice reads
// without opening the pane.
const currentCenterOption = computed(() =>
  centerOptions.find((o) => o.value === centerMode.value),
);

// Keep the button elements so arrow-key navigation can move focus with the
// selection, the way a native radiogroup does (roving focus, not roving tabindex
// alone). Order tracks the v-for, so index maps straight onto centerOptions.
const centerRadioEls = ref<HTMLElement[]>([]);
function setCenterRadioEl(el: unknown, i: number) {
  if (el instanceof HTMLElement) centerRadioEls.value[i] = el;
}

function setCenterMode(mode: CenterMode) {
  if (centerMode.value === mode) return;
  centerMode.value = mode;
  cue("toggle");
}

function onCenterKeydown(e: KeyboardEvent, i: number) {
  // Only a bare arrow navigates the group. A modified arrow (⌘⌥← / → is the
  // board's focus-thread shortcut) or an arrow while the pane isn't showing must
  // pass straight through — a radio button that still holds focus after the
  // drawer shuts mustn't swallow the app's chords.
  if (!props.open || pane.value !== "motion") return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
  const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
  if (!forward && !back) return;
  // Arrows own the group's focus; don't let them also scroll the drawer.
  e.preventDefault();
  const next = (i + (forward ? 1 : -1) + centerOptions.length) % centerOptions.length;
  const option = centerOptions[next];
  if (!option) return;
  setCenterMode(option.value);
  centerRadioEls.value[next]?.focus();
}

// ── agent providers ───────────────────────────────────────────────────────────
// The install-settings surface for the agent CLIs kone drives. useAgentProviders
// only *detects* what's installed + logged in; useProviderSettings holds the
// user's knobs on top of that — a custom binary path (which reaches the Electron
// adapters) and whether the provider shows up in the picker rail at all. "Bring
// your own subscription" still holds: no credentials live here, only how to reach
// a CLI the user already signed into.
const providers = useAgentProviders();
const providerSettings = useProviderSettings();

// Static per-provider facts the probe doesn't carry: display label, vendor, and
// whether the provider spawns an external binary the user can repoint (Claude
// runs the SDK's bundled CLI, so it has no path knob).
const PROVIDER_META: Record<
  ProviderKind,
  { label: string; vendor: string; binary: string | null }
> = {
  codex: { label: "Codex", vendor: "OpenAI", binary: "codex" },
  claudeAgent: { label: "Claude", vendor: "Anthropic", binary: null },
  cursor: { label: "Cursor", vendor: "Cursor", binary: "cursor-agent" },
  opencode: { label: "OpenCode", vendor: "OpenCode", binary: "opencode" },
};
const PROVIDER_ORDER: ProviderKind[] = ["codex", "claudeAgent", "cursor", "opencode"];

// One row per known provider (stable order), merging its live probe status. A
// provider with no probe yet shows as pending until discovery lands.
const providerRows = computed(() =>
  PROVIDER_ORDER.map((provider) => ({
    provider,
    meta: PROVIDER_META[provider],
    status: providers.statuses.value.find((s) => s.provider === provider) ?? null,
    enabled: providerSettings.isEnabled(provider),
  })),
);

// How many detected providers the rail will actually offer (ready ∧ enabled) —
// trails the root row so the current reach reads without opening the pane.
const readyEnabledCount = computed(
  () =>
    providers.statuses.value.filter(
      (s) => s.readiness === "ready" && providerSettings.isEnabled(s.provider),
    ).length,
);

// Map a probe result onto a small status chip: a glyph + label + whether it's the
// "good" (ready) state, which the row marks in --ink like the motion pane's tick.
function statusChip(status: ProviderStatus | null): {
  label: string;
  ready: boolean;
  bad: boolean;
} {
  if (!status) return { label: "Checking…", ready: false, bad: false };
  switch (status.readiness) {
    case "ready":
      return { label: status.authLabel ?? "Ready", ready: true, bad: false };
    case "needs-login":
      return { label: "Needs sign-in", ready: false, bad: true };
    case "not-installed":
      return { label: "Not installed", ready: false, bad: false };
    default:
      return { label: "Unavailable", ready: false, bad: true };
  }
}

// Local drafts for the binary-path inputs so typing doesn't thrash the store on
// every keystroke — committed on blur / Enter. Seeded (and re-seeded) from the
// persisted paths as they load.
const binaryDrafts = ref<Partial<Record<ProviderKind, string>>>({});
watch(
  () => providerSettings.binaryPaths.value,
  (paths) => {
    binaryDrafts.value = { ...paths };
  },
  { immediate: true, deep: true },
);

function commitBinary(provider: ProviderKind) {
  void providerSettings.setBinaryPath(provider, binaryDrafts.value[provider] ?? "");
  cue("toggle");
}

function toggleProvider(provider: ProviderKind) {
  providerSettings.setEnabled(provider, !providerSettings.isEnabled(provider));
  cue("toggle");
}

// Re-probe every CLI (installed? logged in?) on demand — after the user fixes a
// path or signs in elsewhere, so the pane reflects it without an app restart.
const rechecking = ref(false);
async function recheckProviders() {
  if (rechecking.value) return;
  rechecking.value = true;
  cue("press");
  try {
    await providers.discover(true);
  } finally {
    rechecking.value = false;
  }
}

function onSoundToggle() {
  toggleMuted();
  // If we just switched sound back on, confirm it with a soft cue (a no-op the
  // other way, since cues stay silent while muted).
  cue("toggle");
}

// ── pane navigation ──────────────────────────────────────────────────────────
// Root lists the section groups; each detail pane ("shortcuts", "motion") is
// reached by tapping its row. The drawer always reopens at root so the user lands
// somewhere predictable, and leaving the shortcuts pane abandons any in-flight
// rebind capture.
type Pane = "root" | "shortcuts" | "motion" | "providers";
const pane = ref<Pane>("root");

function openShortcuts() {
  pane.value = "shortcuts";
  cue("press");
}

function openMotion() {
  pane.value = "motion";
  cue("press");
}

function openProviders() {
  pane.value = "providers";
  cue("press");
  // Warm the probe + persisted settings on entry (deduped — no-op if already
  // done at app open). A blank list resolves to "Checking…" rows meanwhile.
  void providers.discover();
  void providerSettings.load();
}

function backToRoot() {
  cancelCapture(); // abandon any in-flight rebind when leaving the pane
  pane.value = "root";
  cue("toggle");
}

// ── capture state ─────────────────────────────────────────────────────────────
// Clicking a rebindable row puts it into "listening" mode: the next keydown is
// captured into a fresh binding, Esc cancels. We hold the capturing action id
// plus an optional conflict message so the row can show inline feedback.
const capturingId = ref<string | null>(null);
const captureMsg = ref<string>("");
const captureRef = ref<HTMLElement | null>(null);

function prettyBinding(action: { binding: string }): string[] {
  return displayTokens(action.binding);
}

function startCapture(action: ShortcutAction) {
  if (!action.rebindable || !props.open || pane.value !== "shortcuts") return;
  capturingId.value = action.id;
  captureMsg.value = "";
  cue("press");
  // Focus moves into the capturing chip so screen readers announce the change.
  nextTick(() => captureRef.value?.focus());
}

function cancelCapture() {
  capturingId.value = null;
  captureMsg.value = "";
}

function onCaptureKeydown(e: KeyboardEvent) {
  if (!capturingId.value) return;
  // Capture anywhere on the panel — but don't hijack the drawer's own Esc-close
  // while we're mid-capture? Actually do: a rebind capture owns Esc, so Esc
  // cancels the capture rather than closing the drawer (one Esc leaves capture;
  // a second leaves the drawer).
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const res = captureFromEvent(e);
  if (!res.ok) {
    if (res.reason === "escape") {
      cancelCapture();
      cue("toggle");
    }
    return;
  }
  const id = capturingId.value;
  const conflict = conflictFor(res.binding, id);
  if (conflict) {
    captureMsg.value = `Already used by “${conflict.label}”`;
    cue("error");
    return;
  }
  const ok = rebind(id, res.binding);
  if (!ok) {
    captureMsg.value = "That binding couldn't be set.";
    cue("error");
    return;
  }
  capturingId.value = null;
  captureMsg.value = "";
  cue("success");
}

// Capture calls happen on window so even if focus strays outside the chip we
// still grab the next key. We only act while capturing; otherwise we let events
// through. Bound/unbound with the drawer's visibility, not lifecycle.
useEventListener(window, "keydown", onCaptureKeydown, { capture: true });

// A single drawer-level Esc handler (separate from capture). Esc is a natural
// "up": from mid-capture → capture handler eats it (leaving capture); from the
// shortcuts pane → back to root; from root → close the drawer.
function onKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key !== "Escape") return;
  if (capturingId.value) return; // capture owns this Esc
  e.preventDefault();
  if (pane.value !== "root") {
    backToRoot();
    return;
  }
  emit("close");
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));


// When the drawer closes, abandon capture and land back on the root pane so it
// always reopens at the top level.
watch(
  () => props.open,
  (open) => {
    if (!open) {
      cancelCapture();
      pane.value = "root";
    }
  },
);

// The flat list of rebindable items, used for the "Reset all" affordance's
// enabled state (any override present) — `hasOverrides` already covers this.
const anyCustomized = computed(() => hasOverrides.value);

// ── pane motion ───────────────────────────────────────────────────────────────
// A light horizontal push between panes — root slides left as shortcuts enters
// from the right, and back again on return. Same spring the stage rides. The
// panes sit in a grid stack so they overlap while the transition plays; once it
// ends the inactive pane is removed (the spring has no exit, so the outgoing
// pane's slide is covered by the incoming one arriving over it).
const paneSpring = { type: "spring", stiffness: 520, damping: 26, mass: 0.8 } as const;
const reducedMotion = usePreferredReducedMotion();
const paneOffset = computed(() => (reducedMotion.value === "reduce" ? 0 : 20));

defineExpose({ cancelCapture });
</script>

<template>
  <aside
    class="settings-scroll fixed inset-y-0 left-0 z-0 flex w-[320px] max-w-[80vw] flex-col overflow-y-auto bg-sunken px-5 pt-16 pb-7"
    :aria-hidden="!open"
    role="dialog"
    aria-label="Settings and personalization"
  >
    <!-- Both panes stack in one grid cell so the push transition overlaps them;
         the active pane is keyed and slides in over the outgoing one. -->
    <div class="grid min-h-0 flex-1 content-start">
      <!-- Root pane: the Personalization section — a Keyboard shortcuts row
           that pushes into the shortcuts detail pane. Borderless rows on the
           sunken surface; the row rides the same magnet pull as the app's
           other buttons instead of a hover wash. -->
      <motion.section
        v-if="pane === 'root'"
        key="root"
        class="col-start-1 row-start-1 flex flex-col gap-6"
        aria-label="Settings"
        :initial="{ opacity: 0, x: -paneOffset }"
        :animate="{ opacity: 1, x: 0 }"
        :transition="paneSpring"
      >
        <!-- Personalization -->
        <div class="flex flex-col gap-1.5">
          <p class="px-3 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
            Personalization
          </p>
          <Magnet
            class="block"
            inner-class="w-full"
            :padding="12"
            :magnet-strength="9"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <button
              type="button"
              class="group flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Open keyboard shortcuts settings"
              @click="openShortcuts"
            >
              <HugeiconsIcon
                :icon="KeyboardIcon"
                :size="17"
                :stroke-width="1.7"
                class="shrink-0 text-muted transition-colors group-hover:text-ink"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 text-[15px] leading-tight text-ink">
                Keyboard shortcuts
              </span>
            </button>
          </Magnet>

          <!-- Thread strip — pushes into its own pane (the shelf the board's other
               strip knobs will land on). Same borderless magnet row as Shortcuts;
               the current choice trails the label in --muted so the row reads as
               "Thread strip · When needed" at a glance without opening it. -->
          <Magnet
            class="block"
            inner-class="w-full"
            :padding="12"
            :magnet-strength="9"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <button
              type="button"
              class="group flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Open thread strip settings"
              @click="openMotion"
            >
              <HugeiconsIcon
                :icon="DistributeHorizontalCenterIcon"
                :size="17"
                :stroke-width="1.7"
                class="shrink-0 text-muted transition-colors group-hover:text-ink"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 text-[15px] leading-tight text-ink">
                Thread strip
              </span>
              <span class="shrink-0 text-[12px] leading-tight text-muted">
                {{ currentCenterOption?.label }}
              </span>
            </button>
          </Magnet>

          <!-- Agent providers — pushes into a pane listing each agent CLI kone
               can drive (status, binary path, whether it's offered in the rail).
               The trailing count is the reach the picker actually has right now
               (ready ∧ enabled). -->
          <Magnet
            class="block"
            inner-class="w-full"
            :padding="12"
            :magnet-strength="9"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <button
              type="button"
              class="group flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Open agent provider settings"
              @click="openProviders"
            >
              <HugeiconsIcon
                :icon="AiChipIcon"
                :size="17"
                :stroke-width="1.7"
                class="shrink-0 text-muted transition-colors group-hover:text-ink"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 text-[15px] leading-tight text-ink">
                Agent providers
              </span>
              <span
                v-if="readyEnabledCount"
                class="shrink-0 text-[12px] leading-tight text-muted"
              >
                {{ readyEnabledCount }} ready
              </span>
            </button>
          </Magnet>
        </div>
      </motion.section>

      <!-- Shortcuts pane: rebinds the app's custom gestures. Lists only actions
           marked `personalize` in the registry, grouped by their `group` label
           (Navigation, Conversation, Threads, …). -->
      <motion.section
        v-else-if="pane === 'shortcuts'"
        key="shortcuts"
        class="col-start-1 row-start-1 flex flex-col"
        aria-label="Keyboard shortcuts"
        :initial="{ opacity: 0, x: paneOffset }"
        :animate="{ opacity: 1, x: 0 }"
        :transition="paneSpring"
      >
        <div class="mb-4 flex items-center justify-between gap-3 pr-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="back-glyph flex size-6 items-center justify-center text-muted transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Back to settings"
              @click="backToRoot"
            >
              <HugeiconsIcon
                :icon="ArrowTurnBackwardIcon"
                :size="16"
                :stroke-width="2"
                aria-hidden="true"
              />
            </button>
            <h2 class="px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
              Shortcuts
            </h2>
          </div>
          <button
            v-if="anyCustomized"
            type="button"
            :tabindex="open ? 0 : -1"
            class="flex items-center gap-1 rounded-[7px] px-1.5 py-1 text-[11px] leading-none text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:outline-none"
            @click="resetAll"
          >
            <HugeiconsIcon
              :icon="UndoIcon"
              :size="12"
              :stroke-width="2"
              aria-hidden="true"
            />
            Reset all
          </button>
        </div>

        <div
          v-if="personalizableGroups.length"
          class="flex flex-col gap-6"
        >
          <section
            v-for="g in personalizableGroups"
            :key="g.group"
            class="flex flex-col gap-1.5"
            :aria-label="g.group"
          >
            <p class="px-3 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
              {{ g.group }}
            </p>
            <ul class="flex flex-col">
              <li v-for="a in g.items" :key="a.id">
                <div class="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div class="flex min-w-0 flex-col">
                    <span class="truncate text-[13px] leading-tight text-ink">
                      {{ a.label }}
                    </span>
                    <span
                      v-if="a.description ?? a.hint"
                      class="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted"
                    >
                      {{ a.description ?? a.hint }}
                    </span>
                  </div>

                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      ref="captureRef"
                      type="button"
                      class="flex min-w-[64px] cursor-pointer items-center justify-end gap-1 rounded-[8px] px-1.5 py-1 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                      :class="capturingId === a.id ? 'bg-hover' : ''"
                      :tabindex="open ? 0 : -1"
                      :aria-label="
                        capturingId === a.id
                          ? `Press a new key combination for ${a.label}; Escape cancels`
                          : `Rebind ${a.label}`
                      "
                      @click="startCapture(a)"
                    >
                      <template v-if="capturingId === a.id">
                        <span class="text-[11px] font-medium text-ink-soft">
                          Press keys…
                        </span>
                      </template>
                      <template v-else>
                        <kbd
                          v-for="(tok, i) in prettyBinding(a)"
                          :key="i"
                          class="rounded-[5px] border border-muted/25 bg-hover px-1.5 py-0.5 font-mono text-[11px] leading-none text-ink-soft"
                        >
                          {{ tok }}
                        </kbd>
                      </template>
                    </button>

                    <button
                      v-if="isCustomized(a.id)"
                      type="button"
                      :tabindex="open ? 0 : -1"
                      class="flex size-6 items-center justify-center rounded-[7px] text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:outline-none"
                      :aria-label="`Reset ${a.label} to its default`"
                      title="Reset shortcut"
                      @click="reset(a.id)"
                    >
                      <HugeiconsIcon
                        :icon="RefreshIcon"
                        :size="13"
                        :stroke-width="2"
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                </div>

                <p
                  v-if="capturingId === a.id && captureMsg"
                  class="px-3 pb-2 text-[11px] leading-snug text-red-500"
                >
                  {{ captureMsg }}
                </p>
              </li>
            </ul>
          </section>
        </div>

        <p v-else class="px-3 text-[11px] leading-snug text-muted">
          No customizable shortcuts yet.
        </p>
      </motion.section>

      <!-- Motion pane: the board's scroll-feel settings. Today just the
           center-focused-column choice, laid out as a vertical radio list — each
           option is a borderless row carrying its own one-line explanation, the
           selected one marked in --ink with a tick (Geist is 400-only, so colour +
           glyph carry the state weight can't). Room here for gaps / snap / width
           knobs later. -->
      <motion.section
        v-else-if="pane === 'motion'"
        key="motion"
        class="col-start-1 row-start-1 flex flex-col"
        aria-label="Thread strip"
        :initial="{ opacity: 0, x: paneOffset }"
        :animate="{ opacity: 1, x: 0 }"
        :transition="paneSpring"
      >
        <div class="mb-4 flex items-center gap-2 pr-3">
          <button
            type="button"
            class="back-glyph flex size-6 items-center justify-center text-muted transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-none"
            :tabindex="open ? 0 : -1"
            aria-label="Back to settings"
            @click="backToRoot"
          >
            <HugeiconsIcon
              :icon="ArrowTurnBackwardIcon"
              :size="16"
              :stroke-width="2"
              aria-hidden="true"
            />
          </button>
          <h2 class="px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
            Thread strip
          </h2>
        </div>

        <section class="flex flex-col gap-1.5" aria-label="Center focused column">
          <p class="px-3 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
            Center focused column
          </p>
          <div
            class="flex flex-col"
            role="radiogroup"
            aria-label="Center focused column"
          >
            <button
              v-for="(opt, i) in centerOptions"
              :key="opt.value"
              :ref="(el) => setCenterRadioEl(el, i)"
              type="button"
              role="radio"
              :aria-checked="centerMode === opt.value"
              :aria-label="opt.label"
              :tabindex="open ? (centerMode === opt.value ? 0 : -1) : -1"
              class="center-opt flex cursor-pointer items-start gap-3 rounded-[10px] px-3 py-2.5 text-left focus-visible:outline-none hover:bg-hover focus-visible:bg-hover"
              @click="setCenterMode(opt.value)"
              @keydown="onCenterKeydown($event, i)"
            >
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  class="text-[14px] leading-tight"
                  :class="centerMode === opt.value ? 'text-ink' : 'text-ink-soft'"
                >
                  {{ opt.label }}
                </span>
                <span class="text-[11px] leading-snug text-muted">
                  {{ opt.description }}
                </span>
              </span>
              <HugeiconsIcon
                v-if="centerMode === opt.value"
                :icon="Tick02Icon"
                :size="15"
                :stroke-width="2"
                class="mt-0.5 shrink-0 text-ink"
                aria-hidden="true"
              />
            </button>
          </div>
        </section>
      </motion.section>

      <!-- Providers pane: each agent CLI kone can drive. Per provider: a status
           line (installed? logged in?), an enable switch (whether it's offered in
           the model-picker rail), and — for providers that spawn an external
           binary — a path override. Claude runs the SDK's bundled CLI, so it
           carries a note instead of a path field. A single Re-check re-probes
           them all. -->
      <motion.section
        v-else-if="pane === 'providers'"
        key="providers"
        class="col-start-1 row-start-1 flex flex-col"
        aria-label="Agent providers"
        :initial="{ opacity: 0, x: paneOffset }"
        :animate="{ opacity: 1, x: 0 }"
        :transition="paneSpring"
      >
        <div class="mb-4 flex items-center justify-between gap-3 pr-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="back-glyph flex size-6 items-center justify-center text-muted transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Back to settings"
              @click="backToRoot"
            >
              <HugeiconsIcon
                :icon="ArrowTurnBackwardIcon"
                :size="16"
                :stroke-width="2"
                aria-hidden="true"
              />
            </button>
            <h2 class="px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
              Agent providers
            </h2>
          </div>
          <button
            type="button"
            :tabindex="open ? 0 : -1"
            class="flex items-center gap-1 rounded-[7px] px-1.5 py-1 text-[11px] leading-none text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:outline-none disabled:opacity-50"
            :disabled="rechecking"
            aria-label="Re-check installed agent tools"
            @click="recheckProviders"
          >
            <HugeiconsIcon
              :icon="RefreshIcon"
              :size="12"
              :stroke-width="2"
              class="transition-transform"
              :class="rechecking ? 'animate-spin' : ''"
              aria-hidden="true"
            />
            {{ rechecking ? "Checking…" : "Re-check" }}
          </button>
        </div>

        <div class="flex flex-col gap-6">
          <section
            v-for="row in providerRows"
            :key="row.provider"
            class="flex flex-col gap-2"
            :aria-label="row.meta.label"
          >
            <!-- Header: name + vendor on the left, enable switch on the right. -->
            <div class="flex items-start justify-between gap-3 px-3">
              <div class="flex min-w-0 flex-col">
                <span class="text-[14px] leading-tight text-ink">
                  {{ row.meta.label }}
                </span>
                <span class="mt-0.5 flex items-center gap-1.5 text-[11px] leading-snug">
                  <HugeiconsIcon
                    :icon="statusChip(row.status).ready ? CheckmarkCircle02Icon : AlertCircleIcon"
                    :size="12"
                    :stroke-width="2"
                    class="shrink-0"
                    :class="
                      statusChip(row.status).ready
                        ? 'text-ink'
                        : statusChip(row.status).bad
                          ? 'text-red-500'
                          : 'text-muted'
                    "
                    aria-hidden="true"
                  />
                  <span
                    :class="statusChip(row.status).ready ? 'text-ink-soft' : 'text-muted'"
                  >
                    {{ row.meta.vendor }} · {{ statusChip(row.status).label }}
                  </span>
                  <span v-if="row.status?.version" class="text-muted">
                    · v{{ row.status.version }}
                  </span>
                </span>
              </div>

              <!-- Offer-in-rail switch (same idiom as the sound toggle). -->
              <button
                type="button"
                role="switch"
                :aria-label="`Offer ${row.meta.label} in the model picker`"
                :aria-checked="row.enabled"
                :tabindex="open ? 0 : -1"
                class="switch relative mt-0.5 inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus-visible:outline-none"
                :style="{
                  backgroundColor: row.enabled
                    ? 'var(--ink)'
                    : 'color-mix(in srgb, var(--ink) 14%, transparent)',
                }"
                @click="toggleProvider(row.provider)"
              >
                <span
                  class="knob absolute size-[18px] rounded-full bg-ground transition-transform duration-200 ease-out"
                  :class="row.enabled ? 'translate-x-[18px]' : 'translate-x-[2px]'"
                />
              </button>
            </div>

            <!-- Binary path (providers with an external CLI) or a bundled-CLI
                 note (Claude). The message line, when the probe carries one,
                 sits under it as quiet guidance. -->
            <div v-if="row.meta.binary" class="flex flex-col gap-1 px-3">
              <label
                :for="`bin-${row.provider}`"
                class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted"
              >
                <HugeiconsIcon
                  :icon="CommandLineIcon"
                  :size="11"
                  :stroke-width="2"
                  aria-hidden="true"
                />
                CLI path
              </label>
              <input
                :id="`bin-${row.provider}`"
                v-model="binaryDrafts[row.provider]"
                type="text"
                spellcheck="false"
                autocapitalize="off"
                autocorrect="off"
                :tabindex="open ? 0 : -1"
                :placeholder="row.meta.binary"
                class="bin-input w-full rounded-[8px] bg-hover px-2.5 py-1.5 font-mono text-[12px] leading-tight text-ink-soft placeholder:text-muted focus-visible:outline-none"
                @change="commitBinary(row.provider)"
                @keydown.enter.prevent="commitBinary(row.provider)"
              />
              <p class="text-[11px] leading-snug text-muted">
                Leave blank to use <span class="font-mono">{{ row.meta.binary }}</span> on your PATH.
              </p>
            </div>
            <p v-else class="px-3 text-[11px] leading-snug text-muted">
              Runs the bundled Claude Code CLI — no path to set.
            </p>

            <p
              v-if="row.status?.message && row.status.readiness !== 'ready'"
              class="px-3 text-[11px] leading-snug text-muted"
            >
              {{ row.status.message }}
            </p>
          </section>
        </div>
      </motion.section>
    </div>

    <!-- Controls sit at the foot of the panel. Sound is the first. Only the
         switch itself toggles — the label and icon are inert. It lives on the
         root pane only; a detail pane like Shortcuts fills the panel. -->
    <div v-if="pane === 'root'" class="mt-auto flex items-center justify-between gap-4">
      <span class="flex items-center gap-3">
        <HugeiconsIcon
          :icon="muted ? VolumeMute01Icon : VolumeHighIcon"
          :size="17"
          :stroke-width="1.7"
          class="text-ink-soft"
          aria-hidden="true"
        />
        <span class="text-[15px] leading-tight text-ink">Interaction sounds</span>
      </span>

      <!-- Track + knob. On (audible) fills with ink; off rests quiet. -->
      <button
        type="button"
        role="switch"
        aria-label="Interaction sounds"
        :aria-checked="!muted"
        :tabindex="open ? 0 : -1"
        class="switch relative inline-flex h-[24px] w-[42px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus-visible:outline-none"
        :style="{
          backgroundColor: muted
            ? 'color-mix(in srgb, var(--ink) 14%, transparent)'
            : 'var(--ink)',
        }"
        @click="onSoundToggle"
      >
        <span
          class="knob absolute size-[20px] rounded-full bg-ground transition-transform duration-200 ease-out"
          :class="muted ? 'translate-x-[2px]' : 'translate-x-[20px]'"
        />
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* A slim scrollbar for the drawer — thin and quiet, lifting a touch on hover.
   Matches the app's picker-scroll idiom but narrower. */
.settings-scroll {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.settings-scroll::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}
.settings-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.settings-scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
}
.settings-scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 28%, transparent);
}

/* The thread-strip options fade colour and hover-wash at the same soft pace the
   rest of the drawer's rows use — colour carries the active state (no weight to
   lean on), so the transition is on colour and background only. */
.center-opt {
  transition:
    color 0.18s ease,
    background-color 0.18s ease;
}

/* The knob rides the sunken surface; a hairline keeps it legible in both themes
   without a heavy shadow. */
.switch .knob {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent);
}

/* The pane's back button wears the same glyph as the app's corner return:
   the return arrow turned upside down, then mirrored left-to-right. */
.back-glyph :deep(svg) {
  transform: rotate(180deg) scaleX(-1);
}
</style>

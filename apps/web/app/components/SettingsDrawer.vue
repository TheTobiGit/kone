<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePreferredReducedMotion } from "@vueuse/core";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AiChipIcon,
  Analytics01Icon,
  DistributeHorizontalCenterIcon,
  GaugeIcon,
  KeyboardIcon,
  PuzzleIcon,
  SwatchIcon,
  UserIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
} from "@hugeicons/core-free-icons";
import { Magnet } from "~/components/ui/magnet";
import { CENTER_MODES } from "~/utils/stripScroll";

// The settings / personalization panel, in the spirit of X's account drawer.
// It doesn't float over the launcher — it sits pinned to the left edge, and the
// launcher itself slides aside (see index.vue's stage) to reveal it. So this is
// just the panel surface; the reveal lives upstream.
//
// The panel is a small navigable drawer: a root list of section groups that
// pushes into detail panes. Those panes are *pages* — the drawer widens and
// hands the whole surface to SettingsProfilePane, SettingsShortcutsPane,
// SettingsProvidersPane, SettingsThreadStripPane, and the rest. Which panes are
// pages is declared in useSettingsSurface, since the launcher's slide is measured
// from the same value.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { muted, toggleMuted, cue } = useSound();
const { name: profileName, resolve: resolveProfile } = useProfile();

// ── thread strip (niri's center-focused-column) ─────────────────────────────────
// The same module-scope ref ThreadStrip.vue reads, so setting it here steers the
// board's scroll behaviour live — no reload, no prop threaded across.
const { centerMode } = useStripPrefs();

// The active option, shown trailing the root row so the current choice reads
// without opening the page. The labels come from CENTER_MODES rather than a copy
// kept here, so the row and the page can't disagree about what a mode is called.
const currentCenterOption = computed(
  () => CENTER_MODES.find((o) => o.value === centerMode.value)?.label ?? "",
);

// ── providers ────────────────────────────────────────────────────────────────
// The row only summarises; the surface itself is SettingsProvidersPane, which the
// drawer widens for (see useSettingsSurface) because a provider's install,
// version, channel and executable don't belong in a 320px column.
//
// What the row owes the user is the one fact worth knowing without opening it:
// how far the picker actually reaches, or that something is behind.
const providers = useAgentProviders();
const providerSettings = useProviderSettings();
const upkeep = useProviderMaintenance();

const readyEnabledCount = computed(
  () =>
    providers.statuses.value.filter(
      (s) => s.readiness === "ready" && providerSettings.isEnabled(s.provider),
    ).length,
);

// An available update outranks the ready count: it's the only one of the two
// that's asking for something. Only populated once the pane has looked (the
// lookup is a network call), so a session that never opened it just reads "ready".
const providerSummary = computed(() => {
  const behind = upkeep.outdated.value.length;
  if (behind) return `${behind} update${behind === 1 ? "" : "s"}`;
  return readyEnabledCount.value ? `${readyEnabledCount.value} ready` : "";
});

function onSoundToggle() {
  toggleMuted();
  // If we just switched sound back on, confirm it with a soft cue (a no-op the
  // other way, since cues stay silent while muted).
  cue("toggle");
}

// ── pane navigation ──────────────────────────────────────────────────────────
// Root lists the section groups; each detail pane is reached by tapping its row.
// The drawer always reopens at root so the user lands somewhere predictable.
//
// The pane lives in useSettingsSurface rather than here because the launcher
// slides aside by exactly this drawer's width, and most panes are pages rather
// than a column — so the stage upstream has to know which pane is open to know
// how far to move.
const { pane, isPage, revealWidth } = useSettingsSurface();

// The narrow column (the root list) scrolls the aside itself. It smokes its
// top/bottom edges exactly like the pages do rather than showing a scrollbar.
// Pages manage their own inner smoke and are overflow-hidden here, so the mask
// only rides the column state.
const drawerScroll = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(drawerScroll);
const asideStyle = computed(() => ({
  width: `${revealWidth.value}px`,
  ...(isPage.value ? {} : maskStyle.value),
}));
watch(pane, () => void nextTick(measure));

function openShortcuts() {
  pane.value = "shortcuts";
  cue("press");
}

function openMotion() {
  pane.value = "motion";
  cue("press");
}

function openAppearance() {
  pane.value = "appearance";
  cue("press");
}

function openProfile() {
  pane.value = "profile";
  cue("press");
}

function openProviders() {
  pane.value = "providers";
  cue("press");
}

function openAgentsUsage() {
  pane.value = "agentsUsage";
  cue("press");
}

function openProviderLimits() {
  pane.value = "providerLimits";
  cue("press");
}

function openAgentSkills() {
  pane.value = "agentSkills";
  cue("press");
}

function backToRoot() {
  pane.value = "root";
  cue("toggle");
}

// Esc is a natural "up": from a detail pane → back to root; from root → close.
// A rebind capture on the shortcuts page owns Esc first (capture-phase listener
// there), so one Esc leaves capture and a second walks back.
function onKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key !== "Escape") return;
  e.preventDefault();
  if (pane.value !== "root") {
    backToRoot();
    return;
  }
  emit("close");
}
onMounted(() => {
  resolveProfile();
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

// Always reopen at the top level.
watch(
  () => props.open,
  (open) => {
    if (!open) pane.value = "root";
  },
);

// A light horizontal push when the root list enters. Same spring the stage rides.
const paneSpring = { type: "spring", stiffness: 520, damping: 26, mass: 0.8 } as const;
const reducedMotion = usePreferredReducedMotion();
const paneOffset = computed(() => (reducedMotion.value === "reduce" ? 0 : 20));
</script>

<template>
  <aside
    ref="drawerScroll"
    class="settings-scroll fixed inset-y-0 left-0 z-0 flex flex-col bg-sunken"
    :class="isPage ? 'overflow-hidden' : 'overflow-y-auto px-5 pt-5 pb-7'"
    :style="asideStyle"
    :aria-hidden="!open"
    @scroll.passive="measure"
    role="dialog"
    aria-label="Settings and personalization"
  >
    <!-- Providers is a page, not a column: it takes the whole widened
         aside and lays itself out (masthead, rail, panel). The width change is
         deliberately not animated here — the stage sliding over the top of this
         panel is what uncovers it, so animating both would be two springs
         racing to describe one movement. -->
    <SettingsProfilePane v-if="pane === 'profile'" :open="open" @back="backToRoot" />

    <SettingsShortcutsPane v-if="pane === 'shortcuts'" :open="open" @back="backToRoot" />

    <SettingsAppearancePane v-if="pane === 'appearance'" :open="open" @back="backToRoot" />

    <SettingsProvidersPane v-if="pane === 'providers'" :open="open" @back="backToRoot" />

    <SettingsAgentsUsagePane v-if="pane === 'agentsUsage'" :open="open" @back="backToRoot" />

    <SettingsProviderLimitsPane v-if="pane === 'providerLimits'" :open="open" @back="backToRoot" />

    <SettingsAgentSkillsPane v-if="pane === 'agentSkills'" :open="open" @back="backToRoot" />

    <!-- Root list (and Thread strip, which still mounts from here). Pages above
         take the widened aside themselves. -->
    <div
      v-if="pane === 'root' || pane === 'motion'"
      class="grid min-h-0 flex-1 content-start"
    >
      <!-- Root pane: section groups, each row a magnet rather than a hover wash. -->
      <motion.section
        v-if="pane === 'root'"
        key="root"
        class="col-start-1 row-start-1 flex flex-col gap-6"
        aria-label="Settings"
        :initial="{ opacity: 0, x: -paneOffset }"
        :animate="{ opacity: 1, x: 0 }"
        :transition="paneSpring"
      >
        <!-- General -->
        <div class="flex flex-col gap-1.5">
          <p class="px-3 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
            General
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
              class="group nav-row flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Open profile settings"
              @click="openProfile"
            >
              <HugeiconsIcon
                :icon="UserIcon"
                :size="17"
                :stroke-width="1.7"
                class="shrink-0 text-muted transition-colors group-hover:text-ink"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 text-[15px] leading-tight text-ink">Profile</span>
              <span
                v-if="profileName"
                class="shrink-0 max-w-[40%] truncate text-[12px] leading-tight text-muted"
              >
                {{ profileName }}
              </span>
            </button>
          </Magnet>
        </div>

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
              class="group nav-row flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
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
              class="group nav-row flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
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
                {{ currentCenterOption }}
              </span>
            </button>
          </Magnet>

          <!-- Appearance — the widened page with the mode tiles and the theme
               list. Same borderless magnet row as Shortcuts; the pane itself
               shows what each choice looks like, so the row stays plain. -->
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
              class="group nav-row flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Open appearance settings"
              @click="openAppearance"
            >
              <HugeiconsIcon
                :icon="SwatchIcon"
                :size="17"
                :stroke-width="1.7"
                class="shrink-0 text-muted transition-colors group-hover:text-ink"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 text-[15px] leading-tight text-ink">Appearance</span>
            </button>
          </Magnet>
        </div>

        <!-- Agents -->
        <div class="flex flex-col gap-1.5">
          <p class="px-3 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
            Agents
          </p>

          <!-- Providers — opens the widened provider page (each CLI kone
               can drive: status, version, install channel, executable, whether
               it's offered in the picker). The trailing summary is the picker's
               real reach right now, or the updates waiting if there are any. -->
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
              class="group nav-row flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Open providers settings"
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
                Providers
              </span>
              <span
                v-if="providerSummary"
                class="shrink-0 text-[12px] leading-tight text-muted"
              >
                {{ providerSummary }}
              </span>
            </button>
          </Magnet>

          <!-- Skills — every SKILL.md the CLIs on this machine can reach, and one
               skill's own page. Read-only: kone scans and reports, the CLIs own
               what they actually load. -->
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
              class="group nav-row flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Open agent skills settings"
              @click="openAgentSkills"
            >
              <HugeiconsIcon
                :icon="PuzzleIcon"
                :size="17"
                :stroke-width="1.7"
                class="shrink-0 text-muted transition-colors group-hover:text-ink"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 text-[15px] leading-tight text-ink">Skills</span>
            </button>
          </Magnet>

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
              class="group nav-row flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Open agent usage settings"
              @click="openAgentsUsage"
            >
              <HugeiconsIcon
                :icon="Analytics01Icon"
                :size="17"
                :stroke-width="1.7"
                class="shrink-0 text-muted transition-colors group-hover:text-ink"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 text-[15px] leading-tight text-ink">Usage</span>
            </button>
          </Magnet>

          <!-- Provider limits — the widened limits page: what each provider's
               own accounting says you have left. Same global read as the Agents
               space's Limits section. -->
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
              class="group nav-row flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none"
              :tabindex="open ? 0 : -1"
              aria-label="Open provider limits settings"
              @click="openProviderLimits"
            >
              <HugeiconsIcon
                :icon="GaugeIcon"
                :size="17"
                :stroke-width="1.7"
                class="shrink-0 text-muted transition-colors group-hover:text-ink"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 text-[15px] leading-tight text-ink">
                Provider limits
              </span>
            </button>
          </Magnet>
        </div>
      </motion.section>

      <SettingsThreadStripPane v-else-if="pane === 'motion'" :open="open" @back="backToRoot" />

    </div>

    <!-- Controls sit at the foot of the panel. Sound is the first. Only the
         switch itself toggles — the label and icon are inert. It lives on the
         root pane only; a detail pane fills the panel. -->
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
        class="switch relative inline-flex h-[20px] w-[34px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus-visible:outline-none"
        :style="{
          backgroundColor: muted
            ? 'color-mix(in srgb, var(--ink) 14%, transparent)'
            : 'var(--ink)',
        }"
        @click="onSoundToggle"
      >
        <span
          class="knob absolute size-[16px] rounded-full bg-ground transition-transform duration-200 ease-out"
          :class="muted ? 'translate-x-[2px]' : 'translate-x-[16px]'"
        />
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* No visible bar — the drawer column smokes its top/bottom edges (mask bound from
   useEdgeFade) exactly like the settings pages, so the root list fades out of
   view instead of hard-cutting under a scrollbar. */
.settings-scroll {
  scrollbar-width: none;
}
.settings-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
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
/* Keyboard focus gets the same ring the pages use — the switch's hit target is
   small, so a pointer user leans on the fill, a keyboard user on this. */
.switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The root list rows navigate on click; the magnet pull answers the pointer, but
   a keyboard user needs a ring — the same one the pages and shortcut chips wear. */
.nav-row:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
</style>

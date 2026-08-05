<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEventListener, usePreferredReducedMotion } from "@vueuse/core";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AiChipIcon,
  ArrowTurnBackwardIcon,
  DistributeHorizontalCenterIcon,
  KeyboardIcon,
  RefreshIcon,
  UndoIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
} from "@hugeicons/core-free-icons";
import { Magnet } from "~/components/ui/magnet";
import type { ShortcutAction } from "~/composables/useShortcuts";
import { CENTER_MODES } from "~/utils/stripScroll";

// The settings / personalization panel, in the spirit of X's account drawer.
// It doesn't float over the launcher — it sits pinned to the left edge, and the
// launcher itself slides aside (see index.vue's stage) to reveal it. So this is
// just the panel surface; the reveal lives upstream.
//
// The panel is a small navigable drawer: a root list of section groups that
// pushes into detail panes. One of those panes is a list and lives here in the
// 320px column — Shortcuts, which rebinds the app's custom, genuinely
// rebind-worthy gestures. OS-convention keys (⌘, / ⌘K) and fixed keys (Esc /
// Enter / type-to-compose) stay in the shortcut registry — handlers still consult
// them — but are deliberately hidden from the UI; there's no meaning in rebinding
// those.
//
// The other two are *pages*: the drawer widens and hands the whole surface to
// SettingsProvidersPane and SettingsThreadStripPane. Panes that are pages are
// declared in useSettingsSurface, since the launcher's slide is measured from the
// same value.
//
// Thread strip is a page rather than a column list because the setting it holds
// can't be explained in a sentence — the page previews all three modes live, and a
// strip needs width to be a strip. It's also the shelf the rest of the strip's
// knobs will land on (gaps, snap feel, width steps).

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
// board's scroll behaviour live — no reload, no prop threaded across.
const { centerMode } = useStripPrefs();

// The active option, shown trailing the root row so the current choice reads
// without opening the page. The labels come from CENTER_MODES rather than a copy
// kept here, so the row and the page can't disagree about what a mode is called.
const currentCenterOption = computed(
  () => CENTER_MODES.find((o) => o.value === centerMode.value)?.label ?? "",
);

// ── agent providers ───────────────────────────────────────────────────────────
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
// Root lists the section groups; each detail pane ("shortcuts", "motion") is
// reached by tapping its row. The drawer always reopens at root so the user lands
// somewhere predictable, and leaving the shortcuts pane abandons any in-flight
// rebind capture.
//
// The pane lives in useSettingsSurface rather than here because the launcher
// slides aside by exactly this drawer's width, and one pane (Agent providers) is
// a page rather than a column — so the stage upstream has to know which pane is
// open to know how far to move.
const { pane, isPage, revealWidth } = useSettingsSurface();

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
    class="settings-scroll fixed inset-y-0 left-0 z-0 flex flex-col bg-sunken"
    :class="isPage ? 'overflow-hidden' : 'overflow-y-auto px-5 pt-16 pb-7'"
    :style="{ width: `${revealWidth}px` }"
    :aria-hidden="!open"
    role="dialog"
    aria-label="Settings and personalization"
  >
    <!-- Agent providers is a page, not a column: it takes the whole widened
         aside and lays itself out (masthead, rail, panel). The width change is
         deliberately not animated here — the stage sliding over the top of this
         panel is what uncovers it, so animating both would be two springs
         racing to describe one movement. -->
    <SettingsProvidersPane v-if="pane === 'providers'" :open="open" @back="backToRoot" />

    <!-- Both panes stack in one grid cell so the push transition overlaps them;
         the active pane is keyed and slides in over the outgoing one. -->
    <div v-else class="grid min-h-0 flex-1 content-start">
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
                {{ currentCenterOption }}
              </span>
            </button>
          </Magnet>

          <!-- Agent providers — opens the widened provider page (each CLI kone
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
                v-if="providerSummary"
                class="shrink-0 text-[12px] leading-tight text-muted"
              >
                {{ providerSummary }}
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

      <SettingsThreadStripPane v-else-if="pane === 'motion'" :open="open" @back="backToRoot" />

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

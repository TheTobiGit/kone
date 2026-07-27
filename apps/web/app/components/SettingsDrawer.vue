<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEventListener, usePreferredReducedMotion } from "@vueuse/core";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowTurnBackwardIcon,
  KeyboardIcon,
  RefreshIcon,
  UndoIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
} from "@hugeicons/core-free-icons";
import { Magnet } from "~/components/ui/magnet";
import type { ShortcutAction } from "~/composables/useShortcuts";

// The settings / personalization panel, in the spirit of X's account drawer.
// It doesn't float over the launcher — it sits pinned to the left edge, and the
// launcher itself slides aside (see index.vue's stage) to reveal it. So this is
// just the panel surface; the reveal lives upstream.
//
// The panel is a small navigable drawer: a root list of section groups (General,
// Personalization) that pushes into detail panes within the same 320px aside.
// Today the only detail pane is Shortcuts, which rebinds the app's custom,
// genuinely rebind-worthy gestures (currently just Switch project). OS-convention
// keys (⌘, / ⌘K) and fixed keys (Esc / Enter / type-to-compose) stay in the
// shortcut registry — handlers still consult them — but are deliberately hidden
// from the UI; there's no meaning in rebinding those.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { muted, toggleMuted, cue } = useSound();
const {
  personalizable,
  hasOverrides,
  isCustomized,
  conflictFor,
  rebind,
  reset,
  resetAll,
  captureFromEvent,
  displayTokens,
} = useShortcuts();

function onSoundToggle() {
  toggleMuted();
  // If we just switched sound back on, confirm it with a soft cue (a no-op the
  // other way, since cues stay silent while muted).
  cue("toggle");
}

// ── pane navigation ──────────────────────────────────────────────────────────
// Root lists the section groups; the one detail pane today is "shortcuts",
// reached by tapping the Shortcuts row. The drawer always reopens at root so the
// user lands somewhere predictable, and leaving the shortcuts pane abandons any
// in-flight rebind capture.
type Pane = "root" | "shortcuts";
const pane = ref<Pane>("root");

function openShortcuts() {
  pane.value = "shortcuts";
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
  if (pane.value === "shortcuts") {
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
    class="fixed inset-y-0 left-0 z-0 flex w-[320px] max-w-[80vw] flex-col overflow-y-auto bg-sunken px-5 pt-16 pb-7"
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
        </div>
      </motion.section>

      <!-- Shortcuts pane: rebinds the app's custom gestures. Lists only actions
           marked `personalize` in the registry — today, just Switch project.
           The pane reads as one continuous list: the title stands in for the
           section label, and the rows hang directly beneath it. -->
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

        <ul v-if="personalizable.length" class="flex flex-col">
          <li v-for="a in personalizable" :key="a.id">
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

        <p v-else class="px-3 text-[11px] leading-snug text-muted">
          No customizable shortcuts yet.
        </p>
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

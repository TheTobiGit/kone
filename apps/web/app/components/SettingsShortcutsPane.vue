<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { KeyboardIcon, RefreshIcon, UndoIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import type { ShortcutAction } from "~/composables/useShortcuts";

// Keyboard shortcuts as a settings page — same widened shell as Profile and
// Thread strip. The column list used to live in the drawer itself because the
// rows were just label + chips; once every other Personalization item became a
// page, leaving this one as a 320px push-in made it read as nested rather than
// a peer. The rebind capture still owns Esc (one Esc leaves capture, a second
// walks back) so it stays on this pane, not the drawer.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { cue } = useSound();
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

const capturingId = ref<string | null>(null);
const captureMsg = ref<string>("");

function prettyBinding(action: { binding: string }): string[] {
  return displayTokens(action.binding);
}

function cancelCapture() {
  capturingId.value = null;
  captureMsg.value = "";
}

function startCapture(action: ShortcutAction, e: MouseEvent) {
  if (!action.rebindable || !props.open) return;
  capturingId.value = action.id;
  captureMsg.value = "";
  cue("press");
  // SAFETY: currentTarget is the <button> this handler is bound to while
  // dispatch runs; after nextTick it may already be nulled, hence | null.
  nextTick(() => (e.currentTarget as HTMLElement | null)?.focus());
}

function onCaptureKeydown(e: KeyboardEvent) {
  if (!capturingId.value || !props.open) return;
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

useEventListener(window, "keydown", onCaptureKeydown, { capture: true });

watch(
  () => props.open,
  (open) => {
    if (!open) cancelCapture();
  },
);

function goBack() {
  cancelCapture();
  emit("back");
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Personalization / Keyboard shortcuts"
    :breadcrumb-icon="KeyboardIcon"
    label="Keyboard shortcuts"
    @back="goBack"
  >
    <template #actions v-if="hasOverrides">
      <button
        type="button"
        class="sk__reset"
        :tabindex="open ? 0 : -1"
        @click="resetAll"
      >
        <HugeiconsIcon :icon="UndoIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        Reset all
      </button>
    </template>

    <div v-if="personalizableGroups.length" class="sk__groups">
      <section
        v-for="g in personalizableGroups"
        :key="g.group"
        class="sk__group"
        :aria-label="g.group"
      >
        <p class="sk__label">{{ g.group }}</p>
        <ul class="sk__list">
          <li v-for="a in g.items" :key="a.id" class="sk__row">
            <div class="sk__copy">
              <span class="sk__name">{{ a.label }}</span>
              <span v-if="a.description ?? a.hint" class="sk__hint">
                {{ a.description ?? a.hint }}
              </span>
            </div>

            <div class="sk__keys">
              <button
                type="button"
                class="sk__chip"
                :class="{ 'sk__chip--listen': capturingId === a.id }"
                :tabindex="open ? 0 : -1"
                :aria-label="
                  capturingId === a.id
                    ? `Press a new key combination for ${a.label}; Escape cancels`
                    : `Rebind ${a.label}`
                "
                @click="startCapture(a, $event)"
              >
                <span v-if="capturingId === a.id" class="sk__listen">Press keys…</span>
                <template v-else>
                  <kbd v-for="(tok, i) in prettyBinding(a)" :key="i" class="sk__kbd">
                    {{ tok }}
                  </kbd>
                </template>
              </button>

              <button
                v-if="isCustomized(a.id)"
                type="button"
                class="sk__undo"
                :tabindex="open ? 0 : -1"
                :aria-label="`Reset ${a.label} to its default`"
                title="Reset shortcut"
                @click="reset(a.id)"
              >
                <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>

            <p v-if="capturingId === a.id && captureMsg" class="sk__err" role="alert">
              {{ captureMsg }}
            </p>
          </li>
        </ul>
      </section>
    </div>

    <p v-else class="sk__empty">No customizable shortcuts yet.</p>

    <template #foot>
      Only kone's own gestures live here. OS conventions and keys the app can't
      mean anything else by (Escape, Enter, type-to-compose) stay bound where they
      are — handlers still consult them, they just aren't offered to rebind.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.sk__reset {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms ease;
}
.sk__reset:hover {
  background-color: var(--hover);
}
.sk__reset:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.sk__groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
  gap: 2rem 2.75rem;
  max-width: 52rem;
  /* The pane note sits over the bottom-left; last rows need room under it. */
  padding-bottom: 2.75rem;
}

.sk__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.sk__label {
  padding-inline: 2px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.sk__list {
  display: flex;
  flex-direction: column;
}

.sk__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 12px;
  padding-block: 10px;
}

.sk__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.sk__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 1.25;
  color: var(--ink);
}

.sk__hint {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--muted);
  text-wrap: pretty;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.sk__keys {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
}

.sk__chip {
  display: flex;
  min-width: 64px;
  cursor: pointer;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  border-radius: 8px;
  padding: 4px 6px;
  transition: background-color 140ms ease;
}
.sk__chip:hover,
.sk__chip--listen,
.sk__chip:focus-visible {
  background-color: var(--hover);
}
.sk__chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.sk__listen {
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
}

.sk__kbd {
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, var(--muted) 25%, transparent);
  background: var(--hover);
  padding: 2px 6px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1;
  color: var(--ink-soft);
}

.sk__undo {
  display: flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.sk__undo:hover,
.sk__undo:focus-visible {
  background-color: var(--hover);
  color: var(--ink);
}
.sk__undo:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.sk__err {
  grid-column: 1 / -1;
  font-size: 11px;
  line-height: 1.35;
  color: #ef4444;
}

.sk__empty {
  font-size: 13px;
  line-height: 1.45;
  color: var(--muted);
}
</style>

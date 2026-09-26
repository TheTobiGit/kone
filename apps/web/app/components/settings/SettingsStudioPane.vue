<script setup lang="ts">
import { onMounted, ref } from "vue";
import { DashboardSquare01Icon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import SettingsInlineChoice from "~/components/settings/SettingsInlineChoice.vue";
import { usePaneWidthPrefs } from "~/composables/usePaneWidthPrefs";
import type { PaneKind } from "~/types/studio";
import { CENTER_MODES, LADDER_PX, type CenterMode } from "~/utils/stripScroll";

// The Studio page — how the board behaves: when the strip recentres on the
// column you focus, how wide each kind of pane opens, and how long an unused
// worktree stays on disk.
//
// All defaults and feel, not live state: a pane already on the board keeps the
// width it was given, and a thread keeps its worktree while it's worked in.

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

// ── thread strip ──────────────────────────────────────────────────────────────
// The same module-scope ref the strip reads, so a pick here steers the board
// live. The labels come from CENTER_MODES, the strip's own names for them.
const { centerMode } = useStripPrefs();
const CENTER_OPTIONS = CENTER_MODES.map((m) => ({ id: m.value, label: m.label }));
function chooseCenter(id: string) {
  const mode = CENTER_MODES.find((m) => m.value === id);
  if (mode) centerMode.value = mode.value satisfies CenterMode;
}

// ── default pane widths ───────────────────────────────────────────────────────
// What width a newly opened pane takes, per kind. A pane already on the board
// keeps the width it was given — these only seed the next one, and they're the
// strip's own rungs, so a choice here is the width the strip will actually use.
const { paneWidths, defaultWidth, setDefaultWidth } = usePaneWidthPrefs();

const WIDTH_OPTIONS = LADDER_PX.map((px, i) => ({ id: String(i), label: `${px}px` }));

/** One row per kind, named for the thing it opens rather than its internal kind.
 *  `paneName` is the same thing in a sentence, for the control's aria label. */
const WIDTH_ROWS: { kind: PaneKind; title: string; paneName: string }[] = [
  { kind: "thread", title: "Chat width", paneName: "chat pane" },
  { kind: "terminal", title: "Terminal width", paneName: "terminal" },
  { kind: "scratchpad", title: "Scratchpad width", paneName: "scratchpad" },
];

/** Read through the stored record so a change re-renders the row. */
function widthValue(kind: PaneKind): string {
  void paneWidths.value;
  return String(defaultWidth(kind));
}

function chooseWidth(kind: PaneKind, id: string) {
  setDefaultWidth(kind, Number(id));
}

// ── worktree cleanup ──────────────────────────────────────────────────────────
// How long a worktree nobody works in stays on disk. Only a worktree that would
// lose nothing is removed, its branch is kept, and opening its thread again
// builds a fresh one — so this is a disk setting, not a risk setting. Stored by
// the desktop app, which runs the cleanup; absent outside it.
const CLEANUP_OPTIONS = [
  { id: "off", label: "Never" },
  { id: "7", label: "7 days" },
  { id: "14", label: "14 days" },
  { id: "30", label: "30 days" },
];
const cleanupDays = ref<string | null>(null);
onMounted(async () => {
  const days = await window.koneDesktop?.agent?.worktreeCleanupDays?.().catch(() => undefined);
  if (days !== undefined) cleanupDays.value = days === null ? "off" : String(days);
});

async function chooseCleanup(id: string) {
  if (cleanupDays.value === id) return;
  cleanupDays.value = id;
  const saved = await window.koneDesktop?.agent
    ?.setWorktreeCleanupDays?.(id === "off" ? null : Number(id))
    .catch(() => undefined);
  if (saved !== undefined) cleanupDays.value = saved === null ? "off" : String(saved);
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Workspaces / Studio"
    :breadcrumb-icon="DashboardSquare01Icon"
    label="Studio settings"
    @back="$emit('back')"
  >
    <div class="srow__group">
      <h2 class="srow__heading">Thread strip</h2>
      <div class="srow__rows">
        <div class="srow__row">
          <h3 class="srow__title">Center focused column</h3>

          <SettingsInlineChoice
            :options="CENTER_OPTIONS"
            :value="centerMode"
            :tabbable="open"
            setting="when the strip centres the focused column"
            @pick="chooseCenter"
          />
        </div>
      </div>
    </div>

    <!-- Panes — how wide each kind opens. The rungs are the strip's own, so a
         choice here is the width the board will actually use. -->
    <div class="srow__group">
      <h2 class="srow__heading">Panes</h2>
      <div class="srow__rows">
        <div v-for="row in WIDTH_ROWS" :key="row.kind" class="srow__row">
          <h3 class="srow__title">{{ row.title }}</h3>

          <SettingsInlineChoice
            :options="WIDTH_OPTIONS"
            :value="widthValue(row.kind)"
            :tabbable="open"
            :setting="`the width a new ${row.paneName} opens at`"
            @pick="(id) => chooseWidth(row.kind, id)"
          />
        </div>
      </div>
    </div>

    <!-- Worktrees — how long one nobody works in stays on disk. -->
    <div v-if="cleanupDays !== null" class="srow__group">
      <h2 class="srow__heading">Worktrees</h2>
      <div class="srow__rows">
        <div class="srow__row">
          <h3 class="srow__title" title="Only a worktree with nothing unsaved in it is removed. Its branch stays, and opening the chat again rebuilds it.">
            Remove unused after
          </h3>

          <SettingsInlineChoice
            :options="CLEANUP_OPTIONS"
            :value="cleanupDays"
            :tabbable="open"
            setting="how long an unused worktree is kept"
            @pick="chooseCleanup"
          />
        </div>
      </div>
    </div>

    <template #foot>
      Pane widths are defaults — a pane already on the board keeps the width it was given. The
      strip's centring applies as soon as you pick it.
    </template>
  </SettingsPageShell>
</template>

<style scoped src="./settingsRows.css"></style>

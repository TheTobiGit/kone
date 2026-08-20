<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, PuzzleIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import type { SkillEntry } from "~/types/desktop";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import AgentSettingsSkills from "~/components/AgentSettingsSkills.vue";
import SkillDetailView from "~/components/SkillDetailView.vue";
import SkillAddSheet from "~/components/SkillAddSheet.vue";
import { useAgentSettings } from "~/composables/useAgentSettings";
import { useSkills } from "~/composables/useSkills";

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

// The pane is two views on one page: the list, and one skill's own page. The
// breadcrumb carries which — "Ecosystem / Skills" or "Ecosystem / Skills / <name>" —
// and the shell's back glyph walks the same path, so the way out of a skill is
// the way out of everything else.

const projectPath = () => null;
const space = useAgentSettings(projectPath);
const skills = useSkills(projectPath);

const selected = ref<SkillEntry | null>(null);
const adding = ref(false);
const rescanning = ref(false);

onMounted(() => {
  void space.load();
});

function show(skill: SkillEntry) {
  adding.value = false;
  selected.value = skill;
  void skills.openSkill(skill);
}

function close() {
  selected.value = null;
  adding.value = false;
}

async function rescan() {
  rescanning.value = true;
  await space.refreshInventory();
  rescanning.value = false;
}

/** A skill that just landed on disk is not in the list yet, so arriving back at
 *  the list without rescanning would look like the write did nothing. */
async function added() {
  adding.value = false;
  await rescan();
}

const breadcrumb = computed(() => {
  if (adding.value) return "Ecosystem / Skills / New";
  if (selected.value) return `Ecosystem / Skills / ${selected.value.displayName ?? selected.value.name}`;
  return "Ecosystem / Skills";
});

const atList = computed(() => !selected.value && !adding.value);
</script>

<template>
  <SettingsPageShell
    :open="open"
    :breadcrumb="breadcrumb"
    :breadcrumb-icon="PuzzleIcon"
    label="Agent skills settings"
    @back="atList ? $emit('back') : close()"
  >
    <template #actions>
      <template v-if="atList">
        <button
          type="button"
          class="sp__btn"
          :disabled="rescanning"
          :tabindex="open ? 0 : -1"
          @click="rescan"
        >
          <HugeiconsIcon
            :icon="RefreshIcon"
            :size="13"
            :stroke-width="1.8"
            :class="{ 'sp__spin': rescanning }"
            aria-hidden="true"
          />
          {{ rescanning ? "Scanning…" : "Scan again" }}
        </button>
        <button type="button" class="sp__btn" :tabindex="open ? 0 : -1" @click="adding = true">
          <HugeiconsIcon :icon="Add01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          Add a skill
        </button>
      </template>
    </template>

    <SkillAddSheet v-if="adding" :skills="skills" @done="added" />
    <SkillDetailView
      v-else-if="selected"
      :skill="selected"
      :skills="skills"
      :project-path="null"
      @removed="rescan"
    />
    <AgentSettingsSkills v-else :space="space" :skills="skills" @open="show" />

    <template #foot>
      Every skill found on this machine across Claude, Codex, OpenCode, Cursor, Factory, and Agents.
      Turning one off writes the setting file its own CLI already reads — kone keeps no switch of its
      own, so a CLI with no such setting is reported rather than faked.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.sp__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.sp__btn:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.sp__btn:disabled {
  color: var(--muted);
  cursor: default;
}
.sp__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.sp__spin {
  animation: sp-spin 900ms linear infinite;
}
@keyframes sp-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sp__spin {
    animation: none;
  }
}
</style>

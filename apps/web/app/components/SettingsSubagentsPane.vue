<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  Add01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  RoboticIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import PresetModelList from "~/components/PresetModelList.vue";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import { useSubagentPresets } from "~/composables/useSubagentPresets";
import { useSound } from "~/composables/useSound";
import type { AgentModelRef, SubagentPresetRecord } from "~/types/desktop";

// §3.4's preset sub-agents surface: the reusable definitions an agent cuts a
// spawn from. A list of presets, each opening into a light editor — name, the
// standing instructions the child wakes up to, and the one model it runs on. No
// face, no role, no policies: a preset is lighter than an agent on purpose, just
// enough to name a repeatable job and say how it should run.

const props = defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const { presets, createPreset, updatePreset, deletePreset } = useSubagentPresets();
const { cue } = useSound();

const openId = ref<string | null>(null);
const isCreating = ref(false);
const isDeleting = ref(false);

const current = computed<SubagentPresetRecord | undefined>(() =>
  presets.value.find((p) => p.presetId === openId.value),
);

// A blank draft the create form binds to. Kept apart from the stored rows so
// typing a new preset never touches one until it's actually created.
const draft = reactive<{ name: string; instructions: string; model: AgentModelRef | null }>({
  name: "",
  instructions: "",
  model: null,
});

// Closing the drawer returns to the list, so reopening it doesn't drop you back
// inside whichever preset or flow you last looked at.
watch(
  () => props.open,
  (open) => {
    if (!open) closeToList();
  },
);

function closeToList() {
  openId.value = null;
  isCreating.value = false;
  isDeleting.value = false;
}

function openPreset(id: string) {
  openId.value = id;
  isDeleting.value = false;
  cue("press");
}

function startCreate() {
  draft.name = "";
  draft.instructions = "";
  draft.model = null;
  isCreating.value = true;
  cue("open");
}

async function submitDraft() {
  const name = draft.name.trim();
  if (!name) return;
  const row = await createPreset({
    name,
    instructions: draft.instructions.trim() || null,
    model: draft.model,
  });
  if (row) {
    isCreating.value = false;
    openId.value = row.presetId;
  }
}

// Edits to an open preset persist as they happen — no separate save. The name
// is the one field that can't be blanked, so an empty value is simply not sent;
// the input still shows it, and the stored name stands until a real one lands.
function setName(value: string) {
  const preset = current.value;
  if (!preset) return;
  const name = value.trim();
  if (!name) return;
  void updatePreset(preset.presetId, { name });
}
function setInstructions(value: string) {
  const preset = current.value;
  if (preset) void updatePreset(preset.presetId, { instructions: value.trim() || null });
}
function setModel(next: AgentModelRef | null) {
  const preset = current.value;
  if (preset) void updatePreset(preset.presetId, { model: next });
}

async function handleDelete() {
  const preset = current.value;
  if (!preset) return;
  const ok = await deletePreset(preset.presetId);
  if (ok) {
    cue("press");
    closeToList();
  }
}

/** A one-line read of a preset's model for the card. */
function modelSummary(preset: SubagentPresetRecord): string {
  if (!preset.model) return "Any model";
  return preset.model.label ?? preset.model.model;
}

/** A short snippet of the instructions for the card body. */
function snippetFor(preset: SubagentPresetRecord): string {
  const first = preset.instructions?.split(/\n{2,}/)[0]?.trim();
  return first || "No standing instructions yet.";
}
</script>

<template>
  <!-- Detail / create editor -->
  <SettingsPageShell
    v-if="current || isCreating"
    :open="open"
    :breadcrumb="`Ecosystem / Sub-agents / ${isCreating ? 'New' : (current?.name ?? '')}`"
    :breadcrumb-icon="RoboticIcon"
    :label="isCreating ? 'New sub-agent' : (current?.name ?? '')"
    @back="isCreating ? (isCreating = false) : (openId = null)"
  >
    <template v-if="current && !isCreating" #actions>
      <button
        type="button"
        class="sa__action-btn sa__action-btn--danger"
        title="Delete this preset"
        :tabindex="open ? 0 : -1"
        @click="isDeleting ? handleDelete() : (isDeleting = true)"
      >
        <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        <span>{{ isDeleting ? "Confirm delete" : "Delete" }}</span>
      </button>
    </template>

    <div class="sa__editor">
      <label class="sa__field">
        <span class="sa__field-label">Name</span>
        <input
          v-if="isCreating"
          v-model="draft.name"
          type="text"
          class="sa__input"
          placeholder="e.g. Explorer"
          :tabindex="open ? 0 : -1"
          @keydown.enter.prevent="submitDraft"
        />
        <input
          v-else
          :value="current?.name"
          type="text"
          class="sa__input"
          :tabindex="open ? 0 : -1"
          @input="setName(($event.target as HTMLInputElement).value)"
        />
      </label>

      <label class="sa__field">
        <span class="sa__field-label">Instructions</span>
        <span class="sa__field-hint">
          The standing brief the sub-agent wakes up to, laid ahead of the specific task on each
          spawn.
        </span>
        <textarea
          v-if="isCreating"
          v-model="draft.instructions"
          class="sa__textarea"
          rows="5"
          placeholder="What this sub-agent is for, and how it should work."
          :tabindex="open ? 0 : -1"
        />
        <textarea
          v-else
          :value="current?.instructions ?? ''"
          class="sa__textarea"
          rows="5"
          :tabindex="open ? 0 : -1"
          @input="setInstructions(($event.target as HTMLTextAreaElement).value)"
        />
      </label>

      <section class="sa__field" aria-label="Model">
        <PresetModelList
          v-if="isCreating"
          :model="draft.model"
          @update:model="(m) => (draft.model = m)"
        />
        <PresetModelList
          v-else-if="current"
          :model="current.model"
          @update:model="setModel"
        />
      </section>

      <div v-if="isCreating" class="sa__create-actions">
        <button
          type="button"
          class="sa__cancel-btn"
          :tabindex="open ? 0 : -1"
          @click="isCreating = false"
        >
          Cancel
        </button>
        <button
          type="button"
          class="sa__submit-btn"
          :disabled="!draft.name.trim()"
          :tabindex="open ? 0 : -1"
          @click="submitDraft"
        >
          Create sub-agent
        </button>
      </div>
    </div>

    <template #foot>
      A preset is a reusable sub-agent an agent invokes when it needs one — a name, a standing
      brief, and which model runs it. It isn't a member of the roster and keeps no history of its
      own; each spawn copies its brief and resolves its model afresh.
    </template>
  </SettingsPageShell>

  <!-- List -->
  <SettingsPageShell
    v-else
    :open="open"
    breadcrumb="Ecosystem / Sub-agents"
    :breadcrumb-icon="RoboticIcon"
    label="Sub-agents"
    @back="$emit('back')"
  >
    <template #actions>
      <button
        type="button"
        class="sa__new-action-btn"
        :tabindex="open ? 0 : -1"
        @click="startCreate"
      >
        <HugeiconsIcon :icon="Add01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
        <span>New sub-agent</span>
      </button>
    </template>

    <div class="sa">
      <div class="sa__grid" role="list" aria-label="Preset sub-agents">
        <article
          v-for="p in presets"
          :key="p.presetId"
          role="listitem"
          class="sa__card"
          :tabindex="open ? 0 : -1"
          :aria-label="p.name"
          @click="openPreset(p.presetId)"
          @keydown.enter.prevent="openPreset(p.presetId)"
          @keydown.space.prevent="openPreset(p.presetId)"
        >
          <div class="sa__card-head">
            <span class="sa__glyph" aria-hidden="true">
              <HugeiconsIcon :icon="RoboticIcon" :size="18" :stroke-width="1.7" />
            </span>
            <div class="sa__ident">
              <h4 class="sa__name">{{ p.name }}</h4>
              <p class="sa__model">{{ modelSummary(p) }}</p>
            </div>
            <span class="sa__open-cue" aria-hidden="true">
              <HugeiconsIcon :icon="ArrowRight01Icon" :size="15" :stroke-width="1.8" />
            </span>
          </div>

          <p class="sa__snippet">{{ snippetFor(p) }}</p>
        </article>

        <button
          type="button"
          class="sa__card sa__card--create"
          role="listitem"
          :tabindex="open ? 0 : -1"
          aria-label="Create a new sub-agent"
          @click="startCreate"
        >
          <div class="sa__card-head">
            <span class="sa__create-icon-wrap" aria-hidden="true">
              <HugeiconsIcon :icon="Add01Icon" :size="20" :stroke-width="2" />
            </span>
            <div class="sa__ident">
              <h4 class="sa__name">New sub-agent</h4>
              <p class="sa__model">Reusable preset</p>
            </div>
          </div>
          <p class="sa__snippet sa__snippet--create">
            Name a repeatable job, write its standing brief, and rank the models it should run on.
          </p>
        </button>
      </div>
    </div>

    <template #foot>
      Sub-agents are reusable definitions any agent can invoke without setting one up first —
      Explorer to map code, Code Reviewer to read a diff, and so on. Each carries a name, a standing
      brief, and an ordered model preference; the runtime takes the first model that can run and
      falls to the next when it can't.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.sa {
  --sa-ease: cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 56rem;
  padding-block: 4px 3rem;
  container-type: inline-size;
}

/* ── masthead action buttons ──────────────────────────────────────────────── */
.sa__new-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--accent-ink);
  background-color: var(--accent);
  cursor: pointer;
  white-space: nowrap;
  transition:
    opacity 140ms ease,
    filter 140ms ease;
}
.sa__new-action-btn:hover {
  filter: brightness(1.05);
}
.sa__new-action-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.sa__action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding-inline: 10px;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.sa__action-btn:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.sa__action-btn--danger:hover {
  background-color: color-mix(in srgb, #e05252 14%, transparent);
  color: #e05252;
}

/* ── cards grid ───────────────────────────────────────────────────────────── */
.sa__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}
@container (min-width: 540px) {
  .sa__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.sa__card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 16px;
  background-color: color-mix(in srgb, var(--ink) 3%, transparent);
  cursor: pointer;
  outline: none;
  text-align: start;
  border: 1px solid transparent;
  transition:
    background-color 200ms var(--sa-ease),
    transform 200ms var(--sa-ease),
    border-color 200ms var(--sa-ease);
}
.sa__card:hover {
  background-color: var(--hover);
  transform: translateY(-1px);
}
.sa__card:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.sa__card--create {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--ink) 12%, transparent);
  background-color: color-mix(in srgb, var(--ink) 1.5%, transparent);
}
.sa__card--create:hover {
  border-color: color-mix(in srgb, var(--ink) 28%, transparent);
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
}

.sa__card-head {
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: 0;
}

.sa__glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--ink-soft);
  transition:
    color 200ms ease,
    background-color 200ms ease;
}
.sa__card:hover .sa__glyph {
  color: var(--accent);
  background-color: color-mix(in oklab, var(--accent) 14%, transparent);
}

.sa__create-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--muted);
  transition:
    background-color 200ms ease,
    color 200ms ease,
    transform 200ms var(--sa-ease);
}
.sa__card--create:hover .sa__create-icon-wrap {
  background-color: color-mix(in oklab, var(--accent) 15%, transparent);
  color: var(--accent);
  transform: scale(1.05);
}

.sa__ident {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.sa__name {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.2;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa__model {
  margin: 0;
  font-size: 12px;
  line-height: 1.2;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sa__open-cue {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  opacity: 0;
  transform: translateX(-3px);
  transition:
    opacity 160ms ease,
    transform 160ms var(--sa-ease),
    color 160ms ease;
}
.sa__card:hover .sa__open-cue {
  opacity: 1;
  transform: translateX(0);
  color: var(--ink);
}

.sa__snippet {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-clamp: 2;
  overflow: hidden;
  text-wrap: pretty;
  min-height: 2.9em;
}
.sa__snippet--create {
  color: var(--muted);
}

/* ── editor ───────────────────────────────────────────────────────────────── */
.sa__editor {
  display: flex;
  flex-direction: column;
  gap: 26px;
  max-width: 48rem;
  padding-bottom: 2.5rem;
}
.sa__field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sa__field-label {
  font-size: 13px;
  color: var(--ink);
}
.sa__field-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  max-width: 60ch;
  text-wrap: pretty;
}
.sa__input,
.sa__textarea {
  width: 100%;
  font: inherit;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 3.5%, transparent);
  border: 0;
  border-radius: 12px;
  padding: 11px 13px;
  outline: none;
  transition: box-shadow 0.16s ease, background-color 0.16s ease;
}
.sa__textarea {
  resize: vertical;
  min-height: 7rem;
}
.sa__input::placeholder,
.sa__textarea::placeholder {
  color: var(--faint);
}
.sa__input:focus,
.sa__textarea:focus {
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 34%, transparent);
}

.sa__create-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.sa__cancel-btn {
  height: 32px;
  padding-inline: 14px;
  border-radius: 9px;
  font-size: 12.5px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.sa__cancel-btn:hover {
  background: var(--hover);
  color: var(--ink);
}
.sa__submit-btn {
  height: 32px;
  padding-inline: 16px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--accent-ink);
  background: var(--accent);
  cursor: pointer;
  transition:
    filter 140ms ease,
    opacity 140ms ease;
}
.sa__submit-btn:hover:not(:disabled) {
  filter: brightness(1.05);
}
.sa__submit-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .sa__card,
  .sa__glyph,
  .sa__open-cue,
  .sa__create-icon-wrap {
    transition: none;
    transform: none;
  }
}
</style>

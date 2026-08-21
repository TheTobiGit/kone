<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  Add01Icon,
  ArrowRight01Icon,
  Tick02Icon,
  UserAdd01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import SettingsAgentDetail from "~/components/SettingsAgentDetail.vue";
import CreateAgentModal from "~/components/CreateAgentModal.vue";
import { useAgentRoster } from "~/composables/useAgentRoster";
import { useProject } from "~/composables/useProject";
import { useSound } from "~/composables/useSound";
import type { Agent } from "~/utils/agents";

const props = defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const { roster, projectPath, isOnTeam, addToTeam, removeFromTeam } = useAgentRoster();
const project = useProject();
/** The project a membership toggle acts on — its name for the labels. */
const projectName = computed(() => project.value?.name ?? "this project");
const { cue } = useSound();
const openId = ref<string | null>(null);
const isCreating = ref(false);

/** Add the agent to the active project's team, or take it off. A no-op off a
 *  project — the toggle only shows when one is open. */
async function toggleTeam(agent: Agent) {
  if (isOnTeam(agent.id)) {
    await removeFromTeam(agent.id);
    cue("collapse");
  } else {
    await addToTeam(agent.id);
    cue("select");
  }
}

// Closing the drawer returns you to the list, so reopening it doesn't drop you
// back inside whichever agent or flow you last looked at.
watch(
  () => props.open,
  (open) => {
    if (!open) {
      openId.value = null;
      isCreating.value = false;
    }
  },
);

function openAgent(id: string) {
  openId.value = id;
  cue("press");
}

function startCreate() {
  isCreating.value = true;
  cue("open");
}

function onCreated(agent: Agent) {
  isCreating.value = false;
  openId.value = agent.id;
}

/** Extract a brief introductory snippet from an agent's standing instructions. */
function snippetFor(agent: Agent): string {
  if (agent.instructions) {
    const para = agent.instructions.split(/\n{2,}/)[0]?.trim();
    if (para) return para.replace(/^\*\*(.+?)\*\*\s*/, "$1 — ");
  }
  return "Ready for work across any conversation.";
}

/** Count the number of distinct directive blocks in standing instructions. */
function directiveCount(text?: string): number {
  if (!text) return 0;
  return text.split(/\n{2,}/).map((r) => r.trim()).filter(Boolean).length;
}
</script>

<template>
  <CreateAgentModal
    v-if="isCreating"
    @close="isCreating = false"
    @created="onCreated"
  />

  <SettingsAgentDetail
    v-if="openId"
    :open="open"
    :agent-id="openId"
    @back="openId = null"
    @switched="(id) => (openId = id)"
  />

  <SettingsPageShell
    v-else
    :open="open"
    breadcrumb="Ecosystem / Agents"
    :breadcrumb-icon="UserGroupIcon"
    label="Agents"
    @back="$emit('back')"
  >
    <template #actions>
      <button
        type="button"
        class="ag__new-action-btn"
        :tabindex="open ? 0 : -1"
        @click="startCreate"
      >
        <HugeiconsIcon :icon="Add01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
        <span>New agent</span>
      </button>
    </template>

    <div class="ag">
      <!-- Agent Cards Grid -->
      <div class="ag__grid" role="list" aria-label="Available agents">
        <article
          v-for="c in roster"
          :key="c.id"
          role="listitem"
          class="ag__card"
          :tabindex="open ? 0 : -1"
          :aria-label="`${c.name}, ${c.role}`"
          @click="openAgent(c.id)"
          @keydown.enter.prevent="openAgent(c.id)"
          @keydown.space.prevent="openAgent(c.id)"
        >
          <!-- Top Row: Face + Identity -->
          <div class="ag__card-head">
            <span class="ag__face" v-html="c.svg" />
            <div class="ag__ident">
              <h4 class="ag__name">{{ c.name }}</h4>
              <p class="ag__role">{{ c.role || "Agent" }}</p>
            </div>
            <span class="ag__open-cue" aria-hidden="true">
              <HugeiconsIcon :icon="ArrowRight01Icon" :size="15" :stroke-width="1.8" />
            </span>
          </div>

          <!-- Body: instruction preview snippet -->
          <p class="ag__snippet">
            {{ snippetFor(c) }}
          </p>

          <!-- Foot: Capability Chips + project-team toggle -->
          <div class="ag__card-foot">
            <div class="ag__chips">
              <span v-if="c.instructions" class="ag__chip">
                {{ directiveCount(c.instructions) }} rules
              </span>
            </div>
            <button
              v-if="projectPath"
              type="button"
              class="ag__team"
              :class="{ 'ag__team--on': isOnTeam(c.id) }"
              :tabindex="open ? 0 : -1"
              :aria-pressed="isOnTeam(c.id)"
              :aria-label="
                isOnTeam(c.id)
                  ? `Remove ${c.name} from ${projectName}'s team`
                  : `Add ${c.name} to ${projectName}'s team`
              "
              @click.stop="toggleTeam(c)"
              @keydown.enter.stop
              @keydown.space.stop
            >
              <HugeiconsIcon
                :icon="isOnTeam(c.id) ? Tick02Icon : UserAdd01Icon"
                :size="12"
                :stroke-width="2"
                aria-hidden="true"
              />
              <span>{{ isOnTeam(c.id) ? "On the team" : "Add to team" }}</span>
            </button>
          </div>
        </article>

        <!-- Create New Agent Card -->
        <button
          type="button"
          class="ag__card ag__card--create"
          role="listitem"
          :tabindex="open ? 0 : -1"
          aria-label="Create a new agent"
          @click="startCreate"
        >
          <div class="ag__card-head">
            <span class="ag__create-icon-wrap" aria-hidden="true">
              <HugeiconsIcon :icon="Add01Icon" :size="20" :stroke-width="2" />
            </span>
            <div class="ag__ident">
              <h4 class="ag__name">New agent</h4>
              <p class="ag__role">Custom colleague</p>
            </div>
          </div>

          <p class="ag__snippet ag__snippet--create">
            Define unique character, standing orders, and avatar paint for any workflow.
          </p>

          <div class="ag__card-foot">
            <span class="ag__create-hint">Click to create &rarr;</span>
          </div>
        </button>
      </div>
    </div>

    <template #foot>
      An agent is whoever does the work, kept apart from the threads they do it in, so the same name
      and face follow them across every conversation. Pick one in the composer to hand it the next
      turn; leave it on Guest and the thread gets a name and a face of its own, good for that
      conversation and nothing beyond it. A named agent is told its name and, when it has them, its
      instructions for how to work; it answers to the name and follows the instructions. The role and
      face stay here in the drawer; nothing else about it reaches the model.
      <template v-if="projectPath">
        Add an agent to {{ projectName }}'s team to make it available to work here — the composer
        offers a project's team, and a teammate can delegate only to another. Membership is per
        project; an agent can be on many.
      </template>
      <template v-else>
        Open a project to build its team — the agents made available to work within it.
      </template>
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.ag {
  --ag-ease: cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 56rem;
  padding-block: 4px 3rem;
  container-type: inline-size;
}

/* ── masthead action button ───────────────────────────────────────────────── */
.ag__new-action-btn {
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
.ag__new-action-btn:hover {
  filter: brightness(1.05);
}
.ag__new-action-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── agent cards grid ─────────────────────────────────────────────────────── */
.ag__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}
@container (min-width: 540px) {
  .ag__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.ag__card {
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
    background-color 200ms var(--ag-ease),
    transform 200ms var(--ag-ease),
    border-color 200ms var(--ag-ease),
    box-shadow 200ms var(--ag-ease);
}
.ag__card:hover {
  background-color: var(--hover);
  transform: translateY(-1px);
}
.ag__card:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── create agent card ────────────────────────────────────────────────────── */
.ag__card--create {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--ink) 12%, transparent);
  background-color: color-mix(in srgb, var(--ink) 1.5%, transparent);
}
.ag__card--create:hover {
  border-color: color-mix(in srgb, var(--ink) 28%, transparent);
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
}

.ag__create-icon-wrap {
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
    transform 200ms var(--ag-ease);
}
.ag__card--create:hover .ag__create-icon-wrap {
  background-color: color-mix(in oklab, var(--accent) 15%, transparent);
  color: var(--accent);
  transform: scale(1.05);
}

.ag__snippet--create {
  color: var(--muted);
}

.ag__create-hint {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  transition: color 140ms ease;
}
.ag__card--create:hover .ag__create-hint {
  color: var(--ink);
}

/* ── card header ─────────────────────────────────────────────────────────── */
.ag__card-head {
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: 0;
}

.ag__face {
  display: block;
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.12));
  transition: transform 240ms var(--ag-ease);
}
.ag__card:hover .ag__face {
  transform: scale(1.04);
}
.ag__face :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.ag__ident {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.ag__name {
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

.ag__role {
  margin: 0;
  font-size: 12px;
  line-height: 1.2;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ag__open-cue {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  opacity: 0;
  transform: translateX(-3px);
  transition:
    opacity 160ms ease,
    transform 160ms var(--ag-ease),
    color 160ms ease;
}
.ag__card:hover .ag__open-cue {
  opacity: 1;
  transform: translateX(0);
  color: var(--ink);
}

/* ── snippet preview ──────────────────────────────────────────────────────── */
.ag__snippet {
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

/* ── card footer ─────────────────────────────────────────────────────────── */
.ag__card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 2px;
}

.ag__chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ag__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

/* ── project-team toggle ──────────────────────────────────────────────────── */
.ag__team {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.ag__team:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.ag__team:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.ag__team--on {
  color: var(--accent);
  background-color: color-mix(in oklab, var(--accent) 14%, transparent);
}
.ag__team--on:hover {
  color: var(--accent);
  background-color: color-mix(in oklab, var(--accent) 22%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .ag__card,
  .ag__face,
  .ag__open-cue,
  .ag__create-icon-wrap {
    transition: none;
    transform: none;
  }
}
</style>



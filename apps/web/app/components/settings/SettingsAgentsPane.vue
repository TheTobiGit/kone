<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Add01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import SettingsAgentDetail from "~/components/settings/SettingsAgentDetail.vue";
import CreateAgentModal from "~/components/agent/CreateAgentModal.vue";
import { useAgentRoster } from "~/composables/useAgentRoster";
import { useRecentProjects } from "~/composables/useRecentProjects";
import { useSound } from "~/composables/useSound";
import { botGround, botMark } from "~/utils/bot";
import type { Agent } from "~/utils/agents";

const props = defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const { roster, teams, loadProjectTeam } = useAgentRoster();
const { recents } = useRecentProjects();
const { cue } = useSound();
const openId = ref<string | null>(null);
const isCreating = ref(false);

// A team lives per project and is only in hand once its project's team has been
// read from the store. This is the whole-app view, not the active project's, so
// it pulls every recent project's team up front rather than waiting for one to
// be opened.
watch(
  recents,
  (list) => {
    for (const p of list) void loadProjectTeam(p.path);
  },
  { immediate: true },
);

/** A project's display name for a path — the name it was opened under, or the
 *  folder it lives in for one that isn't in the recents. */
function nameForPath(path: string): string {
  const known = recents.value.find((p) => p.path === path);
  if (known?.name) return known.name;
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * The roster laid out as teams: one section per project that has a team, its
 * members inside, then a final section for every agent on no team at all. An
 * agent on several teams appears under each — this is a listing of teams, not a
 * partition of the roster.
 */
const sections = computed(() => {
  const projectSections = teams.value
    .map((team) => ({ key: team.path, title: nameForPath(team.path), agents: team.agents }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const teamed = new Set(projectSections.flatMap((s) => s.agents.map((a) => a.id)));
  const noTeam = roster.value.filter((agent) => !teamed.has(agent.id));

  const groups = [...projectSections];
  if (noTeam.length) groups.push({ key: "__none", title: "No team", agents: noTeam });
  return groups;
});

/** Head the sections only once there's a team to head — with no team anywhere
 *  the roster is one ungrouped grid, and a lone "No team" label names nothing. */
const showHeaders = computed(() => sections.value.some((s) => s.key !== "__none"));

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
        <HugeiconsIcon :icon="Add01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        <span>New agent</span>
      </button>
    </template>

    <div class="ag">
      <!-- Every team in the app, one section per project, then a last section
           for the agents on no team at all. -->
      <section v-for="s in sections" :key="s.key" class="ag__section">
        <header v-if="showHeaders" class="ag__sectionhead">
          <HugeiconsIcon
            v-if="s.key !== '__none'"
            :icon="UserGroupIcon"
            :size="12"
            :stroke-width="1.8"
            aria-hidden="true"
            class="ag__sectionglyph"
          />
          <span class="ag__eyebrow">{{ s.title }}</span>
          <span class="ag__count">{{ s.agents.length }}</span>
        </header>

        <div class="ag__grid" role="list" :aria-label="s.title">
          <article
            v-for="c in s.agents"
            :key="c.id"
            role="listitem"
            class="ag__card"
            :tabindex="open ? 0 : -1"
            :aria-label="`${c.name}, ${c.role}`"
            @click="openAgent(c.id)"
            @keydown.enter.prevent="openAgent(c.id)"
            @keydown.space.prevent="openAgent(c.id)"
          >
            <!-- Portrait: the face on a neutral disc, so the colour that reads
                 is the agent's own marble, not a ring tinted to match it. An
                 agent with a picture of itself is shown as itself, filling the
                 disc — the drawn face is what everyone else gets.
                 The bot rides the portrait's corner rather than sitting in the
                 row below it: it belongs to this agent, and a mark on its own
                 line would read as a second agent. -->
            <span class="ag__halo" :class="{ 'ag__halo--photo': c.avatar }">
              <img
                v-if="c.avatar"
                class="ag__photo"
                :src="c.avatar.src"
                alt=""
                draggable="false"
              />
              <span v-else class="ag__face" v-html="c.svg" />
              <span
                v-if="c.bot"
                class="ag__bot"
                :style="{ background: botGround(c.bot) }"
                aria-hidden="true"
                v-html="botMark(c.bot)"
              />
            </span>

            <!-- Identity, centred: name over its one-line role -->
            <h4 class="ag__name">{{ c.name }}</h4>
            <p class="ag__role">{{ c.role || "Agent" }}</p>
          </article>
        </div>
      </section>
    </div>

    <template #foot>
      An agent is whoever does the work, kept apart from the threads they do it in, so the same name
      and face follow them across every conversation. Pick one in the composer to hand it the next
      turn; leave it on Guest and the thread gets a name and a face of its own, good for that
      conversation and nothing beyond it. A named agent is told its name and, when it has them, its
      instructions for how to work; it answers to the name and follows the instructions. An agent can
      also be given a picture, which is what it is shown as wherever it answers, and a bot, the
      creature it works through where it is at work rather than talking. The role, the face, the
      picture and the bot stay here in the drawer; nothing else about it reaches the model.
      Every project has a team — the agents made available to work within it; the composer offers a
      project's team, and a teammate can delegate only to another. Membership is per project, so an
      agent can be on many; the ones on no team at all are listed on their own.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.ag {
  --ag-ease: cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  gap: 32px;
  max-width: 56rem;
  padding-block: 4px 3rem;
  container-type: inline-size;
}

/* ── section ──────────────────────────────────────────────────────────────── */
.ag__section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ag__sectionhead {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-inline: 14px;
}
.ag__sectionglyph {
  flex-shrink: 0;
  color: var(--muted);
}
.ag__eyebrow {
  font-size: 10.5px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  line-height: 1;
  color: var(--muted);
}
.ag__count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.6;
}

/* ── masthead action button ───────────────────────────────────────────────── */
.ag__new-action-btn {
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
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.ag__new-action-btn:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.ag__new-action-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── agent cards grid ─────────────────────────────────────────────────────── */
.ag__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
@container (min-width: 460px) {
  .ag__grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@container (min-width: 680px) {
  .ag__grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

/* Each agent is a centred column — portrait, name, role, status — borderless
   until you point at it, when a soft wash lifts it off the page. */
.ag__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 14px 20px;
  border-radius: 18px;
  background-color: transparent;
  cursor: pointer;
  outline: none;
  text-align: center;
  transition:
    background-color 200ms var(--ag-ease),
    transform 200ms var(--ag-ease),
    box-shadow 200ms var(--ag-ease);
}
.ag__card:hover {
  background-color: color-mix(in srgb, var(--ink) 3.5%, transparent);
  transform: translateY(-1px);
}
.ag__card:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── portrait ─────────────────────────────────────────────────────────────── */
/* The face on a neutral disc — the colour that reads is the agent's own marble,
   the disc a quiet, theme-following ring around it. */
.ag__halo {
  position: relative;
  display: grid;
  place-items: center;
  width: 84px;
  height: 84px;
  margin-bottom: 20px;
  border-radius: 50%;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
}
/* A picture is the portrait, so the disc it would have sat on goes away rather
   than showing as a rim around it. */
.ag__halo--photo {
  background-color: transparent;
}

.ag__photo {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  user-select: none;
  transition: transform 240ms var(--ag-ease);
}
.ag__card:hover .ag__photo {
  transform: scale(1.04);
}

/* Small, and on the ground its own colour needs — at this size a body that
   sinks into the surface leaves nothing to see. */
.ag__bot {
  position: absolute;
  right: 0;
  bottom: 0;
  display: block;
  width: 28px;
  height: 28px;
  padding: 3px;
  box-sizing: border-box;
  border-radius: 50%;
}
.ag__bot :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.ag__face {
  display: block;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  transition: transform 240ms var(--ag-ease);
}
.ag__card:hover .ag__face {
  transform: scale(1.06);
}
.ag__face :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── identity ─────────────────────────────────────────────────────────────── */
.ag__name {
  margin: 0;
  max-width: 100%;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: -0.012em;
  line-height: 1.3;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ag__role {
  margin: 5px 0 0;
  max-width: 100%;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-clamp: 2;
  overflow: hidden;
  text-wrap: pretty;
}

@media (prefers-reduced-motion: reduce) {
  .ag__card,
  .ag__photo,
  .ag__face {
    transition: none;
    transform: none;
  }
}
</style>



<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Copy01Icon, Delete02Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import AgentAvatarEditor from "~/components/AgentAvatarEditor.vue";
import AgentBotEditor from "~/components/AgentBotEditor.vue";
import AgentCapabilitiesEditor from "~/components/AgentCapabilitiesEditor.vue";
import AgentPoliciesEditor from "~/components/AgentPoliciesEditor.vue";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import { useAgentRoster } from "~/composables/useAgentRoster";
import { useSound } from "~/composables/useSound";
import type { AgentAvatar } from "~/utils/agents";
import type { AgentBot } from "~/utils/bot";
import type { AgentModelRef } from "~/types/desktop";

// One agent, opened out of the roster: the face big, the name and role up top,
// and the one field a model actually hears — its instructions — read back as
// prose.

const props = defineProps<{ open: boolean; agentId: string }>();
const emit = defineEmits<{
  back: [];
  switched: [agentId: string];
}>();

const { agentById, duplicateAgent, deleteAgent, updateAgent } = useAgentRoster();
const { cue } = useSound();
const agent = computed(() => agentById(props.agentId));
const isCustom = computed(() => agent.value?.id !== "kone");
const isDeleting = ref(false);

// An id that resolves to nobody has no frame to fill — step back to the list
// rather than render an empty page (a stale id, or an agent removed later on).
watch(
  agent,
  (a) => {
    if (props.open && !a) emit("back");
  },
  { immediate: true },
);

async function handleDuplicate() {
  if (!agent.value) return;
  const copy = await duplicateAgent(agent.value.id, `${agent.value.name} Copy`);
  if (copy) {
    cue("press");
    emit("switched", copy.id);
  }
}

async function handleDelete() {
  if (!agent.value) return;
  const ok = await deleteAgent(agent.value.id);
  if (ok) {
    cue("press");
    emit("back");
  }
}

// Capability edits persist as they happen — the editor hands back the whole
// model each time, so there is nothing to save separately. On a built-in this
// writes an overlay over the shipped preset; on a user-made agent it is the
// agent's own row.
function setModel(next: AgentModelRef | null) {
  if (agent.value) void updateAgent(agent.value.id, { model: next });
}

// Policies persist the same way — the editor hands back a whole list per change.
// Each setter carries the other list unchanged so the stored object always has
// both, mirroring the resolved shape the agent already reads.
function setDeniedCommands(next: string[]) {
  if (agent.value) {
    void updateAgent(agent.value.id, {
      policies: { deniedCommands: next, deniedPaths: agent.value.policies.deniedPaths },
    });
  }
}
function setDeniedPaths(next: string[]) {
  if (agent.value) {
    void updateAgent(agent.value.id, {
      policies: { deniedCommands: agent.value.policies.deniedCommands, deniedPaths: next },
    });
  }
}

// The picture and the bot persist on the change too, each from its own section.
// Clearing one clears the overlay, so on
// a user-made agent the picture or bot is gone, and on a built-in the agent goes
// back to looking the way the build ships it — which is what "remove" can mean
// there, since the shipped look isn't a row anybody can delete.
function setAvatar(next: AgentAvatar | null) {
  if (agent.value) void updateAgent(agent.value.id, { avatar: next });
}
function setBot(next: AgentBot | null) {
  if (agent.value) void updateAgent(agent.value.id, { bot: next });
}

interface Directive {
  lead: string;
  body: string;
}

/**
 * A prose field split into paragraphs, with a `**lead.**` opener pulled out of
 * each when it has one. The lead is set apart by colour rather than weight —
 * Geist ships a single weight here, so bold renders as regular. A paragraph with
 * no `**lead**` reads as plain prose; kone's instruction directives each open
 * with one.
 */
function toDirectives(text: string | undefined): Directive[] {
  if (!text) return [];
  return text
    .split(/\n{2,}/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const match = /^\*\*(.+?)\*\*\s*([\s\S]*)$/.exec(paragraph);
      if (!match) return { lead: "", body: paragraph };
      return { lead: (match[1] ?? "").trim(), body: (match[2] ?? "").trim() };
    });
}

const instructions = computed(() => toDirectives(agent.value?.instructions));
const bare = computed(() => instructions.value.length === 0);
</script>

<template>
  <SettingsPageShell
    v-if="agent"
    :open="open"
    :breadcrumb="`Ecosystem / Agents / ${agent.name}`"
    :breadcrumb-icon="UserGroupIcon"
    :label="agent.name"
    @back="$emit('back')"
  >
    <template #actions>
      <div class="det__actions">
        <button
          type="button"
          class="det__action-btn"
          title="Fork a copy of this agent"
          :tabindex="open ? 0 : -1"
          @click="handleDuplicate"
        >
          <HugeiconsIcon :icon="Copy01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span>Duplicate</span>
        </button>

        <button
          v-if="isCustom"
          type="button"
          class="det__action-btn det__action-btn--danger"
          title="Remove agent from roster"
          :tabindex="open ? 0 : -1"
          @click="isDeleting ? handleDelete() : (isDeleting = true)"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ isDeleting ? "Confirm Delete" : "Delete" }}</span>
        </button>
      </div>
    </template>

    <article class="det">
      <header class="det__head">
        <img
          v-if="agent.avatar"
          class="det__face det__face--photo"
          :src="agent.avatar.src"
          alt=""
          draggable="false"
        />
        <span v-else class="det__face" v-html="agent.svg" />
        <span class="det__id">
          <h2 class="det__name">{{ agent.name }}</h2>
          <p class="det__role">{{ agent.role }}</p>
        </span>
      </header>

      <section v-if="instructions.length" class="det__sec" aria-label="How it works">
        <p class="det__eyebrow">How it works</p>
        <div class="det__prose">
          <p v-for="(d, i) in instructions" :key="i" class="det__para">
            <span v-if="d.lead" class="det__lead">{{ d.lead }}</span>{{ d.body }}
          </p>
        </div>
      </section>

      <p v-if="bare" class="det__bare">
        Just a name and a face for now — no instructions to carry into a thread.
      </p>

      <section class="det__sec" aria-label="Picture">
        <!-- The one line each of these is for rides on its eyebrow rather than
             sitting above the controls, so the section opens onto the thing it
             is for. -->
        <p class="det__eyebrow">Picture <span class="det__what">the face it answers with</span></p>
        <AgentAvatarEditor :avatar="agent.avatar" @update:avatar="setAvatar" />
      </section>

      <section class="det__sec" aria-label="Bot">
        <p class="det__eyebrow">Bot <span class="det__what">the creature it works through</span></p>
        <AgentBotEditor :bot="agent.bot" @update:bot="setBot" />
      </section>

      <section class="det__sec" aria-label="Capabilities">
        <p class="det__eyebrow">Capabilities</p>
        <AgentCapabilitiesEditor
          :model="agent.capabilities.model"
          @update:model="setModel"
        />
      </section>

      <section class="det__sec" aria-label="Policies">
        <p class="det__eyebrow">Policies</p>
        <AgentPoliciesEditor
          :denied-commands="agent.policies.deniedCommands"
          :denied-paths="agent.policies.deniedPaths"
          @update:denied-commands="setDeniedCommands"
          @update:denied-paths="setDeniedPaths"
        />
      </section>
    </article>

    <template #foot>
      What a model is told: the name, and the instructions when the agent has them.
      The role, the face, the picture and the bot stay here in the drawer.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.det {
  display: flex;
  flex-direction: column;
  gap: 26px;
  max-width: 48rem;
  padding-bottom: 2.5rem;
}

/* ── actions in shell masthead ────────────────────────────────────────────── */
.det__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.det__action-btn {
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
.det__action-btn:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.det__action-btn--danger:hover {
  background-color: color-mix(in srgb, #e05252 14%, transparent);
  color: #e05252;
}

/* Face and name as one unit, no card around them — the spacing sets the head
   apart from the sections, not a rule or a container. */
.det__head {
  display: flex;
  align-items: center;
  gap: 16px;
}
.det__face {
  display: block;
  flex: none;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  filter: drop-shadow(0 3px 8px rgba(0, 0, 0, 0.14));
}
/* Cropped rather than fitted: a face letterboxed into a circle reads as a
   picture of a picture. */
.det__face--photo {
  object-fit: cover;
  user-select: none;
}
.det__face :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.det__id {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.det__name {
  margin: 0;
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: var(--ink);
}
.det__role {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.2;
  color: var(--muted);
}

/* ── a titled block of prose ─────────────────────────────────────────────── */
.det__sec {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.det__eyebrow {
  margin: 0;
  font-size: 10px;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
  color: var(--muted);
}
/* Sentence case and unspaced beside the eyebrow's caps, so the two read as a
   label and an aside rather than one long heading. */
.det__what {
  margin-left: 8px;
  font-size: 11px;
  letter-spacing: 0;
  text-transform: none;
  opacity: 0.75;
}
.det__prose {
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.det__para {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: color-mix(in oklab, var(--ink) 78%, transparent);
  text-wrap: pretty;
}
/* The directive's opener, set in full ink so it reads ahead of its own line
   without a heavier weight to lean on. The gap after it is a margin, not source
   whitespace, so it survives however the template is condensed. */
.det__lead {
  margin-inline-end: 0.34em;
  color: var(--ink);
}

.det__bare {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
  text-wrap: pretty;
}
</style>



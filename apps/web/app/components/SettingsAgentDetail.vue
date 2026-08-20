<script setup lang="ts">
import { computed, watch } from "vue";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import { useAgentRoster } from "~/composables/useAgentRoster";

// One agent, opened out of the roster: the face big, the name and role up top,
// and the two fields a model actually hears — personality and instructions —
// read back as prose. Read-only for now: the roster is still a set of shipped
// presets, so there is nothing here to type over until the agent library lands.

const props = defineProps<{ open: boolean; agentId: string }>();
const emit = defineEmits<{ back: [] }>();

const { agentById } = useAgentRoster();
const agent = computed(() => agentById(props.agentId));

// An id that resolves to nobody has no frame to fill — step back to the list
// rather than render an empty page (a stale id, or an agent removed later on).
watch(
  agent,
  (a) => {
    if (props.open && !a) emit("back");
  },
  { immediate: true },
);

interface Directive {
  lead: string;
  body: string;
}

/**
 * A prose field split into paragraphs, with a `**lead.**` opener pulled out of
 * each when it has one. The lead is set apart by colour rather than weight —
 * Geist ships a single weight here, so bold renders as regular. Personality has
 * no leads and reads as plain paragraphs; kone's instructions each open with one.
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

const personality = computed(() => toDirectives(agent.value?.personality));
const instructions = computed(() => toDirectives(agent.value?.instructions));
const bare = computed(() => personality.value.length === 0 && instructions.value.length === 0);
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
    <article class="det">
      <header class="det__head">
        <span class="det__face" v-html="agent.svg" />
        <span class="det__id">
          <h2 class="det__name">{{ agent.name }}</h2>
          <p class="det__role">{{ agent.role }}</p>
        </span>
      </header>

      <section v-if="personality.length" class="det__sec" aria-label="Personality">
        <p class="det__eyebrow">Personality</p>
        <div class="det__prose">
          <p v-for="(d, i) in personality" :key="i" class="det__para">
            <span v-if="d.lead" class="det__lead">{{ d.lead }}</span>{{ d.body }}
          </p>
        </div>
      </section>

      <section v-if="instructions.length" class="det__sec" aria-label="How it works">
        <p class="det__eyebrow">How it works</p>
        <div class="det__prose">
          <p v-for="(d, i) in instructions" :key="i" class="det__para">
            <span v-if="d.lead" class="det__lead">{{ d.lead }}</span>{{ d.body }}
          </p>
        </div>
      </section>

      <p v-if="bare" class="det__bare">
        Just a name and a face for now — no personality or instructions to carry into a thread.
      </p>
    </article>

    <template #foot>
      What a model is told: the name, and the personality and instructions when the agent has them.
      The role and the face stay here in the drawer. Editing an agent arrives with the agent library.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.det {
  display: flex;
  flex-direction: column;
  gap: 26px;
}

/* Face and name as one unit, no card around them — the spacing sets the head
   apart from the sections, not a rule or a container. */
.det__head {
  display: flex;
  align-items: center;
  gap: 14px;
}
.det__face {
  display: block;
  flex: none;
  width: 52px;
  height: 52px;
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
  font-size: 19px;
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
.det__prose {
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.det__para {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: color-mix(in oklab, var(--ink) 74%, transparent);
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

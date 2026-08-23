<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  AiChipIcon,
  BotIcon,
  Copy01Icon,
  Delete02Icon,
  IdIcon,
  NoteIcon,
  PencilEdit02Icon,
  SparklesIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import CreateAgentModal from "~/components/CreateAgentModal.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import { useAgentRoster } from "~/composables/useAgentRoster";
import { useRecentProjects } from "~/composables/useRecentProjects";
import { useSettingsSurface } from "~/composables/useSettingsSurface";
import { useSound } from "~/composables/useSound";
import { botGround, botMark, botSummary } from "~/utils/bot";
import { PROVIDER_LABEL } from "~/utils/usageProviders";
import type { BrandKey } from "~/utils/modelCatalog";
import type { ProviderKind } from "~/types/desktop";

// One agent, opened out of the roster.
//
// The page is a reading of the agent, not a place to rewrite it. Who this is
// sits in the head; what is true about it and what it was told sit as two tabs
// below. Appearance, model and restrictions used to be editors in this same
// strip — they belonged in the modal, which is the one surface that already
// knows how to change every field. The tabs that remain only tell.

const props = defineProps<{ open: boolean; agentId: string }>();
const emit = defineEmits<{
  back: [];
  switched: [agentId: string];
}>();

const { agentById, duplicateAgent, deleteAgent, teams, loadProjectTeam } = useAgentRoster();
const { recents } = useRecentProjects();
const { compact } = useSettingsSurface();
const { cue } = useSound();
const agent = computed(() => agentById(props.agentId));
const isCustom = computed(() => agent.value?.id !== "kone");
const isDeleting = ref(false);
const isEditing = ref(false);

// This page is a reading of one agent, so the drawer sits at the compact
// measure rather than the board-width the roster (and every other page) uses.
// Cleared on the way out so the next pane doesn't inherit the tighter cap.
onMounted(() => {
  compact.value = true;
});
onBeforeUnmount(() => {
  compact.value = false;
});

// An id that resolves to nobody has no frame to fill — step back to the list
// rather than render an empty page (a stale id, or an agent removed later on).
watch(
  agent,
  (a) => {
    if (props.open && !a) emit("back");
  },
  { immediate: true },
);

// Teams are per project and only in hand once that project's team has been
// read. The page can be reached without passing the roster's own load, so it
// asks for every recent project's team itself before naming the ones this agent
// is on.
watch(
  recents,
  (list) => {
    for (const p of list) void loadProjectTeam(p.path);
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

function openEdit() {
  isEditing.value = true;
  cue("open");
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

// ── what the details table reads back ──────────────────────────────────────
// Each of these is one row's value, resolved once here so the template stays a
// list of rows rather than a list of conditions.

/** The provider's own logomark for a pinned model's row. */
const PROVIDER_BRAND = {
  codex: "codex",
  claudeAgent: "claude",
  opencode: "opencode",
  cursor: "cursor",
  droid: "droid",
  antigravity: "antigravity",
} satisfies Record<ProviderKind, BrandKey>;

const model = computed(() => agent.value?.capabilities.model ?? null);
const modelLabel = computed(() => {
  const m = model.value;
  if (!m) return "No preference";
  return m.label || m.model;
});
const skills = computed(() => agent.value?.capabilities.skills ?? []);
/** The projects this agent is a member of, by the name each was opened under. */
const teamNames = computed<string[]>(() => {
  const id = agent.value?.id;
  if (!id) return [];
  return teams.value
    .filter((team) => team.agents.some((a) => a.id === id))
    .map((team) => {
      const known = recents.value.find((p) => p.path === team.path);
      if (known?.name) return known.name;
      return team.path.replace(/\/+$/, "").split("/").pop() || team.path;
    })
    .sort((a, b) => a.localeCompare(b));
});
// ── the tabs ──────────────────────────────────────────────────────────────
// Everything below the head is one tabbed panel: what is true about the agent,
// and what it was told. They are alternatives — you come to the page for one
// of them — and stacking both down a column is the wall the page had before.
type TabKey = "details" | "instructions";
const tab = ref<TabKey>("details");
const tabStrip = ref<HTMLElement>();

const TABS = [
  { key: "details", label: "Details", icon: IdIcon },
  { key: "instructions", label: "Instructions", icon: NoteIcon },
] as const satisfies readonly { key: TabKey; label: string; icon: unknown }[];

function selectTab(key: TabKey) {
  if (tab.value === key) return;
  tab.value = key;
  cue("select");
}

/** Left and right walk the strip, since only the live tab is in the tab order.
 *  The moved-to tab takes focus with it — otherwise the arrows would keep
 *  answering to a button that is no longer the one selected. */
async function stepTab(delta: number) {
  const keys = TABS.map((t) => t.key);
  const at = keys.indexOf(tab.value);
  const next = keys[(at + delta + keys.length) % keys.length];
  if (!next) return;
  selectTab(next);
  await nextTick();
  tabStrip.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}

// Switching agents puts the page back to its resting shape, so a tab left open
// on one doesn't greet you inside the next.
watch(
  () => props.agentId,
  () => {
    tab.value = "details";
    isDeleting.value = false;
    isEditing.value = false;
  },
);
</script>

<template>
  <CreateAgentModal
    v-if="isEditing && agent"
    :agent="agent"
    @close="isEditing = false"
    @saved="isEditing = false"
  />

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
          title="Edit this agent"
          :tabindex="open ? 0 : -1"
          @click="openEdit"
        >
          <HugeiconsIcon :icon="PencilEdit02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span>Edit</span>
        </button>

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
      <!-- The agent, at the size it deserves: the face large enough to be a
           portrait rather than a list glyph, and the bot riding its corner the
           way it does everywhere else. No panel behind it — the spacing sets the
           head apart from the sections. -->
      <header class="det__hero">
        <span class="det__portrait" :class="{ 'det__portrait--photo': agent.avatar }">
          <img
            v-if="agent.avatar"
            class="det__photo"
            :src="agent.avatar.src"
            alt=""
            draggable="false"
          />
          <span v-else class="det__face" v-html="agent.svg" />
          <span
            v-if="agent.bot"
            class="det__botmark"
            :style="{ background: botGround(agent.bot) }"
            aria-hidden="true"
            v-html="botMark(agent.bot)"
          />
        </span>

        <span class="det__id">
          <span class="det__nameline">
            <h2 class="det__name">{{ agent.name }}</h2>
            <span class="det__chip">{{ isCustom ? "Custom" : "Built-in" }}</span>
          </span>
          <p class="det__role">{{ agent.role || "Agent" }}</p>
        </span>
      </header>

      <!-- One strip over one panel: what is true about the agent, and what it
           was told. Editing lives in the modal, not in another tab. -->
      <div
        ref="tabStrip"
        class="det__tabs"
        role="tablist"
        aria-label="Agent"
        @keydown.left.prevent="stepTab(-1)"
        @keydown.right.prevent="stepTab(1)"
      >
        <button
          v-for="t in TABS"
          :key="t.key"
          type="button"
          role="tab"
          class="det__tab"
          :class="{ 'det__tab--on': tab === t.key }"
          :aria-selected="tab === t.key"
          :tabindex="open && tab === t.key ? 0 : -1"
          @click="selectTab(t.key)"
        >
          <HugeiconsIcon
            class="det__tab-glyph"
            :icon="t.icon"
            :size="14"
            :stroke-width="1.6"
            aria-hidden="true"
          />
          <span class="det__tab-label">{{ t.label }}</span>
        </button>
      </div>

      <div class="det__panel" role="tabpanel" :aria-label="TABS.find((t) => t.key === tab)?.label">
        <!-- Everything true about the agent, on one table: what it runs on, what
             it is equipped with, where it works, what it may never do, and what
             it is called by the store. Reading it should not mean opening an
             editor. -->
        <dl v-if="tab === 'details'" class="det__table">
          <div class="det__row">
            <dt class="det__key">
              <HugeiconsIcon :icon="AiChipIcon" :size="14" :stroke-width="1.6" aria-hidden="true" />
              <span>Model</span>
            </dt>
            <dd class="det__val">
              <template v-if="model">
                <ProviderLogo :brand="PROVIDER_BRAND[model.provider]" :size="14" />
                <span>{{ modelLabel }}</span>
                <span class="det__aside">{{ PROVIDER_LABEL[model.provider] }}</span>
              </template>
              <span v-else class="det__none">No preference — the thread picks per turn</span>
            </dd>
          </div>

          <div class="det__row">
            <dt class="det__key">
              <HugeiconsIcon
                :icon="SparklesIcon"
                :size="14"
                :stroke-width="1.6"
                aria-hidden="true"
              />
              <span>Skills</span>
            </dt>
            <dd class="det__val det__val--wrap">
              <template v-if="skills.length">
                <span v-for="s in skills.slice(0, 8)" :key="s.path" class="det__tag">{{
                  s.name
                }}</span>
                <span v-if="skills.length > 8" class="det__aside"
                  >+{{ skills.length - 8 }} more</span
                >
              </template>
              <span v-else class="det__none">None assigned</span>
            </dd>
          </div>

          <div class="det__row">
            <dt class="det__key">
              <HugeiconsIcon
                :icon="UserGroupIcon"
                :size="14"
                :stroke-width="1.6"
                aria-hidden="true"
              />
              <span>Teams</span>
            </dt>
            <dd class="det__val det__val--wrap">
              <template v-if="teamNames.length">
                <span v-for="name in teamNames" :key="name" class="det__tag">{{ name }}</span>
              </template>
              <span v-else class="det__none">On no team</span>
            </dd>
          </div>

          <div class="det__row">
            <dt class="det__key">
              <HugeiconsIcon :icon="BotIcon" :size="14" :stroke-width="1.6" aria-hidden="true" />
              <span>Bot</span>
            </dt>
            <dd class="det__val">
              <span
                v-if="agent.bot"
                class="det__botchip"
                :style="{ background: botGround(agent.bot) }"
                :aria-label="botSummary(agent.bot)"
                v-html="botMark(agent.bot)"
              />
              <span v-else class="det__none">None</span>
            </dd>
          </div>

          <div class="det__row">
            <dt class="det__key">
              <HugeiconsIcon :icon="IdIcon" :size="14" :stroke-width="1.6" aria-hidden="true" />
              <span>Identifier</span>
            </dt>
            <dd class="det__val det__val--mono">{{ agent.id }}</dd>
          </div>
        </dl>

        <template v-else>
          <div v-if="instructions.length" class="det__prose">
            <p v-for="(d, i) in instructions" :key="i" class="det__para">
              <span v-if="d.lead" class="det__lead">{{ d.lead }}</span>{{ d.body }}
            </p>
          </div>
          <p v-else class="det__bare">
            Just a name and a face for now — no instructions to carry into a thread.
          </p>
        </template>
      </div>
    </article>

    <template #foot>
      What a model is told: the name, and the instructions when the agent has them.
      The role, the face, the picture and the bot stay here in the drawer.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.det {
  --det-hair: color-mix(in srgb, var(--ink) 7%, transparent);
  display: flex;
  flex-direction: column;
  gap: 30px;
  max-width: 36rem;
  padding-bottom: 3rem;
  /* The tab strip drops its summaries against the page's own width, not the
     window's — the drawer widens and narrows under it. */
  container-type: inline-size;
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

/* ── hero ─────────────────────────────────────────────────────────────────── */
/* Portrait, name and role as one unit on the page itself — no panel, no rule.
   The spacing is what sets the head apart from the sections below it. */
.det__hero {
  display: flex;
  align-items: center;
  gap: 18px;
  padding-block: 2px;
}

.det__portrait {
  position: relative;
  display: grid;
  place-items: center;
  flex: none;
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
/* A picture is the portrait, so the disc it would sit on goes away rather than
   showing as a rim around it. */
.det__portrait--photo {
  background-color: transparent;
}
.det__photo {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  user-select: none;
}
.det__face {
  display: block;
  width: 68px;
  height: 68px;
}
.det__face :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
/* Small, and on the ground its own colour needs — at this size a body that
   sinks into the surface leaves nothing to see. */
.det__botmark {
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
.det__botmark :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.det__id {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.det__nameline {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.det__name {
  margin: 0;
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.025em;
  line-height: 1.1;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Whose agent this is, said once and quietly — a built-in and a made one are
   worth telling apart, but not with a colour that shouts. */
.det__chip {
  flex: none;
  padding: 3px 8px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  line-height: 1.2;
  color: var(--ink-soft);
}
.det__role {
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ink-soft);
  text-wrap: pretty;
}

/* ── details table ────────────────────────────────────────────────────────── */
/* Hairlines between rows, nothing around the block: the table is a rhythm, not
   a container. */
.det__table {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.det__row {
  display: grid;
  grid-template-columns: 10.5rem minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  padding-block: 11px;
}
.det__row + .det__row {
  border-top: 1px solid var(--det-hair);
}
.det__key {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--muted);
}
.det__key :deep(svg) {
  flex: none;
}
.det__val {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  min-width: 0;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ink);
}
.det__val--wrap {
  flex-wrap: wrap;
  row-gap: 6px;
}
.det__val--mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink-soft);
}
.det__none {
  color: var(--muted);
}
.det__aside {
  font-size: 11.5px;
  color: var(--muted);
}
/* A name the agent carries rather than a control — soft ground, no outline. */
.det__tag {
  padding: 3px 9px;
  border-radius: 8px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--ink-soft);
}
.det__tag--code {
  font-family: var(--font-mono);
  font-size: 11px;
}
.det__botchip {
  display: block;
  flex: none;
  width: 20px;
  height: 20px;
  padding: 2px;
  box-sizing: border-box;
  border-radius: 50%;
}
.det__botchip :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

/* ── prose ────────────────────────────────────────────────────────────────── */
.det__prose {
  display: flex;
  flex-direction: column;
  gap: 13px;
  max-width: 68ch;
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
  max-width: 68ch;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
  text-wrap: pretty;
}

/* ── settings tabs ────────────────────────────────────────────────────────── */
/* A strip of names over one panel, on a hairline rather than in a container:
   the underline under the live tab is the only mark that carries weight. */
.det__tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  box-shadow: inset 0 -1px 0 0 var(--det-hair);
  overflow-x: auto;
  scrollbar-width: none;
}
.det__tabs::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.det__tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 11px 11px;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 160ms ease,
    color 160ms ease;
}
.det__tab:hover {
  background-color: var(--hover);
}
.det__tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* The live tab's rule sits on the strip's hairline rather than beside it, so
   the two read as one line with a segment inked in. */
.det__tab--on::after {
  content: "";
  position: absolute;
  inset-inline: 8px;
  bottom: -1px;
  height: 1.5px;
  border-radius: 2px;
  background-color: var(--ink);
}
.det__tab-glyph {
  flex: none;
  color: var(--muted);
  transition: color 160ms ease;
}
.det__tab--on .det__tab-glyph {
  color: var(--ink);
}
.det__tab-label {
  font-size: 12.5px;
  line-height: 1.2;
  color: var(--muted);
  transition: color 160ms ease;
}
.det__tab--on .det__tab-label {
  color: var(--ink);
}
/* The strip is the page's own navigation, so it keeps its full width on a
   narrow drawer and lets the names scroll rather than wrapping to two lines. */
.det__panel {
  padding-top: 4px;
}

@media (prefers-reduced-motion: reduce) {
  .det__tab,
  .det__tab-glyph,
  .det__tab-label {
    transition: none;
  }
}
</style>

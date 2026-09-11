<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Folder01Icon,
  SparklesIcon,
  Tick02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import DrawerModalShell, { type DrawerModalHandle } from "~/components/ui/DrawerModalShell.vue";
import AgentAvatarEditor from "~/components/agent/AgentAvatarEditor.vue";
import AgentBotEditor from "~/components/agent/AgentBotEditor.vue";
import AgentCapabilitiesEditor from "~/components/agent/AgentCapabilitiesEditor.vue";
import { useAgentRoster } from "~/composables/useAgentRoster";
import { useRecentProjects } from "~/composables/useRecentProjects";
import { useSound } from "~/composables/useSound";
import {
  addAgentToProject,
  removeAgentFromProject,
  type Agent,
  type AgentAvatar,
  type AgentAvatarSource,
} from "~/utils/agents";
import { botSummary, type AgentBot } from "~/utils/bot";
import { formatModelChain } from "~/utils/detailFormat";
import type { AgentModelRef } from "~/types/desktop";

// Making or editing an agent: the shell carries the scrim, card, rows and
// keyboard, so this is the row definitions plus create/save. Concerns stacked
// as collapsible rows: who the agent is (name and role), how it looks, how it
// works, and what it may reach for. Only a name is required, so the rest are
// rows a maker may open or leave alone rather than gates they must walk
// through — and a closed row still says what it holds, so the whole draft is
// legible from the outside.
//
// How it looks is two rows, not one, and neither is part of identity. A name
// and a role are typed where a picture and a bot are picked, so they don't
// belong together; and a picture and a bot don't belong together either — a
// picture says who is speaking, a bot is the creature the agent works through,
// and one pane holding both meant scrolling past thirty-six swatches to reach
// a face. Both stay optional: an agent given neither is drawn by the face it
// has always had.
//
// The same card edits an existing agent. Create greets on identity because a
// draft has nothing else to show; edit greets with every row closed so the
// summaries carry what is already true, and a row is opened only to change it.
// The roster detail page is read-only — this is the one place the fields move.

const props = defineProps<{
  /** The agent being rewritten. Absent, the card is making a new one. */
  agent?: Agent;
}>();

const emit = defineEmits<{
  close: [];
  created: [agent: Agent];
  saved: [agent: Agent];
}>();

const { createAgent, updateAgent, agentTeamPaths } = useAgentRoster();
const isEditing = computed(() => Boolean(props.agent));
const { recents } = useRecentProjects();
const { cue } = useSound();
const shellRef = ref<DrawerModalHandle | null>(null);

// ── sections ──────────────────────────────────────────────────────────────────
type Section =
  | "identity"
  | "picture"
  | "bot"
  | "instructions"
  | "capabilities"
  | "teams";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "identity", label: "Identity" },
  { id: "picture", label: "Picture" },
  { id: "bot", label: "Bot" },
  { id: "instructions", label: "Instructions" },
  { id: "capabilities", label: "Model" },
  { id: "teams", label: "Teams" },
];

/**
 * What each row is for, in one line.
 *
 * Shown where the summary sits, and only while the row is open: a summary of a
 * row you are looking at repeats what is under it, and a description of a row you
 * aren't looking at is a paragraph seven times over. The line goes on the head
 * rather than at the top of the pane so the pane opens straight onto the thing
 * it is for — a hint above the fields pushes them down and is read once.
 */
const HINTS = {
  identity: "What it is called, and what it is for.",
  picture: "The face it answers with.",
  bot: "The creature it works through.",
  instructions: "Habits it carries into every thread.",
  capabilities: "The model it thinks with.",
  teams: "The projects it joins.",
} satisfies Record<Section, string>;

/** What a closed picture row says it is carrying. Where the picture came from,
 *  not what it looks like: it is the one thing a summary can say about a face
 *  without drawing it. "Shipped" can't be reached from this modal — nothing here
 *  hands out a build's own picture — but the type covers it, so this does too. */
const PICTURE_LABELS = {
  generated: "Generated face",
  upload: "Your own picture",
  dicebear: "Drawn portrait",
  shipped: "Shipped picture",
} satisfies Record<AgentAvatarSource, string>;

// ── form state ────────────────────────────────────────────────────────────────
const name = ref("");
const role = ref("");
const instructions = ref("");
// How it looks. Null is the resting answer for both, not a placeholder waiting
// to be filled: an agent with no picture wears its drawn face, and an agent with
// no bot has none rather than the default one.
const avatar = ref<AgentAvatar | null>(null);
const bot = ref<AgentBot | null>(null);
const model = ref<AgentModelRef | null>(null);
const modelFallbacks = ref<AgentModelRef[]>([]);
// The project teams this agent should join once made — a set of project paths,
// picked from the projects this machine knows. None is a working answer: a
// project's team is set by hand, so joining nothing on day one is ordinary.
const teamPaths = ref<Set<string>>(new Set());
const isSubmitting = ref(false);
const errorMsg = ref<string | null>(null);

/** The projects a new agent can be added to a team of — the recent ones, since a
 *  team lives per project and these are the projects in hand to join. */
const teamOptions = computed(() =>
  recents.value.map((p) => ({
    path: p.path,
    name: p.name || p.path.replace(/\/+$/, "").split("/").pop() || p.path,
  })),
);

function toggleTeam(path: string) {
  const next = new Set(teamPaths.value);
  const joining = !next.has(path);
  if (joining) next.add(path);
  else next.delete(path);
  teamPaths.value = next;
  cue(joining ? "select" : "collapse");
}

const canSubmit = computed(() => name.value.trim().length > 0 && !isSubmitting.value);

function seedFrom(agent: Agent) {
  name.value = agent.name;
  role.value = agent.role;
  instructions.value = agent.instructions ?? "";
  avatar.value = agent.avatar;
  bot.value = agent.bot;
  model.value = agent.capabilities.model;
  modelFallbacks.value = [...agent.capabilities.modelFallbacks];
  teamPaths.value = new Set(agentTeamPaths(agent.id));
}

if (props.agent) seedFrom(props.agent);

/** What a closed row says about itself: the value it holds, or a word for the
 *  quiet default it will fall back to. A summary never says "empty" — an
 *  untouched row is a working answer, not an omission. */
const summaries = computed<Record<Section, string>>(() => {
  const named = name.value.trim();
  const stated = role.value.trim();
  const words = instructions.value.trim().split(/\s+/).filter(Boolean).length;
  const joined = teamPaths.value.size;
  return {
    identity: named ? (stated ? `${named} · ${stated}` : named) : "Not named yet",
    picture: avatar.value ? PICTURE_LABELS[avatar.value.source] : "Drawn face",
    bot: bot.value ? botSummary(bot.value) : "None",
    instructions: words ? `${words} ${words === 1 ? "word" : "words"}` : "None",
    capabilities: formatModelChain(model.value, modelFallbacks.value) ?? "Inherits the caller",
    teams: joined ? `${joined} ${joined === 1 ? "team" : "teams"}` : "None",
  };
});

const actionLabel = computed(() => {
  if (isSubmitting.value) return isEditing.value ? "Saving…" : "Creating…";
  return isEditing.value ? "Save changes" : "Create agent";
});

async function handleCreate() {
  const trimmed = name.value.trim();
  if (!trimmed || isSubmitting.value) return;

  isSubmitting.value = true;
  errorMsg.value = null;
  try {
    const created = await createAgent({
      name: trimmed,
      role: role.value.trim() || undefined,
      instructions: instructions.value.trim() || undefined,
      // Appearance is only sent when the maker picked some — left off, the agent
      // inherits whatever its preset looks like, which for a made agent is the
      // drawn face.
      avatar: avatar.value ?? undefined,
      bot: bot.value ?? undefined,
      // Only send a model the maker actually pinned — an untouched picker is
      // "no preference", which the draft says by leaving the field off.
      model: model.value ?? undefined,
      modelFallbacks: model.value ? modelFallbacks.value : undefined,
    });
    if (!created) {
      errorMsg.value = "Could not create the agent — check the fields and try again.";
      cue("error");
      isSubmitting.value = false;
      return;
    }
    // Now the agent exists, join it to the teams its maker picked. Membership is
    // its own store write per project, so it happens after the agent is made
    // rather than as part of making it — and a team that can't be joined doesn't
    // undo the agent that was.
    if (teamPaths.value.size) {
      await Promise.all([...teamPaths.value].map((path) => addAgentToProject(path, created.id)));
    }
    cue("success");
    shellRef.value?.finish(() => emit("created", created));
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : "Creation failed.";
    cue("error");
    isSubmitting.value = false;
  }
}

async function handleSave() {
  const current = props.agent;
  const trimmed = name.value.trim();
  if (!current || !trimmed || isSubmitting.value) return;

  isSubmitting.value = true;
  errorMsg.value = null;
  try {
    const saved = await updateAgent(current.id, {
      name: trimmed,
      role: role.value.trim() || null,
      instructions: instructions.value.trim() || null,
      avatar: avatar.value,
      bot: bot.value,
      model: model.value,
      modelFallbacks: model.value ? modelFallbacks.value : [],
    });
    if (!saved) {
      errorMsg.value = "Could not save the agent — check the fields and try again.";
      cue("error");
      isSubmitting.value = false;
      return;
    }
    // Membership is its own write per project. Only the projects this machine
    // already has a team for are in the picker, so the diff is taken against
    // those — an unloaded project is left alone rather than treated as a leave.
    const known = new Set(teamOptions.value.map((opt) => opt.path));
    const before = new Set(agentTeamPaths(current.id).filter((path) => known.has(path)));
    const after = teamPaths.value;
    await Promise.all([
      ...[...after]
        .filter((path) => !before.has(path))
        .map((path) => addAgentToProject(path, current.id)),
      ...[...before]
        .filter((path) => !after.has(path))
        .map((path) => removeAgentFromProject(path, current.id)),
    ]);
    cue("success");
    shellRef.value?.finish(() => emit("saved", saved));
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : "Save failed.";
    cue("error");
    isSubmitting.value = false;
  }
}

function submit() {
  if (isEditing.value) void handleSave();
  else void handleCreate();
}
</script>

<template>
  <DrawerModalShell
    ref="shellRef"
    :sections="SECTIONS"
    :hints="HINTS"
    :summaries="summaries"
    :initial-open="props.agent ? null : 'identity'"
    :eyebrow="isEditing ? 'Edit agent' : 'New agent'"
    :dialog-label="isEditing ? 'Edit agent' : 'Create an agent'"
    :error="errorMsg"
    :action-label="actionLabel"
    :can-submit="canSubmit"
    :is-submitting="isSubmitting"
    @close="emit('close')"
    @submit="submit"
  >
    <!-- Identity: what the agent is called and what it is for. -->
    <template #row-identity>
      <label class="dm-field">
        <span class="dm-glyph">
          <HugeiconsIcon :icon="UserGroupIcon" :size="17" :stroke-width="1.7" aria-hidden="true" />
        </span>
        <input
          v-model="name"
          data-autofocus
          type="text"
          class="dm-input"
          placeholder="Name — Doc Writer, Reviewer, Sentinel"
          maxlength="64"
          spellcheck="false"
          autocomplete="off"
          aria-label="Agent name"
        />
      </label>
      <label class="dm-field">
        <span class="dm-glyph">
          <HugeiconsIcon :icon="SparklesIcon" :size="16" :stroke-width="1.7" aria-hidden="true" />
        </span>
        <input
          v-model="role"
          type="text"
          class="dm-input"
          placeholder="Role — architecture, security & review"
          maxlength="120"
          spellcheck="false"
          autocomplete="off"
          aria-label="Agent role"
        />
      </label>
    </template>

    <!-- Picture -->
    <template #row-picture>
      <AgentAvatarEditor v-model:avatar="avatar" />
    </template>

    <!-- Bot -->
    <template #row-bot>
      <AgentBotEditor v-model:bot="bot" />
    </template>

    <!-- Instructions -->
    <template #row-instructions>
      <textarea
        v-model="instructions"
        data-autofocus
        class="dm-input dm-textarea"
        rows="5"
        placeholder="How it works — habits and rules. e.g. Verify before claiming. Run the tests before saying done."
        aria-label="Standing instructions"
      />
    </template>

    <!-- Model -->
    <template #row-capabilities>
      <AgentCapabilitiesEditor
        v-model:model="model"
        v-model:fallbacks="modelFallbacks"
      />
    </template>

    <!-- Teams: which projects this agent joins the team of, if any.
         Optional — a project's team is built by hand, so joining
         none is an ordinary answer. -->
    <template #row-teams>
      <p v-if="!teamOptions.length" class="dm-empty">
        No projects yet — open one and its team is set from there.
      </p>
      <ul v-else class="ca-teamlist">
        <li v-for="opt in teamOptions" :key="opt.path">
          <button
            type="button"
            class="ca-team"
            :class="{ 'is-on': teamPaths.has(opt.path) }"
            :aria-pressed="teamPaths.has(opt.path)"
            @click="toggleTeam(opt.path)"
          >
            <span class="ca-team-glyph">
              <HugeiconsIcon :icon="Folder01Icon" :size="16" :stroke-width="1.7" aria-hidden="true" />
            </span>
            <span class="ca-team-text">
              <span class="ca-team-name">{{ opt.name }}</span>
              <span class="ca-team-path">{{ opt.path }}</span>
            </span>
            <span class="ca-team-check" aria-hidden="true">
              <HugeiconsIcon
                v-if="teamPaths.has(opt.path)"
                :icon="Tick02Icon"
                :size="15"
                :stroke-width="2.2"
              />
            </span>
          </button>
        </li>
      </ul>
    </template>
  </DrawerModalShell>
</template>

<style scoped>
/* ── teams ── one togglable row per project. Borderless like the rest; the
   picked ones firm up and carry a check. */
.ca-teamlist {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ca-team {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  border: 0;
  border-radius: 10px;
  padding: 0.45rem 0.5rem;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.16s ease;
}
.ca-team:hover {
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}
.ca-team-glyph {
  display: inline-flex;
  flex: none;
  color: var(--muted);
  opacity: 0.75;
  transition: color 0.16s ease, opacity 0.16s ease;
}
.ca-team.is-on .ca-team-glyph {
  color: var(--ink-soft);
  opacity: 1;
}
.ca-team-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-width: 0;
}
.ca-team-name {
  color: var(--ink);
  font-size: 13px;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ca-team-path {
  color: var(--muted);
  font-size: 11px;
  letter-spacing: -0.005em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The check well: an empty ring until picked, filling with the accent when it
   holds a tick. */
.ca-team-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 16%, transparent);
  color: var(--accent-ink);
  transition: background-color 0.16s ease, box-shadow 0.16s ease;
}
.ca-team.is-on .ca-team-check {
  background: var(--accent);
  box-shadow: none;
}
</style>

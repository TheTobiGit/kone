<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from "vue";
import { motion, AnimatePresence } from "motion-v";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Folder01Icon,
  SparklesIcon,
  Tick02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
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
import type { AgentModelRef } from "~/types/desktop";

// Making or editing an agent, in the shared modal shell — scrim, elastic card,
// scooped header/footer bands. Concerns stacked as collapsible rows: who the
// agent is (name and role), how it looks, how it works, and what it may reach
// for. Only a name is required, so the rest are rows a maker may open or leave
// alone rather than gates they must walk through — and a closed row still says
// what it holds, so the whole draft is legible from the outside.
//
// One row is open at a time: these panes are tall (a textarea, three editors)
// and several of them unfurled at once would outgrow the drawer and hide the
// create action under a scroll.
//
// How it looks is two rows, not one, and neither is part of identity. A name and
// a role are typed where a picture and a bot are picked, so they don't belong
// together; and a picture and a bot don't belong together either — a picture says
// who is speaking, a bot is the creature the agent works through, and one pane
// holding both meant scrolling past thirty-six swatches to reach a face. Both
// stay optional: an agent given neither is drawn by the face it has always had.
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

// The open row, or none — every row closed is a legitimate resting state, and
// the summaries carry the draft on their own. Create opens on identity so a
// name is the first thing asked; edit starts closed so the existing answers
// are what greet you.
const open = ref<Section | null>(props.agent ? null : "identity");

function toggle(id: Section) {
  const opening = open.value !== id;
  open.value = opening ? id : null;
  cue(opening ? "expand" : "collapse");
  void nextTick(() => {
    syncHeight();
    if (opening) focusOpenRow();
  });
}

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
  teamPaths.value = new Set(agentTeamPaths(agent.id));
}

if (props.agent) seedFrom(props.agent);

/** Move focus to the entry field of the open row, where it marks one. Found by
 *  query rather than by template ref: the rows are a `v-for`, which collects
 *  every `ref` inside it into an array, and a per-row ref would arrive as a
 *  one-element list rather than the field itself. The editor rows mark nothing
 *  and keep their own focus order. */
function focusOpenRow() {
  contentEl.value?.querySelector<HTMLElement>(".ca-row.is-open [data-autofocus]")?.focus();
}

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
    capabilities: model.value?.label ?? model.value?.model ?? "Any model",
    teams: joined ? `${joined} ${joined === 1 ? "team" : "teams"}` : "None",
  };
});

// ── card entrance / exit ────────────────────────────────────────────────────
const shown = ref(false);
const closing = ref(false);
const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;

// A row unfurls on the same tween the other modals' folds use.
const collapseMorph = { duration: 0.26, ease: [0.22, 1, 0.36, 1] } as const;

// Play the card's exit, then hand control back to the caller. The delay matches
// the 0.24s exit transition so it finishes leaving before the parent unmounts.
function fadeOut(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}

function close() {
  if (closing.value || isSubmitting.value) return;
  cue("collapse");
  fadeOut(() => emit("close"));
}

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
    fadeOut(() => emit("created", created));
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
    fadeOut(() => emit("saved", saved));
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

// ── keyboard ────────────────────────────────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    if (canSubmit.value) {
      e.preventDefault();
      submit();
    }
    return;
  }
  if (e.key === "Enter") {
    // A textarea spends Enter on newlines; a button spends it on clicking — and
    // a row header is a button, so Enter there opens the row rather than
    // creating the agent behind the maker's back.
    if (document.activeElement instanceof HTMLTextAreaElement) return;
    if (document.activeElement instanceof HTMLButtonElement) return;
    if (!canSubmit.value) return;
    e.preventDefault();
    submit();
    return;
  }
  if (e.key === "Tab") {
    const root = contentEl.value;
    if (!root) return;
    const els = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, textarea, button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = els[0];
    const last = els[els.length - 1];
    if (!first || !last) return;
    // SAFETY: els holds only focusable elements; includes() rejects anything else, so the
    // worst case is a spurious refocus at the edge.
    const active = document.activeElement as HTMLElement | null;
    const inTrap = active != null && els.includes(active);
    const atEdge = e.shiftKey ? active === first : active === last;
    if (atEdge || !inTrap) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }
}

// ── sidebar anchoring ─────────────────────────────────────────────────────
// The shell lives inside the settings drawer, not over the whole screen: the
// host (and its scrim) is fixed to the drawer's rect, so the dim only covers
// the sidebar and the card lands in its bottom-right corner. Without a
// measurement the host falls back to the full viewport, so a missing drawer
// degrades to the ordinary shell rather than misplacing the card.
const hostStyle = ref<CSSProperties>({});
let anchorEl: HTMLElement | null = null;
let anchorRO: ResizeObserver | null = null;

function anchorToDrawer() {
  const drawer = document.querySelector<HTMLElement>(".settings-scroll");
  if (drawer !== anchorEl) {
    anchorRO?.disconnect();
    anchorEl = drawer;
    if (drawer) {
      anchorRO = new ResizeObserver(anchorToDrawer);
      anchorRO.observe(drawer);
    }
  }
  if (!drawer) return;
  const rect = drawer.getBoundingClientRect();
  hostStyle.value = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

// ── elastic height (mirrors the other modals) ────────────────────────────────
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

/** How tall the card may grow: the padded host, so it never spills the drawer. */
function maxCardHeight(): number {
  const raw = String(hostStyle.value.height ?? "");
  if (raw.endsWith("px")) {
    const host = Number.parseFloat(raw);
    if (Number.isFinite(host)) return Math.max(160, host - 48);
  }
  return Math.round(window.innerHeight * 0.72);
}

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = Math.min(el.offsetHeight, maxCardHeight());
}

function onWindowResize() {
  syncHeight();
  anchorToDrawer();
}

let opener: HTMLElement | null = null;
onMounted(() => {
  // SAFETY: activeElement is the element focused just before open; null is allowed by the type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  void nextTick(() => {
    anchorToDrawer();
    syncHeight();
    ro = new ResizeObserver(syncHeight);
    if (contentEl.value) ro.observe(contentEl.value);
    focusOpenRow();
    requestAnimationFrame(() => (shown.value = true));
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
  ro?.disconnect();
  anchorRO?.disconnect();
  opener?.focus();
});
</script>

<template>
  <!-- Teleported to the body: this modal is mounted inside the settings drawer,
       whose aside is overflow-hidden and sits under a transformed stage. That
       transform makes a fixed child resolve against the drawer rather than the
       viewport, so without the teleport the scrim and card get clipped to the
       drawer's box. -->
  <Teleport to="body">
    <!-- The host is fixed to the drawer's rect (or the viewport when the drawer
         can't be found), so the shell never covers more than the sidebar. -->
    <div
      class="pointer-events-none fixed inset-0 z-50"
      :style="hostStyle"
    >
    <motion.div
      class="ca-scrim pointer-events-auto absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{ opacity: shown ? 1 : 0, backdropFilter: shown ? 'blur(4px)' : 'blur(0px)' }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="close"
    />

    <div class="pointer-events-none absolute inset-0 flex items-end justify-end p-6">
    <motion.div
      class="ca-card pointer-events-auto relative z-20 w-full max-w-md overflow-hidden"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{ opacity: shown ? 1 : 0, y: shown ? 0 : 12, scale: shown ? 1 : 0.96 }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      :aria-label="isEditing ? 'Edit agent' : 'Create an agent'"
    >
      <div ref="contentEl" class="flex shrink-0 flex-col">
        <!-- Header band: what this card makes, and cancel. -->
        <div class="ca-band ca-header">
          <span class="ca-eyebrow">{{ isEditing ? "Edit agent" : "New agent" }}</span>
          <button type="button" class="ca-close" aria-label="Close" title="Close (Esc)" @click="close">
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" />
          </button>
        </div>

        <!-- Body: four rows, each folding open over the one below it. -->
        <div class="ca-rows">
          <section v-for="s in SECTIONS" :key="s.id" class="ca-row" :class="{ 'is-open': open === s.id }">
            <button
              type="button"
              class="ca-row-head"
              :aria-expanded="open === s.id"
              @click="toggle(s.id)"
            >
              <span class="ca-row-label">{{ s.label }}</span>
              <span class="ca-row-value">
                {{ open === s.id ? HINTS[s.id] : summaries[s.id] }}
              </span>
              <span class="ca-chevron" aria-hidden="true">
                <HugeiconsIcon :icon="ArrowDown01Icon" :size="15" :stroke-width="2" />
              </span>
            </button>

            <AnimatePresence :initial="false">
              <motion.div
                v-if="open === s.id"
                :key="`${s.id}-body`"
                class="ca-row-body"
                :initial="{ opacity: 0, height: 0 }"
                :animate="{ opacity: 1, height: 'auto' }"
                :exit="{ opacity: 0, height: 0 }"
                :transition="collapseMorph"
              >
                <!-- Identity: what the agent is called and what it is for. -->
                <div v-if="s.id === 'identity'" class="ca-pane">
                  <label class="ca-field">
                    <span class="ca-glyph">
                      <HugeiconsIcon :icon="UserGroupIcon" :size="17" :stroke-width="1.7" aria-hidden="true" />
                    </span>
                    <input
                      v-model="name"
                      data-autofocus
                      type="text"
                      class="ca-input"
                      placeholder="Name — Doc Writer, Reviewer, Sentinel"
                      maxlength="64"
                      spellcheck="false"
                      autocomplete="off"
                      aria-label="Agent name"
                    />
                  </label>
                  <label class="ca-field">
                    <span class="ca-glyph">
                      <HugeiconsIcon :icon="SparklesIcon" :size="16" :stroke-width="1.7" aria-hidden="true" />
                    </span>
                    <input
                      v-model="role"
                      type="text"
                      class="ca-input"
                      placeholder="Role — architecture, security & review"
                      maxlength="120"
                      spellcheck="false"
                      autocomplete="off"
                      aria-label="Agent role"
                    />
                  </label>
                </div>

                <!-- Picture -->
                <div v-else-if="s.id === 'picture'" class="ca-pane">
                  <AgentAvatarEditor v-model:avatar="avatar" />
                </div>

                <!-- Bot -->
                <div v-else-if="s.id === 'bot'" class="ca-pane">
                  <AgentBotEditor v-model:bot="bot" />
                </div>

                <!-- Instructions -->
                <div v-else-if="s.id === 'instructions'" class="ca-pane">
                  <textarea
                    v-model="instructions"
                    data-autofocus
                    class="ca-input ca-textarea"
                    rows="5"
                    placeholder="How it works — habits and rules. e.g. Verify before claiming. Run the tests before saying done."
                    aria-label="Standing instructions"
                  />
                </div>

                <!-- Model -->
                <div v-else-if="s.id === 'capabilities'" class="ca-pane">
                  <AgentCapabilitiesEditor v-model:model="model" />
                </div>

                <!-- Teams: which projects this agent joins the team of, if any.
                     Optional — a project's team is built by hand, so joining
                     none is an ordinary answer. -->
                <div v-else-if="s.id === 'teams'" class="ca-pane">
                  <p v-if="!teamOptions.length" class="ca-empty">
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
                </div>
              </motion.div>
            </AnimatePresence>
          </section>
        </div>

        <p v-if="errorMsg" class="ca-error" role="alert">{{ errorMsg }}</p>

        <!-- Footer band: the one action this card exists for. -->
        <div class="ca-band ca-footer">
          <button type="button" class="ca-action text-muted" @click="close">Cancel</button>
          <button
            type="button"
            class="ca-action ca-forward text-ink"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{
              isSubmitting
                ? isEditing
                  ? "Saving…"
                  : "Creating…"
                : isEditing
                  ? "Save changes"
                  : "Create agent"
            }}
            <span class="ca-forward-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </motion.div>
    </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ca-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}

/* The card: the shared shell fill, radius and hairline ring. Bottom-anchored so
   the foot stays welded to the lower edge as the height springs. */
.ca-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  max-height: 100%;
}

/* ── bands ── concave-scooped recessed surfaces, same construction as the
   project and clone modals. */
.ca-band {
  --band-bg: var(--band);
  --band-arc: 14px;
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.ca-band::before,
.ca-band::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.ca-header::before,
.ca-header::after {
  top: 100%;
}
.ca-header::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.ca-header::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.ca-footer::before,
.ca-footer::after {
  bottom: 100%;
}
.ca-footer::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}
.ca-footer::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}

/* ── header ── */
.ca-header {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}
.ca-eyebrow {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
}
.ca-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  margin-right: -0.25rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.ca-close:hover {
  background: var(--hover);
  color: var(--ink);
}

/* ── rows ── the four concerns, stacked. No dividers and no boxes: a row is
   told apart from its neighbour by the space around it, and the open one by
   the faint wash it sits in. */
.ca-rows {
  display: flex;
  flex-direction: column;
  padding: 0.5rem 0.5rem 0.35rem;
}
.ca-row {
  border-radius: 12px;
  transition: background-color 0.24s ease;
}
.ca-row.is-open {
  background: color-mix(in srgb, var(--ink) 3.5%, transparent);
}
.ca-row-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  border: 0;
  border-radius: 12px;
  padding: 0.6rem 0.6rem 0.6rem 0.65rem;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.ca-row:not(.is-open) .ca-row-head:hover {
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}
.ca-row-label {
  flex: none;
  color: var(--ink);
  font-size: 13.5px;
  letter-spacing: -0.01em;
}
/* What a closed row is holding, or what an open one is for — either way kept
   quiet and clipped to one line, so a long role can't push the chevron off the
   edge. */
.ca-row-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  letter-spacing: -0.005em;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.9;
  transition: opacity 0.2s ease;
}
/* Open, the line is the row's purpose rather than its value — lighter still,
   since the fields under it are what the eye is going to. */
.ca-row.is-open .ca-row-value {
  opacity: 0.7;
}
.ca-chevron {
  display: inline-flex;
  flex: none;
  color: var(--muted);
  transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1), color 0.18s ease;
}
.ca-row.is-open .ca-chevron {
  color: var(--ink-soft);
  transform: rotate(180deg);
}
/* The fold itself — height is animated, so nothing inside it may overflow. */
.ca-row-body {
  overflow: hidden;
}
.ca-pane {
  display: flex;
  flex-direction: column;
  gap: 0.95rem;
  padding: 0.15rem 0.65rem 0.85rem;
}

/* ── fields ── borderless; reads as text until focused, with a leading glyph
   that firms on focus. Matches the project modal's name field. */
.ca-field {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.2rem 0;
}
.ca-glyph {
  display: inline-flex;
  flex: none;
  color: var(--muted);
  opacity: 0.7;
  transition: opacity 0.18s ease, color 0.18s ease;
}
.ca-field:focus-within .ca-glyph {
  color: var(--ink-soft);
  opacity: 1;
}
.ca-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink);
  font-size: 13.5px;
  letter-spacing: -0.01em;
  outline: none;
}
.ca-input::placeholder {
  color: var(--muted);
}
.ca-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

/* Instructions share the identity fields' language — borderless text, no
   surface of its own — keeping only what multiline needs: room to grow and a
   line height prose can breathe in. */
.ca-textarea {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
}

/* ── teams ── one togglable row per project. Borderless like the rest; the
   picked ones firm up and carry a check. */
.ca-empty {
  margin: 0;
  padding: 0.15rem 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--muted);
}
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

/* ── error ── quiet failure line beneath the stage. */
.ca-error {
  margin: 0 1rem 0.6rem;
  font-size: 11.5px;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: color-mix(in srgb, var(--diff-del) 82%, var(--ink));
}

/* ── footer ── */
.ca-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.ca-action {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.ca-action:hover:not(:disabled) {
  opacity: 0.7;
}
.ca-action:disabled {
  cursor: default;
  opacity: 0.4;
}
.ca-forward-arrow {
  color: var(--accent);
  font-weight: 500;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.ca-forward:not(:disabled):hover .ca-forward-arrow {
  transform: translateX(3px);
}

@media (prefers-reduced-motion: reduce) {
  .ca-card {
    transition-duration: 0.01s;
  }
}
</style>

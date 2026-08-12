<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import AgentSpaceModels from "~/components/AgentSpaceModels.vue";
import AgentSpaceSkills from "~/components/AgentSpaceSkills.vue";
import AgentSpaceMcp from "~/components/AgentSpaceMcp.vue";
import AgentSpaceInstructions from "~/components/AgentSpaceInstructions.vue";
import type { Project } from "~/composables/useProject";

// The agents space — the sibling of the repository space. Where Git answers
// "what has this code done", this answers "what have the agents done, what are
// they allowed to do, and what can they reach". Same shell on purpose: a
// masthead that says where you are, a fixed rail of sections, and one panel that
// changes under it. The page owns no agent state of its own; every section reads
// through useAgentSpace and renders exactly what came back, including nothing.

const props = defineProps<{ project: Project }>();

const space = useAgentSpace(() => props.project.path);
const { cue } = useSound();

type Section = "models" | "skills" | "mcp" | "instructions";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  { id: "instructions", label: "Instructions" },
];
const section = ref<Section>("models");
const activeIndex = computed(() => SECTIONS.findIndex((s) => s.id === section.value));

function go(id: Section): void {
  if (id === section.value) return;
  cue("press");
  section.value = id;
}

// Counts ride the rail only where a number is a fact worth carrying — how many
// skills are reachable, how many servers are configured, how many instruction
// files are in scope. Models have no count that means anything, so they carry
// none rather than a decorative one.
function countFor(id: Section): number | null {
  const inv = space.inventory.value;
  if (id === "skills") return inv?.skills.length || null;
  if (id === "mcp") return inv?.mcpServers.length || null;
  if (id === "instructions") return inv?.instructions.length || null;
  return null;
}

// The masthead's eyebrow: the standing state of the machine's agent tooling —
// how many providers kone can see.
const providers = useAgentProviders();
const eyebrow = computed(() => {
  const ready = providers.ready.value.length;
  if (!ready) return "no agent CLIs detected";
  return `${ready} provider${ready === 1 ? "" : "s"}`;
});

const refreshing = ref(false);
async function onRefresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  cue("press");
  try {
    await space.refresh();
  } finally {
    refreshing.value = false;
  }
}

onMounted(() => {
  void space.load();
});
</script>

<template>
  <div class="as">
    <div class="as__inner">
      <!-- ── masthead ───────────────────────────────────────────────────── -->
      <header class="as__masthead">
        <div class="as__identity">
          <p class="as__eyebrow">{{ eyebrow }}</p>
          <h1 class="as__title">Agents</h1>
        </div>

        <div class="as__actions">
          <button
            type="button"
            class="as__btn"
            :disabled="refreshing"
            @click="onRefresh"
          >
            <HugeiconsIcon
              class="as__btn-glyph"
              :class="{ 'as__btn-glyph--spin': refreshing }"
              :icon="RefreshIcon"
              :size="13"
              :stroke-width="2"
              aria-hidden="true"
            />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      <!-- ── body ───────────────────────────────────────────────────────── -->
      <div class="as__body">
        <nav class="as__nav" aria-label="Agent sections">
          <div class="as__navrows">
            <i class="as__navmark" :style="{ '--at': activeIndex }" aria-hidden="true" />
            <button
              v-for="s in SECTIONS"
              :key="s.id"
              type="button"
              class="as__navrow"
              :class="{ 'as__navrow--on': section === s.id }"
              :aria-current="section === s.id ? 'page' : undefined"
              @click="go(s.id)"
            >
              <span class="as__navlabel">{{ s.label }}</span>
              <span v-if="countFor(s.id)" class="as__navcount">{{ countFor(s.id) }}</span>
            </button>
          </div>
        </nav>

        <!-- One panel under the rail. Keyed on the section so a switch is a
             clean arrival, not a morph of one section's rows into another's. -->
        <div :key="section" class="as__panel">
          <AgentSpaceModels v-if="section === 'models'" :project="project" />
          <AgentSpaceSkills v-else-if="section === 'skills'" :space="space" />
          <AgentSpaceMcp v-else-if="section === 'mcp'" :space="space" />
          <AgentSpaceInstructions v-else :space="space" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The space shares the repository space's timing vocabulary rather than
   inventing a second one — the two are siblings and should move alike. */
.as {
  --as-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --as-ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --as-t-micro: 140ms;
  --as-t-small: 220ms;
  --as-t-enter: 320ms;
  --as-t-large: 420ms;
  /* The shell's three-beat entrance: masthead, then rail, then panel. */
  --as-enter-mast: 0ms;
  --as-enter-nav: 60ms;
  --as-enter-panel: 120ms;
  display: flex;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.as__inner {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1040px;
  min-height: 0;
  padding: 5rem 2.5rem 2.5rem;
}

/* The one entrance shape in the space: fade plus a 6px rise. */
@keyframes as-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ── masthead ─────────────────────────────────────────────────────────────── */
.as__masthead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  flex-shrink: 0;
  animation: as-in var(--as-t-enter) var(--as-ease) backwards;
  animation-delay: var(--as-enter-mast);
}
.as__identity {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
/* Machine state, set mono in natural case — the same treatment every other
   identifier in the app's spaces gets. */
.as__eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.2px;
  line-height: 1;
  color: var(--muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.as__title {
  font-size: 28px;
  letter-spacing: -0.5px;
  line-height: 1.1;
  color: var(--ink);
}

.as__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-top: 4px;
}
/* The app's one button recipe: bare until hovered, then a soft pill. */
.as__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--as-t-micro) ease,
    opacity var(--as-t-micro) ease;
}
.as__btn:hover:not(:disabled) {
  background-color: var(--hover);
}
.as__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.as__btn-glyph--spin {
  animation: as-spin 900ms linear infinite;
}
@keyframes as-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── body ─────────────────────────────────────────────────────────────────── */
.as__body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 34px;
}
.as__nav {
  display: flex;
  flex-direction: column;
  width: 150px;
  flex-shrink: 0;
  animation: as-in var(--as-t-enter) var(--as-ease) backwards;
  animation-delay: var(--as-enter-nav);
}
.as__navrows {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* One pill that slides, on a fixed 30px ladder with a 2px gap — where it goes is
   arithmetic, not measurement, so it can't fall out of step on a resize. */
.as__navmark {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 30px;
  border-radius: 8px;
  background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
  transform: translateY(calc(var(--at, 0) * 32px));
  transition: transform var(--as-t-small) var(--as-ease-move);
  pointer-events: none;
}
.as__navrow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding-inline: 10px;
  border-radius: 8px;
  font-size: 12.5px;
  letter-spacing: -0.1px;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
  transition:
    background-color var(--as-t-micro) ease,
    color var(--as-t-micro) ease;
}
.as__navrow:not(.as__navrow--on):hover {
  background-color: var(--hover);
}
.as__navrow:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.as__navrow--on {
  color: var(--ink);
}
.as__navlabel {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.as__navcount {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.75;
}

/* ── panel ────────────────────────────────────────────────────────────────── */
.as__panel {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding-left: 40px;
  overflow-y: auto;
  overscroll-behavior: contain;
  animation: as-in var(--as-t-enter) var(--as-ease) backwards;
  animation-delay: var(--as-enter-panel);
}

@media (max-width: 860px) {
  .as__inner {
    padding: 4rem 1.5rem 2rem;
  }
  .as__body {
    flex-direction: column;
    gap: 20px;
  }
  .as__nav {
    width: 100%;
  }
  .as__navrows {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .as__navmark {
    display: none;
  }
  .as__navrow--on {
    background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
  }
  .as__panel {
    padding-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .as__masthead,
  .as__nav,
  .as__panel {
    animation: none;
  }
  .as__navmark {
    transition: none;
  }
  .as__btn-glyph--spin {
    animation: none;
  }
}
</style>

<script setup lang="ts">
// Fused direction — "Card Deck + Rethought Two-Column Board".
// Keeps the user's three favourite pieces intact:
//   1. The horizontal folded-spine Provider Card Deck at the top
//   2. The Limits block (AgentSettingsLimits + Auto-resume / Snooze + Handoff cap)
//   3. The Models list (with Refresh + custom model slugs)
// Directly below the deck sits a compact Identity & Provider Control bar (replacing
// the redundant Sign-in box), followed by a clean two-column board where Runtime,
// Environment, Limits, and Models are all visible at once without tabs.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { onClickOutside } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  MoreHorizontalIcon,
  PlusSignIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import AddAgentPopover from "~/mockups/providers-pane/a/AddAgentPopover.vue";
import ModelsTab from "~/mockups/providers-pane/a/ModelsTab.vue";
import PfIdentityBar from "~/mockups/providers-pane/fused/PfIdentityBar.vue";
import PfRuntimeEnv from "~/mockups/providers-pane/fused/PfRuntimeEnv.vue";
import MockDeck from "~/mockups/providers-pane/MockDeck.vue";
import MockLimits from "~/mockups/providers-pane/MockLimits.vue";
import MockPaneFrame from "~/mockups/providers-pane/MockPaneFrame.vue";
import { MOCK_ORDER } from "~/mockups/providers-pane/sample";
import { useMockProvidersPane } from "~/mockups/providers-pane/useMockProvidersPane";
import type { ProviderKind } from "~/types/desktop";

const route = useRoute();
const asked = String(route.query.p ?? "");
const pane = useMockProvidersPane(
  MOCK_ORDER.find((p): p is ProviderKind => p === asked) ?? "codex",
);

const rows = computed(() => pane.rows.value);
const cur = computed(() => pane.current.value);
const checks = pane.updateChecks;

const INTERVALS = ["5m", "15m", "1m", "Off"] as const;
const intervalIdx = ref(0);
const interval = computed(() => INTERVALS[intervalIdx.value] ?? "5m");

const optsOpen = ref(route.query.opts === "1");
const addOpen = ref(route.query.add === "1");
const editBinary = computed(() => route.query.edit === "binary");
const customBinary = computed(() => String(route.query.bin ?? ""));

const optsWrap = ref<HTMLElement>();
const addWrap = ref<HTMLElement>();

onClickOutside(optsWrap, () => (optsOpen.value = false));
onClickOutside(addWrap, () => (addOpen.value = false));

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  optsOpen.value = false;
  addOpen.value = false;
}

onMounted(() => window.addEventListener("keydown", onKey));

const checking = ref(false);
let checkTimer: ReturnType<typeof setTimeout> | null = null;

function checkAgain() {
  checking.value = true;
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(() => (checking.value = false), 900);
}

const readyCount = computed(
  () => rows.value.filter((r) => r.status?.readiness === "ready" && r.enabled).length,
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  if (checkTimer) clearTimeout(checkTimer);
});
</script>

<template>
  <MockPaneFrame>
    <template #actions>
      <div class="pf__acts">
        <button type="button" class="pp__btn" @click="checkAgain">
          <HugeiconsIcon
            :icon="RefreshIcon"
            :size="13"
            :stroke-width="1.8"
            :class="{ 'pp__spin': checking }"
            aria-hidden="true"
          />
          {{ checking ? "Checking…" : "Check again" }}
        </button>

        <div ref="optsWrap" class="pf__anchor">
          <button
            type="button"
            class="pp__btn"
            aria-label="Providers options"
            :aria-expanded="optsOpen"
            @click="optsOpen = !optsOpen"
          >
            <HugeiconsIcon
              :icon="MoreHorizontalIcon"
              :size="14"
              :stroke-width="1.9"
              aria-hidden="true"
            />
          </button>

          <div v-if="optsOpen" class="pf__pop">
            <button
              type="button"
              role="switch"
              class="pp__checkrow pf__optrow"
              :aria-checked="checks"
              @click="checks = !checks"
            >
              <span class="pp__checklabel">Check registries on open</span>
              <span class="pp__switch" :class="{ 'pp__switch--on': checks }">
                <i class="pp__knob" />
              </span>
            </button>

            <button
              type="button"
              class="pp__checkrow pf__optrow"
              @click="intervalIdx = (intervalIdx + 1) % INTERVALS.length"
            >
              <span class="pp__checklabel">Health check interval</span>
              <span class="pf__optval">{{ interval }}</span>
            </button>
          </div>
        </div>
      </div>
    </template>

    <div class="pf__page">
      <!-- 1. Kept Folded-Spine Provider Card Deck + Add Agent tile -->
      <div class="pf__deckrow">
        <MockDeck :pane="pane" class="pf__deck" />

        <div ref="addWrap" class="pf__anchor">
          <button
            type="button"
            class="pf__addtile"
            aria-label="Add agent"
            :aria-expanded="addOpen"
            @click="addOpen = !addOpen"
          >
            <HugeiconsIcon :icon="PlusSignIcon" :size="18" :stroke-width="1.8" aria-hidden="true" />
          </button>

          <AddAgentPopover v-if="addOpen" />
        </div>
      </div>

      <!-- 2. Compact Identity & Provider Control Bar (replaces old Sign-in box) -->
      <PfIdentityBar :pane="pane" />

      <!-- 3. Rethought Two-Column Board: Runtime + Environment on left, Limits + Models on right -->
      <div :key="cur.provider" class="pf__board">
        <PfRuntimeEnv
          :row="cur"
          :initial-edit-binary="editBinary"
          :initial-custom-binary="customBinary"
        />

        <div class="pf__rightcol">
          <MockLimits :pane="pane" />
          <ModelsTab :pane="pane" />
        </div>
      </div>
    </div>

    <template #foot>
      <p class="pf__foot">{{ readyCount }} of {{ rows.length }} ready</p>
    </template>
  </MockPaneFrame>
</template>

<style scoped>
.pf__page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-inline: 1rem;
  overflow-y: auto;
  scrollbar-width: none;
  container-type: inline-size;
  container-name: pfpage;
}
.pf__page::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.pf__acts {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pf__anchor {
  position: relative;
  display: flex;
}

/* Deck + Add agent tile */
.pf__deckrow {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.pf__deck {
  flex: 1 1 auto;
  min-width: 0;
}
.pf__addtile {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 196px;
  border: 1px dashed var(--line);
  border-radius: 20px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color var(--pp-t-micro) ease,
    border-color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease;
}
.pf__addtile:hover {
  border-color: color-mix(in srgb, var(--ink) 24%, transparent);
  background-color: var(--hover);
  color: var(--ink);
}

/* Two-column board */
.pf__board {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.08fr);
  gap: 32px 48px;
  align-items: start;
  margin-top: 20px;
  padding-bottom: 18px;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) backwards;
}
.pf__rightcol {
  display: flex;
  flex-direction: column;
  gap: 28px;
  min-width: 0;
}

@container pfpage (max-width: 780px) {
  .pf__board {
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
  }
}

/* Global options popover */
.pf__pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background-color: var(--panel);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.14);
  animation: pp-in var(--pp-t-small) var(--pp-ease);
}
.pf__optrow {
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 8px;
  white-space: nowrap;
}
.pf__optval {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink);
}

.pf__foot {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--muted);
}
</style>

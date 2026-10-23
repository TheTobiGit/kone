<script setup lang="ts">
// Direction A — "Deck + section tabs". The deck stays the navigation and the
// summary it already is; everything under it is one section at a time, chosen by
// tabs, so the page never grows tall and each section gets the full width.
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { onClickOutside } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import AccountTab from "~/mockups/providers-pane/a/AccountTab.vue";
import AddAgentPopover from "~/mockups/providers-pane/a/AddAgentPopover.vue";
import EnvironmentTab from "~/mockups/providers-pane/a/EnvironmentTab.vue";
import ModelsTab from "~/mockups/providers-pane/a/ModelsTab.vue";
import RuntimeTab from "~/mockups/providers-pane/a/RuntimeTab.vue";
import MockDeck from "~/mockups/providers-pane/MockDeck.vue";
import MockLimits from "~/mockups/providers-pane/MockLimits.vue";
import MockPaneFrame from "~/mockups/providers-pane/MockPaneFrame.vue";
import MockSwitch from "~/mockups/providers-pane/MockSwitch.vue";
import { useMockProvidersPane } from "~/mockups/providers-pane/useMockProvidersPane";
import type { ProviderKind } from "~/types/desktop";
import { MOCK_ORDER } from "~/mockups/providers-pane/sample";

type TabId = "account" | "models" | "limits" | "runtime" | "environment";

const TABS: { id: TabId; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "models", label: "Models" },
  { id: "limits", label: "Limits" },
  { id: "runtime", label: "Runtime" },
  { id: "environment", label: "Environment" },
];

const route = useRoute();
const pane = useMockProvidersPane(
  MOCK_ORDER.find((p): p is ProviderKind => p === route.query.p) ?? "codex",
);

const rows = computed(() => pane.rows.value);
const cur = computed(() => pane.current.value);
const checks = pane.updateChecks;

const wanted = String(route.query.tab ?? "");
const tab = ref<TabId>(TABS.find((t) => t.id === wanted)?.id ?? "models");
const index = computed(() => rows.value.findIndex((r) => r.provider === cur.value.provider));
const readyCount = computed(() => rows.value.filter((r) => r.status?.readiness === "ready").length);

// Two popovers, one at a time in practice: the pane's options in the masthead,
// and the ACP registry hanging off the tile beside the deck.
const optsOpen = ref(false);
const addOpen = ref(route.query.add === "1");
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

const uid = useId();
const tabDomId = (id: TabId) => `${uid}-tab-${id}`;
const panelId = `${uid}-panel`;

function onTabKey(e: KeyboardEvent, i: number) {
  const n = TABS.length;
  const next =
    e.key === "ArrowRight"
      ? (i + 1) % n
      : e.key === "ArrowLeft"
        ? (i - 1 + n) % n
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? n - 1
            : -1;
  if (next < 0) return;
  const target = TABS[next];
  if (!target) return;
  e.preventDefault();
  tab.value = target.id;
  document.getElementById(tabDomId(target.id))?.focus();
}

// The masthead's re-check is inert, but it still answers the press.
const checking = ref(false);
let checkTimer: ReturnType<typeof setTimeout> | null = null;

function checkAgain() {
  checking.value = true;
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(() => (checking.value = false), 900);
}

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  if (checkTimer) clearTimeout(checkTimer);
});
</script>

<template>
  <MockPaneFrame>
    <template #actions>
      <div class="pa__acts">
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

        <div ref="optsWrap" class="pa__anchor">
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

          <div v-if="optsOpen" class="pa__pop">
            <button
              type="button"
              role="switch"
              class="pp__checkrow pa__optrow"
              :aria-checked="checks"
              @click="checks = !checks"
            >
              <span class="pp__checklabel">Check registries on open</span>
              <span class="pp__switch" :class="{ 'pp__switch--on': checks }">
                <i class="pp__knob" />
              </span>
            </button>
          </div>
        </div>
      </div>
    </template>

    <div class="pa__page">
      <!-- The deck is the navigation, and the tile beside it is the one way in. -->
      <div class="pa__deckrow">
        <MockDeck :pane="pane" class="pa__deck" />

        <div ref="addWrap" class="pa__anchor">
          <button
            type="button"
            class="pa__addtile"
            aria-label="Add agent"
            :aria-expanded="addOpen"
            @click="addOpen = !addOpen"
          >
            <HugeiconsIcon :icon="PlusSignIcon" :size="18" :stroke-width="1.8" aria-hidden="true" />
          </button>

          <AddAgentPopover v-if="addOpen" />
        </div>
      </div>

      <div class="pa__tabrow">
        <div class="pa__tabs" role="tablist" aria-label="Provider sections">
          <button
            v-for="(t, i) in TABS"
            :id="tabDomId(t.id)"
            :key="t.id"
            type="button"
            role="tab"
            class="pa__tab"
            :class="{ 'pa__tab--on': tab === t.id }"
            :aria-selected="tab === t.id"
            :aria-controls="panelId"
            :tabindex="tab === t.id ? 0 : -1"
            @click="tab = t.id"
            @keydown="onTabKey($event, i)"
          >
            {{ t.label }}
          </button>
        </div>

        <!-- The open provider's own controls, where its facts begin. -->
        <div class="pa__prov">
          <div class="pp__checkrow pa__ctl">
            <span class="pp__checklabel">Enabled</span>
            <MockSwitch
              :on="cur.enabled"
              label="Enabled"
              @toggle="pane.toggleEnabled(cur.provider)"
            />
          </div>

          <div class="pp__checkrow pa__ctl">
            <span class="pp__checklabel">In picker</span>
            <MockSwitch
              :on="!cur.hidden"
              label="In picker"
              @toggle="pane.toggleHidden(cur.provider)"
            />
          </div>

          <button
            type="button"
            class="pp__btn pa__move"
            aria-label="Move earlier"
            :disabled="index <= 0"
            @click="pane.move(cur.provider, -1)"
          >
            <HugeiconsIcon
              :icon="ArrowUp02Icon"
              :size="14"
              :stroke-width="1.8"
              class="pa__left"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            class="pp__btn pa__move"
            aria-label="Move later"
            :disabled="index >= rows.length - 1"
            @click="pane.move(cur.provider, 1)"
          >
            <HugeiconsIcon
              :icon="ArrowDown02Icon"
              :size="14"
              :stroke-width="1.8"
              class="pa__right"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      <div
        :id="panelId"
        :key="`${cur.provider}-${tab}`"
        class="pa__panel"
        role="tabpanel"
        :aria-labelledby="tabDomId(tab)"
        tabindex="-1"
      >
        <div v-if="tab === 'models'" class="pa__fill">
          <ModelsTab :pane="pane" />
        </div>

        <div v-else class="pa__scroll">
          <AccountTab v-if="tab === 'account'" :pane="pane" />
          <MockLimits
            v-else-if="tab === 'limits'"
            :pane="pane"
            :label="false"
            class="pa__limits"
          />
          <RuntimeTab v-else-if="tab === 'runtime'" :pane="pane" />
          <EnvironmentTab v-else :pane="pane" />
        </div>
      </div>
    </div>

    <template #foot>
      <p class="pa__foot">{{ readyCount }} of {{ rows.length }} ready</p>
    </template>
  </MockPaneFrame>
</template>

<style scoped>
.pa__page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-inline: 1rem;
}

.pa__acts {
  display: flex;
  align-items: center;
  gap: 4px;
}
/* Both popovers hang from a control rather than from the page. */
.pa__anchor {
  position: relative;
  display: flex;
}

/* ── deck + add tile ──────────────────────────────────────────────────────── */
.pa__deckrow {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.pa__deck {
  flex: 1 1 auto;
  min-width: 0;
}
.pa__addtile {
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
.pa__addtile:hover {
  border-color: color-mix(in srgb, var(--ink) 24%, transparent);
  background-color: var(--hover);
  color: var(--ink);
}
.pa__addtile:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── tabs ─────────────────────────────────────────────────────────────────── */
.pa__tabrow {
  display: flex;
  align-items: flex-end;
  gap: 24px;
  flex-shrink: 0;
  margin-top: 20px;
  border-bottom: 1px solid var(--line-soft);
}
.pa__tabs {
  display: flex;
  gap: 28px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.pa__tabs::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.pa__tab {
  position: relative;
  padding: 0 0 11px;
  font-size: 12.5px;
  line-height: 1.2;
  letter-spacing: -0.1px;
  color: var(--muted);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--pp-t-micro) ease;
}
.pa__tab:hover {
  color: var(--ink-soft);
}
.pa__tab--on {
  color: var(--ink);
}
/* The active tab's rule is the row's own hairline, thickened under it. */
.pa__tab--on::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  border-radius: 2px;
  background-color: var(--ink);
}
.pa__tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
  border-radius: 6px;
}

.pa__prov {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  margin-left: auto;
  padding-bottom: 3px;
}
/* The switch is the control; the row is its label, not a second target. */
.pa__ctl {
  gap: 10px;
  padding: 4px 6px 4px 10px;
  cursor: default;
}
.pa__ctl.pp__checkrow:hover {
  background-color: transparent;
}
.pa__move {
  padding-inline: 6px;
}
/* ArrowUp/Down turned on their side: earlier and later read as ← →. */
.pa__left {
  transform: rotate(-90deg);
}
.pa__right {
  transform: rotate(-90deg);
}

/* ── panel ────────────────────────────────────────────────────────────────── */
.pa__panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 22px;
  container-type: inline-size;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) backwards;
}
.pa__scroll {
  flex: 1 1 auto;
  min-height: 0;
  padding-right: 2px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.pa__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.pa__fill {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.pa__limits {
  max-width: 560px;
}

/* A command's Copy chip: the pane pins it over the truncated end of the command
   on a panel-coloured block. Here the rows are wide and most commands short, so
   the chip rides beside the text instead — and the command it can't fit ends in
   an ellipsis rather than a hard cut. */
.pa__panel :deep(dd.pp__factsval--cmd) {
  flex-wrap: nowrap;
}
.pa__panel :deep(.pp__factsval--cmd code) {
  text-overflow: ellipsis;
}
.pa__panel :deep(.pp__factsval--cmd .pp__copy) {
  position: static;
  margin-left: 2px;
  padding-left: 6px;
  background-image: none;
  transform: none;
}
.pa__panel :deep(.pp__factsval--cmd .pp__copy:hover) {
  background-image: none;
}

/* ── popover: the pane's own settings ────────────────────────────────────── */
.pa__pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 5;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background-color: var(--panel);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.1);
  animation: pp-in var(--pp-t-small) var(--pp-ease);
}
.pa__optrow {
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 4px 2px 4px 8px;
  border-radius: 8px;
  white-space: nowrap;
}

.pa__foot {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--muted);
}
</style>

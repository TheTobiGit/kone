<script setup lang="ts">
// The set of agents, as a roster: every agent in one column, ordered, grouped by
// whether it's enabled. Selecting a row opens that agent on the right; the order,
// the visibility and the disabled state are this column's business, not the
// open agent's. The foot owns the one global setting and the way in for agents
// kone doesn't ship with.
import { computed, nextTick, ref } from "vue";
import { onClickOutside, useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { DragDropVerticalIcon, PlusSignIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { pctLabel } from "~/components/provider/ProviderDeckLimits.vue";
import {
  hasUpdate,
  readinessText,
  type MockProvidersPane,
  type MockRow,
} from "~/mockups/providers-pane/useMockProvidersPane";
import PcAddAgent from "./PcAddAgent.vue";

const props = defineProps<{ pane: MockProvidersPane }>();
const addOpen = defineModel<boolean>("addOpen", { default: false });

/** Enabled agents first, then whatever the user turned off — the same set, told
   in two groups so "off" is a place rather than a dim row among live ones. */
const groups = computed(() => {
  const enabled: MockRow[] = [];
  const disabled: MockRow[] = [];
  for (const row of props.pane.rows.value) (row.enabled ? enabled : disabled).push(row);
  const list = [{ key: "on", label: "Active", rows: enabled }];
  if (disabled.length) list.push({ key: "off", label: "Off", rows: disabled });
  return list;
});

const foot = ref<HTMLElement>();
const addButton = ref<HTMLButtonElement>();

onClickOutside(foot, () => {
  addOpen.value = false;
});

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.key !== "Escape" || !addOpen.value) return;
  addOpen.value = false;
  // The search field owned focus inside the panel; hand it back to the control
  // that opened it rather than dropping the user at the top of the page.
  void nextTick(() => addButton.value?.focus());
});

function isSelected(row: MockRow): boolean {
  return props.pane.selected.value === row.provider;
}

/** The one line under the name: what it's asking for, else where it stands. */
function statusText(row: MockRow): string {
  if (hasUpdate(row.status, row.upkeep)) {
    return row.upkeep?.latestVersion ? `Update to ${row.upkeep.latestVersion}` : "Update available";
  }
  return readinessText(row.status);
}

function statusClass(row: MockRow): string {
  if (hasUpdate(row.status, row.upkeep)) return "pc__rowstatus--update";
  if (row.signal?.tone === "attention") return "pc__rowstatus--warn";
  if (row.signal?.tone === "problem") return "pc__rowstatus--danger";
  return "";
}

function focusRow(provider: string) {
  document.getElementById(`pc-row-${provider}`)?.focus();
}

/** ↑/↓ walk the roster; Alt+↑/↓ move the agent in it, focus staying with it. */
function onRowKey(e: KeyboardEvent, row: MockRow) {
  const dir = e.key === "ArrowDown" ? "down" : e.key === "ArrowUp" ? "up" : null;
  if (!dir) return;
  e.preventDefault();
  const step = dir === "down" ? 1 : -1;
  if (e.altKey) {
    props.pane.move(row.provider, step);
    focusRow(row.provider);
    return;
  }
  const rows = props.pane.rows.value;
  const i = rows.findIndex((r) => r.provider === row.provider);
  const next = rows[i + step];
  if (!next) return;
  props.pane.select(next.provider);
  focusRow(next.provider);
}

function toggleChecks() {
  props.pane.updateChecks.value = !props.pane.updateChecks.value;
}
</script>

<template>
  <aside class="pc__roster" aria-label="Agents">
    <div class="pc__rosterscroll">
      <div class="pc__listbox" role="listbox" aria-label="Agents">
        <div
          v-for="group in groups"
          :key="group.key"
          class="pc__group"
          role="group"
          :aria-label="group.label"
        >
          <p class="pp__blocklabel pc__grouplabel" aria-hidden="true">{{ group.label }}</p>

          <div v-for="row in group.rows" :key="row.provider" class="pc__rowwrap">
            <div
              :id="`pc-row-${row.provider}`"
              class="pc__row"
              :class="{ 'pc__row--on': isSelected(row), 'pc__row--off': group.key === 'off' }"
              role="option"
              :aria-selected="isSelected(row)"
              :tabindex="isSelected(row) ? 0 : -1"
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              @click="pane.select(row.provider)"
              @keydown="onRowKey($event, row)"
            >
              <span class="pc__swatch" :style="{ background: row.meta.grad }">
                <ProviderLogo :brand="row.meta.brand" tone="mono" :size="16" />
              </span>

              <span class="pc__rowtext">
                <span class="pc__rowname">
                  <span class="pc__rowlabel">{{ row.meta.label }}</span>
                  <HugeiconsIcon
                    v-if="row.hidden"
                    :icon="ViewOffIcon"
                    :size="12"
                    :stroke-width="1.8"
                    class="pc__rowhidden"
                    aria-hidden="true"
                  />
                </span>
                <span class="pc__rowstatus" :class="statusClass(row)">{{ statusText(row) }}</span>
              </span>

              <span class="pc__rowmeta">
                <span v-if="row.limits.spine" class="pc__pct">{{ pctLabel(row.limits.spine) }}</span>
                <span
                  v-if="row.signal"
                  class="pc__pip"
                  :class="`pc__pip--${row.signal.tone}`"
                  aria-hidden="true"
                />
              </span>
            </div>

            <button
              type="button"
              class="pc__grab"
              tabindex="-1"
              :aria-label="`Reorder ${row.meta.label}`"
              @click.stop
            >
              <HugeiconsIcon
                :icon="DragDropVerticalIcon"
                :size="14"
                :stroke-width="1.8"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div ref="foot" class="pc__rosterfoot">
      <button
        ref="addButton"
        type="button"
        class="pp__btn pc__addagent"
        aria-haspopup="dialog"
        :aria-expanded="addOpen"
        @click="addOpen = !addOpen"
      >
        <HugeiconsIcon :icon="PlusSignIcon" :size="14" :stroke-width="1.8" aria-hidden="true" />
        Add agent
      </button>

      <button
        type="button"
        role="switch"
        class="pp__checkrow pc__checkonopen"
        aria-label="Check on open"
        :aria-checked="pane.updateChecks.value"
        @click="toggleChecks"
      >
        <span class="pp__checklabel">Check on open</span>
        <span class="pp__switch" :class="{ 'pp__switch--on': pane.updateChecks.value }">
          <i class="pp__knob" />
        </span>
      </button>

      <div v-if="addOpen" class="pc__addwrap">
        <PcAddAgent />
      </div>
    </div>
  </aside>
</template>

<style scoped>
.pc__roster {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* The pane's own note button (the i) is pinned to the bottom-left corner; the
     roster's foot stops above it rather than fighting it for the same pixels. */
  padding-bottom: 26px;
}
.pc__rosterscroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.pc__rosterscroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.pc__listbox {
  display: flex;
  flex-direction: column;
}
.pc__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pc__group + .pc__group {
  margin-top: 18px;
}
.pc__grouplabel {
  padding: 0 10px;
  margin-bottom: 6px;
  color: var(--muted);
}

/* The row's own card, with a permanent slot at its right for the reorder handle
   so revealing it never reflows the name or the gauge. */
.pc__rowwrap {
  position: relative;
  min-width: 0;
}
.pc__row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 8px 26px 8px 10px;
  border-radius: 12px;
  cursor: pointer;
  transition: background-color var(--pp-t-micro) ease;
}
.pc__rowwrap:hover .pc__row {
  background-color: var(--hover);
}
.pc__row--on {
  background-color: var(--hover);
}
.pc__row--off {
  opacity: 0.55;
}
.pc__row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 22%, transparent);
}

.pc__swatch {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  color: #fff;
}

.pc__rowtext {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.pc__rowname {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 13px;
  line-height: 1.2;
  letter-spacing: -0.1px;
  color: var(--ink);
}
.pc__rowlabel {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.pc__rowhidden {
  flex-shrink: 0;
  color: var(--muted);
}
.pc__rowstatus {
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.2;
  color: var(--muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.pc__rowstatus--warn {
  color: var(--warn);
}
.pc__rowstatus--danger {
  color: var(--danger);
}
/* An update is neutral news — the same light the card's pill wears. */
.pc__rowstatus--update {
  color: var(--ink-soft);
}

.pc__rowmeta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.pc__pct {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.pc__pip {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent);
}
.pc__pip--update {
  background-color: var(--ink-soft);
}
.pc__pip--attention {
  background-color: var(--warn);
}
.pc__pip--problem {
  background-color: var(--danger);
}

/* The handle sits in the row's reserved right slot: only the pointer or focus
   brings it out, so the roster reads as a list rather than a control panel. */
.pc__grab {
  position: absolute;
  top: 50%;
  right: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 26px;
  border-radius: 6px;
  color: var(--muted);
  cursor: grab;
  opacity: 0;
  transform: translateY(-50%);
  transition:
    opacity var(--pp-t-micro) ease,
    color var(--pp-t-micro) ease;
}
.pc__rowwrap:hover .pc__grab,
.pc__grab:focus-visible {
  opacity: 1;
}
.pc__grab:hover {
  color: var(--ink-soft);
}
.pc__grab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.pc__rosterfoot {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  flex-shrink: 0;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}
.pc__addagent {
  justify-content: flex-start;
  width: 100%;
}
.pc__checkonopen {
  justify-content: space-between;
  padding: 6px 2px 6px 10px;
}
.pc__addwrap {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 5;
  width: 300px;
  max-width: calc(100vw - 4rem);
}

/* Below a narrow pane the roster is a strip over the detail: same rows, laid
   along the top, foot inline at its end. */
@container pclayout (max-width: 859px) {
  .pc__roster {
    flex-direction: row;
    align-items: center;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--line-soft);
  }
  .pc__rosterscroll {
    flex: 1 1 auto;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .pc__listbox {
    flex-direction: row;
    gap: 6px;
  }
  .pc__group {
    display: contents;
  }
  .pc__grouplabel {
    display: none;
  }
  .pc__rowwrap {
    flex: 0 0 auto;
  }
  .pc__row {
    width: 210px;
  }
  .pc__rosterfoot {
    flex-direction: row;
    align-items: center;
    flex-shrink: 0;
    margin-top: 0;
    padding: 0 0 0 12px;
    border-top: none;
    border-left: 1px solid var(--line-soft);
  }
  .pc__addagent {
    width: auto;
  }
  /* Anchored to the foot's right edge in strip mode, so opening the registry
     never pushes the panel past the viewport; and above the foot is the
     masthead, so it opens down into the board instead. */
  .pc__addwrap {
    left: auto;
    right: 0;
    top: calc(100% + 8px);
    bottom: auto;
  }
}
</style>

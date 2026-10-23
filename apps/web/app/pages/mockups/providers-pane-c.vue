<script setup lang="ts">
// Direction C — "Roster + board". Managing the set of agents (order, hide,
// disable, add) and configuring one agent are different jobs, so they get
// different places: a roster column owns the set, the open agent fills the right
// with its card and a two-column board where every section is on screen at once.
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import MockPaneFrame from "~/mockups/providers-pane/MockPaneFrame.vue";
import MockDeck from "~/mockups/providers-pane/MockDeck.vue";
import MockLimits from "~/mockups/providers-pane/MockLimits.vue";
import { useMockProvidersPane } from "~/mockups/providers-pane/useMockProvidersPane";
import PcRoster from "~/mockups/providers-pane/c/PcRoster.vue";
import PcAccounts from "~/mockups/providers-pane/c/PcAccounts.vue";
import PcModelsExtra from "~/mockups/providers-pane/c/PcModelsExtra.vue";
import PcRuntime from "~/mockups/providers-pane/c/PcRuntime.vue";
import PcEnvironment from "~/mockups/providers-pane/c/PcEnvironment.vue";
import PcSignIn from "~/mockups/providers-pane/c/PcSignIn.vue";
import { MOCK_ORDER } from "~/mockups/providers-pane/sample";
import { canSignIn } from "~/utils/providerLogin";

const route = useRoute();
// The URL names the agent to open; anything the mockup doesn't know falls back
// to the first one rather than selecting a row that isn't on the roster.
const asked = String(route.query.p ?? "");
const pane = useMockProvidersPane(MOCK_ORDER.find((k) => k === asked) ?? "codex");

const row = computed(() => pane.current.value);
const addOpen = ref(route.query.add === "1");
const checking = ref(false);

// The detail carries the app's own edge smoke rather than a scrollbar — the
// composable re-attaches when the keyed column is replaced on a provider switch.
const detailEl = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(detailEl);

const readyCount = computed(
  () => pane.rows.value.filter((r) => r.status?.readiness === "ready" && r.enabled).length,
);

function recheck() {
  if (checking.value) return;
  checking.value = true;
  setTimeout(() => {
    checking.value = false;
  }, 1100);
}
</script>

<template>
  <MockPaneFrame>
    <template #actions>
      <button type="button" class="pp__btn" :disabled="checking" @click="recheck">
        <HugeiconsIcon
          :icon="RefreshIcon"
          :size="13"
          :stroke-width="1.8"
          :class="{ 'pp__spin': checking }"
          aria-hidden="true"
        />
        Check again
      </button>
    </template>

    <div class="pc__wrap">
      <div class="pc__layout">
        <PcRoster :pane="pane" v-model:add-open="addOpen" />

        <div
          :key="row.provider"
          ref="detailEl"
          class="pc__detail"
          :style="maskStyle"
          @scroll.passive="measure"
        >
          <MockDeck :pane="pane" only />

          <div class="pc__provrow">
            <PcAccounts :row="row" />

            <div class="pc__flags">
              <button
                type="button"
                role="switch"
                class="pp__checkrow"
                :aria-checked="!row.hidden"
                @click="pane.toggleHidden(row.provider)"
              >
                <span class="pp__checklabel">Show in picker</span>
                <span class="pp__switch" :class="{ 'pp__switch--on': !row.hidden }">
                  <i class="pp__knob" />
                </span>
              </button>

              <button
                type="button"
                role="switch"
                class="pp__checkrow"
                :aria-checked="row.enabled"
                @click="pane.toggleEnabled(row.provider)"
              >
                <span class="pp__checklabel">Enabled</span>
                <span class="pp__switch" :class="{ 'pp__switch--on': row.enabled }">
                  <i class="pp__knob" />
                </span>
              </button>
            </div>
          </div>

          <div class="pc__board">
            <div class="pc__col">
              <PcSignIn
                v-if="canSignIn(row.provider) && row.status?.readiness !== 'not-installed'"
                :row="row"
                :login="pane.loginDisplay.value"
              />
              <PcRuntime :row="row" />
              <PcEnvironment :row="row" />
            </div>

            <div class="pc__col">
              <MockLimits :pane="pane" />
              <PcModelsExtra :pane="pane" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <template #foot>{{ readyCount }} of {{ pane.rows.value.length }} ready</template>
  </MockPaneFrame>
</template>

<style scoped>
/* The pane's whole body, and the container the roster folds against. */
.pc__wrap {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  container-type: inline-size;
  container-name: pclayout;
}
.pc__layout {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  gap: 28px;
  flex: 1 1 auto;
  min-height: 0;
  padding-inline: 1rem;
}
/* The open agent's column scrolls on its own: the roster never moves with it.
   It is also the width reference for the board's own two columns. */
.pc__detail {
  min-width: 0;
  min-height: 0;
  padding-right: 2px;
  padding-bottom: 8px;
  overflow-y: auto;
  scrollbar-width: none;
  container-type: inline-size;
  container-name: pcdetail;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) backwards;
}
.pc__detail::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* The controls that belong to the open provider rather than to one of its
   sections: who is signed in on the left, what the app does with it on the right. */
.pc__provrow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 20px;
  margin-top: 12px;
}
.pc__flags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.pc__board {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 40px 48px;
  margin-top: 26px;
}
.pc__col {
  display: flex;
  flex-direction: column;
  gap: 32px;
  min-width: 0;
}

/* A pane too narrow for two columns lets the roster run along the top instead
   of eating the detail's width. */
@container pclayout (max-width: 859px) {
  .pc__layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    gap: 16px;
  }
}

/* And a detail too narrow for the board stacks its two columns in reading order:
   sign-in, runtime, environment, then limits and models. */
@container pcdetail (max-width: 719px) {
  .pc__board {
    grid-template-columns: minmax(0, 1fr);
    gap: 32px;
  }
}
</style>

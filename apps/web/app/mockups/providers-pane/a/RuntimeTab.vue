<script setup lang="ts">
// Direction A — Runtime: how kone reaches this provider (executable + health on
// the left) and what it runs (version facts on the right). Two columns when the
// panel is wide enough, stacked when it isn't. Every control is inert.
import { computed, onBeforeUnmount, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  ArrowUp02Icon,
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  Copy01Icon,
  Folder01Icon,
  GitForkIcon,
  Layers01Icon,
  Link01Icon,
  Package01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { MOCK_HEALTH, MOCK_PATH_CHECK } from "~/mockups/providers-pane/sample";
import {
  hasUpdate,
  INSTALL_SOURCE_LABEL,
  type MockProvidersPane,
} from "~/mockups/providers-pane/useMockProvidersPane";

const props = defineProps<{ pane: MockProvidersPane }>();

const row = computed(() => props.pane.current.value);
const upkeep = computed(() => row.value.upkeep);
const check = computed(() => MOCK_PATH_CHECK[row.value.provider]);
const health = computed(() => MOCK_HEALTH[row.value.provider]);
const newer = computed(() => hasUpdate(row.value.status, upkeep.value));
const channel = computed(() => INSTALL_SOURCE_LABEL[upkeep.value?.installSource ?? "unknown"]);

// The path the user would type. The sample's binary is the placeholder, exactly
// as the real field does it.
const binaryDraft = ref("");

const INTERVALS = ["5m", "15m", "1m", "Off"] as const;
const intervalIdx = ref(0);
const interval = computed(() => INTERVALS[intervalIdx.value] ?? "5m");
const rechecking = ref(false);
const copied = ref(false);
let recheckTimer: ReturnType<typeof setTimeout> | null = null;
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function recheck() {
  rechecking.value = true;
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = setTimeout(() => (rechecking.value = false), 900);
}

async function copyUpdate() {
  const command = upkeep.value?.updateCommand;
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1_600);
  } catch {
    // A denied clipboard is not worth an error state — the command is on screen.
  }
}

onBeforeUnmount(() => {
  if (recheckTimer) clearTimeout(recheckTimer);
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <div class="pa__runtime">
    <!-- Left: the executable kone shells out to, and the last health read. -->
    <div class="pa__col">
      <section v-if="row.meta.binary" class="pp__block pa__block" aria-label="Executable">
        <p class="pp__blocklabel">Executable</p>

        <div class="pa__pathrow">
          <input
            v-model="binaryDraft"
            type="text"
            class="pp__input"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            :placeholder="row.meta.binary"
            :aria-label="`${row.meta.label} CLI path`"
          />
          <span
            v-if="check"
            class="pa__check"
            :class="{ 'pa__check--bad': check.state === 'missing' }"
          >
            <HugeiconsIcon
              :icon="check.state === 'missing' ? AlertCircleIcon : CheckmarkCircle02Icon"
              :size="13"
              :stroke-width="1.9"
              aria-hidden="true"
            />
            {{ check.state === "missing" ? "Not found" : check.version }}
          </span>
        </div>

        <dl v-if="upkeep?.resolvedPath" class="pp__facts">
          <div class="pp__factsrow">
            <dt>
              <HugeiconsIcon
                :icon="Folder01Icon"
                :size="14"
                :stroke-width="1.7"
                aria-hidden="true"
              />
              Resolved
            </dt>
            <dd>{{ upkeep.resolvedPath }}</dd>
          </div>
          <div v-if="upkeep.realPath" class="pp__factsrow">
            <dt>
              <HugeiconsIcon :icon="Link01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
              Points at
            </dt>
            <dd>{{ upkeep.realPath }}</dd>
          </div>
        </dl>
      </section>

      <section class="pp__block pa__block" aria-label="Health">
        <p class="pp__blocklabel">Health</p>
        <div class="pa__health">
          <span class="pa__dot" :class="`pa__dot--${health.state}`" aria-hidden="true" />
          <span class="pa__healthlabel">{{ health.label }}</span>
          <span class="pa__healthtime">{{ health.checked }}</span>
          <button
            type="button"
            class="pp__btn pa__interval"
            aria-label="Health check interval"
            @click="intervalIdx = (intervalIdx + 1) % INTERVALS.length"
          >
            Every {{ interval }}
          </button>
          <button type="button" class="pp__btn" @click="recheck">
            <HugeiconsIcon
              :icon="RefreshIcon"
              :size="12"
              :stroke-width="1.8"
              :class="{ 'pp__spin': rechecking }"
              aria-hidden="true"
            />
            Re-check
          </button>
        </div>
      </section>
    </div>

    <!-- Right: what the provider itself runs, and the command that moves it. -->
    <div class="pa__col">
      <section class="pp__block pa__block" aria-label="Version">
        <p class="pp__blocklabel">Version</p>

        <dl class="pp__facts">
          <div class="pp__factsrow">
            <dt>
              <HugeiconsIcon :icon="Layers01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
              Current
            </dt>
            <dd>{{ upkeep?.currentVersion ?? row.status?.version ?? "—" }}</dd>
          </div>

          <div v-if="upkeep?.latestKnowable" class="pp__factsrow">
            <dt>
              <HugeiconsIcon :icon="ArrowUp02Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
              Latest
            </dt>
            <dd>
              {{ upkeep?.latestVersion ?? "—" }}
              <span v-if="newer" class="pp__new">New</span>
            </dd>
          </div>

          <div class="pp__factsrow">
            <dt>
              <HugeiconsIcon :icon="GitForkIcon" :size="14" :stroke-width="1.7" aria-hidden="true" />
              Channel
            </dt>
            <dd class="pp__factsval--plain">{{ channel }}</dd>
          </div>

          <div v-if="upkeep?.packageName" class="pp__factsrow">
            <dt>
              <HugeiconsIcon :icon="Package01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
              Package
            </dt>
            <dd>{{ upkeep.packageName }}</dd>
          </div>

          <div v-if="upkeep?.updateCommand" class="pp__factsrow">
            <dt>
              <HugeiconsIcon
                :icon="ComputerTerminal01Icon"
                :size="14"
                :stroke-width="1.7"
                aria-hidden="true"
              />
              Update
            </dt>
            <dd class="pp__factsval--cmd">
              <code>{{ upkeep.updateCommand }}</code>
              <button
                type="button"
                class="pp__copy"
                aria-label="Copy the update command"
                @click="copyUpdate"
              >
                <HugeiconsIcon
                  :icon="Copy01Icon"
                  :size="12"
                  :stroke-width="1.9"
                  aria-hidden="true"
                />
                {{ copied ? "Copied" : "Copy" }}
              </button>
            </dd>
          </div>
        </dl>

        <button v-if="newer" type="button" class="pp__btn pp__btn--outline pa__upbtn">
          Update to {{ upkeep?.latestVersion }}
        </button>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* One column until the panel can carry two; the query is on the panel, so the
   layout answers the room it actually has rather than the window. */
.pa__runtime {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 26px;
  align-content: start;
}
@container (min-width: 760px) {
  .pa__runtime {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 56px;
  }
}
.pa__col {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}
.pa__block {
  align-items: stretch;
}

/* ── executable ───────────────────────────────────────────────────────────── */
.pa__pathrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.pa__pathrow .pp__input {
  flex: 1 1 auto;
  min-width: 0;
}
/* The inline check: what the typed path actually is, in the version's own
   register, so the answer sits beside the field rather than under it. */
.pa__check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
  color: var(--muted);
}
.pa__check svg {
  color: var(--ok);
}
.pa__check--bad {
  color: var(--danger);
}
.pa__check--bad svg {
  color: var(--danger);
}

/* ── health ───────────────────────────────────────────────────────────────── */
.pa__health {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
}
.pa__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.pa__dot--ok {
  background-color: var(--ok);
}
.pa__dot--warn {
  background-color: var(--warn);
}
.pa__dot--fail {
  background-color: var(--danger);
}
.pa__healthlabel {
  font-size: 12.5px;
  line-height: 1.4;
  letter-spacing: -0.1px;
  color: var(--ink);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa__healthtime {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.3;
  color: var(--muted);
  white-space: nowrap;
}
.pa__health .pp__btn {
  margin-left: 2px;
}
.pa__interval {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.pa__upbtn {
  align-self: flex-start;
  margin-top: 4px;
}
</style>

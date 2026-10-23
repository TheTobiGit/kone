<script setup lang="ts">
// The open agent's runtime: which executable kone calls, what it resolves to,
// how the installed version stands, and the last health read. The path field
// carries its check inline — the answer to "is this path real?" belongs beside
// the path, not in a second place.
import { computed, ref } from "vue";
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
import {
  INSTALL_SOURCE_LABEL,
  hasUpdate,
  type MockRow,
} from "~/mockups/providers-pane/useMockProvidersPane";
import { MOCK_HEALTH, MOCK_PATH_CHECK } from "~/mockups/providers-pane/sample";
import { usePcCopy } from "./usePcCopy";

const props = defineProps<{ row: MockRow }>();

const pathDraft = ref("");
const rechecking = ref(false);
const { copied, copy } = usePcCopy();

const pathCheck = computed(() => MOCK_PATH_CHECK[props.row.provider] ?? null);
const health = computed(() => MOCK_HEALTH[props.row.provider]);
const behind = computed(() => hasUpdate(props.row.status, props.row.upkeep));

const HEALTH_TONE: Record<string, string> = { ok: "", warn: "pc__headdot--warn", fail: "pc__headdot--fail" };
const HEALTH_TEXT: Record<string, string> = { ok: "", warn: "pc__health--warn", fail: "pc__health--fail" };

function recheck() {
  if (rechecking.value) return;
  rechecking.value = true;
  setTimeout(() => {
    rechecking.value = false;
  }, 900);
}
</script>

<template>
  <section class="pp__block" aria-label="Runtime">
    <p class="pp__blocklabel">Runtime</p>

    <!-- The executable field, with its check beside it. A provider kone bundles
         has no path at all, so the row is simply absent. -->
    <div v-if="row.meta.binary" class="pc__pathrow">
      <input
        v-model="pathDraft"
        type="text"
        class="pp__input pc__pathinput"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        :placeholder="row.meta.binary"
        :aria-label="`${row.meta.label} CLI path`"
      />
      <span
        v-if="pathCheck"
        class="pc__pathcheck"
        :class="{ 'pc__pathcheck--bad': pathCheck.state === 'missing' }"
      >
        <HugeiconsIcon
          :icon="pathCheck.state === 'ok' ? CheckmarkCircle02Icon : AlertCircleIcon"
          :size="13"
          :stroke-width="1.9"
          aria-hidden="true"
        />
        <span class="pc__pathver">{{ pathCheck.state === "ok" ? pathCheck.version : "Not found" }}</span>
        <span class="pc__sr">{{ pathCheck.state === "ok" ? "Executable found" : "Executable not found" }}</span>
      </span>
    </div>

    <dl class="pp__facts">
      <div v-if="row.upkeep?.resolvedPath" class="pp__factsrow">
        <dt>
          <HugeiconsIcon :icon="Folder01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
          Resolved
        </dt>
        <dd>{{ row.upkeep.resolvedPath }}</dd>
      </div>

      <div v-if="row.upkeep?.realPath" class="pp__factsrow">
        <dt>
          <HugeiconsIcon :icon="Link01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
          Points at
        </dt>
        <dd>{{ row.upkeep.realPath }}</dd>
      </div>

      <div class="pp__factsrow">
        <dt>
          <HugeiconsIcon :icon="Layers01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
          Current
        </dt>
        <dd>{{ row.upkeep?.currentVersion ?? row.status?.version ?? "—" }}</dd>
      </div>

      <div v-if="row.upkeep?.latestKnowable" class="pp__factsrow">
        <dt>
          <HugeiconsIcon :icon="ArrowUp02Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
          Latest
        </dt>
        <dd>
          {{ row.upkeep?.latestVersion ?? "—" }}
          <span v-if="behind" class="pp__new">New</span>
        </dd>
      </div>

      <div class="pp__factsrow">
        <dt>
          <HugeiconsIcon :icon="GitForkIcon" :size="14" :stroke-width="1.7" aria-hidden="true" />
          Channel
        </dt>
        <dd class="pp__factsval--plain">
          {{ INSTALL_SOURCE_LABEL[row.upkeep?.installSource ?? "unknown"] }}
        </dd>
      </div>

      <div v-if="row.upkeep?.packageName" class="pp__factsrow">
        <dt>
          <HugeiconsIcon :icon="Package01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
          Package
        </dt>
        <dd>{{ row.upkeep.packageName }}</dd>
      </div>

      <div
        v-if="row.upkeep?.canUpdate && row.status?.available && row.upkeep.updateCommand"
        class="pp__factsrow"
      >
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
          <code>{{ row.upkeep.updateCommand }}</code>
          <button
            type="button"
            class="pp__copy"
            aria-label="Copy the update command"
            @click="copy(row.upkeep.updateCommand!)"
          >
            <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
            {{ copied === row.upkeep.updateCommand ? "Copied" : "Copy" }}
          </button>
        </dd>
      </div>

      <div class="pp__factsrow">
        <dt>Health</dt>
        <dd class="pc__health">
          <span class="pc__headdot" :class="HEALTH_TONE[health.state]" aria-hidden="true" />
          <span class="pc__healthlabel" :class="HEALTH_TEXT[health.state]">{{ health.label }}</span>
          <span class="pc__healthtime">{{ health.checked }}</span>
          <button
            type="button"
            class="pp__btn pc__recheck"
            :aria-busy="rechecking"
            @click="recheck"
          >
            <HugeiconsIcon
              :icon="RefreshIcon"
              :size="12"
              :stroke-width="1.9"
              :class="{ 'pp__spin': rechecking }"
              aria-hidden="true"
            />
            Re-check
          </button>
        </dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.pc__pathrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.pc__pathinput {
  flex: 1 1 auto;
  min-width: 0;
}
/* The check rides beside the field, not inside it: the field stays the thing you
   type in, and the mark is the machine's answer about it. */
.pc__pathcheck {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1;
  color: var(--ok);
}
.pc__pathcheck--bad {
  color: var(--danger);
}
.pc__pathver {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  white-space: nowrap;
}
.pc__pathcheck--bad .pc__pathver {
  font-family: var(--font-sans);
  color: var(--danger);
}
.pc__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.pc__health {
  align-items: center;
  gap: 8px;
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--ink-soft);
}
.pc__headdot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--ok);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent);
}
.pc__headdot--warn {
  background-color: var(--warn);
}
.pc__headdot--fail {
  background-color: var(--danger);
}
.pc__health--warn {
  color: var(--warn);
}
.pc__health--fail {
  color: var(--danger);
}
.pc__healthtime {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.pc__recheck {
  margin-left: auto;
  padding-inline: 7px;
}
</style>

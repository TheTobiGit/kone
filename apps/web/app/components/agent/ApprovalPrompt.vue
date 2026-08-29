<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  FileIcon,
  PenTool01Icon,
  SecurityIcon,
  TerminalIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import type { ApprovalDecision, ApprovalRequest, ApprovalRequestKind } from "~/types/desktop";

// The approval ask itself — the kind chip, the headline, the provider's reason,
// and the three decisions — as one self-contained block. Two surfaces wear it:
// the main ApprovalModal (bottom-centre over the composer's spot, inside the
// scrim + elastic card) and the subagent shell's inline approval (pinned in the
// shell body so a parked child's ask can be answered without leaving the shell).
// One block, both hosts — the wording and the decision ladder never fork.

const props = withDefaults(
  defineProps<{
    approval: ApprovalRequest;
    queueIndex?: number;
    queueTotal?: number;
    /** Max height of the scrollable ask body. The modal caps it so a long ask
     *  can't outgrow the card; an inline host passes "none" and lets its own
     *  scroll area own the height. */
    scrollMax?: string;
  }>(),
  { scrollMax: "52vh", queueIndex: 0, queueTotal: 0 },
);

const emit = defineEmits<{
  decide: [decision: ApprovalDecision];
  prev: [];
  next: [];
}>();

const queueActive = computed(() => props.queueTotal > 1);

// The kind chip: icon + short verb per approval kind.
const KIND_META = {
  command: { label: "Run command", icon: TerminalIcon },
  "file-read": { label: "Read file", icon: FileIcon },
  "file-change": { label: "Change files", icon: PenTool01Icon },
  permission: { label: "Request permission", icon: SecurityIcon },
  tool: { label: "Tool call", icon: ToolsIcon },
} satisfies Record<ApprovalRequestKind, { label: string; icon: typeof TerminalIcon }>;
const kindMeta = computed(() => KIND_META[props.approval.kind] ?? KIND_META.tool);

// Commands read best in mono — the headline is a command line or a path for
// every kind except `tool`, where the tool name stays in the body typeface.
const mono = computed(() => props.approval.kind !== "tool");
</script>

<template>
  <div class="approve-body">
    <!-- Recessed header band with the arc scoops flowing into the card walls
         — the shared picker/insert shell signature. -->
    <div class="picker-header">
      <span class="approve-kind">
        <HugeiconsIcon :icon="kindMeta.icon" :size="14" :stroke-width="1.9" aria-hidden="true" />
        {{ kindMeta.label }}
      </span>

      <!-- Queue position readout and step back/next controls -->
      <div v-if="queueActive" class="approve-nav">
        <span class="approve-nav__count">{{ queueIndex + 1 }}/{{ queueTotal }}</span>
        <div class="approve-nav__buttons">
          <button
            type="button"
            class="approve-nav__btn"
            :disabled="queueIndex <= 0"
            aria-label="Previous approval"
            title="Previous approval"
            @click="emit('prev')"
          >
            <HugeiconsIcon :icon="ArrowLeft01Icon" :size="12" :stroke-width="2.2" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="approve-nav__btn"
            :disabled="queueIndex >= queueTotal - 1"
            aria-label="Next approval"
            title="Next approval"
            @click="emit('next')"
          >
            <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2.2" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>

    <div
      class="approve-scroll"
      :style="{ maxHeight: scrollMax }"
    >
      <!-- The headline — the command line / path / tool name. Commands get
           the mono block so the exact thing being approved is unambiguous. -->
      <div
        class="approve-title"
        :class="{ 'approve-title--mono': mono }"
      >{{ approval.title }}</div>

      <!-- The provider's stated reason, when it gave one. -->
      <p v-if="approval.detail" class="approve-detail">{{ approval.detail }}</p>
    </div>

    <!-- Footer band (scoops up into the card walls) — text actions matching
         the shared picker/modal shells. -->
    <div class="picker-footer">
      <div class="approve-actions">
        <button
          type="button"
          class="picker-action text-danger"
          @click="emit('decide', 'reject-once')"
        >
          Reject
        </button>
        <button
          type="button"
          class="picker-action text-danger"
          @click="emit('decide', 'reject-and-stop')"
        >
          Reject and stop
        </button>
      </div>

      <div class="approve-actions">
        <button
          type="button"
          class="picker-action text-muted"
          @click="emit('decide', 'allow-always')"
        >
          Always allow
        </button>
        <button
          type="button"
          class="picker-action text-ink font-semibold"
          @click="emit('decide', 'allow-once')"
        >
          Allow
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.approve-body {
  --band-bg: var(--band);
  --band-arc: 14px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* Recessed header band with the arc scoops that flow into the card walls —
   lifted from the folder/model/insert shells so this reads as one family. */
.picker-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.picker-header::before,
.picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

/* The kind chip — icon + short verb, the header band's title slot. */
.approve-kind {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

/* Queue position and step back/next controls in the header band */
.approve-nav {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
  font-size: 11px;
  color: var(--muted);
}
.approve-nav__count {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  letter-spacing: -0.01em;
}
.approve-nav__buttons {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.approve-nav__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}
.approve-nav__btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--ink);
}
.approve-nav__btn:disabled {
  opacity: 0.25;
  cursor: default;
}

/* The headline — a command line or path in a quiet mono slab; the tool name
   stays in body type. */
.approve-title {
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.4;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.approve-title--mono {
  font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
  padding: 0.5rem 0.65rem;
  background: color-mix(in srgb, var(--ink) 4.5%, transparent);
}

.approve-detail {
  font-size: 13px;
  line-height: 1.45;
  color: var(--ink-soft);
}

/* Footer band, welded to the card's lower edge with the arc scoops flowing UP
   into the walls (mirror of the header band) — the picker footer family. */
.picker-footer {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.picker-footer::before,
.picker-footer::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  bottom: 100%;
  pointer-events: none;
}
.picker-footer::before {
  left: 0;
  background: radial-gradient(
    circle at top right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-footer::after {
  right: 0;
  background: radial-gradient(
    circle at top left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

/* Text-button actions — no fill, quiet hover fade — exactly the pickers'
   treatment. */
.picker-action {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.picker-action:hover:not(:disabled) {
  opacity: 0.7;
}
.picker-action:disabled {
  cursor: default;
  opacity: 0.4;
}
.text-danger {
  color: var(--danger);
}
.text-muted {
  color: var(--muted);
}
.text-ink {
  color: var(--ink);
}

.approve-actions {
  display: flex;
  align-items: center;
  gap: 1.25rem;
}

/* Match the pickers' quiet scrollbar. */
.approve-scroll {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 1rem 1rem 0.5rem;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.approve-scroll::-webkit-scrollbar {
  width: 10px;
}
.approve-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.approve-scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: content-box;
}
.approve-scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
}
</style>

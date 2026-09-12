<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onClickOutside } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AppleFinderIcon,
  Archive02Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  Cancel01Icon,
  Clock01Icon,
  Download01Icon,
  Folder01Icon,
  FolderOpenIcon,
  GitBranchIcon,
  GitCommitIcon,
  GridViewIcon,
  Home01Icon,
  InboxIcon,
  Layers01Icon,
  PinIcon,
  PlusSignIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import PickerShell from "~/components/ui/PickerShell.vue";
import type { IntentIcon, IntentItem, IntentSection } from "~/composables/useIntentMenu";
import type { SurfaceId } from "~/utils/surfaceTop";

// The intent menu — a right-click menu in the picker-shell family. It renders
// the divided cards (go-tos, now, before) without section labels: the cards
// themselves carry the grouping. Positioned fixed at the pointer, clamped into
// the viewport; Escape / outside-click / pick all dismiss through `close`.

const props = defineProps<{
  x: number;
  y: number;
  title: string;
  sections: IntentSection[];
  shown: boolean;
  surfaceTop: SurfaceId;
}>();

const emit = defineEmits<{
  pick: [item: IntentItem];
  close: [];
}>();

const icons = {
  studio: Layers01Icon,
  inbox: InboxIcon,
  overview: Home01Icon,
  git: GitBranchIcon,
  launcher: GridViewIcon,
  back: ArrowTurnBackwardIcon,
  review: GitCommitIcon,
  project: Folder01Icon,
  session: Clock01Icon,
  create: PlusSignIcon,
  open: FolderOpenIcon,
  clone: Download01Icon,
  pin: PinIcon,
  reveal: AppleFinderIcon,
  forget: Cancel01Icon,
  settings: Settings02Icon,
  archive: Archive02Icon,
} satisfies Record<IntentIcon, typeof InboxIcon>;

const shellEl = ref<HTMLElement | null>(null);
const left = ref(props.x);
const top = ref(props.y);

onClickOutside(shellEl, () => emit("close"));

// Keep the whole shell on screen: measure after paint and nudge back from any
// edge it would cross, with a small margin from the viewport.
async function clamp(): Promise<void> {
  await nextTick();
  const el = shellEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const margin = 8;
  left.value = Math.min(props.x, window.innerWidth - rect.width - margin);
  top.value = Math.min(props.y, window.innerHeight - rect.height - margin);
  left.value = Math.max(margin, left.value);
  top.value = Math.max(margin, top.value);
}

onMounted(clamp);
watch(() => [props.x, props.y, props.sections], clamp);

// ── keyboard ────────────────────────────────────────────────────────────────
// One flat list across cards so arrows travel the whole menu; the active row
// highlights like hover and Enter picks it.
const flat = computed<IntentItem[]>(() => props.sections.flatMap((s) => s.items));
// Row id to flat position, so hover and highlight compare numbers instead of
// scanning the list per row. Ids are unique across cards — a session lead
// drops itself from its siblings card, and recents hide under a tile target.
const flatIndex = computed<Map<string, number>>(() => {
  const map = new Map<string, number>();
  flat.value.forEach((item, index) => {
    if (!map.has(item.id)) map.set(item.id, index);
  });
  return map;
});
const active = ref(0);
watch(
  () => props.sections,
  () => (active.value = 0),
);
// A shrink must never strand the cursor past the last row — Enter reads
// flat[active] directly, so clamp it back into range.
watch(
  () => flat.value.length,
  (length) => {
    if (active.value > length - 1) active.value = Math.max(0, length - 1);
  },
);

function isActive(id: string): boolean {
  return flatIndex.value.get(id) === active.value;
}

function hoverItem(id: string): void {
  const next = flatIndex.value.get(id);
  if (next !== undefined) active.value = next;
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.shown) return;
  const count = flat.value.length;
  if (e.key === "Escape") {
    if (props.surfaceTop !== "intent-menu") return;
    e.preventDefault();
    emit("close");
    return;
  }
  if (count === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    active.value = (active.value + 1) % count;
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    active.value = (active.value - 1 + count) % count;
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const item = flat.value[active.value];
    if (item) emit("pick", item);
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div
    class="intent-root"
    :style="{ left: `${left}px`, top: `${top}px` }"
  >
    <div ref="shellEl" class="intent-shell">
      <PickerShell :title="title" :shown="shown" dialog-label="Intent menu" @close="emit('close')">
        <section
          v-for="section in sections"
          :key="section.key"
          class="picker-card flex flex-col p-1"
        >
          <button
            v-for="item in section.items"
            :key="item.id"
            type="button"
            class="action-row"
            :class="{ 'action-row--active': isActive(item.id) }"
            @click="emit('pick', item)"
            @mouseenter="hoverItem(item.id)"
          >
            <span class="action-row__icon">
              <HugeiconsIcon :icon="icons[item.icon]" :size="15" :stroke-width="1.7" aria-hidden="true" />
            </span>
            <span class="action-row__label">{{ item.label }}</span>
            <span v-if="item.hint" class="intent-hint" :title="item.hint">{{ item.hint }}</span>
            <HugeiconsIcon
              :icon="ArrowRight01Icon"
              :size="13"
              :stroke-width="2"
              class="action-row__arrow text-muted"
              aria-hidden="true"
            />
          </button>
        </section>
      </PickerShell>
    </div>
  </div>
</template>

<style scoped>
.intent-root {
  position: fixed;
  z-index: 90;
  width: 300px;
}
.intent-shell {
  width: 100%;
}
/* Tall stacks (open space can hold four cards) scroll under a pinned header
   instead of clipping. The overflow lives on the tray — never on a wrapper
   around the shell, whose soft shadow a scrolling ancestor would cut off,
   leaving only the harsh 1px ring. */
.intent-shell :deep(.picker-tray) {
  max-height: calc(100vh - 180px);
  overflow-y: auto;
}
/* Keyboard-active rows read exactly like hover — one highlight language. */
.intent-shell .action-row--active {
  background-color: var(--hover);
}
.intent-shell .action-row--active .action-row__arrow {
  opacity: 1;
  transform: translateX(0);
}
.intent-hint {
  flex: none;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted);
}
</style>

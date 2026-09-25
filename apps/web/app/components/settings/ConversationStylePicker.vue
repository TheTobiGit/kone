<script setup lang="ts">
import ConversationStyleGlyph from "~/components/settings/ConversationStyleGlyph.vue";
import { useRovingRadios } from "~/composables/useRovingRadios";
import {
  CONVERSATION_STYLES,
  type ConversationStyle,
  type ConversationStyleOption,
} from "~/utils/conversationStyle";

// The Conversation page's style row: one tile per look a conversation can take
// (utils/conversationStyle), each a miniature of one exchange drawn in that
// look — who sits where, and what ties the request to the reply. Pointing at or
// focusing a tile probes it, so the stage plays the thread in that style before
// it is picked, the same way the choices below it do.

const props = defineProps<{
  open: boolean;
  /** The style that's set. */
  value: ConversationStyle;
  /** The tile being pointed at or focused, if any. */
  probe: ConversationStyle | null;
}>();

const emit = defineEmits<{
  choose: [style: ConversationStyle];
  probe: [style: ConversationStyle | null];
}>();

function choose(opt: ConversationStyleOption): void {
  if (opt.id !== props.value) emit("choose", opt.id);
}
function leave(opt: ConversationStyleOption): void {
  if (props.probe === opt.id) emit("probe", null);
}

// Arrows move the selection and the focus together, like the choices below.
const { setTileEl, onKeydown } = useRovingRadios<ConversationStyleOption>();
</script>

<template>
  <section class="cs" aria-labelledby="cs-title">
    <h2 id="cs-title" class="cs__title">Style</h2>
    <div class="cs__tiles" role="radiogroup" aria-labelledby="cs-title">
      <button
        v-for="(opt, i) in CONVERSATION_STYLES"
        :key="opt.id"
        :ref="(el) => setTileEl(el, opt)"
        type="button"
        role="radio"
        class="cs__tile"
        :class="{ 'cs__tile--on': value === opt.id }"
        :aria-checked="value === opt.id"
        :aria-label="`${opt.label} — ${opt.description}`"
        :title="opt.description"
        :tabindex="open && value === opt.id ? 0 : -1"
        @click="choose(opt)"
        @keydown="onKeydown($event, i, CONVERSATION_STYLES, choose, open)"
        @pointerenter="emit('probe', opt.id)"
        @pointerleave="leave(opt)"
        @focus="emit('probe', opt.id)"
        @blur="leave(opt)"
      >
        <ConversationStyleGlyph
          :kind="opt.id"
          :accent="value === opt.id"
          :live="probe ? probe === opt.id : value === opt.id"
        />
        <span class="cs__label">{{ opt.label }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
@keyframes cs-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

.cs {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-inline: 0.25rem;
  animation: cs-in var(--cv-t-enter) var(--cv-ease) backwards;
}
.cs__title {
  margin: 0;
  padding-inline: 0.25rem;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.cs__tiles {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 8px;
}
@media (max-width: 1180px) {
  .cs__tiles {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.cs__tile {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
  min-width: 0;
  padding: 5px 5px 7px;
  border-radius: 13px;
  text-align: center;
  cursor: pointer;
  transition: background-color var(--cv-t-micro) ease;
}
.cs__tile:hover {
  background-color: var(--hover);
}
.cs__tile:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.cs__label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 1.2;
  color: var(--muted);
  transition: color var(--cv-t-micro) ease;
}
.cs__tile:hover .cs__label {
  color: var(--ink-soft);
}
.cs__tile--on .cs__label {
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .cs {
    animation: none;
  }
}
</style>

<script setup lang="ts">
import { computed } from "vue";
import { Robot01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import { useSound } from "~/composables/useSound";
import {
  BOT_COLORS,
  BOT_EXPRESSIONS,
  BOT_FORMS,
  botGround,
  botMark,
  DEFAULT_BOT,
  type AgentBot,
  type BotColorId,
  type BotExpressionId,
  type BotFormId,
} from "~/utils/bot";

// The bot an agent drives: a body shape, a colour, a resting expression. Its own
// editor and its own row, kept away from the agent's picture — a picture says who
// is speaking and belongs beside a name, a bot is the creature the agent works
// through and belongs where it is working. Sharing one pane made a maker scroll
// past thirty-six swatches to reach a face, or past a face to reach the swatches.
//
// Having no bot is a real answer, not an unfinished one: it is a different thing
// from wearing the default bot, so an agent starts without one and the preview
// says so. But it is not a door to be opened — the axes are live from the start
// and picking anything on them is what gives the agent its bot, since a button
// that only reveals the swatches is a click that answers nothing. Until then the
// swatches draw against the default without claiming to be it, and "Remove" is
// how you get back to having none.

const props = defineProps<{ bot: AgentBot | null }>();
const emit = defineEmits<{ "update:bot": [AgentBot | null] }>();

const { cue } = useSound();

const mark = computed(() => (props.bot ? botMark(props.bot) : ""));
/** Every mark here is drawn on the ground its colour needs, so the two neutral
 *  bodies stay visible on both schemes instead of sinking into one of them. The
 *  swatches of an agent with no bot use the default's ground, which is what makes
 *  them legible before there is anything to be legible against. */
const ground = computed(() => botGround(props.bot ?? DEFAULT_BOT));

function clear() {
  cue("collapse");
  emit("update:bot", null);
}

/** One axis moved, the other two left where they were — or, on an agent with no
 *  bot yet, one axis chosen and the other two taken from the default. Which is
 *  the whole of "give it a bot": there is nothing to ask first. */
function pick(over: Partial<AgentBot>) {
  const base = props.bot;
  const next = { ...(base ?? DEFAULT_BOT), ...over };
  if (base && base.form === next.form && base.color === next.color && base.expression === next.expression) {
    return;
  }
  cue(base ? "toggle" : "expand");
  emit("update:bot", next);
}

function setForm(form: BotFormId) {
  pick({ form });
}
function setColor(color: BotColorId) {
  pick({ color });
}
function setExpression(expression: BotExpressionId) {
  pick({ expression });
}

/** Every swatch draws the bot the maker would actually get if they pressed it —
 *  the axis it offers changed and the other two left alone. A row of abstract
 *  labels would make the maker guess at eight shapes and sixteen faces. */
function swatch(over: Partial<AgentBot>): string {
  return botMark({ ...(props.bot ?? DEFAULT_BOT), ...over });
}
</script>

<template>
  <div class="bot">
    <div class="bot__row">
      <span
        v-if="bot"
        class="bot__mug bot__mug--bot"
        :style="{ background: ground }"
        aria-hidden="true"
        v-html="mark"
      />
      <span v-else class="bot__mug bot__mug--empty" aria-hidden="true">
        <HugeiconsIcon :icon="Robot01Icon" :size="18" :stroke-width="1.6" />
      </span>
      <button v-if="bot" type="button" class="bot__btn bot__btn--quiet" @click="clear">
        Remove
      </button>
      <span v-else class="bot__aside">Pick anything below to give it one.</span>
    </div>

    <!-- Nothing is marked while there is no bot: the swatches are drawn against
         the default so they can be told apart, and marking one would say the
         agent already wears it. -->
    <div class="bot__axis">
      <span class="bot__axislabel">Shape</span>
      <div class="bot__swatches">
        <button
          v-for="form in BOT_FORMS"
          :key="form.id"
          type="button"
          class="bot__swatch"
          :class="{ 'is-on': bot?.form === form.id }"
          :aria-pressed="bot?.form === form.id"
          :aria-label="form.label"
          :title="form.label"
          @click="setForm(form.id)"
        >
          <span
            class="bot__mark"
            :style="{ background: ground }"
            v-html="swatch({ form: form.id })"
          />
        </button>
      </div>
    </div>

    <div class="bot__axis">
      <span class="bot__axislabel">Colour</span>
      <div class="bot__swatches">
        <button
          v-for="color in BOT_COLORS"
          :key="color.id"
          type="button"
          class="bot__swatch"
          :class="{ 'is-on': bot?.color === color.id }"
          :aria-pressed="bot?.color === color.id"
          :aria-label="color.label"
          :title="color.label"
          @click="setColor(color.id)"
        >
          <span class="bot__dot" :style="{ background: color.hex }" />
        </button>
      </div>
    </div>

    <div class="bot__axis">
      <span class="bot__axislabel">Expression</span>
      <div class="bot__swatches">
        <button
          v-for="expression in BOT_EXPRESSIONS"
          :key="expression.id"
          type="button"
          class="bot__swatch"
          :class="{ 'is-on': bot?.expression === expression.id }"
          :aria-pressed="bot?.expression === expression.id"
          :aria-label="expression.label"
          :title="expression.label"
          @click="setExpression(expression.id)"
        >
          <span
            class="bot__mark"
            :style="{ background: ground }"
            v-html="swatch({ expression: expression.id })"
          />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bot {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.bot__aside {
  font-size: 11.5px;
  color: var(--muted);
}
.bot__row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 2px;
}
/* The preview holds its size whether or not there is a bot in it, so giving one
   fills a hole rather than pushing the row about. */
.bot__mug {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  color: var(--muted);
}
.bot__mug--empty {
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
/* A bot on its own ground, held off the plate's edge — a body that fills its
   tile to the rim reads as clipped rather than drawn. */
.bot__mug--bot {
  padding: 8px;
  box-sizing: border-box;
}
.bot__mug--bot :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.bot__btn {
  display: inline-flex;
  align-items: center;
  padding: 6px 11px;
  border: 0;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}
.bot__btn:hover {
  background: color-mix(in srgb, var(--ink) 11%, transparent);
}
.bot__btn--quiet {
  color: var(--muted);
  background: transparent;
}
.bot__btn--quiet:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.bot__axis {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.bot__axislabel {
  font-size: 11.5px;
  color: var(--muted);
}
.bot__swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
/* Big enough that sixteen expressions are told apart at a glance — half a
   millimetre of eye is what separates wary from bored, and a smaller tile turns
   the row into sixteen identical blobs. A picked swatch is marked by the ground
   it sits on rather than a ring: a ring on a round mark reads as part of the
   mark. */
.bot__swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.16s ease;
}
.bot__swatch:hover {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}
.bot__swatch.is-on {
  background: color-mix(in srgb, var(--ink) 12%, transparent);
}
.bot__mark {
  display: inline-flex;
  width: 34px;
  height: 34px;
  padding: 3px;
  box-sizing: border-box;
  border-radius: 50%;
}
.bot__mark :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
/* The ring is mixed from the theme's ink, which always contrasts the surface —
   so it delineates the near-black body on the dark scheme and the near-white one
   on paper, where each would otherwise sink into the ground. */
.bot__dot {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 16%, transparent);
}
</style>

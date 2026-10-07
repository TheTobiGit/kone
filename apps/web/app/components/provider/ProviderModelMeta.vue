<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, ArrowRight01Icon, FlashIcon } from "@hugeicons/core-free-icons";
import { brainStack } from "~/utils/subagentRuns";
import type { Effort, ModelOption } from "~/utils/modelCatalog";

// One model family's meta line — vendor, context sizes, reasoning span, fast
// tier — as pieces rather than one string, so each can wear its own mark: the
// reasoning span the same tier-hued brain stacks the composer uses for effort
// (the eye already reads those as "how hard it thinks", which a word list does
// not), the fast tier the composer's bolt.
//
// This component owns the pieces end to end: the caller hands it the family and
// gets the line, and nothing outside knows the shape of a piece.

const props = defineProps<{
  model: ModelOption;
  /** The descriptor's own context size, for a family that lists no windows. */
  fallbackTokens?: number;
  /** Name the model's vendor — worth it only on a harness whose catalog spans
   *  many vendors. */
  showVendor?: boolean;
}>();

type ContextSize = { tokens: number; label: string; isDefault: boolean };

type MetaPiece =
  | { kind: "text"; text: string }
  | { kind: "context"; sizes: ContextSize[]; aria: string }
  | { kind: "reasoning"; rungs: Effort[]; aria: string }
  | { kind: "fast"; label: string };

/** Turn a native context capacity into a compact badge — "200K", "1M". */
function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/** Every context size a model can run at, smallest first, with the one it
 *  starts on marked — a model whose window is a choice says so, rather than
 *  showing only its default and hiding the rest. A model with one fixed window
 *  comes out as a single size. */
function contextSizes(): ContextSize[] {
  const sized = (props.model.contextWindows ?? []).filter((w) => w.tokens > 0);
  const defaultWindow = sized.find((w) => w.isDefault) ?? sized[0];
  if (!defaultWindow) {
    const t = props.fallbackTokens;
    return t && t > 0 ? [{ tokens: t, label: tokenLabel(t), isDefault: true }] : [];
  }
  const distinct = [...new Set(sized.map((w) => w.tokens))].toSorted((a, b) => a - b);
  return distinct.map((t) => ({ tokens: t, label: tokenLabel(t), isDefault: t === defaultWindow.tokens }));
}

function contextAria(sizes: ContextSize[]): string {
  if (sizes.length === 1) return `${sizes[0]!.label} context window`;
  const fallback = sizes.find((s) => s.isDefault)?.label;
  return `Context window: ${sizes.map((s) => s.label).join(" or ")}, ${fallback} by default`;
}

const pieces = computed<MetaPiece[]>(() => {
  const out: MetaPiece[] = [];
  if (props.showVendor && props.model.vendor) out.push({ kind: "text", text: props.model.vendor });

  const sizes = contextSizes();
  if (sizes.length) out.push({ kind: "context", sizes, aria: contextAria(sizes) });

  // Reasoning breadth as a span — lowest rung to highest — rather than a rung
  // count; a single rung is just that rung.
  const real = props.model.efforts.filter((e) => e.tier !== "base");
  const first = real[0];
  const last = real[real.length - 1];
  if (first && last) {
    const rungs = last === first ? [first] : [first, last];
    const aria = rungs.length > 1 ? `${first.label} to ${last.label} reasoning` : `${first.label} reasoning`;
    out.push({ kind: "reasoning", rungs, aria });
  }

  if (props.model.fastTier) out.push({ kind: "fast", label: props.model.fastTier.label });
  return out;
});
</script>

<template>
  <span v-if="pieces.length" class="pmm">
    <template v-for="(piece, i) in pieces" :key="i">
      <span v-if="i > 0" class="pmm__sep" aria-hidden="true">·</span>

      <span v-if="piece.kind === 'text'">{{ piece.text }}</span>

      <span v-else-if="piece.kind === 'context'" class="pmm__ctx" :aria-label="piece.aria">
        <template v-for="(size, c) in piece.sizes" :key="size.tokens">
          <span v-if="c > 0" class="pmm__ctxsep" aria-hidden="true">/</span>
          <span
            class="pmm__ctxsize"
            :class="{ 'pmm__ctxsize--default': size.isDefault && piece.sizes.length > 1 }"
            aria-hidden="true"
          >{{ size.label }}</span>
        </template>
        <span aria-hidden="true">context</span>
      </span>

      <span v-else-if="piece.kind === 'fast'" class="pmm__fast">
        <HugeiconsIcon :icon="FlashIcon" :size="11" :stroke-width="2" class="pmm__fastmark" aria-hidden="true" />
        {{ piece.label }}
      </span>

      <span v-else class="pmm__reasoning" :aria-label="piece.aria">
        <template v-for="(rung, r) in piece.rungs" :key="rung.id">
          <HugeiconsIcon
            v-if="r > 0"
            :icon="ArrowRight01Icon"
            :size="11"
            :stroke-width="2"
            class="pmm__arrow"
            aria-hidden="true"
          />
          <span class="pmm__rung" aria-hidden="true">
            <span class="pmm__brains">
              <HugeiconsIcon
                v-for="n in brainStack(rung.brains)"
                :key="n"
                :icon="AiBrain01Icon"
                :size="11"
                :stroke-width="2"
                :style="{ color: rung.hue }"
              />
            </span>
            {{ rung.label }}
          </span>
        </template>
      </span>
    </template>
  </span>
</template>

<style scoped>
.pmm {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 1.3;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
}
.pmm__sep {
  flex: none;
}

/* Several sizes read as a choice: the default in ink, the alternatives at the
   line's muted weight, so "which one do I get" is answered without a word. */
.pmm__ctx {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  flex: none;
}
.pmm__ctxsep {
  color: color-mix(in srgb, var(--muted) 60%, transparent);
}
.pmm__ctxsize--default {
  color: var(--ink);
}

.pmm__reasoning,
.pmm__rung,
.pmm__brains {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.pmm__reasoning,
.pmm__rung {
  gap: 4px;
}
.pmm__brains {
  gap: 1px;
  line-height: 0;
}
.pmm__arrow {
  flex: none;
  color: color-mix(in srgb, var(--muted) 70%, transparent);
}

/* The bolt in the boost hue, as the composer's fast toggle wears it — but
   without its glow, which there means "on"; here it only says the tier exists. */
.pmm__fast {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.pmm__fastmark {
  flex: none;
  color: var(--boost);
}
</style>

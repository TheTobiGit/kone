<script setup lang="ts">
import { computed } from "vue";
import { RotatingText } from "~/components/ui/rotating-text";

// nxui Rotating Text in a lowercase "make it {word}." sentence, set in the
// Fraunces display serif (contrast with the app's Geist sans).
//
// The rotation is FIVE sets. Each set is four software/dev-themed words that
// build the brand up letter by letter — starting with a longer prefix of "kone"
// (k → ko → kon → kone) — and every set ends on the brand itself, "kone.". Only
// the growing prefix is accent-coloured, so the orange letters spell out the
// brand and land on it each set. After the fifth set the loop restarts at set 1.
const props = withDefaults(
  defineProps<{
    // Five sets of four build words (k · ko · kon · kone prefixes). Each set is
    // capped with `brand` at render time.
    sets?: string[][];
    brand?: string;
    interval?: number;
    // The brand word lingers longer before the next set starts.
    brandHold?: number;
    prefix?: string;
  }>(),
  {
    prefix: "make it",
    brand: "kone.",
    interval: 2200,
    brandHold: 4600,
    sets: () => [
      ["kompiled.", "kompatible.", "konkurrent.", "konekted."],
      ["kached.", "kohesive.", "konfigured.", "konektiv."],
      ["krafted.", "kollaborative.", "kontinuous.", "konektable."],
      ["klustered.", "komposable.", "konsistent.", "konektor."],
      ["kompact.", "kompressed.", "konverged.", "konexus."],
    ],
  },
);

// Flatten the sets into one continuous rotation: [...set, brand] × 5. The build
// words accent a growing prefix (1,2,3,4); the brand accents its whole self
// including the full stop (its length).
const words = computed(() => props.sets.flatMap((set) => [...set, props.brand]));
const accentCounts = computed(() =>
  props.sets.flatMap((set) => [...set.map((_, i) => i + 1), props.brand.length]),
);
// Build words tick at `interval`; the brand word (end of each set) holds longer.
const intervals = computed(() =>
  props.sets.flatMap((set) => [...set.map(() => props.interval), props.brandHold]),
);
</script>

<template>
  <div
    class="flex select-none items-baseline gap-[0.28em] font-serif text-[15px] font-medium leading-[1.15] tracking-normal text-ink"
    style="font-optical-sizing: auto"
    role="img"
    aria-label="kone"
  >
    <span>{{ prefix }}</span>
    <RotatingText
      :texts="words"
      :rotation-interval="interval"
      :intervals="intervals"
      stagger-from="first"
      highlight-class="text-accent"
      :highlight-counts="accentCounts"
      class="leading-[1.15]"
    />
  </div>
</template>

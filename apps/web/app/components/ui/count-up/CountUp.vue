<script setup lang="ts">
  import { useIntersectionObserver } from '@vueuse/core';
  import { cn } from '~/lib/utils';

  const props = withDefaults(
    defineProps<{
      to: number;
      from?: number;
      duration?: number;
      separator?: string;
      decimals?: number;
      class?: string;
    }>(),
    {
      from: 0,
      duration: 2,
      separator: ',',
      decimals: 0,
      class: '',
    },
  );

  const el = ref<HTMLElement>();
  const currentValue = ref(props.from);
  const hasTriggered = ref(false);

  function formatNumber(num: number): string {
    const fixed = num.toFixed(props.decimals);
    if (!props.separator) return fixed;
    const [integer, decimal] = fixed.split('.');
    const formatted = (integer ?? '').replace(
      /\B(?=(\d{3})+(?!\d))/g,
      props.separator,
    );
    return decimal !== undefined ? `${formatted}.${decimal}` : formatted;
  }

  function easeOutExpo(t: number): number {
    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  }

  let frame = 0;

  // Tween the displayed value from wherever it is now to `target`. Used for the
  // first reveal and again whenever `to` changes, so a live data update (a
  // discarded file dropping the total, a commit clearing it) animates rather
  // than snapping.
  function tweenTo(target: number) {
    cancelAnimationFrame(frame);
    const startValue = currentValue.value;
    const startTime = performance.now();
    const durationMs = props.duration * 1000;

    function animate(now: number) {
      const progress = Math.min((now - startTime) / durationMs, 1);
      currentValue.value = startValue + (target - startValue) * easeOutExpo(progress);
      if (progress < 1) {
        frame = requestAnimationFrame(animate);
      } else {
        currentValue.value = target;
      }
    }

    frame = requestAnimationFrame(animate);
  }

  function startCount() {
    if (hasTriggered.value) return;
    hasTriggered.value = true;
    tweenTo(props.to);
  }

  const displayValue = computed(() => formatNumber(currentValue.value));

  useIntersectionObserver(el, ([entry]) => {
    if (entry?.isIntersecting) {
      startCount();
    }
  });

  // After the first reveal, follow subsequent `to` changes live.
  watch(
    () => props.to,
    (next) => {
      if (hasTriggered.value) tweenTo(next);
    },
  );

  onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>

<template>
  <span ref="el" :class="cn('tabular-nums', props.class)">
    {{ displayValue }}
  </span>
</template>

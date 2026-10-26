<script setup lang="ts">
defineProps<{
  label: string;
  variant: "heading" | "description" | "activity" | "checks" | "reviews" | "changes" | "merge" | "files";
  ready: boolean;
  pending: boolean;
  error?: string | null;
}>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="pr-section" :aria-busy="pending || (!ready && !error)">
    <Transition name="pr-section">
      <div v-if="!ready && !error" class="pr-plan" :class="`pr-plan--${variant}`" role="status" :aria-label="`Loading ${label}`">
        <div aria-hidden="true" class="pr-plan__drawing">
          <template v-if="variant === 'heading'">
            <i class="pr-plan__line pr-plan__line--heading" />
            <div class="pr-plan__row"><i class="pr-plan__ring pr-plan__ring--author" /><i class="pr-plan__line" /></div>
          </template>
          <template v-else-if="variant === 'description'">
            <i v-for="line in 4" :key="line" class="pr-plan__line" :style="{ '--step': line }" />
          </template>
          <template v-else-if="variant === 'activity'">
            <div class="pr-plan__rail">
              <div v-for="row in 3" :key="row" class="pr-plan__row" :style="{ '--step': row }">
                <i class="pr-plan__ring" />
                <div class="pr-plan__text"><i class="pr-plan__line" /><i class="pr-plan__line pr-plan__line--soft" /></div>
              </div>
            </div>
          </template>
          <template v-else-if="variant === 'checks'">
            <div class="pr-plan__row"><i class="pr-plan__ring pr-plan__ring--checks" /><div class="pr-plan__text"><i class="pr-plan__line" /><i class="pr-plan__line pr-plan__line--soft" /></div></div>
          </template>
          <template v-else-if="variant === 'reviews'">
            <div class="pr-plan__faces"><i v-for="face in 3" :key="face" class="pr-plan__ring" /></div>
            <i class="pr-plan__line" />
          </template>
          <template v-else-if="variant === 'merge'">
            <i class="pr-plan__slot pr-plan__slot--verdict" />
            <i class="pr-plan__line" />
            <i class="pr-plan__slot pr-plan__slot--action" />
          </template>
          <template v-else>
            <div v-if="variant === 'changes'" class="pr-plan__faces"><i class="pr-plan__slot" /><i class="pr-plan__slot" /></div>
            <div v-for="file in 3" :key="file" class="pr-plan__row" :style="{ '--step': file }">
              <i v-if="variant === 'files'" class="pr-plan__file" />
              <i class="pr-plan__line" /><i class="pr-plan__size" />
            </div>
          </template>
        </div>
      </div>
    </Transition>
    <div v-if="ready" class="pr-section__content"><slot /></div>
    <p v-if="error" class="pr-section__error" role="status">
      Couldn't load {{ label.toLowerCase() }}.
      <button type="button" :disabled="pending" @click="emit('retry')">{{ pending ? "Retrying…" : "Retry" }}</button>
    </p>
  </div>
</template>

<style scoped>
.pr-section { display: grid; min-width: 0; }
.pr-section > * { grid-area: 1 / 1; min-width: 0; }
.pr-section__content { animation: pr-section-in var(--gs-t-enter, 320ms) ease backwards; }
.pr-section-leave-active { transition: opacity var(--gs-t-enter, 320ms) ease; pointer-events: none; }
.pr-section-leave-to { opacity: 0; }
.pr-section > .pr-section__error { grid-area: 2 / 1; display: flex; align-items: baseline; gap: 10px; color: var(--muted); font-size: 12px; padding-block: 12px; }
.pr-section__error button { color: var(--ink-soft); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.pr-section__error button:disabled { opacity: 0.5; cursor: default; }
.pr-plan {
  --plan-ink: color-mix(in srgb, var(--ink) 28%, transparent);
  --plan-soft: color-mix(in srgb, var(--ink) 14%, transparent);
  position: relative;
  padding-block: 6px;
  animation: pr-section-in 220ms ease var(--gs-hold, 140ms) backwards;
}
.pr-plan::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(circle, color-mix(in srgb, var(--ink) 8%, transparent) 1px, transparent 1.2px) 0 0 / 12px 12px; mask-image: radial-gradient(ellipse, #000 35%, transparent 78%); }
.pr-plan__drawing { position: relative; display: grid; gap: 20px; animation: pr-plan-breathe 1700ms ease-in-out 1200ms infinite; }
.pr-plan--heading .pr-plan__drawing { gap: 22px; padding-top: 20px; }
.pr-plan--description { padding-block: 10px 12px; }
.pr-plan--description .pr-plan__drawing { gap: 23px; }
.pr-plan__line { display: block; flex: 1; min-width: 0; height: 1px; background: repeating-linear-gradient(to right, var(--plan-ink) 0 2px, transparent 2px 4px); transform-origin: left; animation: pr-plan-draw 560ms ease calc(var(--gs-hold, 140ms) + var(--step, 0) * 60ms) backwards; }
.pr-plan__line--heading { height: 1px; margin-block: 6px; }
.pr-plan__line--soft { opacity: 0.5; }
.pr-plan__row { display: flex; align-items: center; gap: 14px; min-height: 20px; }
.pr-plan__text { display: grid; flex: 1; min-width: 0; gap: 18px; }
.pr-plan__ring { display: block; flex-shrink: 0; width: 28px; height: 28px; border: 1px dashed var(--plan-ink); border-radius: 50%; }
.pr-plan__ring--author { width: 18px; height: 18px; }
.pr-plan__ring--checks { width: 52px; height: 52px; }
.pr-plan__rail { display: grid; gap: 26px; position: relative; }
.pr-plan__rail::before { content: ""; position: absolute; top: 14px; bottom: 14px; left: 13px; border-left: 1px dashed var(--plan-soft); }
.pr-plan__rail .pr-plan__row { min-height: 42px; }
.pr-plan__faces { display: flex; gap: 8px; }
.pr-plan__slot { display: block; width: 52px; height: 16px; border: 1px dashed var(--plan-ink); border-radius: 3px; }
.pr-plan__slot--verdict { width: 128px; height: 24px; }
.pr-plan__slot--action { width: 100%; height: 32px; }
.pr-plan__size { width: 64px; height: 5px; border: 1px dashed var(--plan-soft); }
.pr-plan__file { width: 12px; height: 15px; border: 1px dashed var(--plan-ink); border-radius: 2px; }
@keyframes pr-section-in { from { opacity: 0; } }
@keyframes pr-plan-draw { from { transform: scaleX(0); } }
@keyframes pr-plan-breathe { 50% { opacity: 0.6; } }
@media (prefers-reduced-motion: reduce) {
  .pr-plan { animation: pr-section-in 1ms linear var(--gs-hold, 140ms) backwards; }
  .pr-section__content, .pr-plan__drawing, .pr-plan__line { animation: none; }
  .pr-section-leave-active { transition: none; }
}
</style>

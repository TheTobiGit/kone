<script setup lang="ts">
import { inject, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Image02Icon } from "@hugeicons/core-free-icons";
import { classifyImageSource, IMAGE_CWD_KEY, IMAGE_THREAD_KEY, type ImageSource } from "~/utils/markdownImageSource";

// An image (or illustration) in an agent reply. It settles into a rounded,
// width-capped frame with a soft tonal placeholder while it loads and an inline
// caption drawn from the alt text. A broken source degrades to a labelled tile
// rather than the browser's default torn-image glyph.
//
// While it loads the image stays laid out, only invisible, over the
// placeholder. A lazy image with no box is never fetched, so hiding it with
// display:none would hold the placeholder forever: no load, and no error either.
//
// A file on disk can't be loaded by path. The desktop shell is asked for a URL
// that serves it, and the placeholder holds while it answers. That URL expires,
// so an image that fails after one was granted asks once more before giving up:
// a reply scrolled back to later has outlived its first one.

const props = defineProps<{ src: string; alt?: string }>();

const cwd = inject(IMAGE_CWD_KEY, () => null);
const threadId = inject(IMAGE_THREAD_KEY, () => null);

const state = ref<"loading" | "ok" | "error">("loading");
const shown = ref<string | null>(null);

let source: ImageSource = { kind: "blocked" };
let regranted = false;
let seq = 0;

async function grant(path: string): Promise<void> {
  const mine = ++seq;
  const api = import.meta.client ? window.koneDesktop?.localImage : undefined;
  const granted = api ? await api.grant({ path, threadId: threadId() }).catch(() => null) : null;
  if (mine !== seq) return;
  if (granted === null) {
    state.value = "error";
    return;
  }
  shown.value = granted.url;
}

watch(
  [() => props.src, cwd],
  ([src, dir]) => {
    seq++;
    regranted = false;
    state.value = "loading";
    shown.value = null;
    source = classifyImageSource(src, dir);
    if (source.kind === "direct") shown.value = source.src;
    else if (source.kind === "local") void grant(source.path);
    else state.value = "error";
  },
  { immediate: true },
);

function onError(): void {
  if (source.kind === "local" && !regranted) {
    regranted = true;
    shown.value = null;
    state.value = "loading";
    void grant(source.path);
    return;
  }
  state.value = "error";
}
</script>

<template>
  <figure class="mdimg">
    <div class="mdimg__frame" :class="`mdimg__frame--${state}`">
      <img
        v-if="shown"
        v-show="state !== 'error'"
        class="mdimg__img"
        :class="{ 'mdimg__img--pending': state === 'loading' }"
        :src="shown"
        :alt="alt ?? ''"
        loading="lazy"
        decoding="async"
        @load="state = 'ok'"
        @error="onError"
      />
      <span v-if="state === 'loading'" class="mdimg__shimmer" aria-hidden="true" />
      <span v-else-if="state === 'error'" class="mdimg__broken">
        <HugeiconsIcon :icon="Image02Icon" :size="20" :stroke-width="1.6" />
        <span class="mdimg__broken-label">{{ alt || "Image unavailable" }}</span>
      </span>
    </div>
    <figcaption v-if="alt && state !== 'error'" class="mdimg__cap">{{ alt }}</figcaption>
  </figure>
</template>

<style scoped>
.mdimg {
  margin: 4px 0 8px;
}
.mdimg__frame {
  position: relative;
  max-width: 100%;
  border-radius: 12px;
  overflow: hidden;
  background: var(--hover);
}
.mdimg__frame--loading {
  min-height: 120px;
}
.mdimg__img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 12px;
}
.mdimg__img--pending {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
}
.mdimg__shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 20%,
    color-mix(in oklab, var(--ink) 7%, transparent) 45%,
    transparent 70%
  );
  background-size: 220% 100%;
  animation: mdimg-shimmer 1.4s ease-in-out infinite;
}
@keyframes mdimg-shimmer {
  to { background-position: -180% 0; }
}
.mdimg__broken {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 18px 16px;
  color: var(--muted);
}
.mdimg__broken-label {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mdimg__cap {
  margin-top: 7px;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--muted);
  text-align: center;
}
@media (prefers-reduced-motion: reduce) {
  .mdimg__shimmer { animation: none; }
}
</style>

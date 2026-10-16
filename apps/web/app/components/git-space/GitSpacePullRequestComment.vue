<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

// A comment at the foot of the conversation, where the next one would appear.
// The field grows with what's written in it; ⌘+Enter (Ctrl+Enter off a Mac) sends, as
// it does in the composer. What was written stays put until GitHub has it, so
// a failed send loses nothing.

const props = defineProps<{
  /** Something else in the space is running. */
  busy: boolean;
  /** Resolves true once GitHub has the comment. */
  send: (body: string) => Promise<boolean>;
  /** Why the last send failed, in GitHub's words. */
  error: string | null;
}>();

const sendKeys = `${useShortcuts().isMacPlatform() ? "⌘" : "Ctrl"}+Enter`;

const body = ref("");
const sending = ref(false);
const field = ref<HTMLTextAreaElement | null>(null);
const ready = computed(() => body.value.trim().length > 0 && !props.busy && !sending.value);

function grow() {
  const el = field.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

async function submit() {
  if (!ready.value) return;
  sending.value = true;
  const ok = await props.send(body.value);
  sending.value = false;
  if (!ok) return;
  body.value = "";
  await nextTick();
  grow();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void submit();
  }
}
</script>

<template>
  <form class="gpc" @submit.prevent="submit">
    <textarea
      ref="field"
      v-model="body"
      class="gpc__field selectable"
      rows="2"
      placeholder="Leave a comment"
      aria-label="Comment on this pull request"
      :disabled="sending"
      @input="grow"
      @keydown="onKey"
    />
    <div class="gpc__foot">
      <p v-if="error" class="gpc__error" role="alert">{{ error }}</p>
      <span v-else class="gpc__hint">Markdown works. {{ sendKeys }} to send.</span>
      <button type="submit" class="gpc__send" :disabled="!ready">
        {{ sending ? "Sending…" : "Comment" }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.gpc {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 74ch;
  margin-top: 28px;
  padding: 12px 14px 10px;
  border-radius: 12px;
  background-color: var(--hover);
  transition: box-shadow var(--gs-t-micro) var(--gs-ease);
}
.gpc:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gpc__field {
  width: 100%;
  min-height: 44px;
  max-height: 320px;
  resize: none;
  background: none;
  border: none;
  outline: none;
  font-family: var(--font-sans);
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--ink);
}
.gpc__field::placeholder {
  color: var(--ink-soft);
  opacity: 0.75;
}
.gpc__foot {
  display: flex;
  align-items: center;
  gap: 12px;
}
.gpc__hint,
.gpc__error {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 11.5px;
  color: var(--ink-soft);
}
.gpc__error {
  color: var(--danger);
}
.gpc__send {
  height: 26px;
  padding-inline: 12px;
  border-radius: 8px;
  background-color: var(--ink);
  color: var(--ground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gpc__send:hover:not(:disabled) {
  opacity: 0.88;
}
.gpc__send:disabled {
  opacity: 0.35;
  cursor: default;
}
.gpc__send:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--ground), 0 0 0 4px color-mix(in srgb, var(--ink) 55%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .gpc,
  .gpc__send {
    transition: none;
  }
}
</style>

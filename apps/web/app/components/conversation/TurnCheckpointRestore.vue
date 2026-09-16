<script setup lang="ts">
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowTurnBackwardIcon,
  Cancel01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  CHECKPOINT_CONFIRM_LIST_CAP,
  checkpointFailureMessage,
} from "~/composables/useTurnCheckpoints";
import { peelIpcError } from "~/utils/ipcError";

// One turn's "restore the files from before this turn" control. It lives in
// the assistant turn's footer, next to Copy / Scratchpad, and only mounts
// where the session seeded a checkpoint for the turn — the button never
// guesses.
//
// The flow is preview → confirm → forced restore, always in that order: the
// backend refuses an unforced restore on a dirty tree, so the confirm step
// shows the exact file lists the preview returned and the restore re-issues
// with `force` only after the user has seen them. A `dirty` answer to the
// forced restore (the tree moved between preview and confirm) re-shows the
// fresh lists instead of proceeding.

const props = defineProps<{
  threadId: string;
  turnId: string;
  /** A turn is in flight — restore is refused server-side while busy, so the
   *  control disables itself rather than offering a doomed call. */
  disabled?: boolean;
}>();

type Phase = "idle" | "previewing" | "confirm" | "restoring" | "done" | "error";

const { cue } = useSound();

const phase = ref<Phase>("idle");
const wouldWrite = ref<string[]>([]);
const wouldDelete = ref<string[]>([]);
const error = ref<string | null>(null);

const bridge = () => (import.meta.client ? window.koneDesktop?.agent : undefined);

const changeCount = computed(() => wouldWrite.value.length + wouldDelete.value.length);
const shownWrite = computed(() => wouldWrite.value.slice(0, CHECKPOINT_CONFIRM_LIST_CAP));
const hiddenWrite = computed(() => wouldWrite.value.length - shownWrite.value.length);
const shownDelete = computed(() => wouldDelete.value.slice(0, CHECKPOINT_CONFIRM_LIST_CAP));
const hiddenDelete = computed(() => wouldDelete.value.length - shownDelete.value.length);
const nothingToDo = computed(() => changeCount.value === 0);

function fail(message: string): void {
  error.value = message;
  phase.value = "error";
}

async function startPreview(): Promise<void> {
  if (props.disabled || phase.value === "previewing" || phase.value === "restoring") return;
  phase.value = "previewing";
  error.value = null;
  cue("press");
  try {
    const result = await bridge()?.previewTurnCheckpoint?.(props.threadId, props.turnId);
    if (!result) {
      fail("Checkpoints aren't available here.");
      return;
    }
    if (!result.ok) {
      fail(checkpointFailureMessage(result));
      return;
    }
    wouldWrite.value = [...result.wouldWrite];
    wouldDelete.value = [...result.wouldDelete];
    phase.value = "confirm";
  } catch (e) {
    fail(peelIpcError(e, "Could not preview the checkpoint"));
  }
}

async function confirmRestore(): Promise<void> {
  if (phase.value !== "confirm") return;
  phase.value = "restoring";
  error.value = null;
  cue("press");
  try {
    const result = await bridge()?.revertTurnCheckpoint?.(props.threadId, props.turnId, true);
    if (!result) {
      fail("Checkpoints aren't available here.");
      return;
    }
    if (result.ok) {
      phase.value = "done";
      cue("success");
      return;
    }
    if (result.reason === "dirty") {
      // The tree moved between preview and confirm — re-show the fresh lists
      // and let the user decide again, never restore blind.
      wouldWrite.value = [...result.wouldWrite];
      wouldDelete.value = [...result.wouldDelete];
      phase.value = "confirm";
      return;
    }
    fail(checkpointFailureMessage(result));
  } catch (e) {
    fail(peelIpcError(e, "Could not restore the checkpoint"));
  }
}

function cancel(): void {
  phase.value = "idle";
  error.value = null;
  cue("collapse");
}
</script>

<template>
  <span class="ckpt">
    <button
      v-if="phase === 'idle'"
      type="button"
      class="ckpt__btn"
      :disabled="disabled"
      title="Restore the working tree to how it was before this turn"
      @click="startPreview()"
    >
      <HugeiconsIcon :icon="ArrowTurnBackwardIcon" :size="13" :stroke-width="2" />
      <span>Restore files</span>
    </button>

    <button
      v-else-if="phase === 'previewing' || phase === 'restoring'"
      type="button"
      class="ckpt__btn"
      disabled
    >
      <HugeiconsIcon :icon="ArrowTurnBackwardIcon" :size="13" :stroke-width="2" />
      <span>{{ phase === "previewing" ? "Checking…" : "Restoring…" }}</span>
    </button>

    <span v-else-if="phase === 'done'" class="ckpt__done">
      <HugeiconsIcon :icon="Tick02Icon" :size="13" :stroke-width="2" />
      <span>Files restored</span>
      <button type="button" class="ckpt__btn" @click="cancel()">
        <span>Dismiss</span>
      </button>
    </span>

    <span v-else-if="phase === 'error'" class="ckpt__error">
      <span class="ckpt__msg">{{ error }}</span>
      <button type="button" class="ckpt__btn" @click="startPreview()">
        <span>Retry</span>
      </button>
      <button type="button" class="ckpt__btn" @click="cancel()">
        <span>Dismiss</span>
      </button>
    </span>

    <span v-else class="ckpt__confirm" role="dialog" aria-label="Confirm file restore">
      <template v-if="nothingToDo">
        <span class="ckpt__msg">The files already match this checkpoint — nothing to restore.</span>
        <button type="button" class="ckpt__btn" @click="cancel()">
          <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" />
          <span>Close</span>
        </button>
      </template>
      <template v-else>
        <span class="ckpt__msg">
          Restore the files from before this turn? The conversation stays — only files change.
        </span>
        <ul v-if="shownWrite.length" class="ckpt__files">
          <li class="ckpt__files-head">Will be overwritten</li>
          <li v-for="f in shownWrite" :key="`w:${f}`" class="ckpt__file">{{ f }}</li>
          <li v-if="hiddenWrite > 0" class="ckpt__file ckpt__file--more">
            +{{ hiddenWrite }} more
          </li>
        </ul>
        <ul v-if="shownDelete.length" class="ckpt__files">
          <li class="ckpt__files-head">Will be removed</li>
          <li v-for="f in shownDelete" :key="`d:${f}`" class="ckpt__file">{{ f }}</li>
          <li v-if="hiddenDelete > 0" class="ckpt__file ckpt__file--more">
            +{{ hiddenDelete }} more
          </li>
        </ul>
        <span class="ckpt__actions">
          <button
            type="button"
            class="ckpt__btn ckpt__btn--danger"
            @click="confirmRestore()"
          >
            <HugeiconsIcon :icon="ArrowTurnBackwardIcon" :size="13" :stroke-width="2" />
            <span>Restore {{ changeCount }} {{ changeCount === 1 ? "file" : "files" }}</span>
          </button>
          <button type="button" class="ckpt__btn" @click="cancel()">
            <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" />
            <span>Keep my files</span>
          </button>
        </span>
      </template>
    </span>
  </span>
</template>

<style scoped>
/* The control inherits the turn footer's mono type and muted chrome — the
   button below is the footer's own `.foot__copy` restated locally, because
   scoped styles never cross the component boundary. The confirm step reads
   like the turn-fail note: same tokens, its own (red-earned) severity only on
   the destructive confirm. */
.ckpt {
  display: inline-flex;
  align-items: center;
}
.ckpt__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.ckpt__btn:hover:not(:disabled) {
  background: var(--hover);
  color: var(--ink);
}
.ckpt__btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.ckpt__btn--danger:hover {
  background: color-mix(in srgb, var(--diff-del) 10%, transparent);
  color: var(--diff-del);
}
.ckpt__confirm,
.ckpt__error,
.ckpt__done {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  max-width: 100%;
}
.ckpt__msg {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
}
.ckpt__done {
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.ckpt__error .ckpt__msg {
  color: var(--diff-del);
}
.ckpt__files {
  list-style: none;
  margin: 2px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
}
.ckpt__files-head {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.ckpt__file {
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.ckpt__file--more {
  color: var(--muted);
}
.ckpt__actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>

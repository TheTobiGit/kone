<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { useElementSize } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { PencilEdit02Icon, ArrowUpRight01Icon, SquareIcon, Undo02Icon, Redo02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { annotatedImageFile, annotationPath, imagePoint, type AnnotationTool, type ImageAnnotation } from "~/utils/imageAnnotations";
import { MAX_IMAGE_BYTES } from "~/composables/useComposerAttachments";

const props = defineProps<{ src: string; name: string }>();
const emit = defineEmits<{ close: []; save: [file: File] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const { height: stageHeight } = useElementSize(stage);
const ready = ref(false);
const dimensions = ref({ width: 0, height: 0 });
const error = ref("");
const saving = ref(false);
const tool = ref<AnnotationTool | null>(null);
const color = ref("#ef4444");
const weight = ref(3);
const marks = ref<ImageAnnotation[]>([]);
const undone = ref<ImageAnnotation[]>([]);
const active = ref<ImageAnnotation | null>(null);
let pointerId: number | null = null;
let mounted = true;
let previousFocus: Element | null = null;
const tools = [
  { id: "pen", label: "Pen", icon: PencilEdit02Icon },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight01Icon },
  { id: "rectangle", label: "Rectangle", icon: SquareIcon },
] satisfies { id: AnnotationTool; label: string; icon: typeof PencilEdit02Icon }[];
const colors = [
  { value: "#ef4444", label: "Red" }, { value: "#f59e0b", label: "Amber" },
  { value: "#22c55e", label: "Green" }, { value: "#3b82f6", label: "Blue" },
  { value: "#ffffff", label: "White" }, { value: "#171717", label: "Black" },
];
const visibleMarks = computed(() => active.value ? [...marks.value, active.value] : marks.value);
const strokeWidth = computed(() => weight.value * Math.max(dimensions.value.width, dimensions.value.height) / 1000);

function loaded(): void {
  if (!image.value) return;
  dimensions.value = { width: image.value.naturalWidth, height: image.value.naturalHeight };
  ready.value = true;
  error.value = "";
}
function undo(): void {
  const mark = marks.value.pop();
  if (mark) undone.value.push(mark);
}
function redo(): void {
  const mark = undone.value.pop();
  if (mark) marks.value.push(mark);
}
function point(event: PointerEvent) {
  return imagePoint(event.clientX, event.clientY, image.value!.getBoundingClientRect(), dimensions.value);
}
function start(event: PointerEvent): void {
  if (!ready.value || !tool.value || saving.value || pointerId !== null || event.button !== 0) return;
  if (!(event.currentTarget instanceof SVGSVGElement)) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  pointerId = event.pointerId;
  active.value = { tool: tool.value, color: color.value, width: strokeWidth.value, points: [point(event)] };
}
function move(event: PointerEvent): void {
  if (pointerId !== event.pointerId || !active.value) return;
  const next = point(event);
  if (active.value.tool === "pen") active.value.points.push(next);
  else active.value.points = [active.value.points[0]!, next];
}
function finish(event: PointerEvent): void {
  if (pointerId !== event.pointerId || !active.value) return;
  move(event);
  marks.value.push(active.value);
  active.value = null;
  pointerId = null;
  undone.value = [];
}
function cancelStroke(): void {
  active.value = null;
  pointerId = null;
}
function close(): void {
  if (!saving.value) emit("close");
}
async function save(): Promise<void> {
  if (!image.value || !marks.value.length || saving.value || active.value) return;
  saving.value = true;
  error.value = "";
  try {
    const file = await annotatedImageFile(image.value, marks.value, props.name);
    if (!mounted) return;
    if (file.size > MAX_IMAGE_BYTES) throw new Error("The annotated image exceeds 10 MB. Try a smaller image.");
    emit("save", file);
  } catch (cause) {
    if (mounted) error.value = cause instanceof Error ? cause.message : "Could not save this image. Please try again.";
  } finally {
    saving.value = false;
  }
}
function onKey(event: KeyboardEvent): void {
  // Keep editor shortcuts and Escape from reaching the composer or thread.
  event.stopImmediatePropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (saving.value || active.value) return;
    if (event.shiftKey) redo();
    else undo();
  }
}
onMounted(() => {
  previousFocus = document.activeElement;
  dialog.value?.showModal();
  window.addEventListener("keydown", onKey, { capture: true });
});
onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener("keydown", onKey, { capture: true });
  dialog.value?.close();
  if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
});
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="image-editor" :aria-label="`Preview ${name}`" @cancel.prevent="close" @click.stop @pointerdown.stop>
      <header class="image-editor__header">
        <div class="image-editor__heading">
          <span class="image-editor__eyebrow">Image preview</span>
          <h2>{{ name }}</h2>
        </div>
        <button type="button" class="editor-icon" aria-label="Close preview" title="Close preview (Esc)" :disabled="saving" @click="close">
          <HugeiconsIcon :icon="Cancel01Icon" :size="18" />
        </button>
      </header>
      <div class="image-editor__toolbar" aria-label="Annotation tools">
        <div class="editor-group">
          <button v-for="item in tools" :key="item.id" type="button" class="editor-tool" :aria-pressed="tool === item.id" :disabled="!ready || saving" @click="tool = tool === item.id ? null : item.id">
            <HugeiconsIcon :icon="item.icon" :size="16" /><span>{{ item.label }}</span>
          </button>
        </div>
        <div class="editor-group editor-colors" aria-label="Drawing color">
          <button v-for="swatch in colors" :key="swatch.value" type="button" class="editor-swatch" :style="{ '--swatch': swatch.value }" :aria-label="swatch.label" :title="swatch.label" :aria-pressed="color === swatch.value" :disabled="saving" @click="color = swatch.value" />
        </div>
        <label class="editor-weight">Size <input v-model.number="weight" type="range" min="2" max="10" step="1" aria-label="Stroke size" :disabled="saving" /></label>
        <div class="editor-group editor-history">
          <button type="button" class="editor-icon" aria-label="Undo drawing" title="Undo (⌘Z / Ctrl+Z)" :disabled="!marks.length || saving || !!active" @click="undo"><HugeiconsIcon :icon="Undo02Icon" :size="17" /></button>
          <button type="button" class="editor-icon" aria-label="Redo drawing" title="Redo (⇧⌘Z / Ctrl+Shift+Z)" :disabled="!undone.length || saving || !!active" @click="redo"><HugeiconsIcon :icon="Redo02Icon" :size="17" /></button>
        </div>
      </div>
      <div ref="stage" class="image-editor__stage" :aria-busy="!ready && !error">
        <span v-if="!ready && !error" class="image-editor__loading">Loading image…</span>
        <div v-show="ready" class="image-editor__picture">
          <img ref="image" :src="src" :alt="name" :style="{ maxHeight: `${stageHeight}px` }" draggable="false" @load="loaded" @error="error = 'This image could not be previewed. You can still send the original file.'" />
          <svg v-if="ready" class="image-editor__drawing" :class="{ 'is-drawing': !!tool }" :viewBox="`0 0 ${dimensions.width} ${dimensions.height}`" aria-label="Image annotation canvas" @pointerdown="start" @pointermove="move" @pointerup="finish" @pointercancel="cancelStroke" @lostpointercapture="cancelStroke">
            <path v-for="(mark, index) in visibleMarks" :key="index" :d="annotationPath(mark)" :stroke="mark.color" :stroke-width="mark.width" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      </div>
      <p v-if="error" class="image-editor__error" role="alert">{{ error }}</p>
      <footer class="image-editor__footer">
        <span>{{ tool ? 'Drag on the image to draw.' : 'Choose a tool to annotate this image.' }}</span>
        <button type="button" class="editor-button" :disabled="saving" @click="close">{{ marks.length ? 'Cancel' : 'Done' }}</button>
        <button type="button" class="editor-button editor-button--primary" :disabled="!marks.length || saving || !!active" @click="save">{{ saving ? 'Saving…' : 'Save image' }}</button>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.image-editor { position: fixed; inset: 0; width: min(1080px, calc(100vw - 48px)); height: min(860px, calc(100dvh - 48px)); max-width: none; max-height: calc(100dvh - 48px); margin: auto; padding: 0; border: 1px solid var(--line); border-radius: 16px; background: var(--ground); color: var(--ink); font-family: var(--font-sans); box-shadow: 0 24px 80px #0004; }
.image-editor[open] { display: flex; flex-direction: column; }
.image-editor::backdrop { background: #0009; }
.image-editor__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; }
.image-editor__heading { min-width: 0; }
.image-editor__eyebrow { color: var(--faint); font-size: 11px; }
h2 { margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 550; }
.image-editor__toolbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 10px 16px; border-block: 1px solid var(--line); }
.editor-group { display: flex; align-items: center; gap: 4px; }
button { font: inherit; cursor: pointer; }
button:disabled { opacity: .35; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.editor-icon, .editor-tool { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 8px; border: 0; border-radius: 7px; color: var(--faint); background: transparent; font-size: 12px; }
.editor-tool[aria-pressed="true"] { color: var(--ink); background: var(--line); }
.editor-icon:hover:enabled, .editor-tool:hover:enabled { color: var(--ink); background: var(--line); }
.editor-colors { gap: 9px; }
.editor-swatch { width: 18px; height: 18px; border: 1px solid #8885; border-radius: 50%; background: var(--swatch); }
.editor-swatch[aria-pressed="true"] { outline: 2px solid var(--ink); outline-offset: 3px; }
.editor-weight { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--faint); }
.editor-weight input { width: 72px; accent-color: var(--ink); }
.editor-history { margin-left: auto; }
.image-editor__stage { flex: 1; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; padding: 24px; background: color-mix(in srgb, var(--ink) 5%, var(--ground)); }
.image-editor__picture { position: relative; display: flex; min-width: 0; }
.image-editor__picture img { display: block; max-width: 100%; object-fit: contain; user-select: none; }
.image-editor__drawing { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.image-editor__drawing.is-drawing { pointer-events: auto; cursor: crosshair; touch-action: none; }
.image-editor__loading { font-size: 13px; color: var(--faint); }
.image-editor__error { margin: 12px 20px 0; color: var(--ink); font-size: 13px; }
.image-editor__footer { display: flex; align-items: center; gap: 8px; padding: 14px 20px; }
.image-editor__footer > span { margin-right: auto; font-size: 12px; color: var(--faint); }
.editor-button { flex-shrink: 0; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; background: transparent; color: var(--ink); font-size: 12px; }
.editor-button--primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
button:active:enabled { transform: scale(.97); }
@media (max-width: 640px) {
  .image-editor { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); }
  .image-editor__toolbar { gap: 12px; }
  .image-editor__footer { flex-wrap: wrap; }
  .image-editor__footer > span { width: 100%; }
  .image-editor__stage { padding: 12px; }
}
</style>

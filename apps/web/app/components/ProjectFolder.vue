<script setup lang="ts">
import { computed } from "vue";
import { motion } from "motion-v";
import { CountUp } from "~/components/ui/count-up";

type FileLang = "ts" | "js" | "vue";
type FileChange = "new" | "edit" | "deleted";

export interface FolderFile {
  lang: FileLang;
  change: FileChange;
  /** Lines added/removed for this file — drives the paper's diff-shape marks. */
  added?: number;
  removed?: number;
  /** File path — seeds the deterministic mark jitter so no two read alike. */
  name?: string;
}

const props = withDefaults(
  defineProps<{
    name: string;
    repo?: boolean;
    branch?: string | null;
    added?: number;
    removed?: number;
    files?: FolderFile[];
    scale?: number;
    hovered?: boolean;
  }>(),
  {
    repo: true,
    branch: null,
    added: 0,
    removed: 0,
    files: () => [],
    scale: 1,
    hovered: false,
  },
);

// Rest positions + hover deltas for the peeking paper fan.
const SLOTS = [
  { left: 44, bottom: 54, rotate: -10, dx: -14, dy: -42, dr: -10 },
  { left: 78, bottom: 60, rotate: 1, dx: 0, dy: -48, dr: 0 },
  { left: 112, bottom: 54, rotate: 11, dx: 14, dy: -42, dr: 10 },
] as const;

// Sketch each paper's diff shape from its +/− magnitude — the same
// representative-hunk sketch the opened project's ChangeCard draws, scaled down
// to the mini paper. Widths jitter deterministically off the file path so no
// two papers read identically. This is what makes the peeking papers read as
// the real changed files, not decoration.
type Mark = { w: number; tone: "ctx" | "add" | "del" };
function marksFor(file: FolderFile): Mark[] {
  const seed = [...(file.name ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0);
  const jit = (base: number, i: number) =>
    Math.max(6, base + ((seed + i * 7) % 5) - 2);
  const added = file.added ?? 0;
  const removed = file.removed ?? 0;
  if (added > 0 && removed > 0)
    return [
      { w: jit(16, 0), tone: "ctx" },
      { w: jit(10, 1), tone: "del" },
      { w: jit(13, 2), tone: "add" },
    ];
  if (added > 0 || file.change === "new")
    return [
      { w: jit(15, 0), tone: "add" },
      { w: jit(10, 1), tone: "add" },
      { w: jit(8, 2), tone: "ctx" },
    ];
  if (removed > 0)
    return [
      { w: jit(15, 0), tone: "del" },
      { w: jit(9, 1), tone: "del" },
      { w: jit(7, 2), tone: "ctx" },
    ];
  // No line delta (rename, mode change) — a quiet two-line context sketch.
  return [
    { w: 15, tone: "ctx" },
    { w: 10, tone: "ctx" },
  ];
}

const papers = computed(() =>
  (props.repo ? props.files : []).slice(0, SLOTS.length).map((file, i) => ({
    ...file,
    ...SLOTS[i]!,
    marks: marksFor(file),
  })),
);

const showDiff = computed(
  () => props.repo && (props.added > 0 || props.removed > 0),
);
</script>

<template>
  <div class="folder" :style="{ '--s': scale }">
    <div class="folder__stage">
      
      <div class="folder__sheet" />

      
      <motion.div
        v-for="(paper, i) in papers"
        :key="i"
        class="folder__paper"
        :class="{ 'folder__paper--torn': paper.change === 'deleted' }"
        :style="{ left: `${paper.left}px`, bottom: `${paper.bottom}px` }"
        :initial="{ x: 0, y: 0, rotate: paper.rotate }"
        :animate="{
          x: hovered ? paper.dx : 0,
          y: hovered ? paper.dy : 0,
          rotate: hovered ? paper.rotate + paper.dr : paper.rotate,
        }"
        :transition="{
          type: 'spring',
          stiffness: 340,
          damping: 15,
          mass: 0.7,
          delay: hovered ? i * 0.04 : 0,
        }"
      >
        
        <span v-if="paper.lang === 'vue'" class="folder__lang-vue">
          <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
            <path d="M3 3 L7 3 L12 11 L17 3 L21 3 L12 20 Z" fill="#41B883" />
            <path d="M7 3 L9.5 3 L12 7.2 L14.5 3 L17 3 L12 11 Z" fill="#35495E" />
          </svg>
        </span>
        <span
          v-else
          class="folder__badge"
          :class="`folder__badge--${paper.lang}`"
        >
          {{ paper.lang === "ts" ? "TS" : "JS" }}
        </span>

        
        <span v-if="paper.change !== 'deleted'" class="folder__marks">
          <i
            v-for="(m, mi) in paper.marks"
            :key="mi"
            class="folder__mark"
            :class="`folder__mark--${m.tone}`"
            :style="{ width: `${m.w}px` }"
          />
        </span>
      </motion.div>

      
      <div class="folder__pocket">
        <div class="folder__row folder__row--name">
          <svg
            v-if="repo"
            class="folder__gh"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
            />
          </svg>
          <span class="folder__name" :title="name">{{ name }}</span>
        </div>

        <div v-if="repo && branch" class="folder__row folder__row--meta">
          <span class="folder__branch">
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" fill="none" />
              <circle cx="6" cy="18" r="3" fill="none" />
              <path d="M18 9a9 9 0 0 1-9 9" fill="none" />
            </svg>
            <span class="folder__branch-name">{{ branch }}</span>
          </span>
          <span v-if="showDiff" class="folder__diff">
            <span v-if="added > 0" class="folder__add"
              >+<CountUp :to="added" :duration="1.1"
            /></span>
            <span v-if="removed > 0" class="folder__del"
              >−<CountUp :to="removed" :duration="1.1"
            /></span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.folder {
  
  --paper-bg: #ffffff;
  --mark-edit-1: #d8d7d3;
  --mark-edit-2: #e4e3df;
  --mark-new-1: var(--diff-add);
  --mark-new-2: #8fd9bd;
  --mark-name: #27272a;
  --mark-gh: #3f3f46;
  --branch: #a1a1aa;
  --add: var(--diff-add);
  --del: var(--diff-del);

  --sheet: linear-gradient(
    160deg in oklab,
    oklab(96.4% -0.0001 0.004) 0%,
    oklab(91.9% 0.0005 0.006) 100%
  );
  --sheet-inset: #ffffffb3;
  --pocket: linear-gradient(
    168deg in oklab,
    oklab(98.8% 0.0003 0.003) 0%,
    oklab(94.7% 0.0009 0.004) 55%,
    oklab(92.2% 0.0002 0.007) 100%
  );
  --pocket-shadow: #ffffffe6 0 2px 0 inset, #00000008 0 -10px 18px inset,
    #1e1b180f 0 4px 10px;
  --paper-shadow: #1e1b1812 0 4px 10px;

  position: relative;
  display: inline-block;
  width: calc(200px * var(--s));
  height: calc(116px * var(--s));
}

.folder__stage {
  position: absolute;
  top: 0;
  left: 0;
  width: 200px;
  height: 116px;
  transform: scale(var(--s));
  transform-origin: top left;
  font-size: 12px;
  line-height: 16px;
}

.folder__sheet {
  position: absolute;
  left: 16px;
  bottom: 66px;
  width: 168px;
  height: 44px;
  border-radius: 16px 16px 14px 14px;
  background-image: var(--sheet);
  box-shadow: var(--sheet-inset) 0 1px 0 inset;
}

.folder__paper {
  position: absolute;
  width: 50px;
  height: 62px;
  padding: 7px 8px;
  border-radius: 6px;
  background-color: var(--paper-bg);
  box-shadow: var(--paper-shadow);
  transform-origin: 0% 0%;
}
.folder__paper--torn {
  background-color: color-mix(in srgb, var(--paper-bg) 35%, transparent);
  border: 1.5px dashed var(--del);
  opacity: 0.9;
}

.folder__badge,
.folder__lang-vue {
  position: absolute;
  top: 8px;
  left: 8px;
}
.folder__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
  border-radius: 2.5px;
  font-family: var(--font-sans);
  font-size: 5px;
  font-weight: 700;
  /* Tiny all-caps mark — a touch of tracking keeps TS/JS from crowding. */
  letter-spacing: 0.02em;
  line-height: 1;
}
.folder__badge--ts {
  background-color: #3178c6;
  color: #ffffff;
}
.folder__badge--js {
  background-color: #f7df1e;
  color: #1a1a1a;
}
.folder__lang-vue {
  display: inline-flex;
}

.folder__marks {
  position: absolute;
  top: 20px;
  left: 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.folder__mark {
  height: 3px;
  border-radius: 2px;
}
.folder__mark--ctx {
  background-color: var(--mark-edit-1);
}
.folder__mark--add {
  background-color: var(--mark-new-1);
}
.folder__mark--del {
  background-color: var(--del);
}

.folder__pocket {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 200px;
  height: 92px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 7px;
  padding: 0 18px 15px;
  border-radius: 22px;
  background-image: var(--pocket);
  box-shadow: var(--pocket-shadow);
}
.folder__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.folder__row--name {
  align-items: flex-end;
  gap: 9px;
  justify-content: flex-start;
  /* Let a long name shrink and clip rather than overflow the pocket. */
  min-width: 0;
}
.folder__gh {
  flex-shrink: 0;
  fill: var(--mark-gh);
}
.folder__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-sans);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.024em;
  line-height: 1;
  color: var(--mark-name);
}

.folder__branch {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.folder__branch svg {
  flex-shrink: 0;
  stroke: var(--branch);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.folder__branch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.2px;
  line-height: 1;
  color: var(--branch);
}
.folder__diff {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.folder__add {
  color: var(--add);
}
.folder__del {
  color: var(--del);
}

@media (prefers-color-scheme: dark) {
  .folder {
    --paper-bg: #2c2c31;
    --mark-edit-1: rgb(255 255 255 / 0.32);
    --mark-edit-2: rgb(255 255 255 / 0.18);
    --mark-new-1: #12b981;
    --mark-new-2: #0f6b4d;
    --mark-name: #f4f4f5;
    --mark-gh: #e4e4e7;
    --add: #10b981;

    --sheet: linear-gradient(
      160deg in oklab,
      oklab(20.2% 0.002 -0.006) 0%,
      oklab(17.4% 0.001 -0.004) 100%
    );
    --sheet-inset: #ffffff0d;
    --pocket: linear-gradient(
      168deg in oklab,
      oklab(22.8% 0.002 -0.007) 0%,
      oklab(19.2% 0.001 -0.004) 55%,
      oklab(16.9% 0.001 -0.004) 100%
    );
    --pocket-shadow: #ffffff12 0 1px 0 inset, #00000038 0 -10px 18px inset,
      #0000004d 0 4px 10px;
    --paper-shadow: #00000073 0 4px 10px;
  }
}
</style>

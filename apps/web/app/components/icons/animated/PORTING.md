# Porting an animated icon (React/Motion → Vue/motion-v)

Each icon here is a Hugeicon with a hand-tuned hover animation. The animation
source lives as a React component at
`~/Developer/opensource/hugeicons-animated/icons/<kebab>.tsx`. We reproduce the
**same gesture** in Vue using `motion-v`, keeping our own Hugeicons geometry.

The two files to copy the exact shape from — study them before porting:

- `Refresh.vue` — animation lives on the **root `<svg>`** (a transform variant).
- `Star.vue` — animation lives on a **single `<motion.path>`** (a `d` morph).
- `useIconAnimation.ts` — the shared engine. Import it; never reimplement it.

## Recipe (follow exactly)

1. Read `~/Developer/opensource/hugeicons-animated/icons/<kebab>.tsx`. Note: the
   variants object(s), which element each is attached to (root `<svg>` vs a
   specific `<path>`/`<g>`), the exact `d` strings, stroke attributes, `viewBox`,
   `overflow`, and any inline `style` / `transformOrigin` / `transformBox`.

2. Write `<Pascal>.vue` as:

   ```vue
   <script setup lang="ts">
   import { motion, useAnimationControls } from "motion-v";
   import { useIconAnimation } from "./useIconAnimation";

   withDefaults(defineProps<{ size?: number }>(), { size: 24 });

   const controls = useAnimationControls();
   const { startAnimation, stopAnimation } = useIconAnimation(controls);
   defineExpose({ startAnimation, stopAnimation });

   // <keep the source's motion comment, minus any outside-source citation>
   const someVariants = { /* copied byte-for-byte from the source */ };
   </script>

   <template>
     <span
       class="animated-icon"
       @mouseenter="startAnimation"
       @mouseleave="stopAnimation"
     >
       <!-- svg body: motion.* where the source used motion.*, plain otherwise -->
     </span>
   </template>

   <style scoped>
   .animated-icon {
     display: inline-flex;
     line-height: 0;
   }
   </style>
   ```

   - If the source calls `useIconAnimation({ ..., loops: true })`, pass
     `useIconAnimation(controls, { loops: true })`. Otherwise omit the options.
   - Copy every variants object **verbatim** — same numbers, `times`, `ease`,
     transform strings, and `d` arrays. Keep them as plain `const x = {...}`; do
     **not** import a `Variants` type.
   - An element that was `motion.svg` / `motion.path` / `motion.g` in the source
     becomes `<motion.svg>` / `<motion.path>` / `<motion.g>`. Plain `svg` / `path`
     stay plain. Bind `:variants="x" :animate="controls" initial="normal"` on each
     animated element, matching the variants object the source attached to it.
   - Convert React attrs → Vue/HTML: `strokeWidth`→`stroke-width`,
     `strokeLinecap`→`stroke-linecap`, `strokeLinejoin`→`stroke-linejoin`. Keep
     `stroke="currentColor"`, `fill`, `viewBox`, and the source's `overflow`
     value exactly.
   - Convert React `style={{ transformOrigin: '10px 12px', transformBox: 'fill-box' }}`
     to `:style="{ transformOrigin: '10px 12px', transformBox: 'fill-box' }"`.
   - The `d` path data and every numeric animation value must be identical to the
     source, character for character.

3. Comments: keep any comment that explains the **motion** (e.g. "the ribbon
   catches at the binding and lands with a saved-state fold"). Strip anything that
   points at something outside this repo — never cite the React file,
   hugeicons-animated, motion.dev, "the original", or "the reference". The
   reasoning stays; the citation goes.

## Rules

- Create **only** your one `<Pascal>.vue` file. Do not edit, move, or delete any
  other file. Do not run git or installs.
- Match `<svg>` `viewBox="0 0 24 24"` and copy stroke widths as authored (usually
  `1.5`); do not "improve" them.

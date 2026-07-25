<script setup lang="ts">
import { computed, useId } from "vue";
import type { BrandKey } from "~/utils/modelCatalog";

// The running engine's own logomark — never the kone mark (that's reserved for
// four-point spark, Anthropic's radiating sunburst, OpenAI's interlocking knot.
// Self-contained inline SVG (no network, no external asset), theme-agnostic.
//
//   tone="brand" → the mark in its brand colour (model picker rows)
//   tone="mono"  → a flat white mark (set into the orb's dark forehead socket)

const props = withDefaults(
  defineProps<{ brand: BrandKey; size?: number; tone?: "brand" | "mono" }>(),
  { size: 16, tone: "brand" },
);

const uid = useId();
const gradId = `gem-${uid}`;
const mono = computed(() => props.tone === "mono");
// Claude's twelve radiating spokes.
const spokes = Array.from({ length: 12 }, (_, i) => i * 30);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    class="plogo"
  >
    <!-- ── Gemini — four-point spark ─────────────────────────────────────── -->
    <template v-if="brand === 'gemini'">
      <defs v-if="!mono">
        <linearGradient :id="gradId" x1="2" y1="3" x2="22" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#4285F4" />
          <stop offset="0.5" stop-color="#9B72CB" />
          <stop offset="1" stop-color="#D96570" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.5C12 7.3 7.3 12 1.5 12 7.3 12 12 16.7 12 22.5 12 16.7 16.7 12 22.5 12 16.7 12 12 7.3 12 1.5Z"
        :fill="mono ? '#ffffff' : `url(#${gradId})`"
      />
    </template>

    <!-- ── Anthropic / Claude — radiating sunburst ───────────────────────── -->
    <g v-else-if="brand === 'claude'" :stroke="mono ? '#ffffff' : '#D97757'" stroke-width="1.7" stroke-linecap="round">
      <line
        v-for="a in spokes"
        :key="a"
        x1="12"
        y1="12"
        x2="12"
        y2="3.4"
        :transform="`rotate(${a} 12 12)`"
      />
      <circle cx="12" cy="12" r="1.9" :fill="mono ? '#ffffff' : '#D97757'" stroke="none" />
    </g>

    <!-- ── OpenAI — the blossom logomark ─────────────────────────────────── -->
    <path
      v-else-if="brand === 'gpt'"
      :fill="mono ? '#ffffff' : 'currentColor'"
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856-5.833-3.388L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.062l4.83-2.786a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08L8.704 5.46a.795.795 0 0 0-.393.68zm1.098-2.366 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z"
    />

    <!-- ── Codex — the C logomark (ink, not muted — brand black/white) ─── -->
    <path
      v-else-if="brand === 'codex'"
      :fill="mono ? '#ffffff' : 'var(--ink)'"
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
    />

    <!-- ── Unknown provider — a calm dot ─────────────────────────────────── -->
    <circle v-else cx="12" cy="12" r="4.5" :fill="mono ? '#ffffff' : 'currentColor'" />
  </svg>
</template>

<style scoped>
.plogo {
  display: block;
  flex-shrink: 0;
}
</style>

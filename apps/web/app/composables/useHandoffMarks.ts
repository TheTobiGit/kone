import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ForkContext, HandoffLink, RuntimeEvent } from "~/types/desktop";
import { describeModelId } from "~/utils/modelCatalog";
import { type HandoffMark } from "~/utils/handoffMarkers";
import { SESSION_BRAND } from "~/types/session";
import { PROVIDER_LABEL } from "~/utils/usageProviders";

// The timeline's handoff marks: "Handed from" when this thread continues
// another, "Handed to" links when others continued from it — each stamped
// with the handoff's creation time so the timeline interleaves them with the
// exchanges they precede, and later turns keep arriving below them.

export function useHandoffMarks(opts: {
  threadId: () => string | null | undefined;
  forkContext: () => ForkContext | null | undefined;
  /** Surfaces without handoff navigation (inbox readers, the house
   *  assistant) opt out — no fetch, no marks, no subscription. */
  enabled: () => boolean;
}) {
  const links = ref<HandoffLink[]>([]);

  function bridge() {
    // Existence probe (not a narrowing check): the bridge only exists in the
    // desktop renderer, and bun tests stand one in on globalThis.window.
    return typeof window !== "undefined" ? window.koneDesktop?.agent : undefined;
  }

  async function load(): Promise<void> {
    if (!opts.enabled()) {
      links.value = [];
      return;
    }
    const id = opts.threadId();
    if (!id) {
      links.value = [];
      return;
    }
    try {
      links.value = (await bridge()?.history?.handoffsFromSource(id)) ?? [];
    } catch {
      links.value = [];
    }
  }

  const marks = computed<HandoffMark[]>(() => {
    if (!opts.enabled()) return [];
    const out: HandoffMark[] = [];
    const ctx = opts.forkContext();
    if (ctx?.forkKind === "handoff") {
      // The source model rides the context the same way its provider does —
      // the mark names it long after the source row may be gone, falling
      // back to the provider when the source never ran named.
      const provider = ctx.sourceProvider;
      out.push({
        key: "from",
        at: ctx.importedAt,
        kind: "from",
        threadId: ctx.sourceThreadId,
        label: ctx.sourceModel
          ? describeModelId(ctx.sourceModel).name
          : provider
            ? PROVIDER_LABEL[provider]
            : "another provider",
        brand: provider ? SESSION_BRAND[provider] : "generic",
      });
    }
    for (const link of links.value) {
      out.push({
        key: link.threadId,
        at: link.handedAt,
        kind: "to",
        threadId: link.threadId,
        label: link.model ? describeModelId(link.model).name : PROVIDER_LABEL[link.provider],
        brand: SESSION_BRAND[link.provider] ?? "generic",
      });
    }
    return out.sort((a, b) => a.at - b.at);
  });

  // Subscribed eagerly — setup runs at mount in real usage, and calling the
  // composable outside setup (tests) still wires the subscription. A handoff
  // minted while this thread is open lands its marker live: the row that
  // asked for it opens the child beside the source, and the source timeline
  // must not wait for a reload to admit it left.
  let stopListening: (() => void) | null = null;
  stopListening =
    bridge()?.onEvent((event: RuntimeEvent) => {
      if (event.type === "thread.handoff-created" && event.sourceThreadId === opts.threadId()) {
        void load();
      }
    }) ?? null;

  onBeforeUnmount(() => stopListening?.());

  // The session can be re-homed onto another thread (or the surface can opt
  // out) — re-read then, rather than showing the old thread's links.
  watch([() => opts.threadId(), () => opts.enabled()], () => void load());

  // The first read goes out with setup, not on mount — same moment in real
  // usage, and directly drivable under test via reload().
  void load();

  return { marks, reload: load };
}

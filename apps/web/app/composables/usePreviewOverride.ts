import { computed, ref, toValue, type MaybeRefOrGetter } from "vue";

// A staged preview override — the one probe mechanism shared by the
// Conversation settings' display tiles and its style tiles.
//
// Each dimension stages the same way: while a tile is pointed at or focused,
// `probe` holds what the tile names and `staged` plays it; otherwise `staged`
// is the set value. `active` is true only while a probe names something other
// than what's set, so the stage's accent tracks "showing a try-on, not the
// truth" without the pane re-deriving it per dimension. `clear` drops the
// probe (switching surfaces clears the display probe the same way).
export function usePreviewOverride<C, P = C>(
  current: MaybeRefOrGetter<C>,
  apply: (current: C, probe: P) => C,
  isChanged?: (current: C, probe: P) => boolean,
) {
  const probe = ref<P | null>(null);
  const staged = computed<C>(() => {
    const c = toValue(current);
    const p = probe.value;
    if (p === null) return c;
    return apply(c, p);
  });
  const active = computed<boolean>(() => {
    const p = probe.value;
    if (p === null) return false;
    const c = toValue(current);
    return isChanged ? isChanged(c, p) : true;
  });
  function clear(): void {
    probe.value = null;
  }
  return { probe, staged, active, clear };
}

export type ThreadEscapeLayer = "composer" | "rail" | "diff" | "picker";
const priorities = { composer: 1, rail: 2, diff: 3, picker: 4 } satisfies Record<ThreadEscapeLayer, number>;

type EscapeEvent = Pick<KeyboardEvent, "key" | "defaultPrevented" | "preventDefault" | "stopImmediatePropagation">;

/** A single owner consumes each press; a picker owned elsewhere blocks lower layers. */
export function createThreadEscapeStack() {
  const layers: { kind: ThreadEscapeLayer; active: () => boolean; dismiss: (() => void) | null }[] = [];

  function register(kind: ThreadEscapeLayer, active: () => boolean, dismiss: (() => void) | null) {
    const layer = { kind, active, dismiss };
    layers.push(layer);
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    };
  }

  function handle(event: EscapeEvent): boolean {
    if (event.key !== "Escape" || event.defaultPrevented) return false;
    const top = layers.toSorted((a, b) => priorities[b.kind] - priorities[a.kind]).find((layer) => layer.active());
    if (!top?.dismiss) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    top.dismiss();
    return true;
  }

  return { register, handle };
}

// The pane-kind registry — everything a pane kind declares *about itself*.
//
// This is what makes the three kinds peers: metadata that used to be scattered
// across `if (c.type === "terminal")` branches in ThreadStrip / ThreadInsertMenu
// now lives in one table. Adding a fourth kind later is a row here plus one
// render branch — not eight edits.
//
// Registry is for METADATA only. Rendering stays an explicit v-if chain in the
// strip: the three pane bodies take different props and emit different events,
// so `<component :is>` would lose type-checking for no real gain.

import { BubbleChatAddIcon, ComputerTerminal01Icon, Note01Icon } from "@hugeicons/core-free-icons";
import { SCRATCHPAD_TITLE } from "~/composables/useScratchpad";
import type { PaneKind } from "~/types/studio";

export interface PaneKindMeta {
  kind: PaneKind;
  /** Header + index-nav aria label for a pane of this kind. */
  label: string;
  /** Seam insert-menu row label. Today's exact copy. */
  insertLabel: string;
  icon: unknown; // Hugeicons IconSvgElement
  /** Only one per project may exist (scratchpad, today). */
  singleton: boolean;
  /** The shortcut id in useShortcuts ACTIONS that opens this kind. */
  shortcutId: string;
  /** Extra class on `.col__body` (e.g. "col__body--terminal"). */
  bodyClass?: string;
  /** Extra class on the index dash (e.g. "is-pad"). */
  dashClass?: string;
  /** May a pane of this kind hold the agent composer dock? */
  composer: boolean;
  /** Attach eagerly on board restore, or wait for focus? Text-only kinds are
   *  cheap enough to attach immediately; anything that spawns a process is not. */
  eagerAttach: boolean;
}

// Order here IS the seam insert menu's row order.
export const PANE_KINDS: readonly PaneKindMeta[] = [
  {
    kind: "thread",
    label: "New thread",
    insertLabel: "New thread",
    icon: BubbleChatAddIcon,
    singleton: false,
    shortcutId: "new-thread",
    composer: true,
    eagerAttach: false,
  },
  {
    kind: "terminal",
    label: "Terminal",
    insertLabel: "Terminal",
    icon: ComputerTerminal01Icon,
    singleton: false,
    shortcutId: "new-terminal",
    bodyClass: "col__body--terminal",
    composer: false,
    eagerAttach: false,
  },
  {
    kind: "scratchpad",
    label: SCRATCHPAD_TITLE,
    insertLabel: SCRATCHPAD_TITLE,
    icon: Note01Icon,
    singleton: true,
    shortcutId: "new-scratchpad",
    bodyClass: "col__body--scratchpad",
    dashClass: "is-pad",
    composer: false,
    eagerAttach: true,
  },
];

const BY_KIND = new Map<PaneKind, PaneKindMeta>(PANE_KINDS.map((m) => [m.kind, m]));

export function paneKindMeta(kind: PaneKind): PaneKindMeta {
  const meta = BY_KIND.get(kind);
  if (!meta) throw new Error(`Unknown pane kind: ${kind}`);
  return meta;
}

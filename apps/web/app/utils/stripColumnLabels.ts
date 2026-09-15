// The strip's column-chrome reads: the brand mark in a thread header, the
// header and map labels, the meter's per-session Compact props, and whether a
// pane kind is already aboard (which greys insert rows).
//
// A leaf module on purpose. The template calls these in six places — header,
// map label, meter, insert menu — and each call must answer the same way, so
// the rule lives once, here, pinned by tests rather than by clicking through
// every column kind. The component keeps only the two `computed`s that join
// these to its live props; everything answerable from a pane list is a pure
// function taking one.
import type { ProviderStatus } from "~/types/desktop";
import type { BrandKey } from "~/utils/modelCatalog";
import type { Pane, PaneKind } from "~/types/studio";
import { SESSION_BRAND } from "~/types/session";
import { compactPropsForSession, type MeterCompactProps } from "~/utils/compactAvailability";
import { PANE_KINDS, paneKindMeta } from "~/utils/paneKinds";

export function brandOf(c: Pane): BrandKey {
  if (c.kind !== "thread" || !c.session) return "generic";
  return SESSION_BRAND[c.session.provider.value] ?? "generic";
}

/** The meter's Compact control per live session, memoized by session key — one
 *  shared rule decides, the session runs the call. Built as a map (the inbox
 *  live pane's pattern, fanned out) so a re-render reuses the props object
 *  instead of minting a fresh one per column per frame. */
export function buildCompactBySession(
  panes: readonly Pane[],
  statuses: readonly ProviderStatus[],
): Map<string, MeterCompactProps> {
  const map = new Map<string, MeterCompactProps>();
  for (const pane of panes) {
    if (pane.kind !== "thread" || !pane.session) continue;
    if (!map.has(pane.session.key)) map.set(pane.session.key, compactPropsForSession(pane.session, statuses));
  }
  return map;
}

/** Spread onto ContextWindowMeter with v-bind. */
export function readCompactProps(
  map: ReadonlyMap<string, MeterCompactProps>,
  key: string,
): MeterCompactProps {
  return map.get(key) ?? {};
}

/** Is a pane of this kind already on the strip? Drives the seam menu's greying
 *  of singleton kinds (the scratchpad, today). */
export function hasPaneKind(panes: readonly Pane[], kind: PaneKind): boolean {
  return panes.some((c) => c.kind === kind);
}

/** The project's single scratchpad is on the strip — the seam menu greys its row. */
export function hasScratchpadPane(panes: readonly Pane[]): boolean {
  const singleton = PANE_KINDS.find((m) => m.singleton);
  return singleton ? hasPaneKind(panes, singleton.kind) : false;
}

export function columnLabel(c: Pane): string {
  if (c.kind === "thread") {
    const title = c.session?.title.value || "New thread";
    return c.session?.isSideChat.value ? `Side chat · ${title}` : title;
  }
  return paneKindMeta(c.kind).label;
}

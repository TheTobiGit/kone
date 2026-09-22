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

/** Whether this column continues a conversation handed off from another
 *  provider. The header then reads old → new instead of a single mark, so a
 *  handoff never passes for a thread born where it runs. */
export function isHandoff(c: Pane): boolean {
  if (c.kind !== "thread" || !c.session) return false;
  // Optional-chained: test doubles cast partial sessions, and only the live
  // session carries forkContext.
  return c.session.forkContext?.value?.forkKind === "handoff";
}

/** Every set of hands this thread has actually been worked by, oldest first.
 *  A hand-in is not a handoff: the thread did not go anywhere, it was picked
 *  up by somebody else — so the header lists the hands rather than drawing a
 *  transition arrow to another thread.
 *
 *  A swap only counts once a turn has landed under it, the same rule the
 *  timeline marker follows. Choosing a provider stages it; until something is
 *  actually sent, those hands have answered nothing and the header would be
 *  claiming work that never happened. Empty when the thread has never changed
 *  hands, which is the ordinary case and wants the plain single mark. */
export function threadHands(c: Pane): BrandKey[] {
  if (c.kind !== "thread" || !c.session) return [];
  // Optional-chained: test doubles cast partial sessions, and only a live
  // session carries its hand-in history.
  const records = c.session.handInRecords?.value ?? [];
  const first = records[0];
  if (!first) return [];
  const blocks = c.session.timelineBlocks?.value ?? [];
  const answered = (at: number): boolean => blocks.some((b) => b.at > at);
  const brands: BrandKey[] = [SESSION_BRAND[first.fromProvider] ?? "generic"];
  for (const record of records) {
    if (!answered(record.at)) continue;
    const brand = SESSION_BRAND[record.toProvider] ?? "generic";
    // A thread handed back to hands it already sits in adds nothing to read.
    if (brand !== brands[brands.length - 1]) brands.push(brand);
  }
  return brands;
}

/** The handed-off-from brand for a handoff column. "generic" when the context
 *  names no source (a row written before provenance existed) — the arrow
 *  still reads, just without a vendor mark. */
export function handoffSourceBrand(c: Pane): BrandKey {
  const source =
    c.kind === "thread" ? c.session?.forkContext?.value?.sourceProvider : undefined;
  return (source ? SESSION_BRAND[source] : undefined) ?? "generic";
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

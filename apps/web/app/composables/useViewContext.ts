// useViewContext — each surface says what it is showing.
//
// The assistant is summoned over the whole app and needs to know what is on
// screen. No one component knows that: the page, the three portals and the
// drawer each keep what they are showing in their own local state (the inbox's
// picked thread, a studio row's columns, the project page's open diff). So each
// one publishes a *facet* — a getter describing itself in the shared
// `ViewLayer` vocabulary — for as long as it is mounted, and the view plugin
// stacks the facets into one snapshot and mirrors it to the shell.
//
// Getters rather than values: a facet is read inside the plugin's computed, so
// it tracks exactly the state its getter touches, and a surface never has to
// decide when to republish. A getter returns null while its surface is away (a
// hidden portal, a closed palette), which is how the plugin knows it is not on
// screen.
//
// Module scope, like useStudioRowRegistry: the page and the plugin are far
// apart, and the portals outlive any one page.

import { getCurrentScope, onScopeDispose, shallowReactive } from "vue";
import type { ViewLayer, ViewPane } from "@kone/protocol/view-context";

/** The surfaces that publish, frontmost first — the order the snapshot stacks
 *  them in. The same precedence `resolveTop` keeps for Escape, plus the search
 *  palette and the page itself. */
export const VIEW_FACET_ORDER = [
  "modal",
  "search",
  "menu",
  "settings",
  "bench",
  "inbox",
  "studio",
  "project",
  "home",
] as const satisfies readonly ViewLayer["surface"][];

export type ViewFacetId = (typeof VIEW_FACET_ORDER)[number];

/** Surfaces that fill the viewport: whatever is stacked behind one is open but
 *  not visible. The settings drawer is not one — the stage slides aside to show
 *  it, so both are on screen — and neither are the dialogs and the palette,
 *  which sit over a scrim with the page showing through. */
export const OPAQUE_FACETS: ReadonlySet<ViewFacetId> = new Set(["bench", "inbox", "studio", "project", "home"]);

type FacetReader = () => ViewLayer | null;
type RowPanesReader = () => ViewPane[];

const facets = shallowReactive(new Map<ViewFacetId, FacetReader>());
const rowPanes = shallowReactive(new Map<string, RowPanesReader>());

/** Publish in a map for the life of the calling scope. Only the entry this call
 *  set is removed on dispose: a remounted surface may already have replaced it. */
function publish<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (!getCurrentScope()) return;
  onScopeDispose(() => {
    if (map.get(key) === value) map.delete(key);
  });
}

/** Describe a surface for as long as the calling component is mounted. */
export function useViewFacet(id: ViewFacetId, read: FacetReader): void {
  publish(facets, id, read);
}

/** Describe one studio row's columns, keyed by its project. The studio portal
 *  publishes the plane; each row publishes what is on it. */
export function useStudioRowView(projectPath: string, read: RowPanesReader): void {
  publish(rowPanes, projectPath, read);
}

/** What a surface says about itself, or null when it is away or unpublished. */
export function readViewFacet(id: ViewFacetId): ViewLayer | null {
  return facets.get(id)?.() ?? null;
}

/** A studio row's columns, left to right. Empty for a row that has not
 *  published (not mounted yet). */
export function readStudioRowPanes(projectPath: string): ViewPane[] {
  return rowPanes.get(projectPath)?.() ?? [];
}

/** Stack every published facet into layers, frontmost first, marking the ones
 *  hidden behind a viewport-filling surface as covered. Pure over the facets,
 *  so the plugin's computed tracks exactly what the getters read. */
export function stackViewLayers(): ViewLayer[] {
  const layers: ViewLayer[] = [];
  let behindOpaque = false;
  for (const id of VIEW_FACET_ORDER) {
    const layer = readViewFacet(id);
    if (!layer) continue;
    layers.push(behindOpaque ? { ...layer, covered: true } : layer);
    if (OPAQUE_FACETS.has(id)) behindOpaque = true;
  }
  return layers;
}

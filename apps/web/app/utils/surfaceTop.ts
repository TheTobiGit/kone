// Viewport surface precedence, stated once.
//
// Four overlay mechanisms share one viewport, and each needs to know whether
// it owns Escape or a summon hotkey. The tier order below is the one shared
// notion of "topmost": one press dismisses exactly the named surface.
//
// Tier order, top first:
//
//   Tier 4 — launcher-modal, intent-menu, assistant. Fixed full-viewport
//   overlays that own keys while up, plus the intent context menu teleported
//   above every portal while up. Within the tier the launcher modal outranks
//   the menu (it blocks summon hotkeys, so when both somehow stand open it
//   answers first), and the menu outranks the assistant (one press dismisses
//   the menu, not the card beneath it).
//   Tier 3 — inbox, studio. Full-viewport portals inside the stage; the inbox
//   paints over the plane. They sit above the drawer on purpose: the tap area
//   that closes the drawer renders underneath both, so working in a portal
//   never dismisses settings revealed behind it.
//   Tier 2 — settings. The lateral panel pinned to the left edge; the stage
//   slides aside to reveal it rather than the panel floating over the stage.
//   Tier 1 — stage. The base page, on top only when nothing else is up.

/** Every layer that can own the viewport, frontmost first. */
export type SurfaceId =
  | "launcher-modal"
  | "intent-menu"
  | "assistant"
  | "inbox"
  | "studio"
  | "settings"
  | "stage";

/** Which layers stand open. Coarse on purpose: inner steps (the studio
 *  overview, a drawer's detail pane, a modal's browser view) are owned inside
 *  their surface and never change which surface answers. */
export interface SurfaceSnapshot {
  launcherModal: boolean;
  intentMenu: boolean;
  assistant: boolean;
  inbox: boolean;
  studio: boolean;
  settings: boolean;
}

/** Name the frontmost open surface. Pure and total: exactly one surface wins,
 *  so one Escape press can only ever dismiss one layer. Checks run topmost
 *  first, matching the tier order documented above. */
export function resolveTop(snapshot: SurfaceSnapshot): SurfaceId {
  if (snapshot.launcherModal) return "launcher-modal";
  if (snapshot.intentMenu) return "intent-menu";
  if (snapshot.assistant) return "assistant";
  if (snapshot.inbox) return "inbox";
  if (snapshot.studio) return "studio";
  if (snapshot.settings) return "settings";
  return "stage";
}

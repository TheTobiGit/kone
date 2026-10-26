// Selection toolbar decisions, kept out of the component so they can be
// exercised without a browser.
//
// The toolbar is a command surface for text the reader already selected. It is
// not a second editor: it never rewrites the selection, never trims it and never
// offers an action that could reach a terminal, a composer or another pane. The
// helpers here answer the three questions the component has to get right —
// whether a selection is admissible, where the measured toolbar fits, and
// which interaction should dismiss or move through it.

import type { TextReference } from "~/types/desktop";

/** The narrow slice of `Node` the admission walk reads. Structural, so the real
 *  DOM satisfies it and the tests can stand in a tiny tree without a document. */
export interface SelectionNode {
  nodeType: number;
  textContent?: string | null;
  parentElement?: SelectionElement | null;
}

export interface SelectionElement extends SelectionNode {
  tagName: string;
  isContentEditable?: boolean;
  getAttribute: (name: string) => string | null;
}

export interface SelectionRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SelectionRange {
  startContainer: SelectionNode;
  endContainer: SelectionNode;
  commonAncestorContainer: SelectionNode;
  getClientRects: () => ArrayLike<SelectionRect>;
  getBoundingClientRect: () => SelectionRect;
}

export interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  toString: () => string;
  getRangeAt: (index: number) => SelectionRange;
}

export interface SelectionCapture {
  /** Exactly what the browser selected — whitespace, tabs and indentation kept. */
  text: string;
  paneId: string;
  /** Only when the whole range sits in one message; cross-message ranges omit it. */
  messageId?: string;
  /** The union of selected line boxes, used to keep actions outside the text. */
  rect: SelectionRect | null;
}

const EXCLUDED_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON"]);
const EXCLUDED_ROLES = new Set([
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "menu",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "slider",
  "spinbutton",
  "switch",
]);
const EDITOR_CLASSES = new Set(["cm-editor", "monaco-editor", "xterm", "selection-actions"]);

function asElement(node: SelectionNode | null | undefined): SelectionElement | null {
  let current: SelectionNode | null | undefined = node;
  while (current && current.nodeType !== 1) current = current.parentElement;
  // SAFETY: nodeType 1 means an element in the DOM; the structural surface above
  // is exactly the element read, and a text node cannot reach here.
  return (current as SelectionElement | null | undefined) ?? null;
}

function closest(
  node: SelectionNode | null | undefined,
  match: (el: SelectionElement) => boolean,
): SelectionElement | null {
  let el = asElement(node);
  while (el) {
    if (match(el)) return el;
    el = asElement(el.parentElement);
  }
  return null;
}

function hasClass(el: SelectionElement, name: string): boolean {
  const raw = el.getAttribute("class");
  if (!raw) return false;
  return raw.split(/\s+/).includes(name);
}

function isEditable(el: SelectionElement): boolean {
  if (el.isContentEditable === true) return true;
  const editable = el.getAttribute("contenteditable");
  return editable !== null && editable !== "false";
}

/** A control or editor is not message text: selecting a label inside a button
 *  or dragging through a code editor must not offer the message actions. */
function isExcludedControl(el: SelectionElement): boolean {
  if (EXCLUDED_TAGS.has(el.tagName)) return true;
  if (isEditable(el)) return true;
  const role = el.getAttribute("role");
  if (role && EXCLUDED_ROLES.has(role)) return true;
  for (const name of EDITOR_CLASSES) {
    if (hasClass(el, name)) return true;
  }
  return el.getAttribute("data-selection-toolbar") !== null;
}

/** The thread pane body owns the selection. Headers, terminals, the scratchpad
 *  and the composer all sit outside it, which is what keeps them out. */
function threadBodyOf(node: SelectionNode): SelectionElement | null {
  const body = closest(node, (el) => el.getAttribute("data-column-type") !== null);
  if (!body || body.getAttribute("data-column-type") !== "thread") return null;
  return body;
}

/** Walk from an endpoint up to (but not through) the pane body, so a label
 *  inside a button or a text node inside an editor is rejected as a whole. */
function hasExcludedControl(node: SelectionNode, boundary: SelectionElement): boolean {
  let el = asElement(node);
  while (el && el !== boundary) {
    if (isExcludedControl(el)) return true;
    el = asElement(el.parentElement);
  }
  return false;
}

function isWithin(node: SelectionNode, ancestor: SelectionElement): boolean {
  return closest(node, (el) => el === ancestor) !== null;
}

function paneIdOf(node: SelectionNode): string | null {
  const column = closest(node, (el) => el.getAttribute("data-column-key") !== null);
  const id = column?.getAttribute("data-column-key") ?? "";
  return id.trim() ? id : null;
}

function messageIdOf(node: SelectionNode): string | null {
  const turn = closest(node, (el) => el.getAttribute("data-turn-id") !== null);
  const id = turn?.getAttribute("data-turn-id") ?? "";
  return id.trim() ? id : null;
}

function selectionRect(range: SelectionRange): SelectionRect | null {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (!rects.length) return range.getBoundingClientRect();
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/**
 * Admit a selection only when every endpoint sits in one thread pane's message
 * body and neither endpoint is a control or editor. The text is returned exactly
 * as the browser reports it; `trim()` is used only to reject emptiness.
 */
export function captureSelection(selection: SelectionLike | null): SelectionCapture | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim()) return null;

  let range: SelectionRange;
  try {
    range = selection.getRangeAt(0);
  } catch {
    return null;
  }

  const startBody = threadBodyOf(range.startContainer);
  const endBody = threadBodyOf(range.endContainer);
  if (!startBody || !endBody || startBody !== endBody) return null;
  if (!isWithin(range.commonAncestorContainer, startBody)) return null;
  if (hasExcludedControl(range.startContainer, startBody)) return null;
  if (hasExcludedControl(range.endContainer, endBody)) return null;

  const paneId = paneIdOf(startBody);
  if (!paneId) return null;

  const startMessage = messageIdOf(range.startContainer);
  const endMessage = messageIdOf(range.endContainer);
  // Both ends must be in message containers: a selection that reaches a
  // loading placeholder, a pane header or thread chrome is not message text.
  if (!startMessage || !endMessage) return null;
  const messageId = startMessage === endMessage ? startMessage : undefined;

  const result: SelectionCapture = {
    text,
    paneId,
    rect: selectionRect(range),
  };
  if (messageId) result.messageId = messageId;
  return result;
}

/** The transport shape handed to the source pane's composer. */
export function captureSelectionReference(capture: SelectionCapture): TextReference {
  const reference: TextReference = {
    text: capture.text,
    sourcePaneId: capture.paneId,
  };
  if (capture.messageId) reference.sourceMessageId = capture.messageId;
  return reference;
}

/** Fill in provenance the composer cannot know — the live session's thread id
 *  and title — without inventing values or overwriting a known message id. */
export function enrichTextReference(
  reference: TextReference,
  provenance: { threadId?: string | null; title?: string | null },
): TextReference {
  const enriched: TextReference = { ...reference };
  const threadId = provenance.threadId?.trim();
  if (threadId) enriched.sourceThreadId = threadId;
  const title = provenance.title?.trim();
  if (title) enriched.sourceTitle = title;
  return enriched;
}

export interface ToolbarViewport {
  width: number;
  height: number;
  /** Visual-viewport offsets, non-zero when the page is pinch-zoomed. */
  offsetLeft?: number;
  offsetTop?: number;
}

export interface ToolbarPlacementInput {
  anchor: SelectionRect;
  releasePoint?: { x: number; y: number };
  bounds?: SelectionRect;
  toolbar: { width: number; height: number };
  viewport: ToolbarViewport;
  margin?: number;
  gap?: number;
}

export interface ToolbarPlacement {
  top: number;
  left: number;
  /** The width the toolbar may occupy after viewport clamping. */
  width: number;
}

/** Where the surface is parked while it is being measured. A fixed, auto-width
 *  box shrinks to fit the space to the right of its `left`, so reading it at the
 *  previous position measures the remainder of the old layout rather than the
 *  box the reader will see. This neutral origin is always roomy enough for the
 *  viewport cap: the cap is the visible width minus both margins. */
export const SELECTION_TOOLBAR_MEASURE_ORIGIN = { top: 0, left: 8 } as const;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** The widest the surface may be before it must wrap: the visible viewport
 *  minus the same eight-pixel margin placement keeps on each side. This is the
 *  only cap applied while measuring, so a narrow viewport measures its real
 *  wrapped width and height instead of an older, narrower measurement. */
export function selectionToolbarCap(viewportWidth: number, margin = 8): number {
  return Math.max(0, viewportWidth - margin * 2);
}

function visibleToolbarBounds(viewport: ToolbarViewport, bounds?: SelectionRect) {
  const left = viewport.offsetLeft ?? 0;
  const top = viewport.offsetTop ?? 0;
  return {
    left: Math.max(left, bounds?.left ?? left),
    right: Math.min(left + Math.max(0, viewport.width), bounds?.right ?? Infinity),
    top: Math.max(top, bounds?.top ?? top),
    bottom: Math.min(top + Math.max(0, viewport.height), bounds?.bottom ?? Infinity),
  };
}

/** Keep actions outside the selected block and inside the visible source pane.
 * Pointer selections prefer the side nearest the release; keyboard selections
 * prefer above. If neither side fits, use the side with more visible space. */
export function placeSelectionToolbar(input: ToolbarPlacementInput): ToolbarPlacement {
  const margin = input.margin ?? 8;
  const gap = input.gap ?? 8;
  const bounds = visibleToolbarBounds(input.viewport, input.bounds);
  const width = Math.min(input.toolbar.width, selectionToolbarCap(bounds.right - bounds.left, margin));
  const height = input.toolbar.height;
  const left = clamp(
    (input.releasePoint?.x ?? input.anchor.left + input.anchor.width / 2) - width / 2,
    bounds.left + margin,
    bounds.right - margin - width,
  );
  const aboveTop = input.anchor.top - gap - height;
  const belowTop = input.anchor.bottom + gap;
  const fitsAbove = aboveTop >= bounds.top + margin;
  const fitsBelow = belowTop + height <= bounds.bottom - margin;
  const prefersBelow = input.releasePoint !== undefined &&
    input.releasePoint.y > input.anchor.top + input.anchor.height / 2;
  let below = prefersBelow;
  if (fitsAbove || fitsBelow) {
    below = prefersBelow ? fitsBelow : !fitsAbove;
  } else {
    const spaceAbove = input.anchor.top - bounds.top;
    const spaceBelow = bounds.bottom - input.anchor.bottom;
    if (spaceAbove !== spaceBelow) below = spaceBelow > spaceAbove;
  }
  const top = clamp(
    below ? belowTop : aboveTop,
    bounds.top + margin,
    bounds.bottom - margin - height,
  );
  return { top, left, width };
}

export interface ToolbarMeasurement {
  /** Park the surface at a neutral origin before it is read. A fixed, auto-width
   *  box shrinks to fit the space right of its current `left`, so a previous
   *  placement would otherwise leak into the measurement. */
  prepare?: () => void | Promise<void>;
  /** Apply the viewport cap and flush layout before the element is read. */
  applyCap: (maxWidth: number) => void | Promise<void>;
  measure: () => { width: number; height: number };
}

export interface ToolbarMeasurementInput {
  anchor: SelectionRect;
  releasePoint?: { x: number; y: number };
  bounds?: SelectionRect;
  viewport: ToolbarViewport;
  measurement: ToolbarMeasurement;
  margin?: number;
  gap?: number;
}

/**
 * Measure, then place. The cap is the visible source pane's width — never a
 * previous measurement — so the first render is not collapsed to zero and a
 * later, wider label grows the surface instead of ratcheting it down. The
 * surface is parked at a neutral origin first so the read cannot inherit the
 * previous placement; a narrow viewport wraps the buttons and the real final
 * height is what placement uses.
 */
export async function measureSelectionToolbar(
  input: ToolbarMeasurementInput,
): Promise<ToolbarPlacement> {
  const bounds = visibleToolbarBounds(input.viewport, input.bounds);
  const cap = selectionToolbarCap(bounds.right - bounds.left, input.margin);
  await input.measurement.prepare?.();
  await input.measurement.applyCap(cap);
  const box = input.measurement.measure();
  return placeSelectionToolbar({
    anchor: input.anchor,
    releasePoint: input.releasePoint,
    bounds: input.bounds,
    toolbar: { width: box.width, height: box.height },
    viewport: input.viewport,
    margin: input.margin,
    gap: input.gap,
  });
}

/** Tab is the explicit keyboard door into the toolbar. Once it has been entered
 *  the second Tab must keep its native meaning and leave; remembering `entered`
 *  also keeps a focusout-delayed hide from recapturing the next Tab. */
export function isToolbarEntryKey(
  event: { key: string; shiftKey: boolean },
  focusInsideToolbar: boolean,
  entered = false,
): boolean {
  return !entered && !focusInsideToolbar && !event.shiftKey && event.key === "Tab";
}

export type ToolbarDismissReason =
  | "escape"
  | "outside"
  | "action"
  | "focusout"
  | "scroll"
  | "viewport"
  | "pane";

export interface FocusTarget {
  focus: (options?: { preventScroll?: boolean }) => void;
  /** Real elements report this; a stand-in may omit it and is treated as live. */
  isConnected?: boolean;
}

/** Dismissals that return the keyboard to where the reader was. Escape is the
 *  deliberate "put me back" key; focusout also lands here when the next focus
 *  was nothing at all (the teleported toolbar is the last focusable subtree in
 *  `body`, so Tab would otherwise drop the reader at the top of the page). */
const FOCUS_RETURN_REASONS = new Set<ToolbarDismissReason>(["escape", "focusout"]);

/**
 * Return focus after a dismissal, using the pre-entry element and falling back
 * to the source pane body when the reader had no focusable origin (a mouse
 * selection leaves focus on `body`). `preventScroll` keeps the viewport still:
 * the selection the reader made is already on screen.
 */
export function restoreToolbarFocus(
  reason: ToolbarDismissReason,
  target: FocusTarget | null,
  fallback: FocusTarget | null = null,
): boolean {
  if (!FOCUS_RETURN_REASONS.has(reason)) return false;
  const destination = target && target.isConnected !== false ? target : fallback;
  if (!destination) return false;
  destination.focus({ preventScroll: true });
  return true;
}

/** The slice of the keydown event the toolbar consumes. */
export interface ToolbarEscapeEvent {
  key: string;
  defaultPrevented?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
  stopImmediatePropagation: () => void;
}

/** An Escape a higher layer already claimed (a modal's window capture listener)
 *  is not the toolbar's, even when the surface is on screen. */
export function ownsToolbarEscape(event: { key: string; defaultPrevented?: boolean }): boolean {
  return event.key === "Escape" && event.defaultPrevented !== true;
}

/**
 * Take Escape before the window-level surfaces see it. The toolbar is teleported
 * to `body`, so its keydown would otherwise bubble to `window` *after* the
 * studio's board binding — which runs on the same node, does not care about
 * `stopPropagation`, and closes the studio out from under the reader. Only a
 * `document` **capture** listener runs earlier; stopping immediate propagation
 * there ends the event's journey.
 */
export function consumeToolbarEscape(event: ToolbarEscapeEvent): boolean {
  if (!ownsToolbarEscape(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  return true;
}

/** Roving focus across the three actions, wrapping at both ends. Null means the
 *  key is not the toolbar's to handle. */
export function nextToolbarIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The narrow slice of the async Clipboard API the toolbar uses. */
export interface ClipboardWriteLike {
  writeText: (text: string) => Promise<void>;
}

export type CopyOutcome = "copied" | "failed";

/**
 * Write the selection exactly as captured. The outcome is only ever `copied`
 * after the clipboard promise resolves; a rejected or absent clipboard is a
 * recoverable `failed`, never a false success.
 */
export async function copySelectionText(
  text: string,
  clipboard: ClipboardWriteLike | null | undefined,
): Promise<CopyOutcome> {
  if (!clipboard) return "failed";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

/** Whether the browser re-reported the selection the toolbar already owns.
 *  Geometry may move; text, pane and message identity may not. */
export function sameSelection(
  current: SelectionCapture | null,
  next: SelectionCapture,
): boolean {
  return (
    current !== null &&
    current.text === next.text &&
    current.paneId === next.paneId &&
    current.messageId === next.messageId
  );
}

/** A pointer landing inside the toolbar must not dismiss it: the native
 *  selection has to survive the click that presses one of its buttons. */
export function isSelectionToolbarTarget(node: SelectionNode | null | undefined): boolean {
  return closest(node, (el) => el.getAttribute("data-selection-toolbar") !== null) !== null;
}

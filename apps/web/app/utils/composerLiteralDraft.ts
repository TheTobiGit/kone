// Putting bytes into the composer's contenteditable field without re-tokenising
// them.
//
// A restored draft is allowed to turn `/name` and `@path` back into skill and
// mention chips — that is what a saved draft is. A New Thread selection is not
// a saved draft: it is ordinary editable text the user asked to see exactly as
// they selected it. A selection that starts with `/tdd fix this` must stay
// those words, not become an invocation chip, and `@src/a.ts` must stay prose.
//
// Keeping this DOM mutation structural (a target with replaceChildren +
// appendChild and a document that mints text nodes) makes the exactness
// behaviour testable without a browser.

/** The one member a DOM text node and a test double share — enough for the
 *  target to accept what the document mints, without naming the DOM here. */
export interface LiteralDraftTextNode {
  readonly nodeType: number;
}

export interface LiteralDraftTarget {
  replaceChildren(): void;
  appendChild(node: LiteralDraftTextNode): void;
}

export interface LiteralDraftDocument {
  createTextNode(text: string): LiteralDraftTextNode;
}

/** Replace the field with the value as one text node. */
export function replaceEditorWithLiteralText(
  target: LiteralDraftTarget,
  value: string,
  doc: LiteralDraftDocument,
): string {
  target.replaceChildren();
  if (value) target.appendChild(doc.createTextNode(value));
  return value;
}

/** Append the value after whatever is already in the field, separated by one
 *  blank line when the existing draft has visible content. Existing nodes —
 *  including standing skill and mention chips — are left in place. */
export function appendEditorLiteralText(
  target: LiteralDraftTarget,
  current: string,
  value: string,
  doc: LiteralDraftDocument,
): string {
  if (!value) return current;
  if (!current.trim()) return replaceEditorWithLiteralText(target, value, doc);
  target.appendChild(doc.createTextNode(`\n\n${value}`));
  return `${current}\n\n${value}`;
}

// The one rendering of a text selection for a model.
//
// Every prompt path uses this: a direct send (`promptAttachments`), a replay
// into a fresh provider session (handoff / hand-in / side chat / edit fork, via
// contextBudget), and a read-back (`app_read_thread`, via
// appThreadsFormatting). Keeping one formatter means the bytes an agent sees
// are the same whether it received the turn or is reading it later.
//
// The quote is fenced rather than wrapped in XML-looking tags: a selection can
// itself contain the old `</referenced_text>` marker (a diff of this code, a
// prompt, documentation), which would let the user's own bytes end the block.
// The fence is always one backtick longer than the longest run inside the
// quote, so no line of the selection can close it. The selected bytes are never
// escaped, trimmed or re-wrapped — the fence and header live outside them.

import type { TextReference } from "@kone/protocol/text-reference";

const MIN_FENCE = 3;

/** A backtick fence longer than any run in `text`. */
export function referenceFence(text: string): string {
  let longest = 0;
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(MIN_FENCE, longest + 1));
}

/** One reference as the model sees it: a provenance header, then the exact
 *  selection in a collision-safe fenced block. */
export function formatReferencePrompt(reference: TextReference): string {
  const title = reference.sourceTitle?.trim();
  const header = title
    ? `Reference from "${title}". The user attached this text as context; it is quoted exactly as selected:`
    : "Reference from the conversation. The user attached this text as context; it is quoted exactly as selected:";
  const fence = referenceFence(reference.text);
  // A quote that already ends in a newline needs no separator before the
  // closing fence; one that does not gets a newline so the fence starts its own
  // line. Either way the quoted bytes themselves are untouched.
  const tail = reference.text.endsWith("\n") ? "" : "\n";
  return `${header}\n${fence}text\n${reference.text}${tail}${fence}`;
}

/** The characters a reference costs in a prompt, framing included. Used by the
 *  compaction and handoff estimators so a large selection is priced at what it
 *  actually delivers. */
export function referencePromptChars(reference: TextReference): number {
  return formatReferencePrompt(reference).length;
}

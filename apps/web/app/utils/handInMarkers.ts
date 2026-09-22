// Hand-in markers: the points where a thread changed hands without changing
// threads. Pure, so placement and labelling are pinned by unit tests rather
// than by switching providers in a long conversation.
import type { HandInRecord } from "~/types/desktop";
import { describeModelId, isPlaceholderModelId } from "~/utils/modelCatalog";
import type { BrandKey } from "~/utils/modelCatalog";
import { SESSION_BRAND } from "~/types/session";
import { PROVIDER_LABEL } from "~/utils/usageProviders";

/** One end of a hand-in: who was answering, drawn as a logo plus a name. */
export type HandInSide = {
  label: string;
  brand: BrandKey;
};

/** One hand-in line on the timeline. `at` is the moment the thread changed
 *  hands, which is what files it above the first exchange that follows. */
export type HandInMark = {
  key: string;
  at: number;
  from: HandInSide;
  to: HandInSide;
};

/** A provider that never ran a named model still has to be nameable, so the
 *  provider's own label stands in for the model rather than a blank — and a
 *  model id that carries no information (a "default" alias rather than a real
 *  model) falls back the same way instead of rendering a name that points at
 *  nothing. */
function side(provider: HandInRecord["fromProvider"], model: string | undefined): HandInSide {
  const trimmed = model?.trim();
  return {
    label:
      trimmed && !isPlaceholderModelId(trimmed)
        ? describeModelId(trimmed).name
        : PROVIDER_LABEL[provider],
    brand: SESSION_BRAND[provider] ?? "generic",
  };
}

export function deriveHandInMarks(records: readonly HandInRecord[]): HandInMark[] {
  return [...records]
    .sort((a, b) => a.at - b.at)
    .map((record) => ({
      // The timestamp is the identity: one thread cannot change hands twice
      // in the same millisecond, and the row id never reaches the renderer.
      key: `hand-in:${record.at}`,
      at: record.at,
      from: side(record.fromProvider, record.fromModel),
      to: side(record.toProvider, record.toModel),
    }));
}

/** The verb the marker leads with. A hand-in keeps the thread and changes who
 *  is answering it, so it reads as the conversation continuing in new hands
 *  rather than as a setting being retuned. */
export const HAND_IN_VERB = "Continued by";

export function handInMarkLabel(mark: HandInMark): string {
  return `${HAND_IN_VERB} ${mark.to.label}, from ${mark.from.label}`;
}

/** Collapse a run of hand-ins that all land on the same turn into the one
 *  change that turn actually saw. Switching provider twice before sending
 *  passes through hands that never answered anything, and naming them would
 *  claim turns that never happened — so the run reads as first-from to
 *  last-to, keeping the latest timestamp as its place in the flow. */
export function collapseHandInMarks(marks: readonly HandInMark[]): HandInMark[] {
  if (marks.length < 2) return [...marks];
  const ordered = [...marks].sort((a, b) => a.at - b.at);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return [...marks];
  // A round trip back to the hands it started in is not a change at all.
  if (first.from.label === last.to.label && first.from.brand === last.to.brand) return [];
  return [{ key: last.key, at: last.at, from: first.from, to: last.to }];
}

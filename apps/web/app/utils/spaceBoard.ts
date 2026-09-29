import { AiBrain01Icon, ChartLineData01Icon, File02Icon, PuzzleIcon } from "@hugeicons/core-free-icons";
import type { DetailIcon } from "~/utils/detailFormat";

// What the Space board is made of: the sections in the nav and the columns each
// one holds, in the order they sit on the track. This is the one place that says
// which column belongs to which section; the nav, the camera's spans, where a nav
// item lands and the instruction files' columns are all read off it.

/** The instruction files, one column each, AGENTS.md beside CLAUDE.md. */
export const INSTRUCTION_KINDS = ["agents", "claude"] as const;

export const SECTIONS = [
  { id: "telemetry", label: "Telemetry", icon: ChartLineData01Icon, columns: ["activity"] },
  { id: "models", label: "Models", icon: AiBrain01Icon, columns: ["models"] },
  { id: "skills", label: "Skills", icon: PuzzleIcon, columns: ["skills"] },
  { id: "instructions", label: "Instructions", icon: File02Icon, columns: INSTRUCTION_KINDS },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: DetailIcon;
  columns: readonly string[];
}>;

type Section = (typeof SECTIONS)[number];
export type SectionId = Section["id"];
export type ColumnId = Section["columns"][number];

/** The columns left to right, and the section each belongs to. */
export const COLUMNS = SECTIONS.flatMap((s) => s.columns.map((id) => ({ id, section: s.id })));

/** How far a column's content sits in from its own edges at the tightest, in px:
 *  the leading gutter columns keep with no rules between them. The board sets it
 *  on the columns as CSS, and the camera keeps its edge fades off it, so it is
 *  named once, here. */
export const COLUMN_GUTTER = 6;

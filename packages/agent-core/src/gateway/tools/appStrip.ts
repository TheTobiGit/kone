// The thread strip's own settings, as gateway tools: where the strip lands when
// a column takes focus, and the width a newly opened pane starts at.
//
// The same arrangement as the theme tools: the renderer holds these — they are
// per-install feel knobs, not board state and not rows in the store — pushes
// them to the shell, and these tools read them back and emit the change for the
// renderer to apply. The width ladder is reported alongside every answer so an
// agent asked for "wider" knows what rungs exist and where the setting sits on
// them, rather than guessing at pixel values the board would clamp anyway.

import type { EmitEvent, RuntimeEvent } from "../../types.js";
import {
  GetStripSettingsInputSchema,
  SetStripSettingsInputSchema,
  GET_STRIP_SETTINGS_JSON_SCHEMA,
  SET_STRIP_SETTINGS_JSON_SCHEMA,
  type SetStripSettingsInput,
  GatewayToolError,
  type GatewayRecord,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";

/** Where the strip lands when a column takes focus. */
export type StripCentering = "never" | "on-overflow" | "always";

/** The pane kinds that carry an opening width. */
export type StripPaneKind = "thread" | "terminal" | "scratchpad";

/**
 * The strip settings as the renderer reports them.
 *
 * `ladder` rides along because a width here is a rung index, not a size: the
 * board's ladder is the renderer's, and an agent that only saw the index would
 * have no way to say what "one wider" means or to notice it is already at the
 * widest.
 */
export interface StripSettingsReading {
  centering: StripCentering;
  defaultWidths: Record<StripPaneKind, number>;
  /** The column width rungs in pixels, narrowest first. */
  ladder: readonly number[];
}

export interface AppStripToolOptions {
  emit?: EmitEvent;
  /** Reads the strip settings the renderer last reported. Absent (or returning
   *  null) means the app has not said what they are, and the tools report that
   *  rather than naming defaults the user may have changed. */
  readStripSettings?: () => StripSettingsReading | null;
}

/** What each centering mode does, in the words the settings page uses. Kept
 *  here so a tool answer and the pane the user is looking at describe the same
 *  behaviour. */
const CENTERING_BLURB = {
  never:
    "Holds the strip still. A column out of view is nudged in by the smallest move that reveals it.",
  "on-overflow":
    "Holds the strip still while the focused column already fits; when it doesn't, brings it to the middle.",
  always: "Brings the focused column to the middle every time, even when it was already in view.",
} satisfies Record<StripCentering, string>;

const PANE_KINDS: readonly StripPaneKind[] = ["thread", "terminal", "scratchpad"];

/** Only the widths a call actually named, as a result record. A kind left out
 *  was left alone, and reporting it as null would read as "cleared". */
function appliedWidths(widths: Partial<Record<StripPaneKind, number>>): GatewayRecord {
  const record: GatewayRecord = {};
  for (const kind of PANE_KINDS) {
    const rung = widths[kind];
    if (rung !== undefined) record[kind] = rung;
  }
  return record;
}

function settingsPayload(reading: StripSettingsReading): GatewayRecord {
  return {
    centering: reading.centering,
    centeringMeans: CENTERING_BLURB[reading.centering],
    defaultWidths: Object.fromEntries(
      PANE_KINDS.map((kind) => [
        kind,
        {
          rung: reading.defaultWidths[kind],
          px: reading.ladder[reading.defaultWidths[kind]] ?? null,
        },
      ]),
    ),
    ladder: [...reading.ladder],
    widestRung: Math.max(0, reading.ladder.length - 1),
  };
}

export function createAppStripTools(options: AppStripToolOptions): ToolEntry[] {
  const emit = options.emit;
  const readStripSettings = options.readStripSettings;

  const reading = (): StripSettingsReading | null => readStripSettings?.() ?? null;

  /** The settings, or a refusal. A write needs them too: a rung has to be
   *  checked against the ladder the board actually has, and clamping against a
   *  guess would silently apply a width nobody asked for. */
  const requireReading = (): StripSettingsReading => {
    const current = reading();
    if (!current) {
      throw new GatewayToolError(
        "provider_unavailable",
        "kone has not reported its thread strip settings yet. Try again once the app window has finished loading.",
      );
    }
    return current;
  };

  // ── 1. app_get_strip_settings ────────────────────────────────────────────
  const getHandler = async (
    _ctx: GatewayToolContext,
    _args: Record<string, never>,
  ): Promise<GatewayToolResult> => {
    const current = reading();
    if (!current) {
      return {
        content: [
          {
            type: "text",
            text: "kone has not reported its thread strip settings yet. Try again once the app window has finished loading.",
          },
        ],
        structuredContent: { known: false },
      };
    }

    const widths = PANE_KINDS.map((kind) => {
      const rung = current.defaultWidths[kind];
      const px = current.ladder[rung];
      return `- ${kind}: rung ${rung}${px ? ` (${px}px)` : ""}`;
    }).join("\n");

    return {
      content: [
        {
          type: "text",
          text:
            `Centering: **${current.centering}** — ${CENTERING_BLURB[current.centering]}\n\n` +
            `Width a new pane opens at:\n${widths}\n\n` +
            `Width ladder (rung → px): ${current.ladder.map((px, i) => `${i} → ${px}`).join(", ")}. ` +
            "A pane already on the board keeps its own width; these only decide what a fresh one opens at.",
        },
      ],
      structuredContent: { known: true, ...settingsPayload(current) },
    };
  };

  // ── 2. app_set_strip_settings ────────────────────────────────────────────
  const setHandler = async (
    ctx: GatewayToolContext,
    params: SetStripSettingsInput,
  ): Promise<GatewayToolResult> => {
    const current = requireReading();
    const widest = Math.max(0, current.ladder.length - 1);

    const widths: Partial<Record<StripPaneKind, number>> = {};
    for (const kind of PANE_KINDS) {
      const requested = params.defaultWidths?.[kind];
      if (requested === undefined) continue;
      // Refused rather than clamped: a caller that asked for rung 7 on a
      // four-rung ladder has the wrong model of the setting, and silently
      // handing it the widest would leave that belief intact.
      if (requested > widest) {
        throw new GatewayToolError(
          "invalid_input",
          `Rung ${requested} is past the widest rung (${widest}). The ladder is ${current.ladder
            .map((px, i) => `${i} → ${px}px`)
            .join(", ")}.`,
        );
      }
      widths[kind] = requested;
    }

    if (!emit) {
      throw new GatewayToolError(
        "provider_unavailable",
        "kone cannot apply thread strip changes in this session — no window is listening for them.",
      );
    }

    const mutation: Extract<RuntimeEvent, { type: "app.strip_mutation" }> = {
      threadId: ctx.threadId,
      provider: ctx.provider,
      at: Date.now(),
      source: "kone.store",
      type: "app.strip_mutation",
    };
    // What isn't named isn't changed — the renderer reads an absent field as
    // "leave this setting alone", the same contract the theme mutation follows.
    if (params.centering) mutation.centering = params.centering;
    if (Object.keys(widths).length > 0) mutation.defaultWidths = widths;
    emit(mutation);

    const parts: string[] = [];
    if (params.centering) {
      parts.push(`centering to **${params.centering}** (${CENTERING_BLURB[params.centering]})`);
    }
    for (const kind of PANE_KINDS) {
      const rung = widths[kind];
      if (rung === undefined) continue;
      const px = current.ladder[rung];
      parts.push(`a new ${kind} pane to rung ${rung}${px ? ` (${px}px)` : ""}`);
    }
    const summary = `Set ${parts.join(", ")}.`;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        ok: true,
        summary,
        applied: {
          centering: params.centering ?? null,
          defaultWidths: appliedWidths(widths),
        },
        previous: settingsPayload(current),
      },
    };
  };

  return [
    {
      name: "app_get_strip_settings",
      description:
        "Inspect the thread strip's settings: how the strip scrolls when a column takes focus, the width a newly opened thread / terminal / scratchpad pane starts at, and the column width ladder those widths are rungs on.",
      inputSchema: GetStripSettingsInputSchema,
      jsonSchema: GET_STRIP_SETTINGS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_get_strip_settings`: the thread strip's centering mode, per-kind opening widths, and the width ladder.",
      promptGuidelines: [
        "Call `app_get_strip_settings` before changing a width — the widths are rungs on a ladder, not pixel sizes, and the ladder is what says which rungs exist.",
      ],
      handler: getHandler,
    },
    {
      name: "app_set_strip_settings",
      description:
        "Change the thread strip's settings: the centering mode ('never', 'on-overflow', 'always') and the rung a newly opened pane of each kind starts at. Panes already on the board keep the width they have.",
      inputSchema: SetStripSettingsInputSchema,
      jsonSchema: SET_STRIP_SETTINGS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_set_strip_settings`: set the strip's centering mode and the opening width of new panes.",
      promptGuidelines: [
        "Use `app_set_strip_settings` when the user asks how columns scroll, centre, or how wide new panes open — do not edit files or settings JSON for it.",
        "These are per-install preferences: they change what happens next, not the panes already open.",
      ],
      handler: setHandler,
    },
  ];
}

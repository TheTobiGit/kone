// Typography preferences as gateway tools: font families for interface (sans),
// wordmark (serif), code (mono), and composer, plus font sizes, line height,
// measure and subpixel smoothing.
//
// The same arrangement as the theme and strip tools: the renderer holds these —
// they are per-install feel knobs, not board state and not rows in the store —
// pushes them to the shell via app:state, and these tools read them back and
// emit the change for the renderer to apply live via app.typography_mutation.

import type { EmitEvent, RuntimeEvent } from "../../types.js";
import {
  GetTypographyInputSchema,
  SetTypographyInputSchema,
  GET_TYPOGRAPHY_JSON_SCHEMA,
  SET_TYPOGRAPHY_JSON_SCHEMA,
  type GetTypographyInput,
  type SetTypographyInput,
  GatewayToolError,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";
import {
  DEFAULT_TYPOGRAPHY_PREFS,
  MIN_CODE_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MIN_COMPOSER_FONT_SIZE,
  MAX_COMPOSER_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MIN_LINE_HEIGHT_BODY,
  MAX_LINE_HEIGHT_BODY,
  MIN_MEASURE,
  MAX_MEASURE,
  TYPOGRAPHY_FAMILY_FALLBACK_LABELS,
  clampCodeFontSize,
  clampComposerFontSize,
  clampInterfaceFontSize,
  clampLineHeightBody,
  clampMeasure,
  readFamily,
  type TypographyFamilyKind,
  type TypographyPrefs,
} from "@kone/protocol/typography";

export type TypographyReading = TypographyPrefs;

type TypographyMutation = Extract<RuntimeEvent, { type: "app.typography_mutation" }>;

const FAMILY_KEYS = ["sans", "serif", "mono", "composer"] as const;

const FAMILY_CHANGE_LABELS = {
  sans: "interface font",
  serif: "wordmark font",
  mono: "code font",
  composer: "composer font",
} satisfies Record<(typeof FAMILY_KEYS)[number], string>;

export interface AppTypographyToolOptions {
  emit?: EmitEvent;
  readTypography?: () => TypographyReading | null;
}

function typographyPayload(reading: TypographyReading): TypographyPrefs {
  return { ...reading };
}

function normalizeFamily(value: string): string {
  // "default" is this tool's alias for the shipped stack. The canonical
  // reader only trims and truncates, so the alias is resolved here at the
  // call site rather than inside the shared helper.
  if (value.trim().toLowerCase() === "default") return "";
  return readFamily(value);
}

function familyLabel(value: string, kind: TypographyFamilyKind): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? `"${trimmed}"` : `Default (${TYPOGRAPHY_FAMILY_FALLBACK_LABELS[kind]})`;
}

export function createAppTypographyTools(options: AppTypographyToolOptions): ToolEntry[] {
  const emit = options.emit;
  const readTypography = options.readTypography;

  const requireReading = (): TypographyReading => {
    const current = readTypography?.() ?? null;
    if (!current) {
      throw new GatewayToolError(
        "provider_unavailable",
        "kone has not reported its typography settings yet. Try again once the app window has finished loading.",
      );
    }
    return current;
  };

  // ── 1. app_get_typography ──────────────────────────────────────────────────
  const getHandler = async (
    _ctx: GatewayToolContext,
    _args: GetTypographyInput,
  ): Promise<GatewayToolResult> => {
    const current = readTypography?.() ?? null;
    if (!current) {
      return {
        content: [
          {
            type: "text",
            text: "kone has not reported its typography settings yet. Try again once the app window has finished loading.",
          },
        ],
        structuredContent: { known: false },
      };
    }

    const lines = [
      "**Fonts:**",
      `- Interface (sans): ${familyLabel(current.sans, "sans")}`,
      `- Wordmark (serif): ${familyLabel(current.serif, "serif")}`,
      `- Code (mono): ${familyLabel(current.mono, "mono")}`,
      `- Composer: ${familyLabel(current.composer, "composer")}`,
      "",
      "**Sizes:**",
      `- Interface: ${current.sizeInterface}px (allowed ${MIN_INTERFACE_FONT_SIZE}–${MAX_INTERFACE_FONT_SIZE}px, default ${DEFAULT_TYPOGRAPHY_PREFS.sizeInterface}px)`,
      `- Composer: ${current.sizeComposer}px (allowed ${MIN_COMPOSER_FONT_SIZE}–${MAX_COMPOSER_FONT_SIZE}px, default ${DEFAULT_TYPOGRAPHY_PREFS.sizeComposer}px)`,
      `- Code: ${current.sizeCode}px (allowed ${MIN_CODE_FONT_SIZE}–${MAX_CODE_FONT_SIZE}px, default ${DEFAULT_TYPOGRAPHY_PREFS.sizeCode}px)`,
      "",
      "**Reading & Rendering:**",
      `- Line height: ${current.lineHeightBody.toFixed(2)} (allowed ${MIN_LINE_HEIGHT_BODY.toFixed(2)}–${MAX_LINE_HEIGHT_BODY.toFixed(2)}, default ${DEFAULT_TYPOGRAPHY_PREFS.lineHeightBody.toFixed(2)})`,
      `- Reading measure: ${current.measure}ch (allowed ${MIN_MEASURE}–${MAX_MEASURE}ch, default ${DEFAULT_TYPOGRAPHY_PREFS.measure}ch)`,
      `- Subpixel smoothing: ${current.smoothing ? "enabled" : "disabled"} (default ${DEFAULT_TYPOGRAPHY_PREFS.smoothing ? "enabled" : "disabled"})`,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        known: true,
        ...typographyPayload(current),
        defaults: { ...typographyPayload(DEFAULT_TYPOGRAPHY_PREFS) },
        ranges: {
          sizeInterface: { min: MIN_INTERFACE_FONT_SIZE, max: MAX_INTERFACE_FONT_SIZE },
          sizeComposer: { min: MIN_COMPOSER_FONT_SIZE, max: MAX_COMPOSER_FONT_SIZE },
          sizeCode: { min: MIN_CODE_FONT_SIZE, max: MAX_CODE_FONT_SIZE },
          lineHeightBody: { min: MIN_LINE_HEIGHT_BODY, max: MAX_LINE_HEIGHT_BODY },
          measure: { min: MIN_MEASURE, max: MAX_MEASURE },
        },
      },
    };
  };

  // ── 2. app_set_typography ──────────────────────────────────────────────────
  const setHandler = async (
    ctx: GatewayToolContext,
    params: SetTypographyInput,
  ): Promise<GatewayToolResult> => {
    const current = requireReading();

    if (!emit) {
      throw new GatewayToolError(
        "provider_unavailable",
        "kone cannot apply typography changes in this session — no window is listening for them.",
      );
    }

    // Refuse-vs-clamp, decided once: out-of-range input never reaches here —
    // the input schema refuses it, and its bounds derive from the same
    // protocol constants. The canonical clamps below therefore only round
    // valid input into stored form (renderer pushes already-clamped prefs, so
    // they agree on what a valid size is by construction).
    const patch: Partial<TypographyPrefs> = {};
    const changes: string[] = [];

    if (params.reset) {
      Object.assign(patch, { ...DEFAULT_TYPOGRAPHY_PREFS });
      changes.push("reset all typography preferences to defaults");
    }

    for (const key of FAMILY_KEYS) {
      const input = params[key];
      if (input === undefined) continue;
      const normalized = normalizeFamily(input);
      patch[key] = normalized;
      changes.push(`${FAMILY_CHANGE_LABELS[key]} to ${normalized ? `"${normalized}"` : "Default"}`);
    }

    if (params.sizeInterface !== undefined) {
      const size = clampInterfaceFontSize(params.sizeInterface);
      patch.sizeInterface = size;
      changes.push(`interface font size to ${size}px`);
    }
    if (params.sizeComposer !== undefined) {
      const size = clampComposerFontSize(params.sizeComposer);
      patch.sizeComposer = size;
      changes.push(`composer font size to ${size}px`);
    }
    if (params.sizeCode !== undefined) {
      const size = clampCodeFontSize(params.sizeCode);
      patch.sizeCode = size;
      changes.push(`code font size to ${size}px`);
    }
    if (params.lineHeightBody !== undefined) {
      const lineHeight = clampLineHeightBody(params.lineHeightBody);
      patch.lineHeightBody = lineHeight;
      changes.push(`line height to ${lineHeight}`);
    }
    if (params.measure !== undefined) {
      const measure = clampMeasure(params.measure);
      patch.measure = measure;
      changes.push(`measure to ${measure}ch`);
    }
    if (params.smoothing !== undefined) {
      patch.smoothing = params.smoothing;
      changes.push(`subpixel smoothing ${params.smoothing ? "enabled" : "disabled"}`);
    }

    const mutation: TypographyMutation = {
      threadId: ctx.threadId,
      provider: ctx.provider,
      at: Date.now(),
      source: "kone.store",
      type: "app.typography_mutation",
      ...patch,
    };
    emit(mutation);

    const summary = `Set ${changes.join(", ")}.`;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        ok: true,
        summary,
        applied: { ...patch },
        previous: { ...typographyPayload(current) },
      },
    };
  };

  return [
    {
      name: "app_get_typography",
      description:
        "Inspect the app's typography settings: font families for interface (sans), wordmark (serif), code (mono), and composer, font sizes in pixels, line height, reading measure, and subpixel smoothing.",
      inputSchema: GetTypographyInputSchema,
      jsonSchema: GET_TYPOGRAPHY_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_get_typography`: inspect current font families, font sizes, line height, reading measure, and font smoothing.",
      promptGuidelines: [
        "Call `app_get_typography` to check what fonts and sizes are currently active before or after adjusting typography.",
      ],
      handler: getHandler,
    },
    {
      name: "app_set_typography",
      description:
        `Change the app's typography preferences: configure custom font families (interface, wordmark, code, composer), adjust font sizes in pixels (interface ${MIN_INTERFACE_FONT_SIZE}–${MAX_INTERFACE_FONT_SIZE}px, composer ${MIN_COMPOSER_FONT_SIZE}–${MAX_COMPOSER_FONT_SIZE}px, code ${MIN_CODE_FONT_SIZE}–${MAX_CODE_FONT_SIZE}px), line height (${MIN_LINE_HEIGHT_BODY}–${MAX_LINE_HEIGHT_BODY}), reading measure (${MIN_MEASURE}–${MAX_MEASURE}ch), toggle subpixel smoothing, or reset all typography back to defaults.`,
      inputSchema: SetTypographyInputSchema,
      jsonSchema: SET_TYPOGRAPHY_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_set_typography`: adjust font families, font sizes, line height, measure, font smoothing, or reset typography to defaults.",
      promptGuidelines: [
        "Use `app_set_typography` when the user asks to change fonts, font sizes, line height, or text appearance — do not edit CSS or configuration files for it.",
        "To restore shipped defaults for a font family, pass \"default\" or an empty string \"\". To restore all typography settings to defaults, pass `reset: true`.",
      ],
      handler: setHandler,
    },
  ];
}

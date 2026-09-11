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
  type GatewayRecord,
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
  MAX_TYPOGRAPHY_FAMILY_LENGTH,
  type TypographyPrefs,
} from "@kone/protocol/typography";

export type TypographyReading = TypographyPrefs;

export interface AppTypographyToolOptions {
  emit?: EmitEvent;
  readTypography?: () => TypographyReading | null;
}

function typographyPayload(reading: TypographyReading): GatewayRecord {
  return {
    sans: reading.sans,
    serif: reading.serif,
    mono: reading.mono,
    composer: reading.composer,
    sizeInterface: reading.sizeInterface,
    sizeComposer: reading.sizeComposer,
    sizeCode: reading.sizeCode,
    lineHeightBody: reading.lineHeightBody,
    measure: reading.measure,
    smoothing: reading.smoothing,
  };
}

function appliedTypography(mutation: Extract<RuntimeEvent, { type: "app.typography_mutation" }>): GatewayRecord {
  const record: GatewayRecord = {};
  if (mutation.sans !== undefined) record.sans = mutation.sans;
  if (mutation.serif !== undefined) record.serif = mutation.serif;
  if (mutation.mono !== undefined) record.mono = mutation.mono;
  if (mutation.composer !== undefined) record.composer = mutation.composer;
  if (mutation.sizeInterface !== undefined) record.sizeInterface = mutation.sizeInterface;
  if (mutation.sizeComposer !== undefined) record.sizeComposer = mutation.sizeComposer;
  if (mutation.sizeCode !== undefined) record.sizeCode = mutation.sizeCode;
  if (mutation.lineHeightBody !== undefined) record.lineHeightBody = mutation.lineHeightBody;
  if (mutation.measure !== undefined) record.measure = mutation.measure;
  if (mutation.smoothing !== undefined) record.smoothing = mutation.smoothing;
  return record;
}

function normalizeFamily(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "default") {
    return "";
  }
  return trimmed.length > MAX_TYPOGRAPHY_FAMILY_LENGTH
    ? trimmed.slice(0, MAX_TYPOGRAPHY_FAMILY_LENGTH)
    : trimmed;
}

function familyLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? `"${trimmed}"` : `Default (${fallback})`;
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
      `- Interface (sans): ${familyLabel(current.sans, '"Geist", system-ui, sans-serif')}`,
      `- Wordmark (serif): ${familyLabel(current.serif, '"Fraunces", ui-serif, serif')}`,
      `- Code (mono): ${familyLabel(current.mono, 'ui-monospace, "SF Mono", monospace')}`,
      `- Composer: ${familyLabel(current.composer, "inherits Interface font")}`,
      "",
      "**Sizes:**",
      `- Interface: ${current.sizeInterface}px (allowed ${MIN_INTERFACE_FONT_SIZE}–${MAX_INTERFACE_FONT_SIZE}px, default 16px)`,
      `- Composer: ${current.sizeComposer}px (allowed ${MIN_COMPOSER_FONT_SIZE}–${MAX_COMPOSER_FONT_SIZE}px, default 14px)`,
      `- Code: ${current.sizeCode}px (allowed ${MIN_CODE_FONT_SIZE}–${MAX_CODE_FONT_SIZE}px, default 12px)`,
      "",
      "**Reading & Rendering:**",
      `- Line height: ${current.lineHeightBody.toFixed(2)} (allowed ${MIN_LINE_HEIGHT_BODY.toFixed(2)}–${MAX_LINE_HEIGHT_BODY.toFixed(2)}, default 1.55)`,
      `- Reading measure: ${current.measure}ch (allowed ${MIN_MEASURE}–${MAX_MEASURE}ch, default 68ch)`,
      `- Subpixel smoothing: ${current.smoothing ? "enabled" : "disabled"} (default enabled)`,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        known: true,
        ...typographyPayload(current),
        defaults: typographyPayload(DEFAULT_TYPOGRAPHY_PREFS),
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

    if (
      params.sizeInterface !== undefined &&
      (params.sizeInterface < MIN_INTERFACE_FONT_SIZE || params.sizeInterface > MAX_INTERFACE_FONT_SIZE)
    ) {
      throw new GatewayToolError(
        "invalid_input",
        `Interface font size must be between ${MIN_INTERFACE_FONT_SIZE}px and ${MAX_INTERFACE_FONT_SIZE}px (received ${params.sizeInterface}px).`,
      );
    }
    if (
      params.sizeComposer !== undefined &&
      (params.sizeComposer < MIN_COMPOSER_FONT_SIZE || params.sizeComposer > MAX_COMPOSER_FONT_SIZE)
    ) {
      throw new GatewayToolError(
        "invalid_input",
        `Composer font size must be between ${MIN_COMPOSER_FONT_SIZE}px and ${MAX_COMPOSER_FONT_SIZE}px (received ${params.sizeComposer}px).`,
      );
    }
    if (
      params.sizeCode !== undefined &&
      (params.sizeCode < MIN_CODE_FONT_SIZE || params.sizeCode > MAX_CODE_FONT_SIZE)
    ) {
      throw new GatewayToolError(
        "invalid_input",
        `Code font size must be between ${MIN_CODE_FONT_SIZE}px and ${MAX_CODE_FONT_SIZE}px (received ${params.sizeCode}px).`,
      );
    }
    if (
      params.lineHeightBody !== undefined &&
      (params.lineHeightBody < MIN_LINE_HEIGHT_BODY || params.lineHeightBody > MAX_LINE_HEIGHT_BODY)
    ) {
      throw new GatewayToolError(
        "invalid_input",
        `Body line height must be between ${MIN_LINE_HEIGHT_BODY} and ${MAX_LINE_HEIGHT_BODY} (received ${params.lineHeightBody}).`,
      );
    }
    if (params.measure !== undefined && (params.measure < MIN_MEASURE || params.measure > MAX_MEASURE)) {
      throw new GatewayToolError(
        "invalid_input",
        `Reading measure must be between ${MIN_MEASURE}ch and ${MAX_MEASURE}ch (received ${params.measure}ch).`,
      );
    }

    const mutation: Extract<RuntimeEvent, { type: "app.typography_mutation" }> = {
      threadId: ctx.threadId,
      provider: ctx.provider,
      at: Date.now(),
      source: "kone.store",
      type: "app.typography_mutation",
    };

    if (params.reset) {
      mutation.sans = DEFAULT_TYPOGRAPHY_PREFS.sans;
      mutation.serif = DEFAULT_TYPOGRAPHY_PREFS.serif;
      mutation.mono = DEFAULT_TYPOGRAPHY_PREFS.mono;
      mutation.composer = DEFAULT_TYPOGRAPHY_PREFS.composer;
      mutation.sizeInterface = DEFAULT_TYPOGRAPHY_PREFS.sizeInterface;
      mutation.sizeComposer = DEFAULT_TYPOGRAPHY_PREFS.sizeComposer;
      mutation.sizeCode = DEFAULT_TYPOGRAPHY_PREFS.sizeCode;
      mutation.lineHeightBody = DEFAULT_TYPOGRAPHY_PREFS.lineHeightBody;
      mutation.measure = DEFAULT_TYPOGRAPHY_PREFS.measure;
      mutation.smoothing = DEFAULT_TYPOGRAPHY_PREFS.smoothing;
    }

    const sans = normalizeFamily(params.sans);
    if (sans !== undefined) mutation.sans = sans;
    const serif = normalizeFamily(params.serif);
    if (serif !== undefined) mutation.serif = serif;
    const mono = normalizeFamily(params.mono);
    if (mono !== undefined) mutation.mono = mono;
    const composer = normalizeFamily(params.composer);
    if (composer !== undefined) mutation.composer = composer;

    if (params.sizeInterface !== undefined) mutation.sizeInterface = Math.round(params.sizeInterface);
    if (params.sizeComposer !== undefined) mutation.sizeComposer = Math.round(params.sizeComposer);
    if (params.sizeCode !== undefined) mutation.sizeCode = Math.round(params.sizeCode);
    if (params.lineHeightBody !== undefined) {
      mutation.lineHeightBody = Math.round(params.lineHeightBody * 100) / 100;
    }
    if (params.measure !== undefined) mutation.measure = Math.round(params.measure);
    if (params.smoothing !== undefined) mutation.smoothing = params.smoothing;

    emit(mutation);

    const changes: string[] = [];
    if (params.reset) {
      changes.push("reset all typography preferences to defaults");
    }
    if (params.sans !== undefined) changes.push(`interface font to ${mutation.sans ? `"${mutation.sans}"` : "Default"}`);
    if (params.serif !== undefined) changes.push(`wordmark font to ${mutation.serif ? `"${mutation.serif}"` : "Default"}`);
    if (params.mono !== undefined) changes.push(`code font to ${mutation.mono ? `"${mutation.mono}"` : "Default"}`);
    if (params.composer !== undefined) {
      changes.push(`composer font to ${mutation.composer ? `"${mutation.composer}"` : "Default"}`);
    }
    if (params.sizeInterface !== undefined) changes.push(`interface font size to ${mutation.sizeInterface}px`);
    if (params.sizeComposer !== undefined) changes.push(`composer font size to ${mutation.sizeComposer}px`);
    if (params.sizeCode !== undefined) changes.push(`code font size to ${mutation.sizeCode}px`);
    if (params.lineHeightBody !== undefined) changes.push(`line height to ${mutation.lineHeightBody}`);
    if (params.measure !== undefined) changes.push(`measure to ${mutation.measure}ch`);
    if (params.smoothing !== undefined) {
      changes.push(`subpixel smoothing ${mutation.smoothing ? "enabled" : "disabled"}`);
    }

    const summary = `Set ${changes.join(", ")}.`;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        ok: true,
        summary,
        applied: appliedTypography(mutation),
        previous: typographyPayload(current),
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
        "Change the app's typography preferences: configure custom font families (interface, wordmark, code, composer), adjust font sizes in pixels (interface 12–20px, composer 12–20px, code 10–18px), line height (1.35–1.80), reading measure (55–80ch), toggle subpixel smoothing, or reset all typography back to defaults.",
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

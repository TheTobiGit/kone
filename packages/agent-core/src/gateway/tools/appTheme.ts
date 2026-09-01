import type { EmitEvent, RuntimeEvent } from "../../types.js";
import {
  CreateCustomThemeInputSchema,
  GetThemeStateInputSchema,
  ListAvailableThemesInputSchema,
  PreviewThemeOverrideInputSchema,
  SetThemeInputSchema,
  CREATE_CUSTOM_THEME_JSON_SCHEMA,
  GET_THEME_STATE_JSON_SCHEMA,
  LIST_AVAILABLE_THEMES_JSON_SCHEMA,
  PREVIEW_THEME_OVERRIDE_JSON_SCHEMA,
  SET_THEME_JSON_SCHEMA,
  type CreateCustomThemeInput,
  type ListAvailableThemesInput,
  type PreviewThemeOverrideInput,
  type SetThemeInput,
  GatewayToolError,
  type GatewayValue,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";

/**
 * One theme as the renderer reports it.
 *
 * This package holds no theme list of its own. The renderer owns the library —
 * kone's built-ins plus whatever the user imported or authored — and pushes the
 * whole roster to the shell alongside the appearance; the gateway reads it back.
 * That is the only reason an imported or agent-created theme can be listed and
 * applied at all, and it is why nothing here has to be kept in step by hand.
 */
export interface ThemeRosterEntry {
  id: string;
  label: string;
  blurb: string;
  /** `system` is kone's own appearance, `adaptive` a theme with a designed
   *  palette per scheme, `fixed` one designed as a single appearance. Only
   *  `fixed` overrides the user's mode. */
  kind: "system" | "adaptive" | "fixed";
  /** The scheme the theme leads with. An adaptive theme also ships the other
   *  one — read `schemes` to know what it can actually paint. */
  appearance: "light" | "dark";
  /** Every scheme the theme ships. Filtering on `appearance` alone would hide
   *  the adaptive themes from a search for dark ones. */
  schemes: readonly ("light" | "dark")[];
  accent: string;
  ground: string;
  /** Where the theme came from. Worth reporting: "remove this theme" means
   *  something for an import and nothing for a built-in. */
  origin: "built-in" | "custom" | "imported";
}

/** The appearance the renderer reports it is painting. The shell mirrors this
 *  from the renderer's own theme push, so it describes the window the user is
 *  actually looking at rather than what an agent last asked for. */
export interface AppearanceReading {
  themeId: string;
  themeLabel: string;
  mode: "system" | "dark" | "light";
  scheme: "light" | "dark";
  locked: boolean;
}

/** What `app_get_theme_state` answers with. `known` is false when the renderer
 *  has not reported an appearance yet — the tool says so instead of naming a
 *  default that may not be on screen. */
export type CurrentThemeState = {
  [key: string]: GatewayValue;
  known: boolean;
  themeId: string | null;
  themeLabel: string | null;
  mode: "system" | "dark" | "light" | null;
  resolvedScheme: "light" | "dark" | null;
  isLocked: boolean | null;
  kind: "system" | "adaptive" | "fixed" | null;
  /** The theme's two defining colours, from the roster. Null while the roster
   *  has yet to arrive — the appearance push carries the theme's name but not
   *  its palette. */
  accent: string | null;
  ground: string | null;
  origin: "built-in" | "custom" | "imported" | null;
};

// ── colour vocabulary ───────────────────────────────────────────────────────
// A theme's roster entry carries an accent but no adjectives, and the words a
// user reaches for are adjectives: "something green", "a warm one", "the purple
// theme". Deriving them from the accent rather than tagging each theme by hand
// is what lets an imported theme nobody wrote a description for still answer to
// "blue" — and keeps a second, hand-maintained vocabulary from drifting out of
// step with the palettes it claims to describe.

/** Hue angle, saturation and lightness for a hex colour, or null if it isn't
 *  one. A role can legitimately hold a relational value instead of a literal,
 *  and those simply contribute no colour words. */
function hsl(hex: string): { h: number; s: number; l: number } | null {
  const raw = hex.trim().replace(/^#/, "");
  const full =
    raw.length === 3
      ? raw.split("").map((c) => c + c).join("")
      : raw.length === 6
        ? raw
        : null;
  if (!full || !/^[0-9a-f]{6}$/i.test(full)) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h = h * 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** Hue bands, each with the words a user might reach for. The bands overlap the
 *  way the words do — an accent at 250° is fair to call blue or violet — so a
 *  colour lands in one band and answers to every word in it. */
const HUE_BANDS: readonly { until: number; words: readonly string[] }[] = [
  { until: 15, words: ["red", "crimson", "warm"] },
  { until: 45, words: ["orange", "terracotta", "rust", "copper", "warm"] },
  { until: 70, words: ["amber", "gold", "yellow", "warm"] },
  { until: 160, words: ["green", "mint", "cool"] },
  { until: 200, words: ["teal", "cyan", "cool"] },
  { until: 250, words: ["blue", "azure", "cobalt", "cool"] },
  { until: 290, words: ["violet", "purple", "indigo", "cool"] },
  { until: 330, words: ["magenta", "purple", "plum"] },
  { until: 345, words: ["pink", "rose", "warm"] },
  { until: 361, words: ["red", "crimson", "warm"] },
];

/**
 * The colour words an accent answers to.
 *
 * A colour with almost no chroma is described by its neutrality rather than its
 * hue: the hue angle of a near-grey is real but meaningless, and reporting it
 * would have a stone-coloured theme turn up in a search for green.
 */
export function colourWords(hex: string): readonly string[] {
  const parsed = hsl(hex);
  if (!parsed) return [];
  if (parsed.s < 0.12) return ["neutral", "grey", "gray", "mono"];
  return HUE_BANDS.find((band) => parsed.h < band.until)?.words ?? [];
}

/** Everything a theme can be matched on, lower-cased and space-joined. The
 *  structured fields are in here too, so "dark", "adaptive" and "imported" find
 *  what a user means by them without being duplicated as descriptive text. */
function searchText(theme: ThemeRosterEntry): string {
  return [
    theme.id,
    theme.label,
    theme.blurb,
    theme.kind,
    theme.origin,
    ...theme.schemes,
    ...colourWords(theme.accent),
  ]
    .join(" ")
    .toLowerCase();
}

/** Ids and labels compare without their punctuation, so "t3chat", "t3-chat"
 *  and "T3 Chat" all reach the theme they name. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Resolve a user-supplied identifier or description to a theme in the roster.
 *
 * Exact names win before anything descriptive, so a theme called "Ocean" is
 * never lost to another theme merely described as oceanic. Only after that do
 * the colour words and prose get a say, and there the roster's own order breaks
 * ties — built-ins first, in the order the appearance pane lists them.
 */
export function resolveTheme(
  input: string,
  themes: readonly ThemeRosterEntry[],
): ThemeRosterEntry | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  const clean = squash(normalized);

  const byId = themes.find((t) => squash(t.id) === clean);
  if (byId) return byId;

  const byLabel = themes.find((t) => squash(t.label) === clean);
  if (byLabel) return byLabel;

  const byColour = themes.find((t) => colourWords(t.accent).includes(normalized));
  if (byColour) return byColour;

  const byPartialName = themes.find(
    (t) => squash(t.id).includes(clean) || squash(t.label).includes(clean),
  );
  if (byPartialName) return byPartialName;

  return themes.find((t) => searchText(t).includes(normalized));
}

/**
 * Filter the roster by query string, kind, and appearance.
 */
export function filterThemes(
  params: ListAvailableThemesInput,
  themes: readonly ThemeRosterEntry[],
): ThemeRosterEntry[] {
  let results = [...themes];

  if (params.kind) {
    results = results.filter((t) => t.kind === params.kind);
  }

  if (params.appearance) {
    // Match on what a theme can paint, not just the scheme it leads with: the
    // adaptive themes are all light-first and would otherwise vanish from a
    // search for dark ones despite shipping a dark scheme.
    results = results.filter((t) => t.schemes.includes(params.appearance!));
  }

  if (params.query) {
    const q = params.query.trim().toLowerCase();
    results = results.filter((t) => searchText(t).includes(q));
  }

  return results;
}

export interface AppThemeToolOptions {
  emit?: EmitEvent;
  /** Reads the appearance the renderer last reported. Absent (or returning
   *  null) means nothing has been reported, and `app_get_theme_state` answers
   *  `known: false` rather than inventing a current theme. */
  readAppearance?: () => AppearanceReading | null;
  /** Reads the theme library the renderer last reported. Absent (or returning
   *  null) means the app has not said what it holds, and the tools that need a
   *  theme by name say so rather than guessing at a list. */
  readThemes?: () => readonly ThemeRosterEntry[] | null;
}

/**
 * Creates the suite of gateway tools for app theming and visual steering.
 */
export function createAppThemeTools(options: AppThemeToolOptions): ToolEntry[] {
  const emit = options.emit;
  const readAppearance = options.readAppearance;
  const readThemes = options.readThemes;

  const roster = (): readonly ThemeRosterEntry[] | null => readThemes?.() ?? null;

  /** The roster, or a refusal. Naming a theme is the one thing these tools
   *  cannot do without the app's own list — every fallback would be a guess at
   *  a library only the renderer can see. */
  const requireRoster = (): readonly ThemeRosterEntry[] => {
    const themes = roster();
    if (!themes?.length) {
      throw new GatewayToolError(
        "provider_unavailable",
        "kone has not reported its theme library yet, so there is no theme to resolve a name against. Try again once the app window has finished loading.",
      );
    }
    return themes;
  };

  const unknownState = (): CurrentThemeState => ({
    known: false,
    themeId: null,
    themeLabel: null,
    mode: null,
    resolvedScheme: null,
    isLocked: null,
    kind: null,
    accent: null,
    ground: null,
    origin: null,
  });

  const currentState = (): CurrentThemeState => {
    const reading = readAppearance?.() ?? null;
    if (!reading) return unknownState();
    const entry = roster()?.find((t) => t.id === reading.themeId);
    return {
      known: true,
      themeId: reading.themeId,
      themeLabel: reading.themeLabel,
      mode: reading.mode,
      resolvedScheme: reading.scheme,
      isLocked: reading.locked,
      kind: entry?.kind ?? null,
      accent: entry?.accent ?? null,
      ground: entry?.ground ?? null,
      origin: entry?.origin ?? null,
    };
  };

  /** What to say about a name the library does not hold. An outside theme is a
   *  likely reason to be here — kone imports those rather than shipping
   *  look-alikes under borrowed names — so the message points at the import
   *  instead of quietly applying the nearest thing kone has. */
  const unknownThemeMessage = (
    rawTheme: string,
    themes: readonly ThemeRosterEntry[],
  ): string => {
    const sample = themes.slice(0, 10).map((t) => `\`${t.id}\` (${t.label})`).join(", ");
    return (
      `Unknown theme "${rawTheme}". kone holds: ${sample}. ` +
      "Use app_list_available_themes to search the whole library. A theme from another editor " +
      "is not here until the user imports it in the appearance settings, after which it appears in this list."
    );
  };

  // ── 1. app_get_theme_state ───────────────────────────────────────────────
  const getThemeStateHandler = async (
    _ctx: GatewayToolContext,
    _args: Record<string, never>,
  ): Promise<GatewayToolResult> => {
    const state = currentState();
    return {
      content: [
        {
          type: "text",
          text: state.known
            ? JSON.stringify(state, null, 2)
            : "The renderer has not reported an appearance yet, so there is no current theme to describe. " +
              "Use app_list_available_themes to see what can be applied.",
        },
      ],
      structuredContent: state,
    };
  };

  // ── 2. app_list_available_themes ─────────────────────────────────────────
  const listAvailableThemesHandler = async (
    _ctx: GatewayToolContext,
    params: ListAvailableThemesInput,
  ): Promise<GatewayToolResult> => {
    const themes = roster();
    if (!themes?.length) {
      return {
        content: [
          {
            type: "text",
            text: "kone has not reported its theme library yet. Try again once the app window has finished loading.",
          },
        ],
        structuredContent: { known: false, total: 0, themes: [] },
      };
    }

    const matches = filterThemes(params, themes);

    return {
      content: [
        {
          type: "text",
          text:
            `Found ${matches.length} available themes:\n` +
            matches
              .map(
                (t) =>
                  `- **${t.label}** (\`${t.id}\`): ${t.blurb} [${t.schemes.join("/")}, accent: ${t.accent}, ${t.origin}]`,
              )
              .join("\n"),
        },
      ],
      structuredContent: {
        known: true,
        total: matches.length,
        themes: matches.map((t) => ({ ...t, schemes: [...t.schemes] })),
      },
    };
  };

  // ── 3. app_set_theme ─────────────────────────────────────────────────────
  const setThemeHandler = async (
    ctx: GatewayToolContext,
    params: SetThemeInput,
  ): Promise<GatewayToolResult> => {
    let resolvedTheme: ThemeRosterEntry | undefined;
    const rawTheme = params.themeId ?? params.theme ?? params.name;
    let targetMode = params.mode;

    if (rawTheme) {
      // A bare mode change needs no library, so the roster is only required on
      // the branch that actually has a name to look up.
      const themes = requireRoster();
      const lower = rawTheme.trim().toLowerCase();
      if (!targetMode) {
        if (lower.endsWith(" dark")) targetMode = "dark";
        else if (lower.endsWith(" light")) targetMode = "light";
        else if (lower.endsWith(" system")) targetMode = "system";
      }
      const cleanThemeQuery = lower.replace(/\s+(dark|light|system)$/, "");
      resolvedTheme = resolveTheme(cleanThemeQuery, themes) ?? resolveTheme(rawTheme, themes);
      if (!resolvedTheme) {
        throw new GatewayToolError("invalid_input", unknownThemeMessage(rawTheme, themes));
      }
    }

    const previous = currentState();

    // Neither a theme nor a mode leaves nothing to apply. The schema's refine
    // already rejects that, so reaching here means the caller passed a theme,
    // a mode, or both — and a bare mode change keeps whatever theme is current.
    const targetTheme = resolvedTheme;
    const appliedMode = targetMode ?? previous.mode ?? undefined;

    // A fixed theme pins its own scheme; otherwise the renderer resolves the
    // mode (and "system" against the OS, which only it can see). Reporting a
    // guess here would contradict the window.
    const resolvedScheme: "light" | "dark" | null =
      targetTheme?.kind === "fixed"
        ? targetTheme.appearance
        : appliedMode === "light" || appliedMode === "dark"
          ? appliedMode
          : null;

    if (emit) {
      const mutationEvent: Extract<RuntimeEvent, { type: "app.theme_mutation" }> = {
        threadId: ctx.threadId,
        provider: ctx.provider,
        at: Date.now(),
        source: "kone.store",
        type: "app.theme_mutation",
      };
      // A bare mode change carries no themeId, and a bare theme change no mode:
      // the renderer reads an absent field as "leave this alone".
      if (targetTheme) mutationEvent.themeId = targetTheme.id;
      if (targetMode) mutationEvent.mode = targetMode;
      emit(mutationEvent);
    }

    const applied = targetTheme
      ? `theme "${targetTheme.label}" (${targetTheme.id})`
      : "appearance mode";
    const scheme = resolvedScheme ? ` (${resolvedScheme} scheme)` : "";
    const summary = `Applied ${applied}${appliedMode ? ` in ${appliedMode} mode` : ""}${scheme}.`;

    return {
      content: [
        {
          type: "text",
          text: summary,
        },
      ],
      structuredContent: {
        ok: true,
        summary,
        applied: {
          themeId: targetTheme?.id ?? previous.themeId,
          themeLabel: targetTheme?.label ?? previous.themeLabel,
          mode: appliedMode ?? null,
          resolvedScheme,
          isLocked: targetTheme ? targetTheme.kind === "fixed" : previous.isLocked,
        },
        previousState: previous,
      },
    };
  };

  // ── 4. app_preview_theme_override ─────────────────────────────────────────
  const previewThemeOverrideHandler = async (
    ctx: GatewayToolContext,
    params: PreviewThemeOverrideInput,
  ): Promise<GatewayToolResult> => {
    const rawTheme = params.themeId ?? params.theme;

    // Resolve before emitting, for the same reason set_theme does: an id the
    // renderer can't find falls back to kone, which would leave this reporting
    // a preview of a theme that never appeared.
    let base: ThemeRosterEntry | undefined;
    if (rawTheme) {
      const themes = requireRoster();
      base = resolveTheme(rawTheme, themes);
      if (!base) {
        throw new GatewayToolError("invalid_input", unknownThemeMessage(rawTheme, themes));
      }
    }

    if (emit) {
      const previewEvent: Extract<RuntimeEvent, { type: "app.theme_mutation" }> = {
        threadId: ctx.threadId,
        provider: ctx.provider,
        at: Date.now(),
        source: "kone.store",
        type: "app.theme_mutation",
        preview: !params.cancel,
      };
      // Same omission contract as set_theme: what isn't named isn't overridden,
      // so a colours-only preview keeps the theme and mode already on screen.
      if (base) previewEvent.themeId = base.id;
      if (params.mode) previewEvent.mode = params.mode;
      if (params.colors) previewEvent.colors = params.colors;
      emit(previewEvent);
    }

    const message = params.cancel
      ? "Cancelled live theme preview; restored saved theme."
      : `Live preview applied (theme: ${base?.id ?? "current"}, mode: ${params.mode ?? "current"}, custom tokens: ${Object.keys(params.colors ?? {}).length}).`;

    return {
      content: [{ type: "text", text: message }],
      structuredContent: {
        ok: true,
        previewActive: !params.cancel,
        message,
      },
    };
  };

  // ── 5. app_create_custom_theme ───────────────────────────────────────────
  const createCustomThemeHandler = async (
    ctx: GatewayToolContext,
    params: CreateCustomThemeInput,
  ): Promise<GatewayToolResult> => {
    // The renderer registers the theme in its own library and reports it back
    // on the next appearance push, so the id used here is a real target for
    // app_set_theme afterwards rather than a name only this call ever knew.
    if (emit) {
      const customThemeEvent: Extract<RuntimeEvent, { type: "app.theme_mutation" }> = {
        threadId: ctx.threadId,
        provider: ctx.provider,
        at: Date.now(),
        source: "kone.store",
        type: "app.theme_mutation",
        themeId: params.id,
        customTheme: {
          id: params.id,
          label: params.label,
          blurb: params.blurb,
          appearance: params.appearance,
          accent: params.accent,
          ground: params.ground,
          roles: params.roles,
        },
      };
      emit(customThemeEvent);
    }

    const summary = `Created and applied custom theme "${params.label}" (\`${params.id}\`) with accent ${params.accent}.`;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        ok: true,
        summary,
        customTheme: params,
      },
    };
  };

  // One name per tool, in the underscore form: a dot is not a legal character
  // in a tool name for every client that consumes this server, so a dotted
  // canonical name is silently dropped and only the alias would survive.
  return [
    {
      name: "app_get_theme_state",
      description: "Inspect the current visual environment of the application: which theme is active, the appearance mode, the resolved light/dark scheme, and whether the theme pins its own scheme.",
      inputSchema: GetThemeStateInputSchema,
      jsonSchema: GET_THEME_STATE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_get_theme_state`: returns the active themeId, mode, resolved scheme and lock status.",
      promptGuidelines: [
        "When the user asks about the visual appearance or current theme, call `app_get_theme_state` to inspect the UI.",
      ],
      handler: getThemeStateHandler,
    },
    {
      name: "app_list_available_themes",
      description: "Discover the themes this kone install actually holds — the ones it ships plus any the user imported or created — with optional search and filtering by kind or appearance (e.g. query: 'dark', 'warm', 'green', 'imported').",
      inputSchema: ListAvailableThemesInputSchema,
      jsonSchema: LIST_AVAILABLE_THEMES_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_list_available_themes`: discover available themes with an optional search query.",
      promptGuidelines: [
        "Use `app_list_available_themes` to find valid theme IDs when the user asks for a theme or a vibe — the library differs per install, so never assume an id.",
      ],
      handler: listAvailableThemesHandler,
    },
    {
      name: "app_set_theme",
      description: "Change, switch, or set the application theme and/or appearance mode (dark, light, system). Call this directly whenever the user asks to change the theme or mode.",
      inputSchema: SetThemeInputSchema,
      jsonSchema: SET_THEME_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_set_theme`: sets the active theme and/or appearance mode ('dark', 'light', 'system').",
      promptGuidelines: [
        "Use `app_set_theme` immediately whenever the user asks to change, switch, or customize the theme or appearance mode.",
        "Do NOT use shell/bash commands or file searches to change UI appearance — use `app_set_theme` directly.",
      ],
      handler: setThemeHandler,
    },
    {
      name: "app_preview_theme_override",
      description: "Temporarily preview a theme, appearance mode, or custom color role overrides on the interface without saving them.",
      inputSchema: PreviewThemeOverrideInputSchema,
      jsonSchema: PREVIEW_THEME_OVERRIDE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_preview_theme_override`: preview a theme or colour overrides non-destructively.",
      promptGuidelines: [
        "Use `app_preview_theme_override` when trying out a palette before persisting it.",
      ],
      handler: previewThemeOverrideHandler,
    },
    {
      name: "app_create_custom_theme",
      description: "Create and apply a new custom theme built from semantic colors (e.g. from a project's brand palette). The theme joins the user's library and can be re-applied by id afterwards.",
      inputSchema: CreateCustomThemeInputSchema,
      jsonSchema: CREATE_CUSTOM_THEME_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "`app_create_custom_theme`: create and save a custom theme from brand/accent colors.",
      promptGuidelines: [
        "Use `app_create_custom_theme` when creating a new project-specific theme.",
      ],
      handler: createCustomThemeHandler,
    },
  ];
}

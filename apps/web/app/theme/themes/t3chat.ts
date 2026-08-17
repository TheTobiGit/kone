import { buildTheme } from "../build";
import type { ThemeDefinition } from "../roles";

/**
 * T3 Chat — pink paper and plum night.
 *
 * The light scheme is genuinely pink rather than a neutral wearing a blush: the
 * page itself is the pink, the text is plum, and the meta voice is raspberry, so
 * the interface carries its colour in the reading instead of only in the
 * buttons. That raspberry is the theme's one unusual move — everywhere else a
 * softer text step is a fade toward the ground, and here it is a *hue* change,
 * which is why the ink above it is pushed deeper than a plum page would
 * otherwise need: the ladder has to keep an even step when one of its rungs
 * changes colour instead of weight.
 *
 * One magenta is the whole interactive voice — selected, pressed, focused. It is
 * pitched a shade under the brightest pink the palette could carry so it holds
 * as *text* on the pink page, not only as a button fill; a magenta that only
 * worked as paint would leave every accent label in the app a degree too faint
 * to read.
 *
 * Dark is the same room under plum, and the accent lifts to meet it. A magenta
 * deep enough to hold pink ink on a button is a magenta that vanishes as a focus
 * ring, an accent label or a caret against a near-black ground, so the night
 * half takes the hot rose and puts the dark plum on top of it instead — the same
 * inversion every other scheme here performs, rather than an exception that
 * quietly costs the interface its accent everywhere but the buttons.
 *
 * The second voice is a violet — a different hue from the magenta, not a shade
 * of it — so the accent and its counter stay distinct. Danger is held out in
 * true red rather than allowed to drift toward the accent, because a pink theme
 * is the one place where "delete" and "brand" can collapse into the same signal.
 * Folders are brass and files violet, so the two kinds of object part ways by
 * hue, and the sidebar is a deeper pink in light but drops below the canvas in
 * dark, where it becomes the dark shell the room sits in. Code sits on a
 * lavender surface in light and a lifted plum in dark, so a diff or a preview
 * reads as a different room in both appearances rather than only in one.
 */
export const T3CHAT_THEME: ThemeDefinition = buildTheme({
  id: "t3chat",
  label: "T3 Chat",
  blurb: "Pink paper and plum night, one magenta voice.",
  kind: "adaptive",
  light: {
    ground: "#fbf1fa",
    sunken: "#ecdcee",
    raised: "#fdf8fd",
    raisedHigh: "#ffffff",

    ink: "#4a1450",
    // Deeper than the usual second rung: the step below it is a hue change
    // rather than a fade, so this one has to carry the weight difference alone.
    inkSoft: "#6d3169",
    // The raspberry meta voice — the theme's signature, and the reason the page
    // reads as pink in the *text* and not just in the furniture.
    muted: "#ab1668",
    faint: "#9c7896",
    placeholder: "#82558a",

    // The magenta the theme is recognised by. It is the only interactive voice,
    // which is what keeps the pink page from turning every button into paint.
    accent: "#cf1f6d",
    accentInk: "#ffffff",
    // Violet, not a softer pink: the second voice has to be a different hue or
    // the palette collapses into one colour wearing two names.
    accentSecondary: "#6c3aa4",
    accentSecondaryInk: "#ffffff",
    // Honey is the mark voice — search matches, live glows — never the button,
    // so "something is happening" never has to borrow the magenta.
    highlight: "#c8901c",

    // Brass folders and violet files, so the two kinds of object separate by
    // hue the way the rest of the palette does.
    folder: "#a3761c",
    file: "#65479c",

    boost: "#c8901c",

    // ok is teal rather than any pink: a passing state must not share the
    // identity colour, or "this worked" and "this is T3 Chat" become the same
    // signal. danger is held in true red for the same reason in reverse — a
    // pink-red would read as the accent on a page already made of pink.
    ok: "#0b7a62",
    warn: "#96660f",
    danger: "#c62a24",
    diffAdd: "#0b7a62",
    diffDel: "#c62a24",

    // The inside of an input is a pink fill, not the raised surface — the one
    // place the theme lets the wash actually hold text. It is pitched to leave
    // the placeholder legible on it, which a deeper pink would not.
    field: "#eccce1",
    chip: "#f7dcee",

    codeBg: "#f3e7f7",
    termBg: "#fbf1fa",
    termInk: "#4a1450",
    termCursor: "#cf1f6d",

    strip: "#f2e2f3",
    roles: {
      termSelection: "#f0c2e4",
    },

    plasma: ["#fbf1fa", "#f3ddf1", "#e4b6dd"],

    ansi: {
      black: "#4a3f50",
      red: "#bd2a22",
      green: "#0f8a5f",
      yellow: "#96660f",
      blue: "#5a3fa0",
      magenta: "#b81a63",
      cyan: "#0e7490",
      white: "#5c5060",
      brightBlack: "#8a7a90",
      brightRed: "#d43c30",
      brightGreen: "#059669",
      brightYellow: "#c8901c",
      brightBlue: "#7a5cb8",
      brightMagenta: "#cf1f6d",
      brightCyan: "#0891b2",
      brightWhite: "#4a1450",
    },
  },
  dark: {
    ground: "#1f1a24",
    sunken: "#130e17",
    raised: "#2b2431",
    raisedHigh: "#372f3e",

    ink: "#f7f4f9",
    inkSoft: "#d9c2d4",
    muted: "#b5a0b1",
    faint: "#7f7183",
    placeholder: "#8a7c8e",

    // The hot rose the night half is built on. It stays the light scheme's
    // pigment, lifted rather than deepened, so the accent survives everywhere it
    // is asked to be a line or a glyph rather than a fill.
    accent: "#e65590",
    accentInk: "#2b0716",
    accentSecondary: "#a98ae4",
    accentSecondaryInk: "#1c1332",
    highlight: "#e8b84a",

    folder: "#d9ab5e",
    file: "#a48cd6",

    boost: "#e8b84a",

    ok: "#4ec9a8",
    warn: "#d8a44a",
    danger: "#f0726e",
    diffAdd: "#4ec9a8",
    diffDel: "#f0726e",

    field: "#2c1e28",
    chip: "#3b2c37",

    // The code surface lifts off the canvas rather than folding into it: the
    // night room is already plum, so the step is small, but a preview with no
    // step at all stops being a region.
    codeBg: "#282030",
    termBg: "#1a151f",
    termInk: "#efe6f0",
    termCursor: "#e65590",

    strip: "#171018",
    roles: {
      termSelection: "#4a2a44",
    },

    plasma: ["#1f1a24", "#2e2033", "#5c2750"],

    ansi: {
      black: "#3b3440",
      red: "#f0726e",
      green: "#4ec9a6",
      yellow: "#e5b567",
      blue: "#9a82d0",
      magenta: "#e58ac0",
      cyan: "#6bd6c6",
      white: "#dcd4e0",
      brightBlack: "#5b5460",
      brightRed: "#ff938c",
      brightGreen: "#79e3c0",
      brightYellow: "#f2cd88",
      brightBlue: "#b8a0f0",
      brightMagenta: "#f0b0d8",
      brightCyan: "#8ce8da",
      brightWhite: "#f7f4f9",
    },
  },
});

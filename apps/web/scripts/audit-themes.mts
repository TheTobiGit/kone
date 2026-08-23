/**
 * Standalone theme audit, runnable without a browser or a build step:
 *
 *   node --experimental-strip-types apps/web/scripts/audit-themes.mts
 *
 * It loads the shipped themes and the role catalog straight out of the app
 * source and, per theme and per scheme, proves that every role exists, that
 * every role resolves to a concrete colour once composited onto the ground,
 * that the critical text pairs stay legible, that no two roles collide where a
 * collision means a mistake, and that the plasma gradient stops are the raw
 * hex the shader expects. A report, not a gate — it always exits 0.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import type { ThemeDefinition, ThemeScheme } from "../app/theme/roles";

// The app source imports its own modules with extensionless specifiers
// (`./kone`, `./derive`). Node's type stripper resolves exactly what it is
// given and nothing more, so those imports would fail as-is; teach resolution
// to fall back to the `.ts` neighbour instead of re-implementing the source.
if (typeof registerHooks === "function") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
        try {
          return nextResolve(specifier, context);
        } catch {}
        return nextResolve(specifier + ".ts", context);
      }
      return nextResolve(specifier, context);
    },
  });
}

type Rgb = readonly [number, number, number];
type Rgba = { rgb: Rgb; a: number };

/** A role → colour table as a built-in theme ships it (ThemeColors): every
 *  value is a CSS colour expression string, re-validated field-by-field below
 *  because this audit exists to check that contract at runtime. */
type RoleColorTable = Record<string, string>;

type ResolveContext = {
  colors: RoleColorTable;
  varToRole: Map<string, string>;
  resolveRole: (role: string) => Rgba;
  resolveVar: (name: string) => Rgba;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const EPS = 1e-6;

/** The pairs the shipped themes must keep legible, and their floor. */
const CONTRAST_PAIRS: readonly (readonly [string, string, number])[] = [
  ["ink", "ground", 4.5],
  ["ink", "raised", 3.0],
  ["inkSoft", "ground", 3.0],
  ["muted", "ground", 3.0],
  ["faint", "ground", 3.0],
  ["accentInk", "accent", 4.5],
  ["termInk", "termBg", 3.0],
  // The second voice has to survive being used, not just exist.
  ["accentSecondaryInk", "accentSecondary", 4.5],
  ["accentSecondary", "ground", 3.0],
  // Domain identity is carried by graphics and small glyphs, so 3:1 is the floor.
  ["folder", "ground", 3.0],
  ["file", "ground", 3.0],
  // A placeholder must be *quieter* than body text but still perceptible.
  ["placeholder", "field", 2.0],
];

/**
 * Pairs where resolving to the same colour is almost certainly a typo. These
 * are the ones picked deliberately: every other equal pair in a palette
 * (`accent` == `focus`, `termBg` == `ground`) is a declared relationship, not
 * an accident.
 */
const EQUALITY_PAIRS: readonly (readonly [string, string])[] = [
  ["ink", "inkSoft"],
  ["ground", "raised"],
  ["line", "lineSoft"],
  ["hover", "press"],
  ["muted", "faint"],
  // The whole point of a second voice is that it is a different hue. If these
  // collide the theme has one accent wearing two names, which is the exact
  // failure the expanded vocabulary exists to prevent.
  ["accent", "accentSecondary"],
  // Folders and files must read as different kinds of object.
  ["folder", "file"],
];

function hexToRgb(hex: string): Rgba {
  const t = hex.toLowerCase();
  const expand = (c: string) => parseInt(c + c, 16);
  let r: number;
  let g: number;
  let b: number;
  let a = 1;
  if (t.length === 3 || t.length === 4) {
    r = expand(t[0]);
    g = expand(t[1]);
    b = expand(t[2]);
    if (t.length === 4) a = expand(t[3]) / 255;
  } else {
    r = parseInt(t.slice(0, 2), 16);
    g = parseInt(t.slice(2, 4), 16);
    b = parseInt(t.slice(4, 6), 16);
    if (t.length === 8) a = parseInt(t.slice(6, 8), 16) / 255;
  }
  return { rgb: [r / 255, g / 255, b / 255], a };
}

function parseAlpha(raw: string): number {
  if (raw.endsWith("%")) return clamp01(parseFloat(raw) / 100);
  return clamp01(parseFloat(raw));
}

function parseRgb(body: string): Rgba {
  const [rgbPart, alphaPart] = body.split("/").map((s) => s.trim());
  const channels = (rgbPart ?? "").split(/[\s,]+/).filter(Boolean);
  let a = alphaPart === undefined ? 1 : parseAlpha(alphaPart);
  if (channels.length === 4 && alphaPart === undefined) {
    a = parseAlpha(channels.pop()!);
  }
  if (channels.length !== 3) {
    throw new Error(`rgb() needs exactly three channels (got ${channels.length})`);
  }
  const toChannel = (c: string) => (c.endsWith("%") ? (parseFloat(c) / 100) * 255 : parseFloat(c));
  // SAFETY: rgb() was validated to have exactly the three channels Rgb holds.
  return { rgb: channels.map((c) => clamp01(toChannel(c) / 255)) as Rgb, a };
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function srgbToOklab([r, g, b]: Rgb): Rgb {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l1 = Math.cbrt(l);
  const m1 = Math.cbrt(m);
  const s1 = Math.cbrt(s);
  return [
    0.2104542553 * l1 + 0.793617785 * m1 - 0.0040720468 * s1,
    1.9779984951 * l1 - 2.428592205 * m1 + 0.4505937099 * s1,
    0.0259040371 * l1 + 0.7827717662 * m1 - 0.808675766 * s1,
  ];
}

function oklabToSrgb([L, a, b]: Rgb): Rgb {
  const l1 = L + 0.3963377774 * a + 0.2158037573 * b;
  const m1 = L - 0.1055613458 * a - 0.0638541728 * b;
  const s1 = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l1 ** 3;
  const m = m1 ** 3;
  const s = s1 ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [clamp01(r), clamp01(g), clamp01(bb)];
}

function parseValue(raw: string, ctx: ResolveContext): Rgba {
  const s = raw.trim();
  if (s.toLowerCase() === "transparent") return { rgb: [0, 0, 0], a: 0 };

  let m = s.match(/^var\((--[a-zA-Z0-9-]+)\)$/);
  if (m) return ctx.resolveVar(m[1]);

  m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) return hexToRgb(m[1]);

  m = s.match(/^rgba?\((.*)\)$/i);
  if (m) return parseRgb(m[1]);

  m = s.match(/^color-mix\(in\s+(srgb|oklab)\s*,(.*)\)$/i);
  if (m) {
    // SAFETY: the regex above matches only the two color-space literals.
    return parseColorMix(m[1].toLowerCase() as "srgb" | "oklab", m[2], ctx);
  }

  const fn = s.match(/^([a-z-]+)\(/i);
  if (fn) throw new Error(`unknown function \`${fn[1]}(...)\``);
  throw new Error("not a supported colour expression");
}

/** One parsed `color-mix()` component: its resolved color and optional
 *  percentage weight as a 0..1 fraction (null when the component has no
 *  percentage). */
type MixComponent = {
  color: Rgba;
  pct: number | null;
};

function parseMixComponent(arg: string, ctx: ResolveContext): MixComponent {
  const m = arg.match(/^(.*?)\s+(\d+(?:\.\d+)?)%$/);
  if (m) return { color: parseValue(m[1], ctx), pct: parseFloat(m[2]) / 100 };
  return { color: parseValue(arg, ctx), pct: null };
}

/**
 * Color-mix interpolation with premultiplied alpha, in the requested space.
 * `transparent` contributes nothing, so "accent 12% / transparent" lands as
 * accent at 12% alpha — the wash every theme's `accentWash` intends.
 */
function parseColorMix(space: "srgb" | "oklab", argStr: string, ctx: ResolveContext): Rgba {
  const args = splitTopLevel(argStr)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (args.length !== 2) {
    throw new Error(`color-mix() needs exactly two components (got ${args.length})`);
  }
  const c1 = parseMixComponent(args[0], ctx);
  const c2 = parseMixComponent(args[1], ctx);
  const w1 = c1.pct ?? (c2.pct == null ? 0.5 : 1 - c2.pct);
  const w2 = c2.pct ?? 1 - w1;
  const a = c1.color.a * w1 + c2.color.a * w2;
  if (a <= 0) return { rgb: [0, 0, 0], a: 0 };
  if (space === "srgb") {
    const rgb = c1.color.rgb.map(
      (v, i) => (c1.color.a * w1 * v + c2.color.a * w2 * c2.color.rgb[i]) / a,
    );
    // SAFETY: mixing two three-channel colors yields three channels.
    return { rgb: rgb.map(clamp01) as Rgb, a };
  }
  const lab1 = srgbToOklab(c1.color.rgb);
  const lab2 = srgbToOklab(c2.color.rgb);
  const lab = lab1.map((v, i) => (c1.color.a * w1 * v + c2.color.a * w2 * lab2[i]) / a);
  // SAFETY: oklab channels are exactly the three Rgb holds.
  return { rgb: oklabToSrgb(lab as Rgb), a };
}

function createResolver(colors: RoleColorTable, varToRole: Map<string, string>) {
  const memo = new Map<string, Rgba>();
  const resolving = new Set<string>();

  function resolveRole(role: string): Rgba {
    const cached = memo.get(role);
    if (cached) return cached;
    if (resolving.has(role)) {
      throw new Error(`reference cycle ${[...resolving, role].join(" -> ")}`);
    }
    const raw = colors[role];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error("role has no usable value");
    }
    resolving.add(role);
    try {
      const out = parseValue(raw, ctx);
      memo.set(role, out);
      return out;
    } finally {
      resolving.delete(role);
    }
  }

  const ctx: ResolveContext = {
    colors,
    varToRole,
    resolveRole,
    resolveVar(name) {
      const role = varToRole.get(name);
      if (!role) throw new Error(`dangling var(${name}) — no role binds it`);
      return resolveRole(role);
    },
  };

  return { resolveRole };
}

function composite(c: Rgba, ground: Rgba | null): Rgb {
  if (c.a >= 1 || !ground) return c.rgb;
  // SAFETY: blending two three-channel arrays channelwise stays three long.
  return c.rgb.map((v, i) => v * c.a + ground.rgb[i] * (1 - c.a)) as Rgb;
}

function linearize(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function sameColor(a: Rgb, b: Rgb): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= EPS);
}

function toHex(c: Rgb): string {
  return `#${c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0")).join("")}`;
}

type Finding = { scheme: string; check: string; message: string };

type SchemeAudit = {
  lines: string[];
  findings: Finding[];
};

const roleList = (roles: readonly string[], colors: RoleColorTable) => {
  const bad: string[] = [];
  for (const role of roles) {
    const v = colors[role];
    if (v == null) bad.push(`\`${role}\` missing`);
    else if (typeof v !== "string" || v.trim() === "") bad.push(`\`${role}\` empty`);
  }
  return bad;
};

function auditScheme(
  scheme: string,
  colors: RoleColorTable,
  roles: readonly string[],
  varToRole: Map<string, string>,
  extras: { plasma?: unknown } | undefined,
): SchemeAudit {
  const lines: string[] = [];
  const findings: Finding[] = [];

  const missing = roleList(roles, colors);
  for (const m of missing) findings.push({ scheme, check: "completeness", message: m });
  lines.push(
    `completeness  ${
      missing.length === 0 ? `${roles.length}/${roles.length} roles present` : missing.join("  ")
    }`,
  );

  const { resolveRole } = createResolver(colors, varToRole);
  let ground: Rgba | null = null;
  try {
    ground = resolveRole("ground");
  } catch {}

  const opaque = new Map<string, Rgb>();
  const unresolved: { role: string; raw: string; reason: string }[] = [];
  for (const role of roles) {
    try {
      opaque.set(role, composite(resolveRole(role), ground));
    } catch (e) {
      // SAFETY: colors[role] is a CSS string by construction; throws here are Errors.
      unresolved.push({ role, raw: colors[role] as string, reason: (e as Error).message });
    }
  }
  for (const u of unresolved) {
    findings.push({
      scheme,
      check: "resolvability",
      message: `\`${u.role}\` cannot be resolved: ${u.reason} — raw \`${u.raw}\``,
    });
  }
  const resolved = roles.length - unresolved.length;
  lines.push(`resolvability ${resolved}/${roles.length} roles resolve`);
  for (const u of unresolved) {
    lines.push(`  WARN ${u.reason} — raw \`${u.raw}\``);
  }

  const ratioParts: string[] = [];
  for (const [fg, bg, threshold] of CONTRAST_PAIRS) {
    const f = opaque.get(fg);
    const b = opaque.get(bg);
    const ratio = f && b ? contrastRatio(f, b) : Number.NaN;
    const flagged = Number.isFinite(ratio) && ratio < threshold;
    ratioParts.push(`${fg}/${bg} ${Number.isFinite(ratio) ? ratio.toFixed(1) : "n/a"}${flagged ? "*" : ""}`);
    if (flagged) {
      findings.push({
        scheme,
        check: "contrast",
        message: `${fg}/${bg} ${ratio.toFixed(1)} — below ${threshold.toFixed(1)}`,
      });
    }
  }
  lines.push(`contrast      ${ratioParts.join("  ")}`);
  for (const f of findings.filter((f) => f.check === "contrast" && f.scheme === scheme)) {
    lines.push(`  WARN ${f.message}`);
  }

  const equal: string[] = [];
  for (const [a, b] of EQUALITY_PAIRS) {
    const ca = opaque.get(a);
    const cb = opaque.get(b);
    if (ca && cb && sameColor(ca, cb)) {
      equal.push(`\`${a}\` == \`${b}\` (both resolve to ${toHex(ca)})`);
    }
  }
  for (const e of equal) findings.push({ scheme, check: "equality", message: e });
  lines.push(`equality      ${equal.length === 0 ? "no suspicious duplicates" : equal.join("  ")}`);

  const plasmaBad: string[] = [];
  const plasma = extras?.plasma;
  if (plasma == null) {
    plasmaBad.push("plasma is missing");
  } else if (!Array.isArray(plasma) || plasma.length !== 3) {
    // SAFETY: this branch ran because Array.isArray(plasma) held.
    plasmaBad.push(`plasma has ${(plasma as unknown[]).length} stops, expected exactly 3`);
  }
  if (Array.isArray(plasma)) {
    plasma.forEach((stop, i) => {
      if (typeof stop !== "string" || !/^#[0-9a-f]{6}$/i.test(stop)) {
        plasmaBad.push(`stop ${i} \`${stop}\` is not a 6-digit hex`);
      }
    });
  }
  for (const p of plasmaBad) findings.push({ scheme, check: "plasma", message: p });
  lines.push(`plasma        ${plasmaBad.length === 0 ? "3/3 stops valid hex" : plasmaBad.join("  ")}`);

  return { lines, findings };
}

async function main(): Promise<void> {
  const report: string[] = [];

  try {
    const themesUrl = pathToFileURL(path.resolve(import.meta.dirname, "../app/theme/themes/index.ts")).href;
    const rolesUrl = pathToFileURL(path.resolve(import.meta.dirname, "../app/theme/roles.ts")).href;

    const themesMod = await import(themesUrl);
    const rolesMod = await import(rolesUrl);
    // SAFETY: the sources are this repo's own theme modules; their exports are
    // the contract this audit exists to check.
    const themes = themesMod.BUILT_IN_THEMES as readonly ThemeDefinition[];
    // SAFETY: same repo-owned module contract as above.
    const roles = rolesMod.THEME_ROLES as readonly string[];
    // SAFETY: same repo-owned module contract as above.
    const variables = rolesMod.THEME_VARIABLES as Record<string, string>;
    // SAFETY: same repo-owned module contract as above.
    const schemesOf = rolesMod.schemesOf as (theme: ThemeDefinition) => readonly ThemeScheme[];

    const varToRole = new Map<string, string>();
    for (const [role, variable] of Object.entries(variables)) varToRole.set(variable, role);

    const schemeCount = themes.reduce((n, t) => n + schemesOf(t).length, 0);
    report.push(
      `theme audit — ${themes.length} theme${themes.length === 1 ? "" : "s"}, ${schemeCount} scheme${schemeCount === 1 ? "" : "s"}, ${roles.length} roles each`,
    );
    report.push("");

    let totalFindings = 0;

    for (const theme of themes) {
      const themeFindings: Finding[] = [];
      const schemeBlocks: string[] = [];

      // Only the schemes the theme actually ships are audited. A fixed theme has
      // exactly one, and reporting a missing second scheme as a finding would be
      // flagging the feature rather than a fault.
      for (const scheme of schemesOf(theme)) {
        const colors = theme.colors[scheme];
        const extras = theme.extras[scheme];

        if (!colors) {
          themeFindings.push({ scheme, check: "completeness", message: `scheme \`${scheme}\` has no colours table` });
          schemeBlocks.push(`  ${scheme}`, `    completeness  NO COLOURS TABLE`);
          continue;
        }

        const audit = auditScheme(scheme, colors, roles, varToRole, extras);
        themeFindings.push(...audit.findings);
        schemeBlocks.push(`  ${scheme}`);
        for (const line of audit.lines) schemeBlocks.push(`    ${line}`);
      }

      // A fixed theme that shipped two tables, or an adaptive one that shipped
      // one, is a spec that doesn't mean what it says.
      const shipped = schemesOf(theme).length;
      const expected = theme.kind === "fixed" ? 1 : 2;
      if (shipped !== expected) {
        themeFindings.push({
          scheme: "-",
          check: "kind",
          message: `kind \`${theme.kind}\` expects ${expected} scheme(s), ships ${shipped}`,
        });
      }

      totalFindings += themeFindings.length;
      const result =
        themeFindings.length === 0
          ? "PASS"
          : `${themeFindings.length} finding${themeFindings.length === 1 ? "" : "s"}`;
      report.push(`theme "${theme.id}" (${theme.label}) — ${theme.kind}, designed ${theme.appearance}`);
      report.push(...schemeBlocks);
      for (const f of themeFindings.filter((f) => f.check === "kind")) {
        report.push(`  WARN ${f.message}`);
      }
      report.push(`  result: ${result}`);
      report.push("");
    }

    report.push(
      `TOTAL: ${totalFindings} finding${totalFindings === 1 ? "" : "s"} across ${themes.length} theme${themes.length === 1 ? "" : "s"}`,
    );
  } catch (err) {
    // SAFETY: module-load failures surface as Errors here.
    report.push(`could not load theme source: ${(err as Error).message}`);
    report.push("nothing audited — another thread may be mid-edit");
  }

  process.stdout.write(`${report.join("\n")}\n`);
  process.exitCode = 0;
}

await main();

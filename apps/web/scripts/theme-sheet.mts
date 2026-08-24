/**
 * Renders every shipped theme as a small mock of the app, so the palettes can be
 * looked at rather than only measured:
 *
 *   node --experimental-strip-types apps/web/scripts/theme-sheet.mts
 *
 * The audit script proves a theme is complete and legible. It cannot say whether
 * a theme is any good — whether the accent is spent well, whether folders and
 * files read as different kinds of thing, whether the whole card looks like one
 * designed room. That needs an eye, so this writes an HTML sheet and shoots it.
 *
 * Each card sets the full role table as inline custom properties on itself, the
 * same way the app sets them on the document, so relational roles composite here
 * exactly as they do in the running interface.
 */

import path from "node:path";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

// The app source imports its own modules with extensionless specifiers. Node's
// type stripper resolves exactly what it is given, so teach resolution to fall
// back to the `.ts` neighbour rather than re-implementing the source.
if (registerHooks) {
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

const appDir = path.resolve(import.meta.dirname, "../app/theme");
const rolesMod = await import(pathToFileURL(path.join(appDir, "roles.ts")).href);
const themesMod = await import(pathToFileURL(path.join(appDir, "themes/index.ts")).href);

const { THEME_VARIABLES, colorsFor, schemesOf, extrasFor } = rolesMod;
// SAFETY: themes/index.ts exports BUILT_IN_THEMES as a readonly ThemeDefinition[]
// array; the dynamic import erases it to any and this restores array-ness only.
const themes = themesMod.BUILT_IN_THEMES as readonly any[];

function vars(theme: any, scheme: string): string {
  const colors = colorsFor(theme, scheme);
  return Object.entries(
    // SAFETY: roles.ts declares THEME_VARIABLES as a literal role → "--property"
    // map; the dynamic import erases that to any, this restores the string values.
    THEME_VARIABLES as Record<string, string>,
  )
    .map(([role, name]) => `${name}:${colors[role]}`)
    .join(";");
}

/** One mock of the app, small enough that fifteen of them fit on a sheet. */
function card(theme: any, scheme: string): string {
  const extras = extrasFor(theme, scheme);
  const kind = theme.kind === "system" ? "default" : theme.kind;

  return `
<figure class="card">
  <figcaption>
    <b>${theme.label}</b>
    <span class="kind">${kind} &middot; ${scheme}</span>
    <span class="blurb">${theme.blurb ?? ""}</span>
  </figcaption>
  <div class="app" style="${vars(theme, scheme)}">
    <aside class="strip">
      <div class="orb"></div>
      <div class="row"><i class="folder"></i><span class="nm">src</span></div>
      <div class="row"><i class="folder"></i><span class="nm">theme</span></div>
      <div class="row sel"><i class="file"></i><span class="nm">build.ts</span></div>
      <div class="row"><i class="file"></i><span class="nm">roles.ts</span></div>
    </aside>
    <main class="main">
      <div class="head">
        <span class="h1">Changes</span>
        <span class="h2">4 files &middot; 2 minutes ago</span>
      </div>
      <div class="panel">
        <div class="frow">
          <i class="file"></i><span class="fn">ChangeCard.vue</span>
          <span class="ctx">app/components</span>
          <span class="add">+24</span><span class="del">&minus;9</span>
        </div>
        <div class="frow">
          <i class="file"></i><span class="fn">build.ts</span>
          <span class="ctx">app/theme</span>
          <span class="add">+6</span><span class="del">&minus;1</span>
        </div>
      </div>
      <div class="field"><span class="ph">Ask anything&hellip;</span><span class="chip">@build.ts</span></div>
      <div class="btns">
        <span class="b1">Commit</span>
        <span class="b2">Review</span>
        <span class="mark">match</span>
        <span class="dot ok"></span><span class="dot warn"></span><span class="dot danger"></span>
      </div>
      <div class="code"><span class="cs">const</span> theme = <span class="cn">build</span>(spec);</div>
      <div class="term">$ kone build<span class="cur"></span></div>
      <div class="plasma" style="background:linear-gradient(100deg, ${extras.plasma.join(", ")})"></div>
    </main>
  </div>
</figure>`;
}

const cards = themes
  .flatMap((theme) => schemesOf(theme).map((scheme: string) => card(theme, scheme)))
  .join("\n");

const html = `<!doctype html><meta charset="utf-8">
<style>
  @font-face { font-family: Geist; src: local("Geist"); }
  body { margin:0; padding:28px; background:#8a8a8e; font-family: Geist, ui-sans-serif, system-ui; }
  .sheet { display:grid; grid-template-columns:repeat(4, 1fr); gap:22px; }
  .card { margin:0; }
  figcaption { display:flex; flex-direction:column; gap:1px; padding:0 2px 7px; color:#fff; }
  figcaption b { font-size:13px; }
  .kind { font-size:10px; opacity:.75; }
  .blurb { font-size:10px; opacity:.6; line-height:1.35; height:26px; overflow:hidden; }
  .app { display:flex; height:236px; border-radius:9px; overflow:hidden; background:var(--ground); }

  .strip { width:92px; flex:none; background:var(--strip); padding:9px 7px; display:flex; flex-direction:column; gap:5px; }
  .orb { width:16px; height:16px; border-radius:50%; background:var(--agent); margin-bottom:3px; }
  .row { display:flex; align-items:center; gap:5px; padding:3px 4px; border-radius:4px; }
  .row.sel { background:var(--selected); }
  .folder, .file { width:8px; height:8px; border-radius:2px; flex:none; }
  .folder { background:var(--folder); }
  .file { background:var(--file); }
  .nm { font-size:9px; color:var(--ink-soft); white-space:nowrap; }

  .main { flex:1; padding:10px 11px; display:flex; flex-direction:column; gap:7px; min-width:0; }
  .head { display:flex; align-items:baseline; gap:6px; }
  .h1 { font-size:12px; color:var(--ink); }
  .h2 { font-size:9px; color:var(--muted); }

  .panel { background:var(--panel); border-radius:6px; padding:6px 7px; display:flex; flex-direction:column; gap:5px; }
  .frow { display:flex; align-items:center; gap:5px; font-size:9px; }
  .fn { color:var(--ink); }
  .ctx { color:var(--faint); flex:1; }
  .add { color:var(--diff-add); }
  .del { color:var(--diff-del); }

  .field { background:var(--field); border-radius:6px; padding:5px 7px; display:flex; align-items:center; gap:6px; }
  .ph { font-size:9px; color:var(--placeholder); flex:1; }
  .chip { font-size:8px; color:var(--ink-soft); background:var(--chip); border-radius:3px; padding:2px 4px; }

  .btns { display:flex; align-items:center; gap:5px; }
  .b1 { font-size:9px; background:var(--accent); color:var(--accent-ink); border-radius:4px; padding:3px 7px; }
  .b2 { font-size:9px; background:var(--accent-2); color:var(--accent-2-ink); border-radius:4px; padding:3px 7px; }
  .mark { font-size:9px; color:var(--ink); background:var(--highlight-wash); border-radius:3px; padding:2px 4px; }
  .dot { width:6px; height:6px; border-radius:50%; }
  .dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); } .dot.danger { background:var(--danger); }

  .code { background:var(--code-bg); border-radius:5px; padding:5px 7px; font-family:ui-monospace,Menlo,monospace; font-size:9px; color:var(--ink-soft); }
  .cs { color:var(--accent); } .cn { color:var(--accent-2); }
  .term { background:var(--term-bg); color:var(--term-ink); border-radius:5px; padding:5px 7px; font-family:ui-monospace,Menlo,monospace; font-size:9px; display:flex; align-items:center; gap:3px; }
  .cur { display:inline-block; width:4px; height:9px; background:var(--term-cursor); }
  .plasma { height:12px; border-radius:5px; margin-top:auto; }
</style>
<div class="sheet">${cards}</div>`;

const out = "/tmp/theme-sheet.html";
writeFileSync(out, html);
console.log(`${themes.length} themes, ${themes.reduce((n, t) => n + schemesOf(t).length, 0)} schemes -> ${out}`);

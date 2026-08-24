# Repo-wide Naming Conventions

Synthesized from five naming audits (agent-core, git-core+protocol, desktop-shell, web-components,
web-logic). Evidence tags: `[ac]` `[gp]` `[ds]` `[wc]` `[wl]`. These are the de-facto majority
conventions — follow them; don't invent new schemes. When in doubt, DON'T rename.

## Boundary contracts are immutable

Never rename anything crossing a process or wire boundary (rule 1 everywhere):

- IPC channel strings (`"git:*"`, `"agent:*"`, `"terminal:*"`, `"presets:*"`, …) and event names
  (`thread.sidechat-created`) `[ds] [gp]`
- The `[kone:KIND]` marker vocabulary and its machinery (`markKind`, `parseKind`) `[gp]`
- JSON wire fields parsed from provider CLIs/APIs (`TodoWritePayloadWire`, `"inProgress"`,
  `plan_text`, …) `[gp]`
- `window.koneDesktop.<group>.<verb>` bridge properties and their `desktop.d.ts` mirror;
  every IPC-crossing type's *field* names `[ds] [wl]`
- SQLite table/column names, userData-relative paths, env vars (`KONE_*`, `NUXT_*`),
  `kone:*` localStorage keys, `/api/*` route strings, electron-builder keys, turbo task names `[ds] [wl]`

If a name is load-bearing on both sides of a boundary, freeze it everywhere or nowhere — never
rename one layer alone. Every IPC-crossing type carries a mirror obligation to
`apps/web/app/types/desktop.d.ts` `[gp]`.

## Casing

- Files: camelCase for function/util/type modules, PascalCase when the primary export is a class
  (`TerminalManager.ts`, `AgentService.ts`, `adapters/*Adapter.ts`) `[ds] [ac]`
- Types: PascalCase, domain-prefixed (`Git*`, `GitHub*`, `Process*`, `PlanTask*`, `Agent*`);
  flat serializable shapes for anything IPC-crossing `[gp]`
- Constants: SCREAMING_SNAKE (`GIT_CONTRIBUTOR_CAP`, `CLONE_PHASES`) `[gp]`
- Provider slugs lowercase in paths (`opencodeHome.ts`); brand casing only inside identifiers
  (`OpenCode*`) `[ac]`
- Always `export type`; `interface` reserved for augmentable contracts (none currently needed) `[gp]`

## File names by kind

- **Util/pure module**: filename matches headline export (`clone.ts`→`clone()`,
  `sessionCost.ts`); multi-file domains get `<domain>/index.ts` barrels `[gp] [wl]`
- **Test**: `<subject>.test.ts`, colocated or at the package's test root; aspect suffix for
  partials (`conversationStore.touchPerf.test.ts`); never named after a nonexistent entity `[gp] [wl] [ac]`
- **Composable**: `use<Thing>.ts` MUST export a matching `function use<Thing>()`. Factories,
  helpers, type-only modules keep plain camelCase names even inside `composables/` `[wl]`
- **Vue component**: filename == full template tag minus nothing. In a `pathPrefix` feature folder
  prefer `Foo/FooBar.vue` so grep-by-tag finds the file; where the derived tag stutters
  (`ScratchpadPad…`), shorten instead of prefixing. Pick one style per folder — don't mix `[wc]`
- **Icons / vendor-mirroring assets**: exempt from domain prefixes; names track upstream catalogs `[wc]`
- **Server routes**: Nitro verb suffixes (`avatar.get.ts`); never encode verbs in the base name `[wl]`
- **Theme**: `themes/<id>.ts` where filename == theme id (lowercase); export `<ID>_THEME` `[wl]`
- **Package subpath exports**: kebab-case keys over camelCase files (`@kone/git-core/core.js`);
  consumers use subpaths, not bare roots `[gp]`

## Verbs

- `is`/`has` for predicates; `get` single item, `list` many; `parse` raw→typed;
  `build`/`format`/`mint` for construction/shaping; `reconcile` for convergence passes;
  `handle` for dispatch entry points; `on` reserved for event subscriptions `[gp] [wl] [ac]`
- Sync/async twins: `<op>` / `<op>Async` (`inspectSubprocessActivity(Async)`) `[gp]`
- Test hooks: `configureXForTests(hooks)` / `resetXForTests()` pairs `[gp]`
- Lifecycle pairs: `register<Domain>Ipc()` ↔ `shutdown<Thing>()` `[ds]`
- Skill/inventory-style verb-noun families are the exemplar for pure-logic modules `[ac]`
- Family members share a prefix (`useComposer*`, `padColors`/`padMarkdown`, `usageFormat`) —
  new siblings follow it `[wl]`

## Suffixes mean things

- `Store` = persistence; `Service` = stateful orchestration/lifecycle (sparingly);
  `Manager` = resource pool; `Adapter` = provider CLI bridge
- `ipc.ts` = IPC registration seam (`register<Domain>Ipc`, private idempotent `registered` flag,
  doc comment "Register the `<domain>:*` IPC handlers."); module trio `{index,ipc,types}.ts`,
  barrel re-exports registration fn + wire-facing types only `[ds]`
- `types.ts` = type-only module, scoped per domain folder; stop growing package-root `types.ts` `[ac]`
- `lib-*` (agent-core) / `lib/` (desktop) = pure, electron-free utils; deep-subpath import surface `[ac] [ds]`

## Forbidden

- Bare generic public exports: `run`, `exists` — name exports after what they ARE `[gp]`
- `use` prefix without an exported hook; test files named after phantom entities `[wl] [ac]`
- Singular/plural drift between folder, channels, and registration fns (`presets:*` ⇒
  `registerPresetsIpc`) `[ds]`
- Two names for one component (explicit-import local name ≠ derived tag); renaming a `.vue`
  file IS an API change — enumerate tag usages first; dedupe-preserving renames are free `[wc]`
- Renames that fight vendored conventions (`lib/utils.ts`=`cn`) or erase domain jargon
  (`lib/bloub/*`) `[wl] [wc]`
- Renaming one layer of a cross-boundary name; deleting/renaming compat aliases that share a
  name with bridge methods (e.g. `cancelClone`) — backlog items, not rename-pass material `[gp]`

## Discipline

Naming passes never move files between directories or split modules — group-level inconsistencies
(`toolOrbDraw.ts`, `thinkingOrb/`) go on a structural-pass backlog `[wl]`. Use `git mv`. Small,
confident diffs win; marginal candidates go on the REJECTED list, not into the diff.

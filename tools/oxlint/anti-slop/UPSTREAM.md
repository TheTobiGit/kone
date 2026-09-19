# Provenance

## Source

| | |
| --- | --- |
| Source | the `install-anti-slop` skill bundle at `~/.claude/skills/install-anti-slop/assets/anti-slop` |
| Revision | **unknown** — the bundle ships no commit, tag, or version marker. Files are dated 2026-09-18. |
| Installed at | `tools/oxlint/anti-slop`, registered in `.oxlintrc.json` as `anti-slop` |
| Dependencies | `oxlint` and `@oxlint/plugins`, both pinned to `1.79.0` (unchanged by this update) |

Because the bundle carries no revision, a future update cannot three-way merge
against it. Keep a pristine copy of the bundle if that matters more later than
it did here.

## History

### 2026-08-19 — first vendoring (`8750c77f`)

Fifteen generic rules plus the opt-in Effect plugin. Revision unknown; the local
fork described in `LOCAL-CHANGES.md` was already applied in that same commit, so
**no pristine base exists for it**.

### 2026-09-18 — update

A conservative port, not a three-way merge: with no recoverable base, each
incoming change was judged on its own behavior against the local behavior.

**Adopted whole** — every incoming change to the fourteen unforked rules, all of
it refactoring or strictly better analysis, and all of it verified to leave this
repo's finding count at zero:

- `resolveVariable` extracted to `shared/scope.ts`; parameter handling to
  `shared/function-parameters.ts`; alias resolution to
  `shared/type-alias-resolution.ts`, which is scope-aware where the old
  `aliases` map was flat and program-wide.
- `createTypeEnvironment` now takes `visitorKeys`, and built-in shadowing is
  resolved per use site rather than through one program-wide set.
- `no-runtime-typeof` exempts `typeof x === "undefined"` existence probes.
- `no-shape-in-symbol-names` exempts member names owned by another value.
- `no-unknown-parameters` exempts type-predicate subjects and now looks inside
  unions.
- `no-unsafe-dictionary-type` exempts type-parameter constraints.
- `require-safety-comment-for-type-assertion` takes a `markers` option and finds
  a justification written above an `export` wrapper.
- `no-known-value-widening` gains the type-predicate argument check.

**New, all registered at `error`:** `no-array-filter-map` (10 findings, left
unfixed), `no-reduce-accumulator-copy` (0), `require-readable-spacing` (18,653
findings, left unfixed) and its native companion `oxc/no-accumulating-spread`
(0). `require-readable-spacing` brings `vendor/eslint-stylistic/`; that
directory's own `UPSTREAM.md` and `LICENSE` travel with it.

**New but not registered:** four Effect rules (`no-manual-effect-error-tag`,
`no-manual-tag-comparison`, `no-manual-tagged-construction`,
`prefer-effect-match`). The Effect plugin stays opt-out — no package manifest
here declares `effect`.

**Local policy preserved:** all four changes in `LOCAL-CHANGES.md`, re-expressed
on the new code. See that file; the fourth one is where upstream now actively
disagrees.

**Nothing left pending.**

## Verification

`no-known-value-widening` was diffed against the pre-update rule across the whole
repo and on targeted probes: identical, 0 findings, with `Record<string, V>`
suppressed and `Record<"a" | "b", V>` reported in both. The other fourteen rules
also report 0. This repo's own code is the test evidence — the bundle ships no
tests, and none were written for this update.

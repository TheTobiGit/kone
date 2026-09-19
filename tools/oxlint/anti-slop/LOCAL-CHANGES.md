# Local changes to the vendored anti-slop plugin

This directory is a vendored copy. Everything here is upstream's except the
changes recorded below, which exist so the rules say something true about *this*
codebase. Re-vendoring means replaying these; nothing else has been touched.

All of it is confined to `no-known-value-widening` and the classifier it leans
on. The other seventeen generic rules and the five Effect rules are untouched —
verified by diffing the full per-rule finding table before and after, which
moved only this rule's number.

## `no-known-value-widening`: judge an annotation by every flow into it

Three of the four changes are the same defect. The rule reports per *flow* — one
declarator, one assignment, one `return` — but an annotation covers every flow
into it at once. Where the flows disagree, any single one is the wrong thing to
judge the annotation by, and the rule reported code that was already correct.

1. **Accumulators reached by name.** The rule already exempts
   `const table: Record<…> = {}` from the empty-object guard, then reported
   `return table` on the next line, because at the `return` the accumulator is an
   identifier rather than the `{}` it was declared with. `isEmptyObjectExpression`
   now follows the same stable-`const` chain the evidence walk already follows.

2. **Mutable bindings.** `let body: unknown = null`, reassigned from a JSON parse,
   was reported for the `null`. The annotation is there for the *other* write. A
   non-`const` declarator is no longer judged by its initializer, and the
   `AssignmentExpression` visitor — which could only ever fire on a `let` — is
   gone.

3. **Multi-path returns.** A function whose `catch` arm returns `null` while its
   `try` arm returns a parse result was reported for the `null`. A `return` is now
   only reported when *every* return in that function carries known evidence, so a
   function that genuinely returns one known shape is still caught.

## `no-known-value-widening`: dictionaries with an open key are out of scope

The fourth change is a policy narrowing, not a bug fix, and is the one to revisit
first if these rules are ever retuned. **Upstream now actively disagrees with it**
— see below.

A table annotated `Record<string, V>` and indexed with an arbitrary runtime string
cannot take the rule's own advice. Dropping the annotation for `satisfies` infers
an object with only the literal keys present, and every `table[key]` stops
compiling with TS7053 — measured, not assumed: 75 of 90 attempted conversions
failed that way. The evidence the rule wants to preserve is also unreachable,
since the consumer's key is not known at the call site, and `noUncheckedIndexedAccess`
is on, so the lookup already yields `V | undefined` — the safety the evidence
would have bought. A key that closes over a union of literals (`Record<Cue, V>`)
is a different matter and is still reported — those convert cleanly and 45 of
them did.

### How it is expressed now

It used to be a local `hasOpenDictionaryKey` in `shared/dictionary-types.ts`,
called from the rule to filter targets the classifier had already returned.
That helper is gone. Upstream has since grown its own key test — `isBroadMappedKey`,
reached through `hasBroadRecordKey` — and wired it into `classifyWideningTarget`
directly, so the predicate no longer needs a local implementation.

What upstream wired it up to do, however, is the **opposite** of this policy:
upstream reports `Record<string, V>` and spares `Record<Cue, V>`. The local change
is now three polarity flips against that, in `classifyWideningTarget` and its
alias-walking twin `classifyAliasBroadTarget`:

- `Record<…>` with a broad key → not a target (upstream: a target).
- an index-signature type literal → not a target (upstream: a target).
- a mapped type → a target only when its constraint is a closed union
  (upstream: always a target).

Measured on this repo at the time of the merge: upstream's polarity produces 69
findings, all of the unconvertible shape above; this one produces 0. The prose
reasoning lives next to `classifyWideningTarget`.

This is the change most likely to conflict again on the next update, and the
cheapest to reverse — flip the three branches back and delete the note.

## What is deliberately still reported

`MERGEABILITY`, `STATE_CHIP`, `VOICES` and `PRESETS` were once left reported and
are recorded here because the reasoning still applies to tables of that shape: a
table whose entries are not uniform, so `satisfies` infers a union of per-entry
literal types and uniform access breaks — TS7053 on the keys a partial table
lacks, TS2339 on members that ragged entries omit. Each was attempted and
reverted against the compiler. They were left reported rather than suppressed,
because a reader may well want to know these tables are partial or ragged.

Those four have since been resolved in the source; the rule reports nothing in
this repo today.

## Two new rules are vendored but registered `"off"`

`require-readable-spacing` and `no-array-filter-map` arrived with the 2026-09-18
update. Both are switched off in `.oxlintrc.json` rather than left out, so the
next update diffs cleanly against a config that lists every rule the plugin
ships.

Neither is a disagreement with the rule. Both report on code that predates them,
and enabling them as `error` turns `lint` red on files no current branch touches:

| Rule | Findings | Files |
| --- | --- | --- |
| `require-readable-spacing` | 18,996 | 890 |
| `no-array-filter-map` | 10 | 8 |

The spacing rule fixes whitespace only, so `--fix` can clear it in one pass; the
reason to wait is that the pass rewrites most of the repo and would land on top
of unreviewed work. `no-array-filter-map` is small enough to clear by hand, but
each site needs its callback ordering and filtering semantics preserved, which
is a code change per site rather than a mechanical one.

Turn each on in its own commit, together with the changes that make it pass.

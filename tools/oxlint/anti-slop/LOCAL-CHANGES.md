# Local changes to the vendored anti-slop plugin

This directory is a vendored copy. Everything here is upstream's except the
changes recorded below, which exist so the rules say something true about *this*
codebase. Re-vendoring means replaying these; nothing else has been touched.

All of it is confined to `no-known-value-widening` and the one helper it owns.
The other fourteen rules are untouched — verified by diffing the full per-rule
finding table before and after, which moved only this rule's number.

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
first if these rules are ever retuned.

A table annotated `Record<string, V>` and indexed with an arbitrary runtime string
cannot take the rule's own advice. Dropping the annotation for `satisfies` infers
an object with only the literal keys present, and every `table[key]` stops
compiling with TS7053 — measured, not assumed: 75 of 90 attempted conversions
failed that way. The evidence the rule wants to preserve is also unreachable,
since the consumer's key is not known at the call site, and `noUncheckedIndexedAccess`
is on, so the lookup already yields `V | undefined` — the safety the evidence
would have bought.

So `classifyWideningTarget` still classifies these, and the rule now filters them
via the new `hasOpenDictionaryKey` in `shared/dictionary-types.ts`. A key that
closes over a union of literals (`Record<Cue, V>`) is a different matter and is
still reported — those convert cleanly and 45 of them did.

`hasOpenDictionaryKey` is additive and used only here. It reuses upstream's own
`isBroadMappedKey`, which already drew this exact distinction for mapped types;
the direct `Record` path just never consulted it.

## What is deliberately still reported

Four findings survive, all one shape: a table whose entries are not uniform, so
`satisfies` infers a union of per-entry literal types and uniform access breaks.

- `MERGEABILITY`, `STATE_CHIP` — partial tables indexed by the full union
  (TS7053 on the absent keys).
- `VOICES`, `PRESETS` — entries that omit an optional member, so reading it fails
  with TS2339 on the members that lack it.

These were each attempted and reverted against the compiler. They are left
reported rather than suppressed, because a reader may well want to know these
tables are partial or ragged.

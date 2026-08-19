# fabrika config key groups

How `.fabrika.jsonc` is read: one load, one parse, one module per key, one registry line.

Lives in [`packages/fabrika-cli/src/config/`](../packages/fabrika-cli/src/config/). Repo-specific
values that used to be TypeScript literals become keys here, so an adopting repo is a data file
rather than a branch in fabrika's source (ADR 0273, epic
[#5631](https://github.com/kamp-us/phoenix/issues/5631)).

## The shape

| File | What it holds |
|---|---|
| `document.ts` | `CONFIG_PATH`, the comment stripper, and `readDocument` — the only place the bytes are parsed |
| `key-group.ts` | `KeyGroup<A>`, the four-arm `Resolution<A>`, `resolveKey`, and `register` |
| `keys/<key>.ts` | One key group: its key name, its shipped default, its decoder |
| `registry.ts` | One `register(...)` line per key group |
| `load.ts` | `loadConfig(source)` → a document every key resolves against, or a refusal; `resolveAll` for a reader over the whole registry |
| `source.ts` | `readConfigSource(dir)` — opens the file off a directory and reports which of the three arms it found |
| `working-root.ts` | `loadRepoConfig(cwd)` — the working-tree opener, for a verb running against the checkout it stands in |
| `containment.ts` | The triage-facet containment invariant, checked over declared data |
| `board.ts` | The board vocabulary's shape (`BoardVocabulary`, `StatusNames`) and how a facet's delete authority is composed from it — pure, so `triage/facets.ts` can build the shipped default off it |
| `resolve-board.ts` | `resolveBoard(load, shipped)` — joins `boardVocabulary` and `triageFacets` into one table and re-runs containment over the join |

Whoever opens the file says which of three things it found — `Absent`, `Text`, `Unreadable` — and
hands that to `loadConfig`. A key module never sees a file, only the parsed record.

## The four arms

Every key resolves to exactly one, and they stay apart in the type:

- **`Default`** — no file, or no key. The key's shipped default.
- **`Declared`** — the repo declared it and it decoded.
- **`Malformed`** — the value is present and refused **whole**, naming what was rejected. Never a
  skipped entry: a typo'd entry silently dropped is a declaration the operator believes is
  configured and is not.
- **`Unknown`** — the file exists and could not be read. Callers refuse. Never a default, never an
  empty set.

`Default` and `Unknown` are the pair the surface turns on. Collapsing them is how a settings file
silently disables a gate.

## Adding a key

1. Write `keys/<your-key>.ts`: export the key name, a `decode`, and a `KeyGroup<A>` with a
   `shippedDefault`.
2. Add one `register(yourKey)` line to `registry.ts`.
3. Add a `render` **only if** the decoded shape is not the shape a repo writes (see below).

Nothing else is touched. That is the point — concurrent slices each add a key without serializing
on one growing reader.

## Three rules a new key must hold

**A shipped default is never an empty gate list.** An empty list of governed roots or of required
labels reads as "nothing is governed" / "nothing is required" and turns the gate off. Pick the
value that reproduces today's behaviour, and make an explicitly-declared empty list `Malformed`
where empty would disable something. The widen-only keys are the exception and say so in their own
docblocks: for `capClearAuthors`, `docLeakExempt` and `workflowValidators`, empty **is** the strict
answer.

**A key whose value could disable or widen a guard is refused at load.** `refuseLoad` on a
`KeyGroup` refuses the whole load, before any key's value is used. Two keys use it, for the same
reason in two shapes: `governedRoots`, so a config whose roots do not cover `.fabrika.jsonc` cannot
un-govern itself; and `triageFacets`, so a config declaring a facet value the facet does not own
cannot reconcile an issue into a shape nobody asked for (#4285). A convention could not hold either
one, because the config is what the convention would be read from — and a check written at a call
site is a check the next verb forgets.

**Two keys that answer one question are joined in one module, not read apart.** `boardVocabulary`
says what each triage facet may *keep*; `triageFacets` says what it may *delete*. Read separately
they drift into #4285's shape — a declared lane no facet owns is written once and never superseded.
So `config/resolve-board.ts` composes them (ownership from `triageFacets` where a repo declared it,
else the shipped pattern if it still contains the declared values, else a set over exactly those
values) and re-runs the containment check over the join. Whoever adds a key that constrains another
key's values does the same: the join is the seat for a cross-key rule, because `refuseLoad` only
sees its own key.

**Roles, not positions.** `boardVocabulary`'s `statuses` is a record keyed by role
(`needsTriage`/`triaged`/…), not a five-entry array: a repo renaming `status:triaged` has to say
which status it renamed, and positional meaning is exactly the invalid state this package refuses to
represent. Lists are for facets where nothing needs to know which member is which.

**A key whose decoded shape is not the file's shape carries a `render`.** `status settings` answers
what a key resolves to so no skill document has to restate it, and a readout printing
`{"_tag":"User","login":"…"}` where the file says `"@…"` hands back this package's internal shape and
leaves the reader to reverse it. `render` is display only: `Registration.readout` applies it,
`Registration.resolve` does not, so a caller computing with a value never gets the display form.
`capClearAuthors` and `workflowValidators` carry one; a plain string array needs none.

## Reading a key at the working tree

A verb running against a base ref opens the bytes itself (`git show`) and hands `loadConfig` a
`Text`. A verb running against the checkout it stands in calls `loadRepoConfig(cwd)`, which finds the
repo root **above** `cwd` first: a config read only at the top level would resolve to the shipped
defaults for every run from a subdirectory, which is a silent widening nothing reports. Take the
`cwd` as an option off `command.ts` (`cwd: process.cwd()`) rather than reading it in the verb, so a
unit test can point the load at a scripted filesystem.

## A gate refuses on a config that never decoded

`loadConfig` answers `Config` for a file nobody could open, a file that is not a JSON object, and a
key whose value the decoder rejected — those arms live per key in `Resolution`, not on the `Load`,
because a caller reading one key has no business being stopped by another key's malformity. A gate
is the opposite case: it is about to write, and it needs *every* key it is judged against to have
decoded.

So a gate never reads `load._tag === "Config"` as "it loaded". It calls `unusableReason(load)`
(`config/unusable.ts`), which answers the one reason no value of this config may be used, or `null`.
Keying on the refusal alone is fail-open on exactly the inputs the surface exists to separate: the
first round of `triage`'s guard let an unreadable and a malformed config straight through to the
label write, with the containment check never run (#6292).

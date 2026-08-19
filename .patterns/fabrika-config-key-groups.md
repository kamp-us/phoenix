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
| `entries.ts` | The shared decoders every list key builds on — one place a list's element shape is read |
| `working-root.ts` | `loadRepoConfig(cwd)` — the working-tree opener, for a verb running against the checkout it stands in |
| `unusable.ts` | `unusableReason(load)` — the one reason no value of this config may be used, which is what a gate keys on instead of the refusal arm |
| `containment.ts` | The triage-facet containment invariant, checked over declared data |
| `board.ts` | The board vocabulary's shape (`BoardVocabulary`, `StatusNames`) and how a facet's delete authority is composed from it — pure, so `triage/facets.ts` can build the shipped default off it |
| `resolve-board.ts` | `resolveBoard(load, shipped)` — joins `boardVocabulary` and `triageFacets` into one table and re-runs containment over the join |
| `ci-producer.ts` | `producerFor(...)` — the "does this repo produce CI at all" rule `review ci` and `ship checks` both decide through, over a workflow count and `ci.noProducer` |
| `paths.ts` | One reader per path key off the working tree — the value, where it came from, and the refusal a verb prints verbatim |

A key read at a PR's **base ref** rather than the working tree opens the bytes through that
group's own platform reader and hands `loadConfig` a `Text` or an `Absent`. Read the policy at the
same ref as the artifact it governs, through the same reader, so the two cannot disagree.
`capClearAuthors` is the live instance: `build/clearances.ts` opens the bytes with `readFileAtRef`
at the base ref and hands them through `repo-config.ts` into `loadConfig`.

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

## Five rules a new key must hold

**A shipped default is never an empty gate list.** An empty list of governed roots or of required
labels reads as "nothing is governed" / "nothing is required" and turns the gate off. Pick the
value that reproduces today's behaviour, and make an explicitly-declared empty list `Malformed`
where empty would disable something. The widen-only keys are the exception and say so in their own
docblocks: for `capClearAuthors`, `docLeakExempt`, `workflowValidators` and `codeValidators`, empty
**is** the strict answer — the last because a list of commands a verb must run is not a gate's
scope: nothing to run refuses UNKNOWN, so an empty default withholds a verdict where a populated one
would have run another repo's script names and called the failure that repo's code (#6015).

`containmentVocabulary` is the other exception, and it is one on purpose: an explicitly-empty half
turns the containment marker off, because a repo with no deployment story has nothing to contain and
must be able to say so (R14.1, [#6300](https://github.com/kamp-us/phoenix/issues/6300)). The
distinction that keeps this from being the failure the rule guards against is *declared* versus
*absent* — an absent file or key still resolves to the shipped pair, so nobody turns the gate off by
writing no config. Any key that follows it owes the same split in its own docblock.

A shipped default may be **looser** than today's behaviour only on a founder ruling, and only
paired with a declaration that holds the strict value where the guard matters. No key takes that
shape today. `unreadableCodeowners` did (ADR
[0307](../.decisions/0307-unreadable-codeowners-is-per-repo.md)) and the founder reverted it on
#5631: a failed CODEOWNERS read is the caller's `11` in every repo again, and nothing reads the key.
The pairing was the whole permission — landing a loose default without the declaration is the
fail-open, so both land in one change or neither does.

**A key whose value could disable or widen a guard is refused at load.** `refuseLoad` on a
`KeyGroup` refuses the whole load, before any key's value is used. Two keys use it, for the same
reason in two shapes: `governedRoots`, so a config whose roots do not cover `.fabrika.jsonc` cannot
un-govern itself; and `triageFacets`, so a config declaring a facet value the facet does not own
cannot reconcile an issue into a shape nobody asked for (#4285). A convention could not hold either
one, because the config is what the convention would be read from — and a check written at a call
site is a check the next verb forgets.

Declaring `refuseLoad` also makes that key's own `Malformed` a load refusal, relayed in the
decoder's words: a value that did not decode leaves the key with nothing to check, and
`{"governedRoots": []}` un-governs the config exactly as `{"governedRoots": [".decisions/"]}` does
(#6314). The two document-level arms stay out of it — `Unknown` proves nothing about what the repo
declared, and a document that is not a JSON object already resolves *every* key `Malformed`, so
there is no weakened value to read off either one.

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
Four key groups carry one — `cap-clear-authors.ts`, `code-validators.ts`, `paths.ts` (for
`decisionsDir`, whose `Declined` renders `null`) and `workflow-validators.ts`; a plain string array
needs none.

## Reading a key at the working tree

A verb running against a base ref opens the bytes itself (`git show`) and hands `loadConfig` a
`Text`. A verb running against the checkout it stands in calls `loadRepoConfig(cwd)`, which finds the
repo root **above** `cwd` first: a config read only at the top level would resolve to the shipped
defaults for every run from a subdirectory, which is a silent widening nothing reports. Take the
`cwd` as an option off `command.ts` (`cwd: process.cwd()`) rather than reading it in the verb, so a
unit test can point the load at a scripted filesystem.

## A gate refuses on a config that never decoded

`loadConfig` answers `Config` for a file nobody could open, a file that is not a JSON object, and a
key whose value the decoder rejected *where that key carries no `refuseLoad`* — those arms live per
key in `Resolution`, not on the `Load`, because a caller reading one key has no business being
stopped by another key's malformity. The exception is the pair above: a `refuseLoad` key's own
`Malformed` does stop the load, because a key that can un-govern the config is one every caller is
stopped by on purpose. A gate is the opposite case: it is about to write, and it needs *every* key
it is judged against to have decoded.

So a gate never reads `load._tag === "Config"` as "it loaded". It calls `unusableReason(load)`
(`config/unusable.ts`), which answers the one reason no value of this config may be used, or `null`.
Keying on the refusal alone is fail-open on exactly the inputs the surface exists to separate: the
first round of `triage`'s guard let an unreadable and a malformed config straight through to the
label write, with the containment check never run (#6292).

## A key whose sub-keys answer one question is one module, not several

`ci` holds two: `noProducer` (what a repo with zero Actions workflows gets — `refuse | degrade`,
shipped `refuse`) and `gateWorkflow` (the filename fabrika names when it points at the gate that
supersedes an in-tree prediction). They are one key group because they are one question — *what may
fabrika assume about this repo's CI?* — and splitting them would put two registry lines and two
resolutions in front of every reader who needs both.

Two rules travel with it. **Existence is the whole test**: nothing opens a workflow or matches a job
name inside one, so no expected-job set exists to drift (#5603, R17.1). And **a shape the API cannot
address is refused, not repaired**: `gateWorkflow` takes a bare filename, so
`.github/workflows/ci.yml` is `Malformed` rather than silently basenamed — a declaration quietly
rewritten is one the operator believes is configured and is not.

## A path key, and the one path a repo may decline

The path surface — `governedRoots`, `decisionsDir`, `roadmapFile`, `cycleDoc`, `designHarness` — is
where a repo says which files fabrika reads by name (#6296). Three things hold across all of them.

**The shipped default is the string's one home, and the old literal re-exports it.**
`review/classes.ts`'s `DECISIONS_ROOT`, `plan/github.ts`'s `CYCLE_DOC_PATH`, `triage/roadmap.ts`'s
`ROADMAP_FILE` and `ui/conventions.ts`'s `HARNESS_PATH` are now `export {…} from` the key module, so
a caller that scaffolds the file and a caller that reads a repo's declared one cannot drift apart.

**A reader that could not read is not a reader that read nothing.** `config/paths.ts` gives every
path key a reader — `governedRootsOr`, `cycleDocOr`, `designHarnessOr`, `decisionsDirOr` and
`readRoadmapFile` — each answering the value plus a note naming where it came from, or the one
refusal sentence its callers print. `roadmapFile` is the exception to the shared sentence: it has no
`…Or` form, exposing the raw `Read` as `readRoadmapFile`, and its four callers word their own
refusal. The exit code stays each verb's; only the sentence is shared, so seven verbs cannot word the
same fault seven ways. `Malformed` and `Unknown` both refuse there: falling back to the shipped
default on a typo silently restores phoenix's own paths inside a repo that is not phoenix.

**Absent is not declined.** An absent key is "this repo said nothing" and resolves to the shipped
value; a *declined* key is "this repo has no such surface", and only `decisionsDir` can be declined,
by writing `null`. The asymmetry is the point: a repo with no decision corpus changes what
`governance` may conclude and what `adr` may write, so the absence has to be declared before those
verbs act on it — while `roadmapFile` and its siblings name files whose absence the filesystem
already reports, and a decline key there would be a second way to say what the tree says. Model the
declinable one as a two-arm type (`{_tag: "Path"} | {_tag: "Declined"}`), never a nullable string:
a `null` path is the shape that gets `?? ".decisions"`-ed back into the default the repo refused.

## An empty declared list is the caller's answer, not the decoder's

A repo may declare a key and declare it **empty**. That is well-formed data, so `decode` accepts it;
what it means is the caller's to say. `codeValidators` is the worked example — an empty list means
no code validator is present, and `build check --surface code` refuses UNKNOWN on it rather than
greening (nothing was checked) or redding (which claims the code failed, #6015). Deciding it in the
decoder would put one verb's vocabulary in the config module and leave every other reader of the key
stuck with it.

The caller owes the resolution arm in its message even when both arms carry the same empty value.
`build check` reads "declares an empty `codeValidators`" off `Declared` and "declares no
`codeValidators`" off `Default`, because the fix differs: one repo wrote the wrong thing and the
other wrote nothing.

## A key over a closed id set merges, and refuses an id it does not know

`surfaceDispositions` (#6301) is a record rather than a list: one entry per repo surface fabrika
reads, each `fail-loud | degrade | bootstrap`. Two rules make that shape safe.

**The registry is the shipped default, and a repo declares only what it moves.** A declared record is
merged over the shipped one, so `{"design-manifest": "degrade"}` resolves as that one change and
every other surface at its shipped disposition. Requiring the whole record instead would make a repo
restate thirty-odd values it does not care about, and every restated value is one that drifts.

**An id outside the registry is `Malformed`, not ignored.** `"desing-manifest": "degrade"` is a
disposition the operator believes is configured and is not, and nothing would ever say so — the same
failure the whole-value refusal above exists for, arriving through a key name instead of a value.
The registry is therefore closed and carries a one-line note per id saying what the surface is, so
the ids are readable without a second document.

**A note nothing prints is a note nobody reads.** The resolved value is an id-to-word map, which
tells a caller what happens and never what the surface *is* — so `status settings --surfaces` joins
the registry's notes to the resolved dispositions and prints one `surface` row each. The join lives
with the key (`surfaceNotes`), not in the verb, because the notes and the overrides are two halves
of one answer and neither is complete alone.

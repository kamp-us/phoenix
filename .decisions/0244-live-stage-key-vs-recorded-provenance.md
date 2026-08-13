---
id: 0244
title: a recorded row's stage key is provenance, never a pointer into `STAGES`
status: accepted
date: 2026-08-08
tags: [fabrika, eval, corpus, vocabulary]
---

# 0244 — a recorded row's stage key is provenance, never a pointer into `STAGES`

**What this decides:** the eval corpus has two different things spelled the same way — the *live*
stage name a command and a join key use, and the stage name a *recorded* row carries because that
is what actually produced it. The six v1 rows already in the corpus keep their original names
forever; the live vocabulary re-keys around them.

## Context

fabrika re-keys the pipeline's stage vocabulary (ADR
[0242](0242-fabrika-skill-nouns-redefine-build-and-review.md): `write-code` becomes `build`, the
`review-*` family collapses to `review`). The eval harness in
`packages/fabrika-cli/src/eval/` uses a stage name in two
unrelated jobs, and the re-key forced the difference into the open:

- **As a live key.** `STAGES` in `corpus.ts` is what
  `--stage` accepts (`command.ts` rejects anything
  else by name), what `CorpusManifest` groups entries under, and what
  `runner.ts`'s `collectFromCapture` joins a capture
  run to a corpus entry on.
- **As a record.** A committed corpus row's own `stage` field says which pipeline produced the
  labeled artifact. The module's README states the label is what the baseline *actually produced*,
  and three rows in `corpus/build.json` plus
  three in `corpus/review.json`
  are genuine v1 artifacts (issues/PRs #1223, #106, #1032, #1199, #1294, #1115).

Treating those as one thing gives two bad options. Retiring the rows throws away the only graded
ground truth the harness has. Re-keying them onto fabrika names republishes a v1 measurement as a
fabrika baseline — the "don't fake the baseline" no-go the epic's own pitch fences. The founder
ruled on [#4977](https://github.com/kamp-us/phoenix/issues/4977) (2026-08-09): recorded provenance
wins, old records keep their original stage keys. This entry is the durable record of that ruling
and of the four consequences it forces. The shape it describes is already on `main` — #4978 landed
the `write-code` → `build` re-key against it.

This decides a data-model question inside the harness. It does not re-open ADR 0242's naming, and
it does not touch ADR [0112](0112-token-measurement-no-quality-compromise-methodology.md)'s
corpus-curation discipline — "append, never mutate a pinned entry's recorded expectation" is
exactly the rule this entry extends from a row's `label` to a row's `stage`. Nor does it soften ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md): a retired stage name kept in fabrika's own
schema is *data about* v1, not a call into v1 code, and v1 stays deletable with these rows in place.

## Decision

**A stage name means one of two different things depending on where it sits: in `STAGES`, a
manifest group key, `--stage`, or a capture run it is a live key; in a committed corpus row's own
`stage` field it is recorded provenance — what ran — and is never resolved against the live set.**

### 1. The rule a reader applies to a row this record never saw

Read the row's position, not its spelling.

- **The group key it is filed under is live.** `CorpusManifest.stages` has exactly the `STAGES`
  members as keys. A group key always names a stage that exists now.
- **The row's own `stage` field is provenance.** It answers "which pipeline produced this label",
  and it is frozen at the moment the row was recorded.
- The two coincide for everything measured from now on, and diverge only where the vocabulary moved
  under an already-recorded row.

So: a group key may be looked up in `STAGES`; a row's `stage` may not. A row whose `stage` is not a
member of `STAGES` is not corrupt — it is a record of a pipeline that no longer exists.

### 2. The six recorded v1 rows are kept, at their original keys

All six stay. None is retired, none is re-keyed.

The three rows in `corpus/build.json` remain `"stage": "write-code"` while sitting under the live
`build` group — `corpus.ts` admits that by giving the retired name its own schema member
(`RecordedWriteCodeEntry`, the same label shape as `build`), and the `build` group's value schema
is the union of the live entry and that recorded one. Carrying the rule in the schema rather than
in prose is ADR [0241](0241-wire-formats-owned-by-schema-modules.md)'s ownership law applied here:
"nothing new may be filed under a dead key" is a decode-time fact, not a paragraph someone must
remember. `corpus.data.unit.test.ts` asserts the three keys are still `write-code`, so a
well-meaning later re-key reds instead of landing silently.

**How a reader tells a v1-produced row from a fabrika-produced one.** By the row's `stage` field,
under one rule and one honest limit:

- **Rule.** A row whose `stage` is absent from `STAGES` is v1-produced. A row whose `stage` equals
  its live group key is produced by the pipeline that owns that key today. Nothing may ever be
  filed under a recorded-only key again — those schema members exist to decode history, not to
  accept new rows.
- **Limit.** Where a v1 name and a live name are still the same word, the key cannot discriminate.
  That is the case today for the three `review-code` rows: `review-code` is both what recorded them
  and a current `STAGES` member, so they read as ordinary live-key rows. This record does not
  pretend otherwise. The discrimination appears the moment the vocabulary diverges — when a later
  change retires `review-code` from `STAGES`, those rows keep the name and it becomes a
  recorded-only key exactly like `write-code`.

**Binding constraints.**
- A retired stage name that any committed row carries gets its own `Recorded*Entry` schema member,
  admitted only inside the live group that succeeded it.
- A recorded row's `stage` is never rewritten. It is frozen like its `label` (ADR 0112 §1 growth
  rule).
- New rows are filed under a live key only.

**Banned.**
- Re-keying a recorded v1 row onto a fabrika stage name.
- Resolving a row's own `stage` against `STAGES` in any consumer.

### 3. A retained row does *not* occupy a live stage key

A retired name is carried **outside** the stage vocabulary. `write-code` is absent from `STAGES`;
`--stage write-code` is rejected by name (`isStageName` tests membership in `STAGES`); it survives
only as the `Schema.Literal("write-code")` inside `RecordedWriteCodeEntry`.

So the answer to "may a retained row's old stage name reappear in `STAGES`" is **no**. Putting it
back would make `--stage write-code` runnable and would re-admit new rows under a dead pipeline's
name, which is the relabelling this whole ruling exists to prevent.

### 4. The capture join: a capture manifest's stage is a live key, and re-keying it is the migration

A capture manifest is not a record of provenance. `CaptureRun.stage` is typed
`Schema.Literals([...STAGES])`, and `collectFromCapture` skips any run whose `stage` is not the
live stage being collected, then joins to the corpus entry by `inputRef` within that group. The
stage field there is join material by construction; the run's provenance lives in the corpus row it
joins to, never in the capture manifest.

A capture manifest recorded outside the repo under an old name therefore does **worse** than fail
to join: `decodeCaptureManifest` returns a `schema-mismatch` failure, because the old name is no
longer an admissible `CaptureRun.stage` literal.

**What an operator holding one does.** Re-key that manifest's `stage` field, per run, to the live
successor (`write-code` → `build`). That is the whole migration, and it is safe precisely because
the field was never provenance. No tool ships to do it — the edit is one field per run, and a
manifest small enough to hand-edit is not worth a migrator. Two boundaries:

- `inputRef` is untouched by any re-key, so a re-keyed manifest joins to the same corpus rows it
  always did.
- If an old stage name has **no** live successor, the manifest is **re-record-only**: there is
  nothing to point it at, and inventing a target would fabricate a join.

### 5. `incident-corpus/` is out of scope

`incident-corpus/` — `evals.json`,
`provenance.json`, `ruled-keeps.json` — is a separate body of ground truth, decoded by
`skill-eval-set.ts` / `incident-provenance.ts`, and carries **no stage key at all**. Where v1 skill
names appear in it they are the *subject* of a recorded incident, not a key anything dispatches on.

**Nothing in this record applies to it.** A later reader must not extend this ruling — or a future
re-key of `STAGES` — to those files.

## Consequences

- The harness carries a name that is not in its own live vocabulary, forever. That is the intended
  cost: the alternative is a corpus that lies about who produced its numbers.
- `corpus.ts` grows one schema member per retired-but-recorded stage name. Each is dead weight for
  new writes and load-bearing for decoding history; the union member is what keeps "nothing new may
  be filed here" a type-level fact rather than a convention.
- **The per-stage minimum-entry and seed assertions in
  `corpus.data.unit.test.ts` are
  undisturbed by this ruling, and that is a consequence of keeping the rows.** Those assertions
  require ≥3 entries in each of the `triage` / `build` / `review-code` groups and the presence of
  the ADR 0112 §1 seed `inputRef`s (#1227, #1223, #1199). Because nothing is retired and `inputRef`
  never changes under a re-key, every count and every seed still holds — a re-key alone can never
  red them. Two things still can, and are the forcing constraints an implementing child inherits:
  retiring any row drops a group below its minimum (or removes a seed) and **must** amend that test
  in the same change, and renaming a manifest file breaks the test's exact
  `["build.json", "review.json", "triage.json"]` filename list.
- The test now also pins the ruling itself: it asserts `build.json`'s three rows are still keyed
  `write-code`. A future re-key attempt fails CI rather than quietly republishing a v1 measurement.
- Consumers get a small standing obligation: never resolve a row's `stage` against `STAGES`. Only
  `runner.ts` and the scorecard join today, and both key on the live stage.
- Where a v1 name is still live (`review-code`), the six rows are not fully self-identifying yet.
  That resolves itself at the next re-key rather than needing a marker field now; adding a
  provenance flag to every row to solve a two-name overlap would be a schema change paid by every
  future row.

## Records

Closes [#4977](https://github.com/kamp-us/phoenix/issues/4977). Unblocks
[#4978](https://github.com/kamp-us/phoenix/issues/4978) (landed) and shapes
[#4979](https://github.com/kamp-us/phoenix/issues/4979).

**Vocabulary impact.** Two terms are coined here and routed to
[`.glossary/TERMS.md`](../.glossary/TERMS.md) via a filed `report`:

- **live stage key** — a member of `STAGES`: what `--stage` accepts, what a corpus manifest groups
  under, and what a capture run joins on. Not a recorded row's own `stage`.
- **recorded provenance (stage)** — a committed corpus row's own `stage` field: which pipeline
  actually produced the labeled artifact, frozen at record time. Not a pointer into `STAGES`, and
  never re-keyed.

## Amendment (2026-08-09, #5082) — two stale corpus filenames corrected

This entry was written against a corpus layout that had already changed. ADR 0243 collapsed the
review stage to one key with a `surface` discriminator and renamed the manifest
`corpus/review-code.json` to `corpus/review.json`; that landed on `main` a couple of hours before
this entry did, which still carried the old filename in two places:

- the link under "As a record.", which pointed at a path that no longer exists — a dead link that
  reds the repo-wide `doc-links` gate on every pull request that runs it;
- the `["build.json", "review-code.json", "triage.json"]` filename list under Consequences, which
  described `corpus.data.unit.test.ts`'s exact-filename assertion inaccurately — that test asserts
  `["build.json", "review.json", "triage.json"]`.

Both now read `review.json`. **No decision or reasoning changed** — only two stale filenames. The
ruling this entry records stands exactly as written: recorded provenance wins, and the old rows
keep their original `review-code` stage keys, which is why `review-code` still appears throughout
this entry as a recorded stage key.

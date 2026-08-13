---
id: 0253
title: the eval record is an `eval`-namespaced PR comment, and a run that returns no verdict is a counted `NoVerdict`
status: accepted
date: 2026-08-10
tags: [fabrika, eval, wire, contracts]
---

# 0253 — the eval record is an `eval`-namespaced PR comment, and a run that returns no verdict is a counted `NoVerdict`

**What this decides:** the three things [#4678](https://github.com/kamp-us/phoenix/issues/4678)
requires its downstream children to depend on and never names. The head-bound eval result is a **PR
comment**, never a committed file; its marker namespace is **`eval`**, its own root and its own wire
format; and *"a grader invocation that returns no verdict"* is a `NoVerdict` outcome over a closed
four-reason vocabulary that stays in the denominator, never passes, and is counted in its own field.

## Context

#4678's Amendment 1 moved the graded axis out of CI and into the `review` stage, so the answer no
longer returns into a CI job — it has to be *left behind*, bound to the exact commit the review ran
against, for [#4681](https://github.com/kamp-us/phoenix/issues/4681)'s gate to verify and
[#4680](https://github.com/kamp-us/phoenix/issues/4680)'s scorecard to source. Three facts that
record depends on are absent from the spec, and
[#4769](https://github.com/kamp-us/phoenix/issues/4769) verified each one at the issue body:

- **The namespace is unnamed.** The amended criteria say the record reuses the SHA-bound verdict
  shape *"in its own namespace"* and never say what that namespace is. A namespace that exists only
  as the phrase "its own" is a string #4681's gate must match and nobody wrote down.
- **The storage location is unstated.** Amendment 1 calls the result an "artifact" without saying
  whether it is a PR comment or a committed file. The two give #4680 completely different work —
  parse-and-commit versus read-a-committed-file — and `missing` is only definable relative to a
  location.
- **"Returns no verdict" has no referent.** Both the original spec and the amendment require the
  condition be *"a typed, counted outcome"* with a unit test against it, and neither says what the
  condition is or what the type is called. A timeout, unparseable output and no output at all are
  three different failures, and a required test against an undefined condition passes against
  whatever the implementer decided it meant.

Each absence would be filled silently by whoever codes #4678 first. That is the same
unpinned-wire-format shape already filed as [#4759](https://github.com/kamp-us/phoenix/issues/4759):
a gate that reds or greens on a string match nobody pinned.

**Grounded in shipped fabrika code, not in the issue prose.** The verdict marker this record reuses
is real and readable at
[`packages/fabrika-cli/src/wire/verdict-marker.ts`](../packages/fabrika-cli/src/wire/verdict-marker.ts):
namespace, polarity, `@ <sha>`, trailing clause, with `bindToHead` answering
`Current | Stale | Unbindable`. Its namespace class is `/^(review|check-epic-plan|governance)(-[a-z0-9]+)*$/`
and its own docblock records *why* each addition is a root and not a `review-<gate>` member — a
verdict wearing another gate's namespace is the family confusion the partition ruling removed
([#4891](https://github.com/kamp-us/phoenix/issues/4891)). The scorecard cell the record feeds is
`ScorecardCell` in `packages/fabrika-cli/src/eval/report.ts`,
carrying `stage`, `surface`, `model`, `gradedRuns`, `passedRuns`, `passRate`. Both were read at head.

This is engineering's lane: the eval harness is pipeline infrastructure, which ADR
[0078](0078-product-driven-decisions-by-default.md) puts with engineering, and the same delegation
that produced ADR [0252](0252-grading-chain-dispersion-and-decline-criterion.md) covers it.

**What this record does not re-open.** ADR 0252 defines `dispersion` and the decline criterion and
is untouched here — its arithmetic, its `runs` / `passed` carriage and its observe-only sequencing
are reused verbatim. ADR [0243](0243-review-eval-stage-surface-discriminator.md)'s `(stage, surface)`
cell key is the identity this record carries, unchanged. ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md) and ADR
[0251](0251-shared-formats-are-pinned-not-reimplemented.md) decide the v1 relationship: the shape is
re-implemented in fabrika, v1's contract is prior art, and no call crosses.

## Decision

### 1. The namespace is `eval` — its own root, its own wire format

The marker's namespace string is the literal **`eval`**. It is a root, not a `review-<x>` member, and
it belongs to a **new schema module** — `packages/fabrika-cli/src/wire/eval-record.ts` plus one
registry row, on ADR [0241](0241-wire-formats-owned-by-schema-modules.md)'s standing terms
(`emit` / `read` / `check`, a total read of `Found` / `Absent` / `Malformed`). `verdict-marker.ts`
is **not** widened to admit it.

Three reasons, in the order they carry weight:

- **A `review-*` namespace is a merge verdict by construction.** `ship gate` resolves a conjunction
  over required namespaces and raises the required set from the diff itself. An eval record filed
  under the review root is one `--require` away from being a gate verdict nobody meant to grant, and
  a skill-diff PR is exactly the diff that derives review namespaces. Under `eval`, the verdict
  marker's reader answers `Absent` on the record's first line — it does not *reach* for a review
  namespace — so no verdict scan can ever mistake the two.
- **The precedent already in the format says roots, not members.** `check-epic-plan` and
  `governance` are roots for the reason `verdict-marker.ts` writes down. The eval record answers a
  different question from any review gate — *what did the graded set measure at this head* — so it
  is a fourth family, not a fifth review member.
- **It carries a payload a marker line cannot hold.** Per-run verdicts, dispersion, and the
  model / CLI / harness pins do not fit in four fields. That is a second format, and ADR 0241 says a
  second format is a sibling module and a row, never a branch inside an existing one.

**This is still reuse, not a second head-binding mechanism**, which is what #4678's amended criterion
asks for. The record's first line is the §VERDICT grammar in shape and in field order — namespace,
outcome token, `@ <sha>`, `—`, clause — read by the same stepwise walk, bound by the same
`Current | Stale | Unbindable` relation, resolved latest-in-force-wins exactly as the verdict marker
already is. What is reused is the binding; what is new is the payload beneath it.

### 2. The outcome token is `RECORDED | UNRECORDABLE`, never `PASS | FAIL`

```
eval: RECORDED @ 03135b91 — review/skill 0.95 (19/20 runs, dispersion 1)
```

The second token is **not** a polarity, and this is the one place the record deliberately departs
from the verdict marker's vocabulary.

- **`RECORDED`** — a measurement exists. Whatever the number is. A below-bar run is `RECORDED` with a
  below-bar rate; it never withholds the record.
- **`UNRECORDABLE`** — the graded axis could not produce a measurement at all. The payload carries
  the reason.

A `PASS | FAIL` polarity would have to mean *pass against what*, and the only candidate is the 90%
bar — which #4678 puts explicitly out of its own scope and #4681 owns. Spelling the record with a
polarity smuggles that gate back into the module that must not hold it, and it makes "the number is
bad" indistinguishable from "the run died".

**This adds a fourth state to #4678's three, on purpose.** The verifier in #4681 now discriminates
`missing` (no eval record at this PR), `stale` (a record bound to a head that has moved),
`below-bar` (a `RECORDED` record whose rate is under the bar) and `unrecordable` (a `RECORDED`
measurement was never made). The alternative is folding `UNRECORDABLE` into a `0.0` pass rate, which
publishes a measurement that was never taken — the zero-scope green ADR
[0092](0092-gates-fail-closed-on-zero-scope.md) forbids — or into `missing`, which is a lie about a
record that is right there.

### 3. The record is a PR comment on the pull request under review

Not a committed file, and not a row inside a committed scorecard.

- **Committing self-invalidates the binding.** The record binds the head the review ran against.
  Writing it into the tree moves that head, so the record is stale the instant it lands. There is no
  ordering of commit-then-bind that escapes this.
- **The reviewer does not push.** The `review` stage has no write authority over the author's
  branch; that separation is the split-role firewall, not an implementation gap.
- **The resolver already exists for comments and does not exist for files.** In-force resolution —
  head-bound first, then by write stamp, ACL-gated fail-closed (ADR
  [0055](0055-acl-sourced-review-authz.md)) — is defined over PR comments. A committed file has no
  latest-wins rule, no author gate, and no natural staleness read.
- **One comment per `(head, cell)`.** A `(stage, surface, model)` cell is what a pass rate measures
  (ADR 0243 §4), so a review that grades two surfaces leaves two records. A re-run at the same head
  posts again and the latest in-force record wins, by the same rule the verdict marker uses.

**This settles #4680 as parse-and-commit.** The committed scorecard at
`claude-plugins/fabrika/reports/eval/<date>.json` (ADR 0252 §3) is the downstream, aggregated
artifact: #4680 reads these comments and commits rows derived from them. It does not read a
committed per-run file, because there is none.

### 4. A run that returns no verdict is a `NoVerdict`, over four reasons

The typed tag is **`NoVerdict`**, carrying a `reason` from a closed vocabulary:

| `reason` | what happened |
|---|---|
| `no-output` | the invocation returned and produced nothing to read |
| `unparseable` | output is present and no verdict can be extracted from it |
| `timed-out` | the invocation did not return within its budget |
| `invocation-failed` | the invocation never produced output — spawn, transport, quota, cancellation |

The four are distinguished because they are four different repairs. Collapsing them gives an
operator one number and no lead.

**The counting rule, which is the half the spec actually turns on:**

- A `NoVerdict` run **stays in `runs`**. It is a run that happened.
- It is **not counted in `passed`**, so it can never default to a pass.
- It is counted in its own integer, **`noVerdict`**, so a 3-of-5 median pass with two dead
  invocations is legible as a different fact from a 3-of-5 with two honest fails. Without that
  field the median is the same number over two very different situations.
- **It is never retried inside the five.** A retry replaces a measurement with a re-measurement and
  silently changes what the median measured. If the harness wants a retry policy it belongs around
  the whole five-run block, recorded as such, and it is not decided here.
- **All five `NoVerdict` ⇒ the record's token is `UNRECORDABLE`**, not a `0.0` rate (§2).

ADR 0252's `dispersion = min(passed, runs − passed)` is unchanged and still computed from the five
per-run outcomes, with a `NoVerdict` sitting on the non-pass side. That is a reading of 0252, not an
edit to it.

### 5. The payload's field inventory

The module owns the exact bytes (ADR 0241); this record fixes the inventory and the spellings, so
two consumers cannot invent two names for one thing.

Below the marker line, one fenced JSON object:

```json
{
  "sha": "03135b91",
  "recordedAt": "2026-08-10T04:08:00Z",
  "cell": {"stage": "review", "surface": "skill", "model": "<model id>"},
  "pins": {"model": "<model id>", "cli": "<cli version>", "harness": "<harness version>"},
  "gradedRuns": 20,
  "passedRuns": 19,
  "passRate": 0.95,
  "cases": [
    {
      "caseId": "<case id>",
      "verdict": "pass",
      "runs": 5,
      "passed": 3,
      "noVerdict": 1,
      "dispersion": 2,
      "perRun": ["pass", "fail", "pass", "no-verdict:timed-out", "pass"]
    }
  ]
}
```

**The two levels use two spellings on purpose, and neither is a drift.** `gradedRuns` / `passedRuns`
/ `passRate` are the *cell* aggregate and are spelled to match `ScorecardCell` at head, so #4680
commits a row without renaming anything. `runs` / `passed` / `dispersion` are the *case* block and
are spelled to match ADR 0252 §1, which defines them over one case's five runs. A reader can
re-derive every aggregate from the case blocks, which is 0252's own rule that a stored aggregate
whose inputs are absent is a number nobody can check.

`pins` carries #4637 ruling 4's model + CLI + harness triple. `recordedAt` is the spelling ADR 0252
§3 already named for the scorecard's date pin — one word for one thing across both artifacts.

**Binding constraints.**

- The eval record's namespace is `eval`; it is a root and never a `review-*` member.
- It is a sibling wire-format module plus one registry row, with a total read; `verdict-marker.ts` is
  not widened.
- The outcome token is `RECORDED | UNRECORDABLE`. The 90% bar is read by #4681's gate and by nothing
  in the record.
- The record lives in a PR comment, one per `(head, cell)`, latest in-force wins.
- A `NoVerdict` run stays in the denominator, never counts as passed, is counted in `noVerdict`, and
  is not retried inside the five.
- Cell-level fields are spelled as `ScorecardCell`; case-level fields are spelled as ADR 0252 §1.

**Banned.**

- A `PASS` / `FAIL` polarity on the eval record.
- Filing the record under a `review-*` namespace, or teaching the verdict marker to read it.
- Committing the per-run record to the tree, or folding it into the scorecard file.
- Reporting a `0.0` pass rate for a set that produced no measurement.
- Dropping a `NoVerdict` run from `runs`, or spelling one cell-level field two ways.

## Consequences

**Easier.** #4681 has a string to match and a location to look in, so its gate is a comparison rather
than a guess. #4680's work is settled as parse-and-commit against a named field inventory. #4678's
required unit test now has something to test: four named reasons, a denominator rule, and a token
that is not a polarity.

**Harder.** The eval record costs a schema module, a golden fixture and a registry row rather than a
reuse of `verdict-marker.ts` — ADR 0241's standing price, paid here because the payload genuinely
does not fit the marker's four fields. And #4681 now discriminates four states rather than three.

**The `eval` root is claimed here and stays out of the verdict family.** A future author who wants a
gate verdict about evals gets a `review-*` namespace for it; the `eval` root is the measurement, not
the judgement. Nothing about that split is enforced by a type, so it is written down instead.

**The issue bodies still say what they said.** This ADR is the source. Amending #4678, #4680 and
#4681 to cite it is a separate write, already tracked by
[#5258](https://github.com/kamp-us/phoenix/issues/5258) alongside the same residue ADR 0252 left; a
builder who reads only the issue body will not find this file until that lands.

**The most likely thing here to change** is the `NoVerdict` reason vocabulary, if a fifth failure
mode shows up in a real run. It is closed on purpose — a fifth reason is a decode failure and a
recorded change, not a silent widening.

## Records

- Closes [#4769](https://github.com/kamp-us/phoenix/issues/4769) (`type:decision`, fabrika campaign),
  which enumerated the three absences and deliberately proposed no values for them.
- Extends ADR [0241](0241-wire-formats-owned-by-schema-modules.md) (a new format is a module and a
  row) and ADR [0252](0252-grading-chain-dispersion-and-decline-criterion.md) (whose `dispersion`
  arithmetic and `runs` / `passed` carriage are reused unchanged). Applies ADR
  [0243](0243-review-eval-stage-surface-discriminator.md)'s `(stage, surface)` cell key and ADR
  [0058](0058-sha-bound-verdict-contract.md)'s head binding. Contradicts none of them; no ADR's
  status line moves.
- **Vocabulary impact: one term coined — `eval record`.** The head-bound PR comment a `review` run
  leaves behind carrying one graded cell's measurement. It is *not* a gate verdict, *not* a committed
  scorecard, and *not* a corpus row. Routed to [`.glossary/TERMS.md`](../.glossary/TERMS.md) through
  the glossary path via a follow-up report rather than inline, on ADR 0243's precedent, so this PR
  stays additive and the term gets its `Not` column.

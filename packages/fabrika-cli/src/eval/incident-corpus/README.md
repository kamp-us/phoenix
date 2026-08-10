# How an incident becomes an eval case

This directory is the **incident corpus**: the committed, growing set of incident-derived eval
cases that fabrika's regression floor is measured against. The floor is 100% — every case here
must pass, always — and the founder's ruling on
[#4637](https://github.com/kamp-us/phoenix/issues/4637) says it **grows**: every new incident
becomes a case within days. This page is how you do that, so the floor grows by rule rather than
by whoever remembers.

Three files hold the corpus:

- `evals.json` — the cases, in the `/skill-creator` authoring format, decoded by
  [`../skill-eval-set.ts`](../skill-eval-set.ts). No field is added to that format here.
- `provenance.json` — the sidecar that binds each case to the artifact it pins, decoded by
  [`../incident-provenance.ts`](../incident-provenance.ts).
- `ruled-keeps.json` — the enumeration of the incidents ruled into the feedstock, decoded by
  [`../ruled-keeps.ts`](../ruled-keeps.ts) and printed by `fabrika eval keeps`.

## What makes an incident a case

Three things, all of them checkable by someone who was not there:

1. **It happened.** An incident is admitted only against a real artifact — an issue, a PR, a
   commit, or a posted verdict. A remembered incident is not an incident. If you cannot cite it,
   record it under `declined` with that as the reason.
2. **It has a reproduction.** You can state the input the pipeline saw and the wrong answer it
   gave. An incident whose mechanism is still unknown is an investigation, not a case.
3. **It would be missed again.** The corpus exists for defects the natural guard cannot see —
   a failure that presents as a **plausible value rather than an error**, so "did it succeed? is
   it non-empty? did it match?" all read green. That class has its home at
   [#4482](https://github.com/kamp-us/phoenix/issues/4482), and most of this corpus is members of
   it.

An incident that fails any of the three is not silently dropped. It goes in `declined` with the
reason, so the omission is visible and reversible.

### And a fourth: it has to be observable in something a run produced

Harness and platform breakages are **not** eval material. Ruled on
[#4824](https://github.com/kamp-us/phoenix/issues/4824) and recorded as ADR
[0257](../../../../../.decisions/0257-platform-incidents-enter-only-as-artifact-checks.md):

> An incident is eval-bar material iff the failing behaviour is observable in an artifact a skill or
> CLI run produces (a verdict, an exit status, a written file) — such cases enter at the
> **deterministic CLI tier only**, never as spawn-a-skill graded cases; incidents whose failing
> behaviour lives in platform mechanics the harness cannot stage (merge-queue semantics, worktree
> provisioning, cache reuse, CI check arming) are **out of the eval bar** and route to CI guards /
> regression tests instead.

Where a platform failure was followed by an **agent's response**, the case is written about the
response and never about the breakage that triggered it — "the merge queue wedged" is not a case, "the
shipper discharged its guards by hand" is the candidate — and it is still admitted only on the test
above. Apply the rule **per row as you author**; the "~22 harness/platform items" figure in the sweep
report is a candidate from one read-only pass, not a bucket to trust.

The tier does the enforcing for you. `deriveTier` returns `graded` for any case with a judgment
assertion, so if you cannot word a platform-originated case's expectations mechanically, that derived
`graded` is the signal the incident is **out of scope** — not a licence to file it graded. Decline it
with the reason and route it to a CI guard or a regression test.

This does not widen milestone #44's completion condition: "the #4637-B bar green at 1.0 scope" means
1.0 over the corpus admissible under this rule. Origin of the question:
[#4634](https://github.com/kamp-us/phoenix/issues/4634) calibration flag 6; the enumeration that scopes
it: [#4823](https://github.com/kamp-us/phoenix/issues/4823).

## Who authors it, and when

The agent or seat that **resolved** the incident writes the case — the diagnosis is at its
sharpest the moment it lands, and a case written a week later is written from the ticket rather
than from the failure. The ruled expectation is **days, not sprints**: an incident closed today
should carry its case before the week is out.

If the incident is one of the ruled KEEP issues, **read `ruled-keeps.json`** — or run
`fabrika eval keeps incident-corpus/ruled-keeps.json`, which prints each row with the eval cases
that already pin it. The corpus is **66 members plus 1 pending** — the pending row is
[#4180](https://github.com/kamp-us/phoenix/issues/4180), whose sweep verdict the
[#4642](https://github.com/kamp-us/phoenix/issues/4642) ruling retracted and never replaced. Cite
the enumeration in the case's `verification`.

Do **not** re-run the two-artifact join by hand. That join — a `KEEP-AS-EVAL` row on the
[#4634](https://github.com/kamp-us/phoenix/issues/4634) verdict table **and** absence from the
153-issue kill list in the #4642 ruling — is now recorded once, as `ruled-keeps.json`'s
`derivation`, which is also where the arithmetic behind the corrected figure lives. #4642 published
the size as 74; that double-counts the 7 borderline items, which carry `KEEP-AS-EVAL` rows and were
never outside the set. The enumerated figure is 66 ([#4823](https://github.com/kamp-us/phoenix/issues/4823)).

## Adding a case

1. **Append the case to `evals.json`** with the next free integer `id`, the prompt that puts a
   skill in front of the incident, and its `expectations` — the verifiable statements a grader or
   a CLI check reads.
2. **Write the assertions at the deterministic tier if you can.** A case is deterministic when
   every one of its expectations names an observable: an exit status, a file artifact, a content
   match on stdout or stderr, or which script ran. That tier runs once, with no model, so the
   growing corpus stays cheap enough to run on every change. The tier is **derived** from the
   assertions by `deriveTier` — you do not declare it in `evals.json`, you earn it by how you word
   the expectation.
3. **Append the matching entry to `provenance.json`**: the incidents it pins as `#NNNN`
   citations, how you verified each, and the tier. If the case is graded, `tierRationale` is
   required — state what observable does not exist, not that grading felt easier.
4. **Run the data test.** `incident-corpus.data.unit.test.ts` decodes both files, checks the two
   id sets agree, and checks the derived tier against the declared one. A malformed case cannot
   land.

## Correcting a case

Incidents get re-diagnosed, and the re-diagnosis is often worth more than the original entry.
Case 11 was first recorded as an instrumentation artifact and corrected the same night to a live
code defect: a fail-closed guard returning success under a non-default `IFS`
([#4675](https://github.com/kamp-us/phoenix/issues/4675) comment 5153283658). The lesson
generalises — **a symptom that disappears when you clean your environment has not been shown to be
your environment's fault.** It may be a latent defect your environment merely exposed.

So a correction is **appended, never substituted**: add an entry to the case's `corrections` with
the date, the artifact that carries the retraction, and what it retracts. The original claim stays
where it is. A ledger that quietly rewrites its own history teaches nothing about how the first
reading went wrong.

## What this corpus does not decide

Where these cases run, and what happens when one fails, belong elsewhere: the unattended runner is
[#4676](https://github.com/kamp-us/phoenix/issues/4676), the deterministic tier
[#4677](https://github.com/kamp-us/phoenix/issues/4677), the graded axis
[#4678](https://github.com/kamp-us/phoenix/issues/4678), and the merge gate
[#4681](https://github.com/kamp-us/phoenix/issues/4681). No case here depends on a parked defect
being fixed — a case pins the incident's reproduction, and it keeps pinning it whether or not the
underlying ticket is ever worked.

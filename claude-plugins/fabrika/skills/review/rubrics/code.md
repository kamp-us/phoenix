# Code rubric — the `review-code` namespace

Applied to the code-class slice of the diff. The verdict is conjunctive and default-deny: one
miss, or one ambiguity the diff cannot resolve, is a FAIL — never an "it's-probably-fine" pass.

## What CI already answers — expect, never recompute

Typecheck, lint, unit tests, secret scan, leak scan and unresolved-thread accounting are required
CI gates on every PR. Read them structurally (`fabrika review ci`) and refuse to conclude over an
incomplete enumeration; do not re-run them — a local re-run can hand you another worktree's cached
green (#4106), and a second answer to an enforced question can contradict the gate (v1's ADR 0067
in-worktree-authoritative posture is deliberately not carried; the brief's scope rule wins).

## Per-criterion verification

One row per acceptance criterion, graded against the diff and the CI-at-head facts:

- **Evidence, not vibes.** Each `[PASS]` row cites the file and lines that satisfy the criterion;
  each `[FAIL]` row states what is missing or wrong, specifically enough to repair from.
- A criterion the diff cannot evidence either way is `[FAIL]` with the ambiguity named — the
  conjunctive verdict never carries an unresolved row as a pass.
- `[N/A]` only on positively-established non-obligation, never as "could not tell".

## Standing checks (judgement CI cannot make)

- **Test honesty.** A changed or deleted pre-existing test/assertion is a §DEV class-6 flag; a
  test rewritten to assert the implementation against itself proves nothing — treat the covered
  behavior as untested.
- **Release containment.** New user-facing behavior states its containment (flag-gated, exempt,
  or none) and the diff matches the statement; a new default-on surface with no stated containment
  is a finding.
- **Comment discipline.** Comments earn their place or die: a load-bearing note states a
  constraint the code cannot show; separators, name-restaters, and narration of obvious control
  flow are findings, not style preferences (the repo's CLAUDE.md comment law).
- **Staleness traps.** Session/state caching across a boundary that can move underneath it
  (heads, tokens, label sets) is a finding when nothing re-validates.

## Behavior claims

A diff-level claim about runtime behavior that the criterion turns on ("this retries", "this is
atomic") must be traceable to the code read — not inferred from names. State what you read; a
claim you could not ground is an ambiguity, and ambiguity fails.

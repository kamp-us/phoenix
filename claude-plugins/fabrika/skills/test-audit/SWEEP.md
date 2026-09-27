<!--
Adapted from the whole-subsystem guide in OpenClaw's test-audit skill
(https://github.com/openclaw/openclaw/tree/80930af448eb/.agents/skills/test-audit),
MIT License, Copyright (c) 2026 OpenClaw Foundation. See LICENSE-OPENCLAW.
Changes: the mode is renamed "subsystem sweep"; OpenClaw's examples, runner
APIs and review process are replaced with repository-neutral text; the sweep
is bounded to one ticket and one pull request, with outside work routed to
fabrika's report skill.
-->

# Subsystem sweep

A subsystem sweep prunes one subsystem's whole test surface, such as one plugin
or one core area, as the work of one ticket that lands as one pull request. The
value bar, retention bar, candidate evidence and validation in
[SKILL.md](SKILL.md) apply to every slice. This file adds the order of work.
Each step ends on its completion criterion; do not start the next step early.

Anything the sweep finds outside its ticket, including product bugs it does not
fix, leaves through [`report`](../report/SKILL.md) as a follow-up issue.

## 1. Baseline

Record the subsystem's test and support line counts and every test file's
pass/fail state at a pinned default-branch commit. Keep baseline failures in
their own list: a failing test is as likely to be a real product bug as a stale
test.

Done when every in-scope test file has a recorded baseline result.

## 2. Slices and inventory

Split the surface into **slices** along production owner boundaries, not file
prefixes: for example inbound handling, outbound delivery, persistence,
transport, shared helpers and the test harness. Include the subsystem's cases at
shared core boundaries and its end-to-end or live-proof harness tests.

Done when every test file and end-to-end scenario the subsystem owns belongs to
exactly one slice.

## 3. Read-only marks per slice

Give each slice to its own read-only pass. It reads every assigned test in full,
including parameter tables, and the production owners with their entry points,
callers, history and CI routing. Each test declaration gets one mark and an
evidence line. A parameterized test is one declaration unless its rows need
different marks; then mark each row.

- `R`: retain, naming the contract and the bug it catches; a retained test that
  only moves to a better-named file stays `R` with the move noted;
- `F`: retain the contract but repair the assertion, such as a vacuous negative
  that passes when only one of several items is missing;
- `C`: consolidate, naming the owner that absorbs the assertion first: a sibling
  table case, a stronger boundary suite, or the shared owner in another package;
- `D`: delete, naming the proof that remains, or why no contract exists.

Judge a test by its assertions, not its name: a test named for clearing some
state may assert that the state was _not_ cleared.

Done when every declaration in the slice has a mark and an evidence line.

## 4. Layer plan per slice

Treat the marks as input, not as the edit list. A second read-only pass,
starting from the marks, looks for the redundant **layer**: for example several
suites replaying one shared helper through the same mock, around a stronger
suite that drives the real boundary. Name the **keeper** suite for each
contract. Prefer the real transport boundary with a fake network over a mocked
collaborator. Correct any marks this pass finds wrong.

Done when each slice plan names its retired files, its keeper per contract, the
assertions to carry into keepers, and the test-only production seams unlocked.

## 5. Cutover

Edit slice by slice. Serialize changes to shared harnesses and support files
through one owner. With each slice, remove the test-only production seams it
unlocks: injection parameters, getters, reset exports and indirection layers.
Register moved suites wherever the repository routes tests to CI or keeps a test
inventory or size baseline.

Done when every slice plan is applied and each slice's keepers pass.

## 6. Preservation check

Before claiming completion, have independent read-only passes compare deleted
coverage against the keepers, one per boundary group. They look for contracts
that lost their only proof, and for new assertions that cannot fail, such as a
rejection row the production code never reaches. This check comes before the
pull request opens; it does not replace the repository's review gate.

For each restored contract, make one deliberate **mutation** of the production
owner and confirm the keeper goes red. Then restore the source byte for byte.

Done when every reported gap is restored or rejected with source evidence, and
every restored contract has a caught mutation.

## 7. Product defects

A baseline failure that survives into a keeper is a product bug. Fix it inside
the sweep only when the ticket covers it; otherwise file it through
[`report`](../report/SKILL.md), naming the failing keeper, and leave the keeper
marked as a known failure the way the repository marks one. A fix the ticket
covers is proved through the real user flow, with a **control** run that
reverts the fix and shows the old behavior.

Done when each baseline failure is either fixed with a failing control and a
passing candidate on the same harness, or filed as a follow-up.

## 8. Reconcile and hand off

A sweep can outlive many default-branch commits. When the default branch
modified a file the sweep deleted, keep the deletion, port the new contract
into the keeper, and confirm every new regression the default branch added
still has a home. Rerun the whole subsystem suite on the reconciled head.

Hand off with the [SKILL.md](SKILL.md) report, plus:

- baseline and final test/support line counts, with production counted separately;
- slices, retired layers and keepers;
- preservation gaps found and their mutations;
- product defects fixed, with control and candidate proof, and the ones filed.

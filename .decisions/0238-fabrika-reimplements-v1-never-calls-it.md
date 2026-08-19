---
id: 0238
title: fabrika re-implements v1's deterministic work rather than calling it, keeping v1 deletable
status: accepted
date: 2026-08-01
tags: [fabrika, pipeline, tooling, architecture]
---

# 0238 — fabrika re-implements v1's deterministic work rather than calling it, keeping v1 deletable

**What this decides:** No fabrika skill and no fabrika verb runs any v1 code. Where the old pipeline
already solves part of a problem, a fabrika session reads that code to learn how it behaves and what
it got wrong, then writes fabrika's own version. Duplicating the work is the price we accept for
being able to delete the old pipeline later.

## Context

fabrika is the agent pipeline rebuilt from first principles ([#4648](https://github.com/kamp-us/phoenix/issues/4648)),
with v1 — `claude-plugins/kampus-pipeline/` and `packages/pipeline-cli/` — as the frozen comparison
baseline. Until now the stated posture was that fabrika **may call** `pipeline-cli` but never grows
into it.

The wave-0 pilot ([#4704](https://github.com/kamp-us/phoenix/issues/4704) /
[#4724](https://github.com/kamp-us/phoenix/pull/4724)) showed that posture does not survive contact.
Two forces pushed it:

- **The harness leaves no legal way to call it.** `cli-invocation-guard` reds a bare `pipeline-cli`
  inside a runnable fence anywhere under `claude-plugins/`, and the canonical fix it suggests —
  `PCLI="${CLAUDE_PLUGIN_ROOT:-…}"` — is exactly the variable expansion the fabrika skill conventions
  forbid, because the isolation verifier refuses a variable-rooted command (ADR
  [0232](0232-agents-execute-skill-scripts-never-source-them.md)). Verified both directions: the
  guard is clean without the call, and re-introducing it reds.
- **Wrapping to get around that multiplies.** The pilot needed two wrapper verbs whose only job was
  relaying an upstream answer, out of seven verbs for one skill. Nineteen skills on the same pattern
  rebuild `pipeline-cli` inside fabrika by accretion — the precise outcome "never grows into it" was
  written to prevent, arrived at without anyone choosing it.

The deeper problem is the one that decides it. A fabrika that calls v1 can never be the thing that
replaces v1, because every call keeps the old tree alive. The corpus already fails the deletion test
this way and nobody had noticed.

## Decision

**No fabrika skill and no fabrika verb invokes `pipeline-cli` or anything else under
`claude-plugins/kampus-pipeline/`; fabrika implements what it needs in its own verb package.**

Where v1 already solves the same problem, a session reads its source for two things — the semantics,
and **the scars it carries** — and then specifies fabrika's own implementation. A scar recorded in an
old implementation is the cheapest thing a rebuild can inherit, and it is the only thing worth
inheriting. The pilot carried two out of `adr-sweep`: it exits non-zero on its own informative case,
and its `--json` payload goes to stderr leaving stdout empty ([#4723](https://github.com/kamp-us/phoenix/issues/4723)).
fabrika's contract designs both out rather than reproducing them.

**Not every v1 capability becomes a fabrika verb — some become nothing.** Where a thing is already
*enforced* elsewhere, fabrika does not compute a second answer to it. The pilot dropped its
`adr classify` verb on this test: `cp-classify` decides control-plane membership at the merge gate,
that gate is the authority, and a fabrika copy of the guard vocabulary could tell an author
"ordinary" while the gate says "control-plane". Two answers to a merge-gating question are worse than
either a dependency or a drifted heuristic. The skill states the expectation instead and leaves the
verdict where it is enforced.

**Binding constraints.**
- No fence in a fabrika `SKILL.md` invokes anything outside fabrika's own verb package.
- A derived contract names no v1 verb as a dependency; a spec clause that defers to one has derived
  nothing.
- An authoring brief's prior-art field lists code **to read**, never verbs to call.
- Where a question is already decided by a gate, fabrika expects the answer and does not recompute it.

**Banned.**
- Wrapper verbs whose only behaviour is relaying an upstream answer.
- Duplicating anything whose answer gates a merge.

This supersedes the "fabrika may call `pipeline-cli` but never grows into it" line in the fabrika
README, which is amended by the same change.

## Consequences

Fabrika gets a second implementation of some deterministic work, and during the transition the two
can disagree. That is bounded and one-directional: fabrika's becomes the authority as each skill
lands, and v1's is frozen. It is a real cost — the pilot's `adr sweep` now owes a lexical/rarity
ranking that already exists a few directories away.

In exchange, v1 becomes deletable. That is the whole point, and it does not come in degrees: one
remaining call is enough to block the removal.

Worth stating so nobody over-reads this: **it does not make `packages/pipeline-cli/` removable
today.** Thirty-one CI workflows invoke that package directly, independent of any skill — it is the
guard and enforcement layer, not merely v1's skill tooling. This decision makes the v1 *skills*
deletable once fabrika replaces them; retiring the package is a separate and larger question that
this ADR does not answer.

## Records

Recorded on the wave-0 pilot ([#4704](https://github.com/kamp-us/phoenix/issues/4704)), landed with
[#4724](https://github.com/kamp-us/phoenix/pull/4724). Encoded for future sessions in three places a
fresh authoring run actually reads: rule 6 of the fabrika CLI interface convention, the fabrika
README's absent-list, and field 4 of the authoring-brief contract, which becomes prior-art-to-read
rather than verbs-to-call. The eighteen unfired briefs
([#4705](https://github.com/kamp-us/phoenix/issues/4705)–[#4722](https://github.com/kamp-us/phoenix/issues/4722))
were amended to match, which is the amendment path their own sequencing note anticipated.

No vocabulary impact — "the deletion test" is already the canonical term in
[`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md) and this decision applies it rather than coining
anything.

> Amendment 2026-08-19: the caveat is discharged. The v1 skills are deleted (ADR [0303](0303-retire-kampus-pipeline-plugin.md)), all 34 guards run on `packages/fabrika-cli/`, and `packages/pipeline-cli/` was removed by PR #6326 — there is no v1 code left to call. The rule itself stands: fabrika implements its own deterministic work and calls no v1 code.

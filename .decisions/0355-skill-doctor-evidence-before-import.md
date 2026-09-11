---
id: 0355
title: Skill Doctor evaluation evidence ships separately from its gated production import
status: proposed
date: 2026-09-06
tags: [fabrika, skills, benchmarks, privacy, agents]
---

# 0355 — Skill Doctor evaluation evidence ships separately from its gated production import

**What this decides:** the sanitized Skill Doctor evaluation and its OpenCode adapter stay
reviewable as their own evidence change, while the production import proceeds under the
founder-approved epic sequence on #8035 — packaged import first, collector next — with the
report fabrika-branded and internal by default, external sharing deferred to a later ruling
rather than a v1 gate, and discussion-level support for importing still approving no
implementation choice.

## Context

[Discussion #7319](https://github.com/kamp-us/phoenix/discussions/7319) pitched the Warp Skill
Doctor (MIT, [`warpdotdev/common-skills`](https://github.com/warpdotdev/common-skills)) as a
benchmark for fabrika's skills, and a maintainer supported importing it because its license is
MIT. A local-only experiment then imported the skill byte-exact (upstream @ `0254cbe9`, re-synced
to `b811c243`), ran its unmodified pipeline over 2 real opencode sessions through a translation
shim, and returned a **revise-before-import** verdict: five blockers, filed and since triaged as
the epic [#8035](https://github.com/kamp-us/phoenix/issues/8035). The sanitized evidence — docs
plus the adapter — is up for review as draft PR
[#8037](https://github.com/kamp-us/phoenix/pull/8037).

Since filing, the founder recorded the ruling this ADR transcribes. The pitch-approval comment
on #8035 ([2026-09-05, comment
5555033755](https://github.com/kamp-us/phoenix/issues/8035#issuecomment-5555033755)) approves
the epic on `axis:pipeline-hardening`, rules blocker 3 — **the report is fabrika-branded and
internal by default; a share posture is a later child, not a v1 gate** — and accepts triage's
read that the local `.claude/skills` misattribution risk earns no child. The grilling session
([#8046](https://github.com/kamp-us/phoenix/issues/8046)) then found the frontier clear — no
`decision` question stood open — and the plan landed approved (`plan-approved` @ `b7be5100`,
`check-epic-plan` PASS) with seven children, [#8048](https://github.com/kamp-us/phoenix/issues/8048)
through [#8054](https://github.com/kamp-us/phoenix/issues/8054), the epic build-claimed and
executing. Per [0300](0300-a-cited-ruling-makes-a-decision-buildable.md), that recorded comment
is what makes this transcription buildable: the ruling is cited here and transcribed, not
re-decided.

Evidence honesty is part of the record here. The verification claims travel with exact scopes:
the upstream test suites pass 25/25 **under `PYTHONUTF8=1`**, which does not prove native Windows
encoding is fixed — the portability child owns that exposure. The **B+ (overall 0.88) grade over
2 sessions** demonstrates the pipeline executes end to end; it is not a validated measurement of
grading quality, and the sessions came from a translation shim, not a first-party collector.

## Decision

**The Skill Doctor evaluation ships as reviewable evidence on its own change; the production
import proceeds as the founder-approved epic sequence on #8035 — packaged import first, collector
next — with the report fabrika-branded and internal by default, and external sharing deferred to
the share-posture child rather than gated into v1; support for importing on discussion #7319
approves the direction only — no implementation choice.**

**Binding constraints.**

- The evidence change carries only sanitized docs and the OpenCode adapter shim. Real
  transcripts, census inventories, rendered reports, and the import candidate never enter it;
  machine-local artifacts stay under the ignored `results/` tree.
- Evidence claims keep their scopes attached: `PYTHONUTF8=1` qualifies the test result; "pipeline
  executes" — not "grading validated" — qualifies the B+ run. The calibration child
  (#8053) owns the rerun over at least 20 real sessions and its published readout; no grade is
  quoted past the 2-session floor before it lands, and a calibration pass is evidence the corpus
  was measured, not proof of grading validity.
- Upstream rubrics and scorers stay byte-exact; every deviation lands as a ledgered,
  child-scoped change — #8048 authors the fabrika routing `SKILL.md`, #8049 adds the collector,
  #8050 carries the portability patch, #8051 the corpus discovery — with the provenance ledger
  and pinned upstream commit binding throughout. Re-sync means re-copy from the pinned source,
  never silent in-place edits.
- This ADR transcribes the founder ruling it cites; the report share posture remains the
  `ready-for:human` child (#8054), and its own ADR is transcribed the same way when that ruling
  is recorded.

**Execution sequencing ruled on #8035** (`plan-approved` @ `b7be5100`, `check-epic-plan` PASS,
7 children):

- **#8048 — packaged import.** Byte-exact upstream vendor, fabrika-shaped `SKILL.md` and
  contract, upstream unittest suites wired into a **new Python CI job** (grilling R1.1: no
  Python exists at `origin/main` today, and "Node over Python" does not reach vendored MIT code;
  R1.2: `skill-lint` binds the whole `claude-plugins/` corpus, with reasoned
  `SELF_EXEMPT_SUFFIXES` rows as the sanctioned escape for protected files).
- **#8049 — opencode collector**, shaped like the upstream ones; the PoC's adapter shim is the
  shape reference, not the deliverable.
- **#8050 — portability**: UTF-8 reads, a portable scratch dir, per-OS interpreter.
- **#8051 — skills-corpus discovery** with no flag.
- **#8052 — report fabrika-branded and internal by default** (the ruled blocker-3 posture).
- **#8053 — calibration** over at least 20 real sessions, readout published.
- **#8054 — share posture**, recorded as an ADR; `ready-for:human`.

## Alternatives considered

- **One PR carrying evidence plus the import** — rejected: it couples a finished,
  decision-free artifact to import implementation, and merging under review pressure is exactly
  how "support for importing" silently becomes "approved every implementation choice". The
  founder's ruling has since resolved the sequence, and the separation still earns its keep:
  [#8037](https://github.com/kamp-us/phoenix/pull/8037) reviews and merges on its own while the
  landing children run.
- **Import PR first, evidence attached as context** — rejected at proposal time because #8035
  carried no rulings and the import could not be built
  ([0300](0300-a-cited-ruling-makes-a-decision-buildable.md) fences agent-built decision work
  without a cited ruling comment); the recorded ruling removed that fence, and the approved epic
  sequence is the ruled form of "import first".
- **No ADR — the issue and PR bodies carry the split** — rejected: the separation rule and the
  evidence-claim wording are rulings a future session would otherwise re-derive or soften; the
  scope of what may ship, and with which caveats attached, is exactly the kind of settled
  preference that earns a record.

## Consequences

Reviewers can grade the evidence on its own merits without an import decision riding on the same
diff, and the import no longer waits on this ADR: the epic's children carry it, each scoped and
ruled. The cost is three surfaces moving at once — the evidence PR, this ADR, and the landing
children — and the evidence docs must track the epic rather than the filing-time state, upkeep
this revision itself models. The privacy posture stays discipline-enforced, not gate-enforced:
the `results/` ignore rules and the sanitization checks that ran before publication are
conventions a future session must re-apply by hand — a gap of the same shape
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md) accepted for its own citation fence,
not a fence this ADR extends. This ADR itself is `proposed`: if maintainers reject the split, it
retires and the corpus records whatever posture the epic lands instead.

## Open rulings (explicitly not decided here)

Rulings recorded on #8035 and transcribed above: the epic's sequencing, the report's
fabrika-branded, internal-by-default posture with share as a later child, and no ctx-* child.
Still open, and deliberately out of this ADR's scope:

- **Report share posture** — its own child, [#8054](https://github.com/kamp-us/phoenix/issues/8054),
  `ready-for:human`. The deferral is the ruling; the posture itself is not yet ruled.
- The content-ingestion trust posture stays an unruled founder call on
  [#4859](https://github.com/kamp-us/phoenix/issues/4859); the epic's children declare what the
  skill reads and stop there.

## Records

no vocabulary impact

---
id: 0379
title: Architecture audits preserve findings in a grilling session before selected work is filed
status: accepted
date: 2026-09-10
tags: [fabrika, architecture-audit, human-selection]
---

# 0379 — Architecture audits preserve findings in a grilling session before selected work is filed

**What this decides:** Each audit preserves its research in a grilling session, which works through
one human choice at a time. Only selected scopes become actionable reports.

## Context

ADR [0371](0371-audit-findings-gated-by-founder-pick.md) makes the human's pick the filing authority,
requires a ranked table as the handoff, and discards unpicked findings after the run. The first
Fabrika CLI audit returned seven findings across eight columns, then a smell table. The founder
asked for short, one-at-a-time discussion. A screenshot failure also needed an explanation of the
visual-review workflow before its implementation fault made sense.

The founder then proposed ending research by starting a grilling session whose initial GitHub issue
contains all the findings. A later reply settled reruns: every new audit opens a fresh session linked
to the previous one, keeping each run's evidence intact. This changes more than presentation. The
research now survives the conversation, while the human still chooses every actionable scope.

Agreement that an explanation was clear must not become permission to file. The founder separately
requested immediate triage after each selected report. That request authorizes this session's
handoff, not every future audit's triage mutations. The founder also rejected treating cleanup as
low-value merely because a census was missing. Competing examples and obsolete paths cost agent
attention; a census can be part of a bounded migration-and-removal task.

This amends the audit-output clauses of 0371 and
[0099](0099-glossary-surface-audit-skill-emits-issues.md). The founder's
[dated authorization](https://github.com/kamp-us/phoenix/issues/8868#issuecomment-5614236277)
identifies the reviewed draft and records the instruction: "i think i want it to finish with
starting a new grilling session + it's initial grilling gh issue should include all the findings
from audit." The [implementation issue](https://github.com/kamp-us/phoenix/issues/8868) specifies
fresh reruns and same-run recovery. The amendment preserves the human filing pick and prior history.

## Decision

**An architecture audit with unresolved findings creates a grilling session whose initial body holds
all consolidated findings, then works through human choices before filing actionable work.**

The session preserves scope, revision, every consolidated finding, evidence, uncertainty, ranking,
existing ownership and coverage limits. Agent recommendations are labeled as recommendations.
Grilling's existing ruling mechanism records human decisions; the initial body grants none. Include
already-owned or uncertain findings with their dispositions. A disproven suspicion receives a brief
explanation, not a new work item. Evidence accounting distinguishes files inspected from search
reach and unexamined areas; lens agreement does not prove exhaustive coverage.

The chat opens with a short orientation and the recommended first question. Grilling asks one
decision at a time, explaining the relevant workflow before the structural proposal. The full
research stays inspectable on the session without requiring a dense table in every response. When
there are no supported findings or no remaining human choice, finish without creating a session.

Each deliberate audit rerun creates a fresh session linked to the previous audit session. Read
previous decisions as context and identify new evidence; previous recommendations do not become
rulings. A retry of the same handoff keeps its audit-run identity and resumes the same session.
Neither a title change nor a lost response is a reason to create a duplicate.

Selection still controls actionable reporting. Agreement with an explanation is not a filing pick;
an explicit filing request needs no repeated permission. Only a human-picked scope enters `report`
under its intake contract. Fully covered findings need no redundant issue or note; partial overlap
narrows the new report to the uncovered scope. Unpicked entries remain research context without
assignment, priority, pickability or automatic future filing, including after a resume.

The user may separately authorize immediate triage of selected reports while the next discussion
continues. Filing alone does not authorize that handoff. Audited code stays read-only, and neither
audit nor its triage handoff starts implementation.

Recommendation order is not board priority. Compare impact, recurring pain, recent changes, likely
change cost and uncertainty. Include the value of removing competing rules and examples for agents.
A production incident is not required to justify cleanup. Missing migration evidence limits when
code can be deleted, not whether a bounded census, migration and retirement task has value.

The audit uses its current harness's native tools. Use structural read-only restrictions where
available; otherwise disclose that limitation and give native explorers explicit read-only
instructions. If delegation is unavailable, disclose local lens passes. A user requirement for
structural isolation still binds. Switching harnesses to imitate missing restrictions is not a
fallback; [#8849](https://github.com/kamp-us/phoenix/issues/8849) records the observed failure.

**Binding constraints.**

- The complete research is in the initial session body, with recommendations separate from rulings.
- Actionable reports require an explicit human pick. Triage needs its own authorization.
- Audited code stays read-only. No builder or new shipping gate starts from the audit handoff.

## Implementation

[Issue 8868](https://github.com/kamp-us/phoenix/issues/8868) implements the coordinated CLI and skill
change. The registered audit-context wire module owns the research format. The grilling contract's
[Audit create and recovery](../claude-plugins/fabrika/skills/grilling/contract.md#audit-create-and-recovery)
section owns the input, validation and recovery behavior, including its remaining concurrent-create
limit. The initial request carries the complete research and verifies it before success.

## Consequences

The human can work through choices without reconstructing the research after a context reset.
Every rerun retains its own evidence, including uncertainty and previous ownership. This costs one
session issue for an audit that needs discussion, while avoiding separate backlog issues for every
observation.

This record amends ADR 0371 and the audit-output part of ADR 0099. Their explicit
human pick and per-selected-scope report path remain. The mandatory table handoff, issues-only output
and disposal of unpicked research are replaced by the grilling context described here. No standalone
audit document, automatic implementation or new shipping gate is introduced.

## Records

No vocabulary impact. A grilling session retains its existing meaning; this adds an audit caller.

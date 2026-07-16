---
id: 0187
title: pipeline-crew-mcp is not §CP — the control-plane test is "could an unreviewed merge weaken the pipeline's own gates", not "is it pipeline-adjacent" (reverses #3072)
status: accepted
date: 2026-07-16
tags: [pipeline, control-plane, ship-it, process, classifier]
---

# 0187 — pipeline-crew-mcp is not §CP; control-plane is an enforcement-surface test, not a proximity test

## Context

The control-plane boundary (ADR [0053](0053-control-plane-boundary.md), enforced at GitHub
per ADR [0071](0071-enforce-control-plane-at-github.md)) marks the surfaces where an
autonomous green-then-ship merge could compromise the pipeline's own guards, so those PRs
bank for a human control-plane (§CP) merge instead of auto-shipping. The concrete boundary
is a path regex in
[`packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts`](../packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts),
its byte-synced copy, `.github/CODEOWNERS`, and the classifier tests.

Decision #3072 ADDED `packages/pipeline-crew-mcp/` to that regex, reasoning that a new
pipeline-adjacent package belonged in the control plane. That reasoning was over-broad: it
conflated *"new pipeline-adjacent package"* with *"control plane / gate machinery."*
`pipeline-crew-mcp` is crew messaging and coordination tooling — it does not enforce any
pipeline rule. Merging it unreviewed cannot weaken a gate, because it is not a gate.

The founder ruled directly this session (2026-07-16): the crew-mcp package "is about the
crew, not the pipeline itself, so no need for blocking reviews." When the reviewer of the
reversal PR correctly flagged that the ruling was, at that point, only an agent-authored
relay (tracking issue #3147 carried no founder corroboration), the founder confirmed it
explicitly — "yeah, un-§CP it — confirmed." This is a conversation-authored ADR (ADR
[0075](0075-issueless-doc-pr-merge-seam.md)): it is the durable corroboration of that
ruling, not a report→triage item. Reverses #3072; tracked by #3147; implemented by #3163.

## Decision

`packages/pipeline-crew-mcp/` is **not** §CP. It is removed from the control-plane path
classifier (the regex drops from 21 to 20 clauses — the other 20 genuine §CP paths
untouched), from `.github/CODEOWNERS`, and from the classifier test fixtures (PR #3163,
1335 tests pass). Its PRs are ordinary non-§CP work that auto-ships on green like any
product package.

The discriminator for §CP, stated as a principle so this mis-classification is not
repeated: **a path is §CP if merging it unreviewed could weaken the pipeline's enforcement
of its own rules** — the gate machinery and control-plane surfaces (`.claude/`, `.github/`,
the gate-critical pipeline skills, `packages/ci-required/`, `packages/pipeline-cli/`). A
path is **not** §CP merely because it is new, infrastructure-flavored, or pipeline-adjacent.
The test is *enforcement surface*, not *proximity*. `pipeline-crew-mcp` fails the
enforcement test — it coordinates the crew, it does not gate the pipeline — so it is
ordinary work.

## Consequences

- Crew-mcp PRs auto-ship on green; they no longer bank at the §CP human-merge approver.
- Existing and future crew-mcp children — e.g. #3162 (edge-server), #3059, #3062, and the
  canon docs — become non-§CP the moment #3163 lands, and auto-ship rather than queue for a
  control-plane approval.
- Future authors extending the §CP classifier must apply the enforcement-surface test above,
  not a "is it pipeline-adjacent" heuristic. Adding a package to §CP requires showing an
  unreviewed merge of it could weaken a gate.
- The 20 remaining §CP clauses (true gate machinery) are unchanged; this narrows the
  boundary by exactly one over-broad clause, it does not loosen it elsewhere.

---
id: 0141
title: kampus-pipeline is an agent-automation harness forked from a human-cooperation lineage — the telos lens governs what we port
status: accepted
date: 2026-07-04
tags: [pipeline, harness, skills]
---

# 0141 — The telos lens: an agent-automation harness, not its human-cooperation lineage

## Context

kampus-pipeline descends from a specific, battle-tested lineage: `mattpocock/skills` → `usirin/claude-skills` → kampus-pipeline. That origin is worth learning from continuously. But a naïve "we are missing skill X that Matt has" comparison mis-frames the relationship and produces deficit-thinking.

The two harnesses have different **telos**:

- **`mattpocock/skills` is built for human cooperation** — a human sits inside every design loop. Its flagship skills (`grill-with-docs`, `grilling`, `domain-modeling`, `to-prd`) are interview machines that extract completeness *from a person*.
- **kampus-pipeline is built for agent automation** — autonomous throughput, no human in the inner loop. Work flows report → triage → plan-epic → write-code → review → ship-it, with durable GitHub artifacts (labels, comments, PRs) as the seam between stages.

This surfaced concretely: the `phoenix-reactions` feature was flag-released to 100% in production with its entire user-facing UI missing ([#1943](https://github.com/kamp-us/phoenix/issues/1943)) — Matt's human grill would have caught it; our automation had no forcing function in its place. Auditing the two harnesses under the correct lens (rather than a plain feature-diff) is what turned a vague "we lost the design spine" into precise, actionable gaps.

## Decision

Adopt the **telos lens** as the standing frame for evaluating our harness against its lineage. When a lineage skill enforces a discipline we lack, do **not** ask "should we copy it." Ask: *what is the agent-automation analog that enforces the same discipline without a human, and do we have neither?* A "neither" is a real gap; a discipline his human enforces that our structure already enforces mechanically is not a gap at all.

Applying the lens to the founding audit yields four dispositions, each filed as its own triageable gap:

- **BUILD-AUTOMATED-ANALOG** — [#1944](https://github.com/kamp-us/phoenix/issues/1944) vertical-completeness plan-gate (`USER_FACING_NO_SURFACE` in `review-plan`, closing the [#1943](https://github.com/kamp-us/phoenix/issues/1943) class); [#1945](https://github.com/kamp-us/phoenix/issues/1945) a red-repro-before-hypothesis diagnosis discipline for the autonomous repair loop; [#1947](https://github.com/kamp-us/phoenix/issues/1947) a fail-closed "router that lies" skills-index coverage check.
- **PORT-ADAPT** — [#1946](https://github.com/kamp-us/phoenix/issues/1946) a constructive skill-authoring reference (port `writing-great-skills`), pairing an author-reference with the existing `review-skill` *gate*.
- **SKIP-WE-HAVE-IT** — our slicing is *more* domain-driven than his (we **enforce** two-way story↔child coverage; his story-trace is optional); `architecture-audit` is the automation port of his `improve-codebase-architecture`; `doctor` is the non-interactive form of his setup; durable-artifact handoff replaces his in-context handoff doc.
- **REJECT** — his human-in-the-loop *ceremonies* (grilling-as-live-interview, conversation-sourced glossary) are correctly shed by an automation harness; we keep the vocabulary they produce (`.glossary/`), not the ritual.

Record where we are **ahead**: kampus-pipeline carries verification infrastructure the human-cooperation harness has no equivalent of — because his human *is* the gate that ours had to make structural. SHA-bound run-evidence bundles, byte-for-byte CI-command typecheck gates, the config-isolation review firewall (ADR [0052](0052-review-code-config-isolation.md)), fail-closed claim/worktree preflights, and durable-artifact stage handoff are not catch-up; they are the automation telos producing what a human harness never needs.

## Consequences

- Future harness comparisons start from the telos lens, not a feature-diff. The deliverable of "learn from Matt" is a **disposition** (keep / adapt / build-analog / reject), not a port list.
- The four gap issues (#1944, #1945, #1946, #1947) are the actionable consequences of this decision; each enters through report → triage like any other work.
- **Open architectural question — deliberately not decided here:** whether kampus-pipeline should invest in an *active domain-modeling* step upstream of `plan-epic` — modeling entities, relationships, and stress-tested edge-case scenarios against code, rather than merely surfacing nouns as the `glossary` skill does. This is the one genuine "neither" the audit found in our vertical-definition path (his `domain-modeling` feeds a live model into the PRD; we surface vocabulary only). It is a product-shaping bet owned by the founder + product, deferred to a future decision rather than resolved in this record.

## Vocabulary impact

Coins **telos lens** — the frame that, when comparing kampus-pipeline to a lineage or peer harness, asks for the *agent-automation analog* of a *human-cooperation* discipline rather than treating a difference as a deficiency. Also names the standing distinction **agent-automation harness** vs **human-cooperation harness**. These are short and unambiguous; they should be routed to [`.glossary/TERMS.md`](../.glossary/TERMS.md) via `/glossary` as a follow-up (not inlined here, to keep this PR a purely additive single-ADR add).

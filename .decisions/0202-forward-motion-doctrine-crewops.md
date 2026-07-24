---
id: 0202
title: Forward-motion doctrine — p0 freely minted for arc-homed ship-work; CrewOps state
status: accepted
date: 2026-07-24
tags: [process, prioritization, pipeline]
---

# 0202 — Forward-motion doctrine — p0 freely minted for arc-homed ship-work; CrewOps state

**What this decides:** Every unit of work is priced against "is this moving us forward?" — p0 is freely given to work that ships value or raises ship-rate, but only inside the documented active arc, and the documented ROADMAP/board/ADR chain is the single company state agents reconcile toward.

## Context

Founder ruling, 2026-07-24, in conversation — recorded on the ADR-0075 conversation-authored path (ADR [0075](0075-issueless-doc-pr-merge-seam.md)) via #3852. The pipeline had grown strong self-healing instincts: improvement work was plentiful, but nothing forced the question of whether a given improvement moved the company toward shipped user value or revenue. The founder's verbatim ruling (two messages):

> "we also need to be responsible and start prioritizing 'what's gonna move us forward' i love improving every little piece but is it moving us forward is the question we should always be asking. and this should be encoded into the heart of the pipeline. self healing pipelines are important but we need balance. we're burning tokens but we need to also ship so we can start thinking about 'how can we even start making money from this' … i am not saying we should deprio pipeline, on the contrary. pipeline is a first class product now, we established that. we should start focusing on freely making important shit to be shipped p0s"

> "p0s also should be part of the active arc everything should be documented. remember the gitops, this is companyops for agents type of thing. the things you coordinated today is ok, we are trying to drain the backlog, that's important before we have clarity so we can have focus."

The founder subsequently named the doctrine **CrewOps** — "GitOps for code, CrewOps for the crew" (#3852 naming ruling, 2026-07-24) — superseding the in-conversation working name CompanyOps; the verbatim quotes above predate the rename and stay as spoken.

This sits on top of ADR [0078](0078-product-driven-decisions-by-default.md) (decisions are product-driven by default), ADR [0072](0072-milestones-encode-strategic-sequencing.md) (milestones encode strategic sequencing — the documented structure priorities must live in), and ADR [0201](0201-pipeline-tenant-phoenix-first.md) (the pipeline is a first-class product on the phoenix tenant).

## Decision

**Forward motion is the pricing question for all work: p0 is freely minted for moves-us-forward work, every p0 lives in the active arc's documented structure, and the documented ROADMAP/board/ADR chain — CrewOps — is the single declarative company state agents reconcile toward.**

The doctrine, in five points:

1. **p0 semantics.** p0 is freely minted for moves-us-forward work — shipped user/revenue value, or work that directly raises ship-rate. Engines fill p0 first.
2. **p0 is never homeless.** Every p0 belongs to the active arc's documented structure (arc → campaign/epic). No orphan priorities.
3. **Triage asks the question.** The triage rubric prices every issue against "what does this move forward?" — and kill/close is a valid triage verdict for improvement-for-improvement's-sake.
4. **CrewOps.** The ROADMAP/board/ADR chain is the single declarative company state; agents reconcile toward it; direction that isn't documented doesn't exist. This is GitOps applied to the company: the documented artifact chain is the desired state, agent work is the reconciliation loop. The pipeline remains a first-class product per ADR [0201](0201-pipeline-tenant-phoenix-first.md) — this doctrine governs prioritization, not the tenant model.
5. **Backlog-drain clarification.** The 2026-07-24 campaign batch (#3827, #3843–#3847) is founder-blessed as the clarity-before-focus drain, not a doctrine violation.

**Binding constraints.**

- Every p0 is homed in the active arc's documented structure; an orphan p0 is invalid.
- Triage prices every issue against forward motion; kill/close is a sanctioned verdict.
- Undocumented direction is not direction — it enters the ROADMAP/board/ADR chain or it doesn't exist.

**Banned.**

- Orphan priorities — a p0 outside any documented arc/campaign/epic.
- Improvement-for-improvement's-sake surviving triage without a forward-motion answer.

## Consequences

- The triage-skill rubric change that operationalizes points 1–3 (the forward-motion question, p0 semantics, kill-as-valid-verdict) is the follow-on — gate-critical, so it routes §CP and banks for control-plane approval; tracked by #3852.
- Engines and coordinators fill p0 first and can mint p0 freely, so ship-work stops competing with self-healing work on equal footing — the balance is priced explicitly, not by whoever files loudest.
- Kill/close becomes a normal, expected triage outcome; the backlog carries less improvement-for-improvement's-sake by construction.
- Documenting direction becomes load-bearing: an undocumented intention cannot direct agent work, which raises the cost of skipping the ROADMAP/board/ADR write-down and lowers the cost of drift.
- A ROADMAP/docs touch-up may be needed where priorities are defined, so the p0/arc-membership rule is stated at the point of use (tracked by #3852).

## Records

- References #3852 (also tracks the triage-rubric change — intentionally not auto-closed by this PR).
- Vocabulary impact: coins **forward-motion doctrine** (the pricing question for all work) and **CrewOps** (the documented ROADMAP/board/ADR chain as declarative company state, GitOps-for-the-company — founder-named on #3852, superseding the working name CompanyOps); both routed to `.glossary/TERMS.md` via a `report` issue for the glossary skill to pick up.

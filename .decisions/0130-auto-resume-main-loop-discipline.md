---
id: 0130
title: Orchestrator-layer auto-resume is a main-loop discipline (first cut)
status: accepted
date: 2026-07-02
tags: [pipeline, workflow, reliability]
---

# 0130 — Orchestrator-layer auto-resume is a main-loop discipline (first cut)

## Context

This is a conversation-authored decision made by the founder — the ADR [0075](0075-issueless-doc-pr-merge-seam.md) exception — resolving triaged decision issue [#1757](https://github.com/kamp-us/phoenix/issues/1757).

Overnight hand-driven backlog draining via dynamic Workflows requires manual resumes when a run crashes — one night alone needed roughly three (a null-verdict crash, a stringified-args crash, and a whole-process death on a model switch). Epic [#1751](https://github.com/kamp-us/phoenix/issues/1751) asks for capped, failure-classified auto-resume at the **orchestrator layer** — the backstop *above* the executor and the only handler for whole-process death.

This is distinct from [#1682](https://github.com/kamp-us/phoenix/issues/1682) and [#1692](https://github.com/kamp-us/phoenix/issues/1692), which harden `drive-issue.js` internals *at the source* (null-guard + stage retry) and kill most of the **TRANSIENT** class before anything crashes. The two layers compose: source-hardening prevents crashes; orchestrator-layer auto-resume recovers from the ones that still escape.

The open fork this ADR closes: **where does the orchestrator-layer auto-resume live?** The candidates were (a) a main-loop discipline, (b) a wrapper workflow, and (c) an external watcher.

## Decision

For the first cut, orchestrator-layer auto-resume lives as a **main-loop discipline** — encoded in the workflow-driving skill / a memory rule, with **zero new infrastructure**.

The driving session detects a crashed or incomplete run and re-invokes the workflow with `{scriptPath, resumeFromRunId}`; completed `agent()` calls replay from the journal cache rather than re-executing. Resumes are **capped at K=2 attempts, then surfaced** to a human.

This composes with the failure classifier ([#1758](https://github.com/kamp-us/phoenix/issues/1758), default-deny-to-LOGIC): only **TRANSIENT** crashes auto-resume. **LOGIC** and **SCRIPT** crashes surface immediately and are **never** auto-resumed — a blind resume of a deterministic re-crash is a token-burning loop.

**Rejected alternatives.** (b) a wrapper workflow and (c) an external watcher are **not** chosen for the general case. (c) an external supervisor stays scoped **only** to whole-process death ([#1760](https://github.com/kamp-us/phoenix/issues/1760), explicitly deferred): nothing in-session can self-heal a dead process, so that one sub-case may later warrant an external supervisor — but it is out of scope for the first cut.

## Consequences

- Unattended overnight draining becomes genuinely unattended for the common (TRANSIENT) case, with **zero new infrastructure**.
- The classifier's default-deny bias means a misclassification can only ever **over-surface** (a human glance), never **over-resume** into a burn loop — the failure mode is safe by construction.
- Unblocks [#1759](https://github.com/kamp-us/phoenix/issues/1759) (the capped-resume mechanism), which implements this discipline. This ADR is the decision record only; it does not implement that mechanism.
- Whole-process death remains a human / external-supervisor concern ([#1760](https://github.com/kamp-us/phoenix/issues/1760), deferred) — the one sub-case a main-loop discipline structurally cannot cover.
- Supersedes nothing.

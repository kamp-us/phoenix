---
id: 0136
title: "Feature-flag retirement is assisted — the machine nominates an error-clean, exercised flag; the human confirms; the cleanup rides the pipeline"
status: accepted
date: 2026-07-03
tags: [feature-flags, release-engineering, observability, process]
---

# 0136 — Flag retirement: machine nominates, human confirms

## Context

ADR [0083](0083-agents-deploy-humans-release.md) (agents deploy, humans release) and the release
tooling (`cf-utils flag set`, the `/release` skill, ADR [0134](0134-clis-agent-invokable-human-only-at-invocation-layer.md))
cover a flag's birth and go-live. Nothing covers its **death.** Today a flag, once flipped to
`on@100%`, sits forever: the `FlagGate` and the old fallback code path (e.g. the non-optimistic
mutation path behind the seven optimistic flags) are never removed. On 2026-07-03 all nine feature
flags went live at once — nine flags now awaiting a retirement path that doesn't exist.

The question the founder posed: **what signal says "we're good, remove the old code"?** Four shapes
were weighed — (A) automated error-clean burn-in, (B) manual founder call, (C) a time+evaluation
floor, (D) assisted: machine surfaces a candidate, human confirms. The founder's call: **D is not a
rival of A/B/C — it is the frame that subsumes them.**

## Decision

**Flag retirement is assisted: the machine *nominates*, the human *confirms*, the cleanup rides the
pipeline.** A flag is never auto-retired.

1. **Human confirmation is the invariant.** No flag's gate + fallback is removed without an explicit
   human decision. Retirement is a release-class act — a human call, per ADR 0083's spirit.
2. **The machine nominates on error-clean + exercised (the detector = option A's machinery).** A
   released flag becomes a *retirement candidate* when, since its release-flip timestamp (from the
   Flagship changelog): (a) Sentry shows **zero errors** attributable to that flag's feature area
   (requires the per-flag Sentry attribution substrate), AND (b) Flagship analytics show the flag was
   **actually exercised** ≥ a minimum evaluation count. Both halves are required — clean-but-never-run
   is the empty-room trap (kamp.us has ~zero traffic, so "exercised" is gated on the founders
   dogfooding, not calendar time).
3. **The time/evaluation floor (option C) is a knob on the detector**, not a separate model — the
   nomination can additionally require ≥T days or ≥N evals before surfacing.
4. **Manual retirement (option B) is the always-on escape.** The human may retire any flag at any
   time regardless of the detector, or reject a surfaced candidate and keep the flag. The detector
   is a convenience that removes "you have to remember," never a gate on the human.
5. **The cleanup rides the normal pipeline.** On confirmation, a cleanup issue/PR (rip the `FlagGate`
   + the fallback path + the flag registration) enters report→triage→write-code→review→ship like any
   other work.

Lifecycle, end to end: **dark → `/release` (flip live) → burn-in → nominate (clean + exercised) →
human confirms → cleanup PR → gone.**

## Consequences

- Old code has a defined death, not an indefinite afterlife; the flag registry stays bounded.
- Hard dependency: the detector needs Sentry live (worker + SPA DSN) AND per-flag error attribution
  (feature/flag tagging) — without attribution, "is this flag clean?" is unanswerable, so the
  detector degrades to manual-only (option B) until the substrate lands.
- The machine never removes code on its own; a false-clean detector (e.g. an un-exercised flag) can
  at worst *surface* a bad candidate, which the human rejects — it can never auto-delete.
- Implementation (the `graduate`/nominate check + the cleanup-PR filing) is tracked; it was gated as
  decision-pending until this ADR, and now has a ratified model to build against.

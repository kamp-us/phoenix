# Driving dynamic Workflows — capped, classified auto-resume

How the session that **drives dynamic Workflows** (overnight backlog draining via the
`.claude/workflows/*.js` scripts on the Workflow runtime) recovers from a run that
**crashes mid-flight** without a human at the keyboard, and without ever looping on a
deterministic re-crash. This is the *shape of the discipline*; the *why* + the rejected
alternatives (a wrapper workflow, an external watcher) are ADR
[0130](../.decisions/0130-auto-resume-main-loop-discipline.md), and the whole-process-death
sub-case it explicitly cannot cover is [#1760](https://github.com/kamp-us/phoenix/issues/1760)
(deferred). This doc points at those, it does not re-derive them.

The discipline is **a main-loop rule with ZERO new always-on infrastructure** (ADR 0130's
chosen fork). There is no supervisor process and no wrapper workflow — the driving session
itself, on a `status: failed` event, runs the decision below and re-invokes or stops.

## The problem it recovers from

A dynamic Workflow run can die mid-flight — a subagent returns a null result, a process
exits on a model switch, an API/session limit kills a stage. The Workflow runtime journals
completed `agent()` stages, so **re-invoking with `{scriptPath, resumeFromRunId}` replays
the finished stages from the journal cache** and only re-runs from the crash point — cheap
recovery. Overnight, a hand-driven drain needed roughly three such manual resumes a night
(ADR 0130 Context). The discipline automates the safe subset of those resumes.

The danger it must not create: a **blind** auto-resume of a *deterministic* crash (a null
deref, a wrong-arg-type) re-crashes identically and loops forever, burning tokens. So the
resume is gated on **both** a failure classification **and** a hard per-run cap.

## The two-part decision (the shipped mechanism)

The decision is a pure, unit-tested core — `pipeline-cli resume-policy decide`
([`packages/pipeline-cli/src/tools/resume-policy/`](../packages/pipeline-cli/src/tools/resume-policy/),
`decideResume`) — so "resume up to K then surface" is testable **without spawning a real
workflow**. It **composes** the failure classifier (it does not reimplement classification):

### 1. Classify the crash (compose `failure-classifier`, #1758)

`decideResume` calls the sibling [`failure-classifier`](../packages/pipeline-cli/src/tools/failure-classifier/)'s
`classify()` on the crash signal (reason / errorKind lifted off the `status: failed` event).
The taxonomy is two classes, **default-deny toward LOGIC**: a TRANSIENT signal is a positive
match on a known recoverable signature (null subagent result, API/session-limit death,
process exit / model-switch death); **everything else — an unrecognized reason, an empty
signal, a recognized logic crash — is LOGIC.**

- **LOGIC → surface immediately, ZERO resume attempts.** A deterministic re-crash must never
  auto-resume.
- **TRANSIENT → eligible to resume**, subject to the cap below.

### 2. Cap the resumes per run (K=2, then surface)

A TRANSIENT crash resumes **only if this run is under the cap of `RESUME_CAP = 2` resumes**.
The count is tracked **per `resumeFromRunId`** — the caller looks the prior-resume count up
by run id, so a **fresh run (a new id) starts a fresh K budget**; K counts resumes of the
*same* run, never a global tally.

- **Under the cap** (`priorResumes < 2`) → **resume**: re-invoke with the `<recovery>`
  block's `{scriptPath, resumeFromRunId}`; `attempt = priorResumes + 1`. The caller persists
  the incremented count as the run's new `priorResumes`.
- **At the cap** (`priorResumes >= 2`) → **surface** (`cap-reached`). A "transient" crash
  that keeps recurring after two resumes is a **masked LOGIC error**; the cap bounds token
  burn even when the classifier is optimistically wrong. This is the **load-bearing safety
  property** (ADR 0130): because the classifier default-denies and the cap is hard, a
  misclassification can only ever **over-surface** (a human glance), never **over-resume**
  into a burn loop.

## What the driving session does on `status: failed`

1. Lift the crash signal (reason / errorKind / stage) off the failed event and the
   `<recovery>` block's `{scriptPath, resumeFromRunId}`.
2. Look up how many times **this `resumeFromRunId`** has already been auto-resumed
   (`priorResumes`, 0 on a run's first crash — the session owns this small per-run ledger; a
   new run id is absent ⇒ 0).
3. Run `resume-policy decide` (or `decideResume` in-process) with the signal + ledger.
4. On **`resume`** — re-invoke the workflow with `{scriptPath, resumeFromRunId}` and record
   the new `priorResumes = attempt`. Completed stages replay from the journal cache.
5. On **`surface`** — **stop and hand the crash to a human.** Do not resume. The rationale
   says whether it surfaced for `logic` (never-resumable) or `cap-reached` (exhausted budget).

## Worked: three consecutive TRANSIENT crashes of one run

A run `run_flaky` crashes TRANSIENT three times in a row:

| Crash | `priorResumes` in | `decideResume` | Outcome |
|-------|-------------------|----------------|---------|
| 1 | 0 | `resume` (attempt 1) | re-invoke; ledger → 1 |
| 2 | 1 | `resume` (attempt 2) | re-invoke; ledger → 2 |
| 3 | 2 | `surface` (`cap-reached`) | **stop, surface to human** |

**Exactly two resumes, then a surface** — no unbounded loop. A LOGIC crash at crash 1 would
have surfaced immediately with **zero** resumes. A *different* run's crash carries its own
zeroed budget, so it gets its own full two resumes independent of `run_flaky`.

## A second, orthogonal cap: the healthy-resume lifetime cap (ADR 0152 (b))

Everything above is the **crash axis** — it fires on a `status: failed` event and caps resumes
of a *crashed* run at K=2. There is a **second, independent** cap on a different failure mode:
a **healthy, non-crashing** subagent that is resumed across a very long chain and degrades
toward confident-but-confabulated output (the #1876 near-miss — a triager resumed ~5000s across
many cycles). Confabulation correlates with long resume chains, not crashes, so the crash
machinery does not cover it (ADR
[0152](../.decisions/0152-confabulation-guardrail-and-resume-cap.md) mitigation (b),
[#2053](https://github.com/kamp-us/phoenix/issues/2053)).

The rule: on a **healthy** resume request (no crash signal), the driving session consults the
lifetime cap before re-invoking. A single healthy subagent is resumed at most
`HEALTHY_RESUME_CAP` (K=5) times; past the cap the session **spawns a fresh instance** instead
of resuming the degraded one. The count is per subagent instance (its
spawn/`resumeFromRunId`), so a fresh spawn zeroes the budget and the successor gets a full K
again. The decision is the pure, unit-tested
[`resumeCapDecision`](../packages/pipeline-cli/src/tools/drive-issue-flow/resume-cap.ts)
(mirrored inline in `.claude/workflows/drive-issue.js` as `HEALTHY_RESUME_CAP` +
`resumeCapDecision`, the enforcement home per ADR 0152).

**The two axes are distinct and never double-count.** The crash cap (K=2, `resume-policy.ts`)
is consulted on a **crash**; the lifetime cap (K=5, `resume-cap.ts`) on a **healthy** resume.
A single resume is one axis or the other, never both — neither budget weakens the other, and a
resume is never counted against both. A run that has crash-resumed under K=2 may still
healthy-resume up to K=5, and vice versa; they are separate ledgers over separate failure modes.

## What this discipline does NOT cover

**Whole-process death** ([#1760](https://github.com/kamp-us/phoenix/issues/1760), deferred):
nothing in-session can self-heal a dead driving process, so that one sub-case is the single
thing a main-loop discipline structurally cannot handle. It stays a human / future
external-supervisor concern — explicitly out of scope here (ADR 0130).

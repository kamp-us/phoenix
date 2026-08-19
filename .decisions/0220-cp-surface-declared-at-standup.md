---
id: 0220
title: An adopter declares its §CP surface at stand-up; absence is a configuration error
status: accepted
date: 2026-07-26
tags: [pipeline, control-plane, plugin-portability, ship-it, guards]
---

# 0220 — An adopter declares its §CP surface at stand-up; absence is a configuration error

**What this decides:** When the pipeline runs in a repo other than phoenix, the adopter has to say which paths are control-plane as part of standing the pipeline up. If they never said, that is a setup error the adopter is told about at stand-up and must fix — not something the pipeline papers over by treating every file as control-plane (which is what it does today, and why nothing merges) and not something it papers over by treating no file as control-plane.

## Context

The pipeline is repo-agnostic (ADR [0062](0062-repo-as-config-plugin.md)): an adopter installs the
plugin and it operates on *their* repo. The §CP boundary (ADR
[0053](0053-control-plane-boundary.md), hard-gated per ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)) is the one part of
that contract with no adopter-supplied value.

Each merge-deciding gate bootstraps `CONTROL_PLANE_RE` to the match-everything ERE `'.'` and then
tries to replace it by fetching `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`
off the **adopter's own** `main` — the deliberate anti-self-authorization read (#981), so a
boundary-editing PR is judged against main's boundary rather than its own edit. The plugin ships
that skill under the plugin root and does **not** install it into the adopter's tree, so in a
foreign repo the fetch returns nothing and the sentinel stands. Every path then matches, every PR
classifies control-plane, and the repo builds and reviews normally and merges nothing (#4271).

**This is a family of sites, not one.** The same "unresolved ⇒ `'.'`" idiom carries three different
contract values: `CONTROL_PLANE_RE` in
`ship-it`,
`review-code` and
`review-doc`; `UI_RE` in `ship-it`
and `review-design`; and
`GUARD_ADR_RE` in
`gh-issue-intake-formats.md`.
The ruling below governs the pattern, not a single line.

**`'.'` was never a safety property.** It is fail-closed only in the repo it was written for.
Anywhere else it is *fail-stopped*: it protects no boundary, it halts all work. The comments calling
it "fail-closed" are what make the behavior read as intended at each individually-correct step.

### Premise correction — the failure path is fail-open, and it is not the `N == 0` branch

Issue #4271's body states the mechanism wrong, and the correction is recorded here rather than
applied silently, so the record shows the ruling was re-aimed rather than quietly re-scoped.

The body says the roster lookup 404s and `cp-cardinality` then refuses on `N == 0`. **That branch
never executes on this failure mode.** `gh` does not apply `--jq` to an error response — it writes
the raw error body to **stdout**. A 404 from the roster read therefore yields a one-line JSON error
document, so a line-counting cardinality computes **`N = 1`**: a phantom member synthesized from an
error body. That is **fail-open**, not fail-closed. The `n === 0` branch is real code and its reason
string is accurate for a genuinely empty team; it is simply unreachable from a 404.

Two consequences bind this ADR:

- **Ruling against `N == 0` would harden a branch this defect never reaches** — a correct ruling
  against the wrong proposition. The ruling below is aimed at the declaration, at stand-up, which is
  upstream of both branches.
- **Two failure classes the original premise collapses.** A fresh *org* with no team: the roster
  read succeeds and returns empty, so `N == 0` is genuine and an org admin can create the team. A
  *user-owned* repo: there is no `orgs/<user>` namespace at all, the read 404s, and the phantom
  appears. Verified against a control on one token (`orgs/<user>` → 404 while `users/<same>` and
  `orgs/<a-real-org>` both resolve), so the 404 is namespace absence, not auth and not scope.

Not asserted here: that the phantom `N = 1` *discharges* the gate. That is one execution-engine
instance's observation, is not corroborated, and is tracked on #4223. Nothing below depends on it.

### Relationship to ADR 0086 — inherited in part, extended in part

ADR [0086](0086-ship-it-foreign-repo-degradation.md) is the same problem shape one guard over, and
this ADR does not re-derive it.

- **Inherited verbatim: 0086 §3, "the presence check fails *safe*, not open."** Degradation fires
  only on a **confirmed** absence; an unconfirmed read (network / auth / rate-limit) takes the
  strict path. That distinction is reused below, not restated as new.
- **Not decided by 0086: what §CP degrades *to*.** 0086's degrade target was self-evidently safe —
  guard 2 becomes N/A and the merge still gates on checks-green. §CP has **no residual gate behind
  it**: under branch protection with `required_approving_review_count: 0`, CODEOWNERS is the only
  source of required human review (ADR [0218](0218-pipeline-cli-cp-enforcement-core.md)), so
  degrading §CP off means the adopter repo has no human-merge boundary at all. That is a guard
  *removal*, a different risk class, and this repo does not let a guard be relaxed by an
  implementer's inference (ADR [0164](0164-guard-relaxing-adr-cp-gate.md)).
- **New here: *when* the question is asked.** 0086 asks its producer-presence question at merge
  time, which is correct for it because the degrade is safe. It is not correct for §CP.

### The fork

Three readings were live: **(a)** no boundary file ⇒ §CP disabled entirely, everything merges
without human approval; **(b)** §CP holds everything — today's deadlock; **(c)** absence is a
configuration error the adopter resolves at stand-up. The founder ruled **(c)**.

## Decision

**An adopter declares its §CP surface when it stands the pipeline up, and a repo with no declared
§CP surface is a configuration error reported at stand-up — never a match-everything sentinel, and
never a permissive default.**

### 1. The declaration is the adopter's, and absence is not a declaration

The §CP boundary is adopter-supplied configuration, like labels and auth. "This repo declares no §CP
surface" is a **legitimate** declaration — an adopter may reasonably decide nothing in their tree is
an enforcement surface under ADR [0187](0187-crew-mcp-is-not-control-plane.md)'s test. But it must be
*written down by the adopter*, never inferred from a file that is missing or unreadable. An absent
declaration and a declared-empty boundary are different states and the pipeline must not conflate
them: the first is an error, the second is a configuration the adopter owns.

### 2. Detection fires at stand-up, not at merge — the acceptance criterion

**Acceptance criterion for any implementation of this ADR: the missing-declaration error must be
raised by the stand-up preflight, and a run that never reaches merge must still surface it.** An
implementation that only raises the error when a PR tries to merge does **not** satisfy this ADR. It
rebuilds today's deadlock with a nicer message: every PR still builds, still reviews, and still
parks. Stand-up-time detection is the entire reason (c) was chosen over (b) — (b) *is* the
merge-time error, spelled less clearly.

The shape has precedent: ADR [0210](0210-direction-binds-at-intake.md) binds its check at intake and
explicitly *never* as a merge gate, for the same reason — a constraint discovered at merge is a
constraint discovered too late to act on. This is that move applied to the §CP declaration.

The stand-up surface already exists: the `doctor`
skill and its `doctor.sh`, which verifies a repo's pipeline prerequisites before its first run and
exits non-zero on a gating gap. The §CP-declaration check belongs there as a **gating** tier — one
that fails the checklist, not a Tier-3 warn.

### 3. Confirmed absence and unconfirmed read stay distinct

Per ADR 0086 §3: the stand-up check reports a configuration error only on a **confirmed** absent
declaration. An unconfirmed read at stand-up is reported as unconfirmed, not as an absence. At merge
time the strict path is unchanged — a transient failure to re-resolve the boundary can never be read
as "the adopter declared nothing," because stand-up already certified that they declared something.

### 4. The merge-time unresolvable state converges on `cp-classify`'s `unknown`

`cp-classify` already separates "I could not resolve the boundary" from "every path matched it": an
unresolvable or uncompilable boundary is the distinct state `unknown` (`boundary-unresolved` /
`boundary-uncompilable`), whose own docblock names collapsing `unknown` → `not-control-plane` as the
recurring fail-open defect. That is the target shape for all the surfaces in the sentinel family.
`unknown` still holds the PR, and that is now *correct* rather than a deadlock: after §2, `unknown`
at merge time means a transient, not a configuration gap.

### 5. The roster leg is the same shape

The approver surface — today `orgs/<owner>/teams/control-plane`, keyed off `${REPO%%/*}` — is
declared at stand-up on the same terms. Whether it stays a GitHub team or gains a configuration
value of its own is implementation, deliberately not decided here. What is decided: its absence is a
**stand-up** configuration error, discovered before the first PR, never a merge-time surprise — and
never something a phantom roster member can appear to satisfy.

### 6. The boundary being declared is ADR 0218's narrowed shape

Any implementation targets the post-#4258 boundary — ADR
[0218](0218-pipeline-cli-cp-enforcement-core.md)'s narrowed enforcement core, with its transitive
import-closure obligation — not the pre-#4258 whole-package shape and not today's. An adopter has no
`packages/pipeline-cli/` to narrow; what they declare is *their own* enforcement surface under ADR
0187's test, and 0218 is the worked example of what that test produces.

**Binding constraints.**
- This ADR lands before any code; implementation is a separate follow-on filed against it.
- The stand-up check is gating — a tier that fails the checklist, not a warn.
- A confirmed-absent declaration is a named, greppable configuration error naming the fix.
- An explicit "this repo declares no §CP surface" is a valid adopter declaration; absence is not.
- Confirmed absence and unconfirmed read stay distinct (ADR 0086 §3).
- Implementations target ADR 0218's narrowed core.

**Banned.**
- A match-everything sentinel (`'.'`) as the default on an unresolved boundary, at any site in the
  `CONTROL_PLANE_RE` / `UI_RE` / `GUARD_ADR_RE` family.
- A permissive default — unset boundary read as "no §CP."
- Merge-time-only detection of a missing declaration.
- Ruling or implementing against `cp-cardinality`'s `n === 0` branch as the fix for this defect.
- Describing `'.'` as "fail-closed" in a comment or a report line.

## Consequences

- **Adopters gain a stand-up step they cannot skip.** That is the accepted cost of (c): the pipeline
  is not usable in a new repo until its human-merge boundary is named. (a) would have removed the
  boundary silently; (b) leaves it unusable forever.
- **Zero behavior change in phoenix.** The home repo resolves the boundary off `origin/main` as
  today, so the #981 anti-self-authorization property is untouched.
- **This resolves about 2 of the 13 halts** a fresh-repo dry-trace predicted for #4268 (7 hard, 6
  silent). It does **not** unblock the Pipeline Anywhere path, and must not be sized as if it does.
  Note also that 13 is a **hypothesis count**: the sites were verified, the runtime effects
  predicted.
- **Scoped out — a user-owned repo may be permanently undischargeable regardless.** With no
  `orgs/<user>` namespace, a `@<org>/control-plane` team cannot exist there at all, so a declared
  §CP surface may have no dischargeable approver. That is a separate problem, owned by #4223; this
  ADR does not resolve it and a stand-up check that certifies such a repo would be wrong.
- **Scoped out — the phantom `N = 1` on a live org.** Any transient roster-read failure (5xx,
  secondary rate limit, SSO lapse) produces the same phantom against phoenix's real team. That is a
  defect on *this* repo, tracked on #4223, and is not in scope here.
- **Scoped out — the class-probe collapse.** `HAS_CODE_RE` / `HAS_SKILLS_RE` / `HAS_DOCS_RE` share
  the idiom and collapse the same way, but over-dispatching gates never stops a merge and needs no
  ruling. A separate, lower-priority unit.
- **Relates to:** ADR [0062](0062-repo-as-config-plugin.md) (the targeting axis),
  [0086](0086-ship-it-foreign-repo-degradation.md) (the mechanism, extended above),
  [0092](0092-gates-fail-closed-on-zero-scope.md) (zero scope is not evidence of innocence),
  [0175](0175-cp-self-approval-cardinality-check.md) (the cardinality check whose `N == 0` branch is
  *not* what this rules on), [0218](0218-pipeline-cli-cp-enforcement-core.md) (the shape being
  declared).

## Records

- **Closes #4271** on the recorded decision, per that issue's own terms; the implementation is filed
  as a separate follow-on referencing this ADR.
- **Premise correction recorded, not applied silently.** #4271's `N == 0` mechanism is measured
  false; see the Context subsection above.
- **Vocabulary impact — one term coined: `fail-stopped`.** A default that is fail-closed in the repo
  it was written for and, elsewhere, protects no boundary while halting all work. Distinct from the
  existing `fail-closed gate` entry, and the distinction is the reason this ADR exists. Routed to
  [`.glossary/TERMS.md`](../.glossary/TERMS.md) via a follow-up `report` rather than edited into this
  purely-additive ADR PR.

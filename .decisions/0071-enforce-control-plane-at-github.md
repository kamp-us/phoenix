---
id: 0071
title: Enforce the control-plane boundary at the GitHub level — required status checks back the gate; a human-only CODEOWNERS holds the control plane
status: accepted
date: 2026-06-15
tags: [pipeline, ship-it, review-code, security, control-plane, ci, governance]
---

# 0071 — Enforce the control-plane boundary at the GitHub level — required status checks back the gate; a human-only CODEOWNERS holds the control plane

## Context

ADR [0053](0053-control-plane-boundary.md) drew the control-plane boundary (`.claude/**`,
`.github/**` are blocking, human-merged) and ADR [0065](0065-gate-critical-skills-are-blocking.md)
extended it from "by path" toward "by nature" (the gate-critical skills are blocking
*wherever they live*). Both are **security** boundaries: they exist so the pipeline cannot
auto-merge a weakening of its own guardrails — the skills, hooks, and CI that *perform* the
merge.

GitHub enforces **none** of it. The `main` ruleset (`main protection`, id `17377992`,
`enforcement: active`) enforces only PR-only merge, squash-only, no force-push, no deletion.
Its `pull_request` rule sets **`required_approving_review_count: 0`**, **`require_code_owner_review: false`**,
there is **no `required_status_checks` rule**, and **no bypass actors**. So:

- `review-code`/`review-doc` emit a verdict as a **PR comment marker** (ADR
  [0058](0058-sha-bound-verdict-contract.md) §1), not a GitHub *required check* — advisory by
  construction.
- `ship-it`'s gate (assert a SHA-bound PASS marker authored by a `write+` collaborator, ADRs
  [0055](0055-acl-sourced-review-authz.md)/[0058](0058-sha-bound-verdict-contract.md); confirm
  the gating-check set is green, ADR [0061](0061-ship-it-gating-check-set.md); **refuse** the
  control-plane blocking set, ADRs 0053/0065) is an **agent skill run by convention**. GitHub
  does not enforce its refusal.

The whole gate architecture (`review-plan` → `review-code`/`review-doc` → `ship-it`) therefore
rests on `ship-it`'s self-restraint plus operator discipline. Any actor with `write` can
`gh pr merge` and bypass it entirely — hand-merge a control-plane PR against 0053/0065, or
merge a PR with no `review-code` PASS at all. A single mistaken merge, a misbehaving agent, or
a compromised token defeats the boundary. This is the gap ADR 0061 already named ("`main` has
**no required-status-check branch protection**"): with zero required checks, the *platform*
gate is empty and the *skill* gate is all there is.

The decision to settle is **how — and how far — to make the boundary binding at the platform**.
This is a fork in the road, not a single fix, because the candidate mechanisms interact with
the existing authorization model and each carries a tradeoff. Two of those interactions are
load-bearing:

- **The solo-operator constraint.** The repo runs as effectively one operator (`usirin`;
  `cansirin` is a second). Under org branch rules an operator **cannot post an approving review
  on their own PR** — the exact reason `ship-it` consumes a marker comment instead of a native
  approval (ADRs [0048](0048-ship-it-merge-actor.md)/0055). So `required_approving_review_count
  >= 1` interacts badly with solo operation: the operator's own non-control-plane PRs (the
  autonomous lane) could never satisfy it, breaking the pipeline that 0048–0061 exist to run.
- **The ADR 0055 wrinkle.** ADR 0055 sources reviewer authorization from the repo ACL (a
  `write+` floor), which is **agent-inclusive** — a future review-bot earns standing by being a
  `write+` collaborator. If agent-authored approvals satisfy a required-review rule, then
  "required approvals" does **not** keep the control plane *human*-merged; the very property
  0053/0065 protect (a human at the control-plane merge) would be satisfiable by the pipeline
  itself.

## Decision

Make the boundary binding at the platform with **two complementary GitHub mechanisms**, each
matched to the half of the gap it actually closes, and **specify them as ruleset-as-code +
checked-in CODEOWNERS** (not click-ops) so they are reviewable and durable. This **records the
target configuration**; a human (or a deliberate follow-up) **enacts** the `main` ruleset and
CODEOWNERS changes — the pipeline does not change its own enforcement (see Consequences).

### 1. Required status checks back the gate suite (the no-PASS-merge half)

Add a `required_status_checks` rule to the `main` ruleset listing the **gating-check set** —
exactly the suite ADR 0061 already treats as blocking and the suite the run-evidence bundle
attests SHA-bound (ADRs [0054](0054-run-evidence-bundle.md)/0061). The required contexts are:

- `lint / format / typecheck` (CI)
- `unit tests` (CI)
- `validate skill frontmatter` (CI)
- `integration tests` (CI)
- `produce run-evidence bundle` (run-evidence)
- `scan changed files for leaks` (leak-guard)

with `strict_required_status_checks_policy: true` (branch must be up to date). The
preview-deploy check (`deploy (web)`) is **deliberately excluded** — it is informational, the
single check ADR 0061 denylists; making it required would block on a known infra flake.

This is the principled lever, and it composes cleanly with 0061: that ADR explicitly says its
denylist "degrades to [required-status-checks] cleanly … if a required-checks ruleset is ever
added, those checks are all gating." Adding the ruleset is that addition. After it, a
`gh pr merge` with red tests or a missing run-evidence bundle is **blocked by GitHub**, not
merely refused by `ship-it` — closing the "no-PASS merge bypasses the platform" half of #382.

Required *status checks* are chosen over required *reviews* for this half precisely because of
the solo-operator constraint: a status check is satisfied by CI, which an operator's own PR
*can* satisfy, so the autonomous non-control-plane lane keeps working. The verdict-author
identity (whose PASS counts) stays where ADR 0055 put it — `ship-it`'s ACL author-gate — which
this ADR does not move; the required check binds *that CI ran green*, the marker binds *who
signed*, and the two are complementary, not redundant.

### 2. A human-only CODEOWNERS holds the control plane (the human-merge half)

Required status checks alone do **not** keep the control plane human-merged — green CI says
nothing about *who* may land a guardrail edit. To make 0053/0065's "a human merges these by
hand" binding at the platform, add `require_code_owner_review: true` to the `main` ruleset's
`pull_request` rule **and** a checked-in `CODEOWNERS` that assigns the control-plane paths to a
**human-only** owner.

Resolving the ADR 0055 wrinkle is the crux: a CODEOWNERS owner that is a `write+`-inclusive
identity (e.g. a team that could contain an agent) would let an agent approval satisfy the gate
and defeat the human-merge property. Therefore the control-plane owner is **a named human
individual** (`@usirin`) — or, when a second human operator is added, a GitHub **team whose
membership is humans only** (e.g. `@kamp-us/control-plane-humans`), never a team that includes
any agent/bot collaborator. The owner set for the control-plane paths is **disjoint** from the
ADR-0055 ACL population for the purpose of this gate: ACL `write+` decides whose *verdict
marker* counts (agent-inclusive, by design); CODEOWNERS decides whose *approval* unblocks a
*control-plane* merge (human-only, by this ADR). The two authz sources serve two different
questions and must not be conflated.

The `CODEOWNERS` covers the ADR 0053 + 0065 blocking set:

```
# Control-plane: human-only approval required (ADR 0053, 0065, 0071).
# Owner MUST be a human individual or a humans-only team — never an agent/bot,
# else an ADR-0055 agent approval would defeat the human-merge property.
/.claude/                       @usirin
/.github/                       @usirin
/skills/ship-it/                @usirin
/skills/review-code/            @usirin
/skills/review-doc/             @usirin
/skills/review-plan/            @usirin
/skills/gh-issue-intake-formats.md  @usirin
```

`require_last_push_approval: true` is also set so a control-plane PR amended after approval must
be re-approved (an approval cannot be inherited across a new control-plane head).

The solo-operator self-approval constraint **does not bite here**, and that is the point:
control-plane PRs are *already* human-merged by hand under 0053/0065 — they were never in the
autonomous self-approve lane. CODEOWNERS-required review formalizes the human hand that is
already required; it does not impose self-approval on the operator's own *non*-control-plane
PRs, because CODEOWNERS only triggers required review when the diff touches an owned path.
A non-control-plane PR touches no CODEOWNERS path, so `require_code_owner_review` is vacuously
satisfied and the autonomous lane (gated by §1's status checks) is untouched.

### 3. Ruleset-as-code over click-ops; CODEOWNERS is already code

The `required_status_checks` + `require_code_owner_review` ruleset changes are specified as a
**committed ruleset definition** the repo applies (durable, diffable, reviewable — and itself
control-plane, so a human merges it), rather than a one-off Settings/UI edit. A manual UI edit
is invisible to review and silently drifts; a committed ruleset is the same repo-as-config
discipline ADR [0062](0062-repo-as-config-plugin.md) applies elsewhere. `CODEOWNERS` is a
checked-in file by definition and lives under `.github/` (itself control-plane), so its own
edits are human-merged — the boundary protects its own owner-list.

### Why not the alternatives

- **Accept honor-system, harden `ship-it` discipline only (status quo).** Rejected: it leaves
  the security boundary with **no technical backstop**. `ship-it`'s refusal is real but
  bypassable by any other `write` actor's `gh pr merge`; the boundary is a security boundary
  precisely against a misbehaving/compromised actor, which is exactly the actor that ignores
  `ship-it`. Discipline reduces accidents but cannot enforce against the threat the boundary
  exists for. #382 is filed *because* discipline is insufficient.
- **Required approvals (`required_approving_review_count >= 1`) on all PRs.** Rejected as the
  general lever: it breaks the autonomous non-control-plane lane under the solo-operator
  constraint (an operator can't approve their own PR), the reason 0048/0055 use markers, not
  reviews. Required *reviews* are adopted **only** for the control-plane subset via CODEOWNERS
  (§2), where a human merge is already mandatory.
- **Manual Settings/ruleset UI edits.** Rejected per §3 — undurable, unreviewable, drift-prone.
- **A required status check fed by the review verdict itself** (so a no-PASS merge is blocked).
  Deferred, not adopted: today the verdict is a PR comment marker, not a check run, so making it
  a *required check* would require a verdict-emitting check producer (a Action or app posting a
  check-run conclusion) — net-new machinery. §1's required gating-check set already blocks the
  no-green-CI merge; binding the *verdict* as a required check is a strictly additive, separately
  scoped hardening filed as the follow-up below.

## Consequences

- **The boundary gains a platform backstop.** After enactment, GitHub blocks a no-green-CI
  merge (§1) and a no-human-approval control-plane merge (§2) — the two bypasses #382 names.
  The boundary stops being honor-system; `ship-it`'s skill-level gate becomes defense-in-depth
  *over* a platform gate, not the sole gate.
- **The autonomous lane is preserved.** Non-control-plane PRs satisfy the required status
  checks via CI (no self-approval needed) and trigger no CODEOWNERS review (they own no
  control-plane path), so the `write-code → review-code → ship-it` autonomous loop is unchanged.
- **The control plane stays *human*-merged, soundly.** CODEOWNERS approval is required and
  scoped to a **human-only** owner, so the ADR 0055 agent-inclusive ACL cannot satisfy it — the
  one way "required approvals" could have undermined 0053/0065 is closed by construction.
- **`ship-it` is unchanged by this ADR.** Its Step-0 control-plane refusal, ACL author-gate
  (0055), SHA-staleness check (0058), and gating-check classification (0061) all stand; this
  ADR adds a *platform* layer beneath them, it does not move the skill's logic. The required
  status check set is, by construction, the same set 0061 gates on, so skill and platform
  cannot contradict.
- **Enactment is an outward-facing governance action a human performs.** Recording the decision
  is this ADR; **applying** the `main` ruleset (`required_status_checks` + `require_code_owner_review`
  + `require_last_push_approval`) and committing `CODEOWNERS` is the mechanical follow-up below.
  The pipeline does **not** change its own GitHub enforcement settings — that is the human's act,
  consistent with the very boundary this ADR makes binding.
- **New cost.** A control-plane PR now needs an explicit human CODEOWNERS approval *in addition*
  to the hand-merge it already required (a small, deliberate friction on ~the 0053/0065 set). A
  required-check ruleset means a genuinely-green PR with a transient *required*-check flake is
  blocked until re-run — the safe direction, and `deploy (web)` (the known flake) is excluded so
  it never gates.
- **Follow-up filed:** the mechanical config change (apply the ruleset + commit CODEOWNERS) and
  the deferred verdict-as-required-check hardening are tracked in
  [#402](https://github.com/kamp-us/phoenix/issues/402) (`status:needs-triage`, milestone
  "Pipeline hardening").
- **Banned:** treating the control-plane boundary as enforced by `ship-it` alone once this is
  enacted; a CODEOWNERS owner for the control-plane paths that is an agent/bot or an
  agent-inclusive team (it would defeat the human-merge property via ADR 0055); imposing
  `required_approving_review_count >= 1` on all PRs (breaks the solo-operator autonomous lane);
  adding any CI-suite / run-evidence check to an *informational* exclusion (the required set and
  ADR 0061's denylist are complements, never overlapping); enacting the ruleset/CODEOWNERS by
  click-ops UI edit instead of committed config.
- **Relationship:** makes ADRs [0053](0053-control-plane-boundary.md)/[0065](0065-gate-critical-skills-are-blocking.md)
  **binding at the platform** (they defined the boundary; this enforces it). Reconciles with
  [0055](0055-acl-sourced-review-authz.md) by separating the two authz questions (verdict-author
  ACL stays agent-inclusive; control-plane approval is human-only). Realizes the
  required-status-checks composition [0061](0061-ship-it-gating-check-set.md) anticipated, using
  exactly its gating set. Preserves the solo-operator marker reality of
  [0048](0048-ship-it-merge-actor.md) by choosing required *checks* (not reviews) for the
  general lane. Applies the repo-as-config discipline of [0062](0062-repo-as-config-plugin.md)
  to the ruleset itself.

---
id: 0151
title: A §CP PR's approval-aware enqueue resolves the reviewed head from the advisory body's canonical Reviewed-head line — deterministic, without a bindable first-line marker
status: accepted
date: 2026-07-04
tags: [pipeline, ship-it, review-skill, review-doc, control-plane, security, agents]
---

# 0151 — §CP approval-aware enqueue resolves the reviewed head from the advisory body

## Context

ADR [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md) amended ADR
[0053](0053-control-plane-boundary.md)'s human-hand-merge model into **approve-then-enqueue**: a
control-plane (§CP) PR with a current-head `@kamp-us/control-plane` team APPROVE plus green
machine gates is **enqueued by `ship-it`**, not left for a hand-merge.

That amendment collided with ADR [0111](0111-blocking-set-verdicts-sha-less-by-design.md). For a
§CP PR, `review-skill` / `review-doc` emit the **canonical SHA-less advisory line** (§6.6) — no
first-line `@ <sha>` **by design**, so the verdict never enters `ship-it`'s
`PASS @ <sha> — merge-ready` auto-merge namespace (that omission is precisely what makes `ship-it`
refuse to auto-merge the control plane under ADR 0053). ADR 0111 kept the head-binding evidence in
the verdict **body** (a reviewed-head SHA + the per-AC PASS table), for a human or delegated
control-plane merge actor to read.

`ship-it` Step 2 resolves each present class's verdict from its namespace and requires a
current-head PASS in each. Its `review-skill` / `review-doc` resolution matched **only** a
first-line bindable `review-skill: PASS @ <sha>` marker and stated outright that the advisory line
"carries no `@ <sha>` and is **not** a PASS." So under ADR 0135 a §CP **skills-class** (or
docs-class) PR reached Step 2 with an advisory-only namespace, which the enqueue path could not
resolve — even with a valid control-plane approval at head and green CI.

The failure mode was not merely "always refuses" — it was **nondeterministic**. With no defined,
parseable resolution for the advisory namespace, structurally-identical §CP PRs resolved
differently depending on which reading a shipper instance improvised: some treated the team APPROVE
as the go-ahead and enqueued (PRs #2010/#2004/#2009/#2011/#2001), one refused
`unverified (no review-skill PASS)` on the identical structure (PR #2005) until a marker was
hand-posted. That hand-posted-marker workaround is **gate-weakening** — a bindable
`review-skill: PASS @ <sha>` on a §CP PR drops the verdict into `ship-it`'s auto-merge namespace,
the exact §CP self-weakening ADR 0053/0065/0150 exists to prevent — and must be made **unnecessary**,
not adopted.

The root ambiguity: ADR 0111 said the reviewed SHA "lives in the body" but never pinned a
**canonical, parseable form** for it. Real advisories on live §CP PRs spelled it at least six ways —
`Reviewed head: \`<sha>\`.`, `Reviewed head \`@ <sha>\``, `Verdict bound to head \`@ <sha>\``,
`sourced from the PR head \`<sha>\``, `approves at head \`<sha>\``, `Skill text read from head
\`<sha>\`` — none machine-resolvable by a single anchor. A body a machine must read for an enqueue
decision needs one canonical line, not free prose.

BUG RECORD: #1932 (the higher-context reconciliation). Determinism fix-issue: #2022. Live evidence:
#2010/#2004/#2009/#2011/#2001 (enqueued) vs #2005 (refused).

## Decision

**Resolve the §CP advisory verdict's reviewed head from a canonical body line, on the `ship-it`
enqueue side — do not widen the reviewer marker contract (ADR 0111 stays intact).**

Two coordinated parts:

1. **Pin a canonical `Reviewed-head` body line in the advisory format.** Every §CP advisory
   `review-skill` / `review-doc` verdict body carries exactly one machine-parseable line recording
   the reviewed head SHA:

   ```
   Reviewed-head: @ <HEAD_SHA>
   ```

   This is a **body** line, not the first line — the first line stays the SHA-less canonical
   advisory marker (`review-skill: advisory — blocking-set PR (manual merge)`), so the verdict still
   **never** enters `ship-it`'s `PASS @ <sha> — merge-ready` auto-merge namespace (ADR 0111
   preserved). The `Reviewed-head:` prefix is a **distinct token** from the first-line
   `review-(skill|doc): PASS @ <sha>` marker, so `ship-it`'s existing PASS-namespace matchers do not
   match it and a §CP advisory can never be mistaken for an auto-mergeable PASS. §6.6 mandates the
   line and the anchored matcher; `review-skill/SKILL.md` and `review-doc/SKILL.md` emit it in their
   advisory templates.

2. **Teach `ship-it` Step 2's §CP path to resolve the advisory namespace deterministically.** For a
   §CP PR whose latest `review-skill` (or `review-doc`) namespace verdict is a **current-head
   advisory**, `ship-it` resolves the reviewed head from the body's canonical `Reviewed-head: @ <sha>`
   line and treats the namespace as satisfied **iff**:

   - (a) the body's `Reviewed-head: @ <sha>` **prefix-matches the PR's current head** (the same
     ADR [0058](0058-sha-bound-verdict-contract.md) freshness test the first-line markers get — a
     stale body SHA is refused), **and**
   - (b) **every** per-AC / per-rigor / per-hygiene checkbox in the body is `[PASS]` (no `[FAIL]`
     present — the recorded verdict is a clean pass), **and**
   - (c) Step 0's current-head `@kamp-us/control-plane` team approval is present (the human-judgment
     gate ADR 0135 already requires).

   All three hold → the §CP namespace is resolved as an enqueue-eligible current-head PASS-equivalent.
   Any one missing or stale → a **deterministic refuse with a named reason**
   (`unverified (§CP advisory reviewed-head stale)`, `unverified (§CP advisory not all-PASS)`,
   `awaiting control-plane approval`). The outcome is a pure function of the PR's state (body
   `Reviewed-head` SHA + per-AC PASS + approval@head + CI), never of which shipper instance runs.

This resolution path is **§CP-only** and is reached only after Step 0 has classified the PR §CP and
its approval gate has passed. The **non-§CP path is unchanged**: a non-§CP skills/docs/code PR still
requires a bindable first-line `review-(skill|doc|code): PASS @ <sha>` marker (or a native APPROVE
for code) — a §CP PR must **never** require, nor be satisfied by, a bindable marker (that would drop
it into the auto-merge namespace — the ADR 0111 hazard).

### Why body-resolution, not a bindable §CP marker (reconciling #1932's candidate direction 2)

#1932's decision comment floated "emit a bindable `review-skill: PASS @ <sha>` gated behind the
control-plane approval" (its candidate 2 — amend the marker contract). #2022 chose the more
conservative body-resolution route, which this ADR records. Body-resolution:

- **Does not widen ADR 0111.** The advisory first line stays SHA-less; no new bindable marker
  surface exists; a §CP verdict is still structurally excluded from the auto-merge namespace. A
  bindable §CP marker (candidate 2) would re-introduce exactly the ADR-0111-rejected Option 2 — a
  first-line signal that *looks* machine-bindable for merge, inviting an automated actor to
  auto-merge control-plane PRs and eroding ADR 0053.
- **Reuses ADR 0111's own mechanism.** ADR 0111 already says a delegated control-plane merge actor
  confirms by reading the body's `@ <sha>` + per-AC PASS. This ADR makes that same read
  **deterministic and machine-executable** by pinning its form — `ship-it`'s approval-aware enqueue
  *is* a delegated merge actor acting on the maintainer's current-head APPROVE, so it reads the body
  the way ADR 0111 prescribes, only now against a canonical anchor instead of free prose.

### The two-person control and the §CP boundary are unchanged

The enqueue still requires the `@kamp-us/control-plane` team APPROVE at head (ADR 0135's human
gate — a member cannot approve their own §CP PR, so the OTHER member must). CI-green (Step 3), the
run-evidence bundle (Step 3.5), SHA-staleness (Step 2b), and single-merge-authority (ADR 0048) all
still apply. The body-`Reviewed-head` resolution replaces an **ambiguous, improvised** namespace read
with a **defined** one; it adds no merge authority the approval + machine gates did not already
confer, and it removes none of the guards. The code-class §CP path (native-APPROVE-folds-in-as-
review-code-PASS) is untouched.

## Consequences

- `claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md` Step 2 gains a §CP-only advisory
  resolution: for a §CP PR whose `review-skill` / `review-doc` namespace verdict is a current-head
  advisory, resolve the reviewed head from the body's `Reviewed-head: @ <sha>` line, require all-PASS
  in the body + the Step 0 approval, and enqueue — else refuse deterministically with a named reason.
  The advisory-is-not-a-PASS statement is scoped to the **non-§CP** case; the §CP case now has a
  defined enqueue path.
- `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` §6.6 mandates the canonical
  `Reviewed-head: @ <HEAD_SHA>` body line for every §CP advisory verdict and states the anchored
  matcher `ship-it` uses to read it. The first-line advisory marker is still SHA-less by design.
- `review-skill/SKILL.md` and `review-doc/SKILL.md` advisory templates emit the canonical
  `Reviewed-head: @ <HEAD_SHA>` line, replacing the free-prose "reviewed head" sentences whose drift
  caused the nondeterminism.
- A §CP skills/docs PR with a current-head control-plane approval + green gates now reaches
  `ship-it`'s enqueue **deterministically** — the #1932 self-block (the pipeline could not ship its
  own gate repairs) and the #2022 nondeterminism (#2005-vs-#2010 split) both close. No PR ever needs
  a hand-posted bindable `review-skill: PASS @ <sha>` to unblock — that gate-weakening workaround is
  now unnecessary and remains forbidden.
- ADR 0111's invariant holds unchanged: §CP verdicts are SHA-less in the first line, the SHA is bound
  in the body, no first-line bindable §CP marker exists. This ADR refines **how the body binding is
  written and read** (a canonical anchor), and refines ADR 0135's enqueue precondition for the §CP
  advisory namespaces; it supersedes neither.

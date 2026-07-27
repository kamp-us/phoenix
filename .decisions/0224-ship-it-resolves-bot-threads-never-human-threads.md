---
id: 0224
title: ship-it may resolve a bot-authored review thread with rationale, never a human's — unknown author is human
status: accepted
date: 2026-07-27
tags: [pipeline, ship-it, review-code, control-plane]
---

# 0224 — ship-it may resolve a bot-authored review thread with rationale, never a human's — unknown author is human

**What this decides:** The shipper is allowed to close out a *bot's* review comment by itself (with a written reason), but it is never allowed to close out a *person's* review comment — and if it cannot tell which one it is looking at, it must treat it as a person's.

## Context

ADR [0158](0158-unresolved-review-thread-is-a-merge-gate.md) made an unresolved inline
review thread a merge gate and gave `ship-it` a **judgment-gated, author-blind**
disposition over every such thread: substantive → refuse and route back; genuine nit →
resolve-with-explicit-rationale; in doubt → substantive. The author-blindness was
deliberate, not an omission — 0158's own title reads "human or bot" and its §Decision 1
puts the two on the same footing, with *post-hoc audit* (the mandatory rationale reply) as
the control.

This amends that clause in part. Three facts moved since 0158 was written:

- **The platform flag is now live.** Read live over REST on ruleset `17377992`
  (`main protection`, target `branch`, enforcement `active`), the `pull_request` rule
  carries `required_review_thread_resolution: true`. 0158 recorded it as `false (OFF)` and
  founder-gated. It has since been flipped, so 0158's stated deadlock precondition is real
  today: `ship-it`'s resolve is the **only** mechanism in the pipeline that can clear a
  thread and let a PR enqueue.
- **No net catches a *wrongly resolved* thread.** The
  `unresolved-threads-guard` CI job and the platform flag both key on the *live-unresolved*
  set; a resolved thread drops out of that set entirely, so neither can see a resolution
  that should not have happened. The mandatory rationale reply is an after-the-fact audit
  trail, not a block.
- **Code-owner approval does not cover the ordinary PR.** With
  `required_approving_review_count: 0` and a `.github/CODEOWNERS` that enumerates paths
  with no `*` catch-all, a PR touching no enumerated path needs zero approvals. On such a
  PR a human's unresolved inline thread is the *only* human block on the merge — and
  today `ship-it` may clear it.

The founder ruled on the substance (bots yes, humans never); the chief-of-staff ruled on
implementability and sequencing under ADR
[0078](0078-product-driven-decisions-by-default.md), which makes the agent pipeline
engineering-led. This ADR records both rulings; it does not re-open either. Filed as issue
#4408.

The **wider** change considered and **rejected**: reducing the disposition to "any
unresolved thread → refuse, route back." With the flag live that removes the only mechanism
able to clear a lint-bot nit, parking every PR carrying one with nothing able to unpark it
— the exact deadlock 0158 sequenced around. Bot-resolve is what makes the flag survivable;
human-resolve is the part that should never have been granted.

Amends ADR [0158](0158-unresolved-review-thread-is-a-merge-gate.md) §Decision 3 in part —
0158's §Decisions 1, 2 and 4 stand unchanged, and its decision text is untouched.

## Decision

**`ship-it` may resolve a bot-authored review thread with an explicit written rationale,
may never resolve a human-authored one, and must treat any thread whose author class it
cannot derive as human-authored.**

0158 §Decision 3's substantive-vs-nit judgment is now **subordinate to author class**. The
class is evaluated first:

1. **Bot-authored thread** → the 0158 §Decision 3 disposition applies unchanged. Substantive
   → refuse and route back. Genuine nit → `ship-it` **may** resolve it, but **only** with an
   explicit written rationale reply saying why it is a nit. In doubt → substantive. This is
   where the deadlock pressure comes from and where the relief stays.
2. **Human-authored thread** → **always** refuse and route back. There is no nit exception,
   no in-doubt branch, and no override: the class decides. `ship-it` has no authority to
   dismiss a person's objection under any circumstance.
3. **Author class not derivable → the human branch.** Unknown is human. This is the
   fail-closed default and it is load-bearing (ADR
   [0092](0092-gates-fail-closed-on-zero-scope.md)'s posture applied to a discriminator
   rather than a scope). It settles the `Mannequin` / `Organization` / null-author-on-a-
   ghosted-account cases **by construction rather than by enumeration**: only a *positive*
   derivation of the bot class unlocks branch 1; everything else — an unrecognised actor
   type, a null author, a failed or empty read, an ambiguous integration — lands in
   branch 2. The failure mode is a wasted round-trip, never a dismissed objection.

**`review-code`'s surfacing is deliberately left author-blind and unchanged.** 0158
§Decision 4 has `review-code` list unresolved threads in its verdict table as `[FAIL]`
rows. Surfacing is not dismissing: making an objection *visible at the gate* is safe for
every author class, and splitting it by class would hide bot threads that a human reviewer
may well want to see. This is a decided-and-unchanged outcome, not an oversight.

**The `--auto` bypass caveat is ruled an edge case; the flag is trusted.** 0158's
Consequences held the platform gate untrusted-as-sole-gate pending a definitive live test
(enable → throwaway PR with one unresolved thread → confirm it cannot enqueue) against the
2022 `gh pr merge --auto` bypass bug that GitHub reported fixed. The founder judged that
bypass an edge case. **That live test was not run and is not being run** — recorded plainly
rather than implied. The consequence is that `ship-it`'s thread read becomes
**defense-in-depth rather than the primary gate**: the platform flag is the primary gate,
`ship-it` is the second layer, and the open item 0158 left founder-gated is closed by
judgment, not by evidence.

**Binding constraints.**
- Only a positive derivation of "bot" may unlock the resolve path; every other outcome is human.
- A bot-thread resolution still requires the explicit written rationale reply of 0158 §Decision 3.
- No flag, prompt, operator instruction, or judgment call may move a human-authored thread out of the refuse branch.

**Banned.**
- Resolving a human-authored thread, for any reason.
- Inferring "bot" from a login suffix, a name pattern, or an allowlist of known bots as a substitute for a real class derivation.
- Shipping the mechanism half while the discriminator's availability is unverified (see the open question below).

### Open question — the discriminator, and what it gates

**How `ship-it` derives author class is not settled as fact by this ADR, and this ADR does
not assert that it is derivable.** The sanctioned GraphQL `reviewThreads` read of 0158
§Decision 2 already selects `comments(first:1) { nodes { author { login } body } }`, so an
author *identifier* is available with no query change. The schema-correct way to get the
*class* is `author { __typename }` — `author` is GitHub's `Actor` interface, whose concrete
types include `User` and `Bot` — but **that selection has not been verified against this
org's `reviewThreads` query**, and a GitHub App's review comments can surface as `Bot` or as
`User` depending on the integration. Verifying it is a separate, in-flight investigation.

The doctrine above holds either way, because rule 3 covers non-derivability by
construction. What the open question gates is the **mechanism**:

- **If author class is derivable** — the `ship-it` skill edit implements the three-way split
  as written.
- **If it is not** — **the skill edit does not proceed as written.** The honest fallback is
  that `ship-it` resolves **nothing**, accepting the bot-nit deadlock until a discriminator
  exists. A rule keyed on a field that does not resolve is worse than today's state: it
  would read as narrowed while behaving author-blind.

### Sequencing — doctrine first, mechanism second

**This ADR lands before the `ship-it` skill edit, and the skill edit is a separate PR.** The
two halves sit under different gates: `.decisions/**` is not control-plane by path, so this
is an ordinary doc PR; `claude-plugins/kampus-pipeline/skills/ship-it/` is enumerated in
`.github/CODEOWNERS`, so the skill edit banks for a control-plane approval (ADRs
[0053](0053-control-plane-boundary.md) /
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)). A
gate-critical skill that narrows its behaviour *ahead of* the doctrine authorising the
narrowing is a skill contradicting an accepted ADR — precisely the defect #4394 exists to
fix. The mechanism PR must also be sequenced against #4405, which edits a different span of
the same file.

## Consequences

- **A human's inline objection is no longer machine-dismissible.** The only remaining ways
  past it are addressing it or a human resolving it. On an ordinary PR that touches no
  code-owner path, that restores the one human veto the pipeline had left.
- **The bot-nit deadlock relief survives.** With `required_review_thread_resolution` live,
  the resolve path is load-bearing for throughput; narrowing by class keeps it exactly where
  the lint traffic is.
- **The cost is round-trips, deliberately.** Every underivable author becomes a route-back.
  If the discriminator is noisy, the pipeline pays cycles — which is the intended direction
  of the error.
- **`ship-it` keeps a judgment call, but a smaller one.** The substantive-vs-nit judgment now
  applies only inside the bot branch, so a misjudgment can no longer discard a person's
  objection.
- **The platform flag is now the primary gate, on judgment rather than a test.** If the 2022
  `--auto` bypass is not in fact fixed, the pipeline-native read is still there as the second
  layer — but the ADR-0158 precondition for trusting the flag was waived, not met, and a
  future reader should know that.
- **This ADR is not §CP; the follow-up is.** This PR adds one file under `.decisions/` and
  nothing else — no skill, agent, code, `.github/`, or `.claude/` change, and no CODEOWNERS
  row. The mechanism PR is where the control-plane approval is owed.
- **Stale text in ADR 0158 is corrected here, not there.** 0158 records the flag as
  `false (OFF)` and founder-gated; that is stale against the live `true` read above. An
  accepted ADR's body is immutable, so the correction lives in this ADR and 0158 carries only
  an `amended-in-part` status line pointing here.

## Records

- Reshapes #4408 (the ADR half only; the `ship-it/SKILL.md` mechanism half is a separate,
  later PR gated on the discriminator investigation).
- Amends ADR [0158](0158-unresolved-review-thread-is-a-merge-gate.md) §Decision 3 in part;
  0158's status line is set to `amended-in-part by [0224](0224-ship-it-resolves-bot-threads-never-human-threads.md)`
  and its body is untouched.
- **Vocabulary impact — no `.glossary/TERMS.md` change.** This ADR names two mechanics —
  a review thread's **author class** (bot / human / underivable) and the **unknown-is-human**
  fail-closed default. Both are narrow, self-defining refinements of the gate vocabulary ADR
  0158 already coined (unresolved review thread, substantive-vs-nit), not new domain nouns,
  so they are defined here at their coining site and at the skill's use site rather than
  earning a glossary row — the same call ADR 0158 made for its own terms.

---
id: 0143
title: "Reject phoenix[bot] pipeline authorship — a bot-authored §CP PR enables a zero-human self-merge (agent authors as the bot AND approves as usirin); #1875 author≠approver is a security invariant, not a bottleneck; supersedes 0140 + 0142"
status: accepted
date: 2026-07-03
tags: [pipeline, control-plane, governance, security, github-app, ship-it, rejection]
---

# 0143 — Reject phoenix[bot] pipeline authorship: it opens a zero-human §CP self-merge

## Context

ADR [0140](0140-phoenix-bot-authors-pipeline-prs-team-cp.md) decided that a `phoenix[bot]` GitHub App would author pipeline PRs, making §CP approvable by any `@kamp-us/control-plane` member on the premise that the bot's distinct authorship turns every human into a valid *non-author* approver. ADR [0142](0142-bot-credential-resolution-convention.md) defined the bot-credential resolution convention that served it. Epic #1934 was provisioning the App, and #1940 already cut `write-code` over to bot authorship (landed on `main`).

The premise is a **security hole** (verified, #1961). The unexamined fact underneath it: **agents run `gh` authenticated as `usirin`.** So one agent can BOTH open a §CP PR as the bot AND post the approval as `usirin` — a fully-automated, **zero-human control-plane merge**. Bot-authorship removed the only structural block on §CP self-approval — **#1875's author≠approver invariant** (GitHub forbids a PR's author from approving it). ADR 0140 reframed that invariant as a scaling annoyance ("a specific second human is conscripted") and designed it away. But with the human moved off the author line, the human's approval counts *and the agent is that human's `gh` identity* — so "a human approves" collapses to "the automation approves as the human." The two-human §CP gate becomes zero-human. That reframing was the error: **#1875 (author≠approver) is a security invariant, not a bottleneck.**

## Decision

**Reject the phoenix[bot] pipeline-authorship direction.** `phoenix[bot]` does not author pipeline PRs. This ADR **supersedes ADR 0140 and ADR 0142**, both of which rest on the rejected premise.

- Pipeline PRs are authored **as `usirin`** (the pre-#1940 state), which preserves author≠approver: a `usirin`-authored §CP PR cannot be approved by `usirin`, so a §CP merge still requires a genuinely different human (`cansirin`, or another control-plane member acting in person). The two-human gate holds.
- The live hole was **closed by #1962** (merged at 05:25Z, commit `8c581fab` — reverts #1940, restoring `usirin` PR-authorship). Per the teardown discipline #1962 was authored **as `usirin`** and **hand-merged by a human** — deliberately NOT auto-shipped and NOT agent-approved, so the fix did not use the hole to close the hole.

## The invariant, stated plainly

> A §CP merge must involve **two distinct humans**: an author and a different approver. Any mechanism that lets one actor occupy both roles — including a bot author whose approval is posted by the *same automation* that authored the PR — defeats the gate. #1875 (author≠approver) is the enforcement point and is load-bearing for control-plane security. Do not remove it without a mechanism that provably keeps the author and approver as two different humans, verified against exactly this attack.

## Forensic — the capability was live but NOT exploited

#1940 was on `main`, so the zero-human capability was **live** during the window. It was **not exploited**: the §CP bot PRs in that window (#1953, #1959) were **personally approved by umut in-chat** (his own explicit statements) — real human approvals, never agent-as-`usirin`. No zero-human §CP merge occurred. #1962 (merged) removed the capability.

## Consequences

- **0140 and 0142 are superseded** (each marked `status: superseded by [0143]` with a back-link); their decisions do not stand.
- **Teardown (epic #1934), in order:** revert #1940 first (#1962 — the hole-closer, human-hand-merged); then unwind the mint infra (#1938 helper, #1959) and keep #1941/#1942 frozen; the `phoenix[bot]` App is left dormant or deleted (harmless once #1940 is reverted). #1934 and its children close; #1926 (the decision #1940 served) is superseded by this ADR; #1951 (the CF token-broker rung-3 follow-up) is moot.
- **What survives:** the pain #1926 named is real — every agent PR authored by `usirin` forces a *specific* second human onto §CP. But relieving it is **not** worth a zero-human hole. Any future attempt must preserve the two-distinct-humans invariant (e.g. an author identity whose approval channel is provably not the same automation, or a different gate design) and must be tested against this exact self-merge attack before adoption.

---
id: 0111
title: Blocking-set (§CP) review verdicts are deliberately SHA-less in the first line — the SHA is bound in the body, and a delegated control-plane merge actor confirms by reading the body, not the first-line marker
status: accepted
date: 2026-06-27
tags: [pipeline, ship-it, review-skill, review-doc, control-plane, security, agents]
---

# 0111 — Blocking-set (§CP) review verdicts are deliberately SHA-less in the first line

## Context

A human-delegated merge actor — an operator hand-merging a banked control-plane PR on the
maintainer's authority, applying `ship-it`'s just-in-time guards (verdict bound to head +
mergeable + no failing required check) — tried to **mechanically bind** the `review-skill`
verdict on a §CP PR (#974, head `a70a25c`) to its head SHA and failed. The verdict's first
line was:

```
review-skill: advisory — blocking-set PR (manual merge)
```

which the canonical `review-skill: PASS @ <sha> — merge-ready` matcher does not match — so a
mechanical consumer read it as `unverified`, even though the verdict **body** carried a clean,
head-bound PASS (re-review `@ a70a25c`, every AC + every gate-invariant marked `[PASS]`).

This is **not** a `review-skill` bug. The SHA-less advisory form is by design (#977's triage
confirmed it against the contract). For a PR in the **control-plane / blocking set** (§CP),
`review-skill` and `review-doc` intentionally emit the SHA-less advisory line and suppress the
canonical `PASS @ <sha> — merge-ready` marker (ADR
[0073](0073-review-skill-gate.md) §5 converged all three gates on this one advisory shape; the
contract states it in [`gh-issue-intake-formats.md`](https://github.com/kamp-us/phoenix/blob/main/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md)
§6.6). The reason is structural: the advisory line **carries no first-line `@ <sha>` on
purpose** so the verdict never enters `ship-it`'s `PASS @ <sha> — merge-ready` namespace — which
is exactly what makes `ship-it` refuse to auto-merge a control-plane PR (ADR
[0053](0053-control-plane-boundary.md)). The design assumes a **human reads the verdict prose**
for the control-plane path, not a machine binding a first-line marker.

The friction #977 surfaced is narrow: a *delegated* merge actor (vs. the maintainer reading the
PR by eye) wanted a bindable first-line signal the design deliberately withholds. The verdict
body **does** record the reviewed head (`@ <sha>`) and the per-AC PASS table — the binding
evidence exists; it just lives in the body, not in a first-line marker a `ship-it`-style matcher
can pick up.

This decision records the choice between two reconciliations, extending ADR
[0058](0058-sha-bound-verdict-contract.md) (SHA-bound verdict contract) and ADR 0053
(control-plane boundary / `ship-it` refuses control-plane).

## Decision

**Keep the design; document the contract (Option 1 — document-as-intentional).**

A §CP / blocking-set `review-skill` and `review-doc` verdict is **deliberately SHA-less in its
first line**. The head SHA the reviewer inspected is recorded in the verdict **body** (the
re-review `@ <sha>` line + the per-AC PASS table), never as a first-line `@ <sha>` marker. This
is intentional and load-bearing:

- It keeps the verdict **out of `ship-it`'s `PASS @ <sha> — merge-ready` namespace**, so
  `ship-it` refuses to auto-merge the control-plane PR (ADR 0053). A first-line bindable PASS
  would be exactly the signal `ship-it`'s matcher consumes — re-introducing it would invite
  automated §CP merging and erode 0053.
- A **delegated or human control-plane merge actor confirms the verdict by reading the body** —
  the `@ <sha>` against the PR's current head plus the per-AC PASS — **not** by matching the
  first-line PASS marker. The merge actor still applies `ship-it`'s just-in-time guards (head
  freshness, mergeable, no failing required check) at merge time; it sources the head-binding
  evidence from the body, where the SHA-binding of ADR 0058 is preserved.

`review-skill` and `review-doc` stay **symmetric** — both emit the same SHA-less advisory line
for §CP PRs, both record the binding `@ <sha>` evidence in the body.

### Rejected alternative — a namespace-isolated bindable first-line SHA (Option 2)

Emit the advisory line **with** a first-line `@ <sha>` in a new marker shape that a delegated
actor can bind but that `ship-it`'s PASS-namespace matcher still ignores. **Rejected:** it adds
a new marker surface + a matcher carve-out, and — most importantly — it makes §CP verdicts
*look* machine-bindable for merge, which invites an automated actor to auto-merge control-plane
PRs and erodes the very boundary ADR 0053 draws. The friction it would relieve (one delegated
actor's bind attempt) is a per-event re-derivation a human reads in seconds; the marker surface
it would add is permanent. The cheaper, safer fix is to **document the contract** the report
found ambiguous, not to widen the marker namespace.

## Consequences

- The advisory contract is now stated explicitly where the actors read it:
  `gh-issue-intake-formats.md` §6.6, `review-skill/SKILL.md`, and `review-doc/SKILL.md` all say
  the §CP advisory line omits the first-line `@ <sha>` **by design**, that the SHA is bound in
  the body, and that a delegated control-plane merge actor confirms by reading the body
  (`@ <sha>` + per-AC PASS), never the first-line marker.
- No marker shape changes; no matcher changes; `ship-it`'s control-plane refusal is unchanged.
  ADR 0058's SHA-binding still holds — the binding evidence is in the body, which is where a §CP
  verdict's head attestation has always lived.
- A delegated merge actor's runbook is: read the verdict body, confirm `@ <sha>` matches the
  PR's current head and every AC is PASS, then apply `ship-it`'s just-in-time guards and merge by
  hand. The first-line advisory marker is informational (it flags "this is §CP, a human merges"),
  not the bind target.

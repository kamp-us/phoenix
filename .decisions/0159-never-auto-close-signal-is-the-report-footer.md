---
id: 0159
title: The never-auto-close signal is the report footer, not GitHub authorship
status: accepted
date: 2026-07-05
tags: [pipeline, triage, control-plane]
---

# 0159 — The never-auto-close signal is the report footer, not GitHub authorship

## Context

Triage's Step 5 protects human-filed issues from being auto-closed: an autonomous
agent (an audit or kill-sweep) must never silently close an issue a human owns. That
protection needs a reliable **human-vs-agent-filed** signal — and GitHub issue
authorship is **not** one.

Every issue filed through the `report` → `triage` skills goes through the shared
`usirin` gh token, so **all agent-filed issues show `author: usirin` — identical to a
genuinely hand-typed issue** (the same shared-login degeneracy ADR
[0115](0115-agent-distinguishable-claim-marker.md) removes for the claim marker). Any
protection that keys off `author == usirin` classifies *everything* as human-filed and
over-protects the whole board into un-closeable, defeating the sweep; keying off
`author != usirin` silently bypasses the protection. Authorship is unusable either way.

The reliable signal already exists: the `report` skill emits a
`<sub>Filed by an agent · …</sub>` footer
(`claude-plugins/kampus-pipeline/skills/report/footer.sh`). Its **presence** means the
issue was filed via the report skill; its **absence** means it was hand-typed in the
GitHub UI. This footer rule already held operationally as an interim convention — we're
codifying it, not inventing new behavior.

There is one load-bearing residual: a **human-invoked `/report` also emits the footer**.
So the footer signals "filed via the report skill," *not* "agent intent." That leaves a
fork the decision must settle — how to distinguish "a human wants this protected" from
"an agent filed this" on the footer-present path:

1. **Option 1 — a distinct human-invoked marker** (a separate footer token / env flag
   set when a human runs `/report`), so the report-skill path carries the human-vs-agent
   bit explicitly.
2. **Option 2 — accept "footer present ⇒ auto-close-eligible after confirmation,"** and
   rely on the confirmation step for the human-owned report case.

## Decision

**The never-auto-close signal is the report footer, with this semantic:**

- **Footer ABSENT** (the issue was hand-typed in the GitHub UI) ⇒ **human-owned ⇒
  PROTECTED**: never auto-close.
- **Footer PRESENT** (filed via the report skill, *including* a human-invoked `/report`)
  ⇒ **raw INTAKE ⇒ auto-close-ELIGIBLE after confirmation.**
- **The confirmation step IS the guard** on the footer-present path.

The literal **`Filed by an agent`** marker is the invariant tell; the footer's
session/model/branch fields are best-effort and often absent, so a sparse footer is
still a present footer.

**We take Option 2 and reject Option 1.** A `/report` issue is intake *by nature* —
meant to be triaged and, once handled, closed; a human tracking their own thing types it
directly in the UI (where it has no footer and is therefore protected). Distinguishing
human- from agent-invoked `/report` adds ceremony to separate two things that should be
treated identically: both are raw intake, and the confirmation step already stands
between "eligible" and "closed." Building a human-invoked marker would carry a
human-vs-agent bit that no downstream consumer needs, because the confirmation guard
already covers the human-owned-report case.

This convention is encoded in two surfaces:

- **The canonical convention** — footer present/absent semantic — lands in the shared
  intake contract `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`.
  That file is control-plane per §CP / ADR
  [0053](0053-control-plane-boundary.md) / ADR
  [0065](0065-gate-critical-skills-are-blocking.md), so the coordinated PR is §CP →
  human-merge (ADR
  [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)).
- **The behavior** — the close-eligibility path that keys on footer presence — lands in
  `claude-plugins/kampus-pipeline/skills/triage/SKILL.md` Step 5 (non-§CP).

## Consequences

- **The protection has a reliable input.** An autonomous close/kill-sweep can safely key
  off footer presence: footer-absent issues are structurally excluded from
  auto-close-eligibility, so a human's hand-typed capture is never silently closed even
  when an autonomous sweep runs. Authorship is never consulted for this judgment again.
- **The confirmation step becomes load-bearing on the footer-present path.** "Eligible"
  is not "closed" — a footer-present issue a human owns (their own `/report`) is still
  caught at confirmation. This is a deliberate choice to keep the guard where it already
  is rather than push it upstream into a new marker. A future move to a fully-autonomous,
  confirmation-free close-sweep would re-open the residual this ADR left to confirmation,
  and would need to revisit Option 1 — but that is out of scope here (the interim rule
  holds operationally; no live incident is burning).
- **No new marker, no new env flag, no `footer.sh` change.** Option 1's ceremony is not
  built. The signal is the marker `footer.sh` already emits.
- **Follow-on decisions cite this ADR** as the single source of the human-vs-agent-filed
  signal (footer, not authorship); the interim operational rule is now recorded.

*No vocabulary impact* — this ADR re-decides the mechanics of an existing protection
(the never-auto-close rule) over already-named concepts (the report footer / the
`Filed by an agent` marker); it coins no new term and redefines none.

> Amendment 2026-08-19: the paths moved with the kampus-pipeline retirement (ADR 0303); the decision is unchanged. The footer is now emitted by the `report file` verb (`claude-plugins/fabrika/skills/report/contract.md` §footer, no `footer.sh`), the intake/footer format contract lives in `claude-plugins/fabrika/skills/report/contract.md` + `claude-plugins/fabrika/skills/graduate/contract.md` instead of `gh-issue-intake-formats.md`, and the close-eligibility path is `claude-plugins/fabrika/skills/triage/SKILL.md` (provenance section) + `triage/contract.md`. Triage now reads a second agent signal alongside the footer — an author in `$FABRIKA_OPERATOR_ACCOUNTS`.

> Amendment 2026-08-21: **the never-auto-close rule is narrowed on the `--duplicate-of` path, and nowhere else.** The founder ruled on #6070 — [comment 5361950454](https://github.com/kamp-us/phoenix/issues/6070#issuecomment-5361950454), verbatim answer `a+c` — that `fabrika triage kill --duplicate-of <survivor>` may close a duplicate whatever its provenance, once the triager has read both issues and judged them the same observation. The ruling is recorded in full as ADR [0181](0181-unified-intake-dedup-one-deterministic-tool.md)'s 2026-08-21 amendment, (c) half; this amendment records only what it does to *this* decision.
>
> This ADR's footer-absent ⇒ PROTECTED semantic is where that rule is enforced, in `packages/fabrika-cli/src/triage/kill-verb.ts`. Read absolutely it now states a rule that is no longer whole, so: **a footer-absent filing is still protected from every close that is not a `--duplicate-of` fold**, and on the fold path the `HUMAN_FILED` refusal no longer applies. Nothing else moves. The footer remains the single source of the human-vs-agent-filed signal, authorship is still never consulted, and the confirmation guard is untouched — a human-filed fold without `--confirm` still refuses, because the fold narrows the *first* guard of the two and the second binds every close alike.
>
> **Why a fold is different from a close.** The thing this ADR protects is a human's captured observation, not the issue number carrying it. A fold posts that content onto the survivor before closing, so the observation stays live and readable; an ordinary kill ends it. That asymmetry is the whole license, which is why the narrowing is keyed on `--duplicate-of` and not on a triager's judgment that some other close is safe.
>
> **What did not change: the escape hatch stays shut.** The refusal is tested on `--duplicate-of`'s presence, never on the check's position in the sequence. Moving it below the `--confirm` check would have re-seated a flagless human-filed kill on exit `13`, and the `12`-before-`13` precedence is deliberate — the two refusals have different fixes, so a caller must read which one they hit. Every `--duplicate-of` precondition also still binds on the human path: an absent or closed survivor refuses on `7` and writes nothing. Provenance is a route around none of them. The park route (ADR 0202/0208) remains the answer for every human filing that is not a twin.
>
> Landed as #6924, with the surfaces that stated the absolute rule: `packages/fabrika-cli/src/triage/kill-verb.ts`, `codes.ts`, `command.ts`, `claude-plugins/fabrika/skills/triage/SKILL.md` and `triage/contract.md`.

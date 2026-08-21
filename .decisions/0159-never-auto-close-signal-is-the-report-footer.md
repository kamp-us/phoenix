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

> Amendment 2026-08-21: the never-auto-close rule is narrowed on the `--duplicate-of` path only. The founder's `a+c` ruling on [#6070](https://github.com/kamp-us/phoenix/issues/6070#issuecomment-5361950454) — recorded as the 2026-08-21 amendment to ADR [0181](0181-unified-intake-dedup-one-deterministic-tool.md) — licenses `fabrika triage kill <n> --confirm --duplicate-of <survivor>` to close a human-filed issue, because a fold posts its content onto an open survivor rather than discarding it, which is the thing this protection exists to prevent. Every other close of a human filing still refuses on exit `12` with the message unchanged, and the confirmation guard is untouched: a fold without `--confirm` refuses on `13`, and a human filing with neither flag still refuses on `12`, not `13`. The narrowing is conditional on the flag rather than a reordering of the provenance test, so that `12`-before-`13` precedence survives. Implemented in #6924.

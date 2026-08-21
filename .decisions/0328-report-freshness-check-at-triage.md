---
id: 0328
title: A report's freshness is checked at triage, never on the filing path
status: accepted
date: 2026-08-21
tags: [pipeline, intake, triage]
---

# 0328 — A report's freshness is checked at triage, never on the filing path

**What this decides:** the triager reads the gap at current `origin/main` before enriching an
agent-filed report, and closes it if main already fixed it; nothing on the filing path re-checks
anything, and nothing inspects the running checkout.

## Context

An agent files a report from a worktree whose skills and code were cut before some fix merged. It
sees a real-looking gap that main no longer has, and files it. Draining the queue on 2026-08-20
turned up four parked KILLs of exactly that shape in one pass —
[#6527](https://github.com/kamp-us/phoenix/issues/6527),
[#6519](https://github.com/kamp-us/phoenix/issues/6519),
[#6526](https://github.com/kamp-us/phoenix/issues/6526),
[#6512](https://github.com/kamp-us/phoenix/issues/6512). #6527's "epic integrate dead-ends on a
locked assembly branch" is answered on main by the `lane assembly` verb, which already refuses and
relocates a locked assembly tree. Each of those cost a founder ruling to kill a bug that was never
live, and each one sat in the parked pile until it got one.

The question was which layer catches it. Three placements were on the table, and they trade
differently: a check on the filing path pays on every report and stalls the one path that must never
stall; a check at triage pays only on the reports that reach the gate, where a board-read already
happens; a detector at the worktree layer is new always-on machinery that inspects the running
checkout and can only ever guess at whether the staleness matters.

The founder ruled at [#6528](https://github.com/kamp-us/phoenix/issues/6528#issuecomment-5362289611).

## Decision

**The freshness check lives in the `triage` skill's read step, and the filing path stays
unchanged.**

- **Triage re-reads the gap at main.** Before enriching an agent-filed report, the triager fetches
  and reads the named file or verb at `origin/main` — not the copy in the filer's snapshot and not
  the copy in the triager's own checkout, both of which are the same failure.
- **A superseded report is triage's to close.** A gap the artifact at main no longer has falls under
  the `superseded` clause of triage's value bar, and the triager closes it with
  `fabrika triage kill <n> --confirm`. **No founder ruling is owed for that close** — the
  [#6070 (c) ruling](https://github.com/kamp-us/phoenix/issues/6070#issuecomment-5361950454) already
  lets triage close a twin on its own judgment; this is the same judgment against main instead of
  against another issue.
- **Agent filings only.** The check keys off the same provenance signal as every other close, per
  ADR [0159](0159-never-auto-close-signal-is-the-report-footer.md).

This is the seam ADR [0181](0181-unified-intake-dedup-one-deterministic-tool.md) already picked for
intake hygiene: triage board-reads every intake issue, so the check costs zero new surface. It is
the same lazy shape as ADR
[0254](0254-ready-for-gap-closes-lazily-at-triage-time.md) — the gap closes when the issue reaches
the gate, not when it is created.

**Banned.**

- A freshness step on the `report` path. Filing never stalls, and no re-check against `origin/main`
  runs before an issue is created.
- A stale-snapshot detector — no `fabrika` verb, CI guard, or hook that compares the running
  checkout or its skill snapshot against `origin/main`.
- Closing a human filing on this axis. A human filing is parked, never killed, however plainly main
  already fixed it.

## Consequences

- A superseded agent-filed report dies at the gate for the cost of one `git show`, instead of
  sitting parked until a founder rules on it.
- Triage gets slower per agent-filed report by one fetch and one read, and it is the triager's
  judgment that decides — nothing mechanical proves the gap is gone.
- The reporting agent still files against a stale snapshot. This decision does not stop the bad
  report from existing; it stops it from costing a ruling.
- A superseded report closed here leaves no founder-visible trace beyond the kill note, so the note
  has to say what landed and where it was read.

## Records

no vocabulary impact

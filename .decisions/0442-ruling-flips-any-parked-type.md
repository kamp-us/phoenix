---
id: 0442
title: A founder ruling flips any parked issue type, and an agent audience rests on a cited ruling
status: accepted
date: 2026-09-30
tags: [fabrika, decision, pipeline-hardening]
---

# 0442 — A founder ruling flips any parked issue type, and an agent audience rests on a cited ruling

**What this decides:** `fabrika decision rule` is the route back from `ready-for:human` for every
issue type but an epic, and a flip to `ready-for:agent` on an issue whose criteria demand a founder
ruling must carry a citation to that ruling.

## Context

[#7753](https://github.com/kamp-us/phoenix/issues/7753) found that `build claim` reads the
`ready-for:` label and nothing about what the criteria demand. #7740, a `type:bug` whose first
criterion was "a founder ruling is recorded on this issue", was flipped to `ready-for:agent` by a bare
label edit with no ruling behind it. A build lane claimed it and had to back off. The citation arm
(`build claim --cites`) already binds a ruling to the flip, but only on `type:decision`.

[#8016](https://github.com/kamp-us/phoenix/issues/8016), folded into #7753, found the other side:
triage parks bugs and features on `ready-for:human` with a question for the founder, and when he
answers, `decision rule` records the marker but leaves the audience alone. So the only way back was a
hand label swap, which is the unguarded flip #7753 names.

#7753 offered four shapes: (1) extend the citation arm past `type:decision`; (2) a `build claim` axis
that scans criteria text for founder-act language; (3) the same scan at `triage apply`; (4) rule a
bare label edit as operator error and change no tooling. The count taken on #7753
([comment](https://github.com/kamp-us/phoenix/issues/7753#issuecomment-5916879980)) found 41 triaged
criteria blocks that demand a ruling. Eight are on types other than `type:decision`, and six of those
sit on `ready-for:agent` over a prose ruling with no `decision-ruled:` marker.

The founder ruled shape 1:
[the ruling comment](https://github.com/kamp-us/phoenix/issues/7753#issuecomment-5554842306). This
record transcribes that ruling; the choice is not the author's.

## Decision

**Shape 1 wins. The citation arm extends past `type:decision`, and `decision rule` flips any type.**

- **`decision rule` flips every type but `type:epic`.** It proves the marker first, then moves the
  issue from `ready-for:human` to `ready-for:agent`, on a bug, a feature or a chore exactly as on a
  decision. The marker is the citation the flip carries. The criteria guard still holds: a body with
  no readable `### Acceptance criteria` block keeps its marker and is refused on exit `4`, unflipped.
  An epic keeps its marker and its labels, because an epic's agent audience is `check-epic-plan`'s
  flip alone.
- **The fence seam is the citation arm in `build claim`'s admission**
  (`citationOpens` in `packages/fabrika-cli/src/build/scope-admission.ts`). A non-decision issue
  whose criteria demand a ruling is refused a build claim unless a ruling is cited. The ruling names
  this seam and not `triage apply`'s label write.
- **Shapes 2 and 3 are rejected.** No prose heuristic reads criteria text for founder-act language,
  at either seam.
- **Shape 4 is rejected.** #8016 showed it is a class, and a ruling-only answer strands every parked
  bug and feature with no route back.

**What the ruling left open, sent back to the founder.** Two facts the fence needs are not in the
ruling: the mechanical signal that marks a non-decision issue's criteria as demanding a ruling (the
prose scan being ruled out), and the exit code the extended arm refuses on. Both are filed as
[#10288](https://github.com/kamp-us/phoenix/issues/10288). Until it lands, the `decision rule` half
stands alone: the sanctioned flip exists for every type, and a bare label edit still passes the
claim.

## Consequences

- The triage skill's line that `decision rule` is how a human hands a parked issue back is now true
  for bugs and features, not only decisions.
- Recording a ruling on a parked, criteria-bearing issue of any type now makes it agent-pickable.
  A ruling that answers only part of what the issue parked on should be recorded after the rest is
  settled, or the issue re-parked by hand.
- The code comment that held the flip to `type:decision` cited
  [#9517's ruling](https://github.com/kamp-us/phoenix/issues/9517#issuecomment-5752597880), which
  widened the marker's subject and said nothing about the flip. That hold was the builder's caution,
  and this ruling replaces it.

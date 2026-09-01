# Dual-homed issue sweep — 33 issues resolved against ADR 0208

**Date:** 2026-08-31 · **Issue:**
[#6860](https://github.com/kamp-us/phoenix/issues/6860) · **Rule:**
[ADR 0208](../.decisions/0208-standing-lane-exemption-from-full-homing.md)

An issue has one home: an open milestone, or a standing lane label — never both.
[ADR 0208](../.decisions/0208-standing-lane-exemption-from-full-homing.md) calls `wayfinder:backlog`
and `axis:pipeline-hardening` "permanent milestone-less lanes by design", and its **Banned** list
names "Milestones on `wayfinder:backlog` fog … or on `axis:pipeline-hardening` items". The board had
drifted off that rule: issues carried a lane label and a milestone at once, and because
`planReconcile` in [`packages/fabrika-cli/src/triage/facets.ts`](../packages/fabrika-cli/src/triage/facets.ts)
emits `ClearMilestone` whenever the requested home is null, the next `triage apply` re-stamp of any
of them would silently drop one of the two homes with no sign that anything was lost.

This report records the sweep that cleared them.

## The ruling

The founder ruled the 33 dual-homed issues **individually, not as a blanket strip** — the founder
ruling comment is
[#6860 (comment)](https://github.com/kamp-us/phoenix/issues/6860#issuecomment-5489764280), reproduced
verbatim below.

> ## Founder ruling and sweep, 2026-08-31
>
> The founder ruled each of the 33 dual-homed issues individually (not a blanket strip). 23 keep their campaign milestone and lose `axis:pipeline-hardening`; 10 keep the lane and lose the milestone. Both outcomes comply with ADR 0208 (its ban is a milestone on an issue that carries the lane label). All 33 writes landed and each issue carries a comment naming what was removed. Live count of open issues with both: 0.
>
> | Issue | Kept | Dropped |
> |---|---|---|
> | #6072 | milestone | lane label |
> | #6128 | milestone | lane label |
> | #6165 | milestone | lane label |
> | #6205 | milestone | lane label |
> | #6237 | milestone | lane label |
> | #6302 | milestone | lane label |
> | #6379 | milestone | lane label |
> | #6419 | milestone | lane label |
> | #6474 | milestone | lane label |
> | #6491 | milestone | lane label |
> | #6503 | milestone | lane label |
> | #6517 | lane | milestone |
> | #6521 | milestone | lane label |
> | #6525 | milestone | lane label |
> | #6537 | milestone | lane label |
> | #6550 | milestone | lane label |
> | #6580 | milestone | lane label |
> | #6606 | lane | milestone |
> | #6611 | milestone | lane label |
> | #6613 | lane | milestone |
> | #6685 | lane | milestone |
> | #6694 | lane | milestone |
> | #6718 | lane | milestone |
> | #6719 | lane | milestone |
> | #6726 | lane | milestone |
> | #6730 | milestone | lane label |
> | #6768 | milestone | lane label |
> | #6772 | milestone | lane label |
> | #6785 | milestone | lane label |
> | #6789 | milestone | lane label |
> | #6793 | milestone | lane label |
> | #6796 | lane | milestone |
> | #6800 | lane | milestone |
>
> Remaining for this issue: the dated `reports/` file recording the sweep (criterion 3). The lane is unblocked for that.

## Why two outcomes both comply

The issue's original method proposed one move for every row: strip the milestone, keep the lane
label. ADR 0208's ban is narrower than that. It bans **a milestone on an issue that carries the lane
label** — so dropping *either* side clears it. That leaves the choice of which home an issue keeps as
a product call about where the work actually lives, and the founder made it per issue:

- **23 issues keep their campaign milestone** and lose `axis:pipeline-hardening`. These are homed
  work inside a live campaign; the lane label was residue.
- **10 issues keep the lane** and lose the milestone. These are standing pipeline-hardening work that
  never completes into an arc, exactly the class ADR 0208 carves out.

## The enumeration query and its count

The query is the one from the original report, run against the live board:

```bash
gh issue list --state open --limit 800 --json number,labels,milestone --jq \
  '[.[] | select(.milestone != null) | select([.labels[].name] | any(startswith("axis:") or startswith("wayfinder:"))) | .number] | length'
```

Counted on 2026-08-31, after the sweep: **0**.

Narrowed to the single label class this sweep covered:

```bash
gh issue list --state open --limit 800 --json number,labels,milestone --jq \
  '[.[] | select(.milestone != null) | select([.labels[].name] | index("axis:pipeline-hardening")) | .number] | length'
```

Also **0**.

Both queries are re-runnable, so a later reader can tell whether the board has drifted back rather
than taking this report's word for it.

## Trail

Every one of the 33 issues carries a comment naming what was removed and citing ADR 0208, so the
trail runs both ways: from this report to the issues, and from any swept issue back to the rule.

## Counts drift

The issue body's own numbers moved twice before the sweep landed — 75 at filing, 58 at triage, 33 at
ruling time — as sibling re-stamps cleared rows on their own. A count in this report is a
point-in-time measurement of 2026-08-31 and nothing more. Re-run the query above rather than trusting
the number beside it.

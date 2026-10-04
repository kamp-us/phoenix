---
id: 0435
title: Adding acceptance criteria after a ruling keeps the ruling marker current, never stale
status: accepted
date: 2026-09-30
tags: [fabrika, decision, pipeline-hardening]
---

# 0435 — Adding acceptance criteria after a ruling keeps the ruling marker current, never stale

**What this decides:** When someone adds the acceptance criteria to a decision issue after the
founder ruled on it, `decision ruling` still reads that ruling as `current`. Any other edit to the
body still reads `stale`.

## Context

`decision rule` posts a marker that binds the ruling to a digest of the whole issue body
(`packages/fabrika-cli/src/decision/digest.ts`, `bodyDigest` over `canonicalBody`). Since
[#6803](https://github.com/kamp-us/phoenix/issues/6803), a decision can only flip to
`ready-for:agent` once its body has an `### Acceptance criteria` block. For a decision, those
criteria usually cannot be written until the ruling exists. So writing them moves the digest, and the
ruling that made the issue buildable reads `stale` right away. On
[#6683](https://github.com/kamp-us/phoenix/issues/6683) the marker stayed `3b01fcdf05c2` while the
body moved to `d7bcaeb87ed2`.

[#6856](https://github.com/kamp-us/phoenix/issues/6856) asked whether `stale` is the honest answer
(a roster account re-runs `decision rule` after the criteria land) or whether the digest should be
scoped so added criteria keep the marker current. The founder answered **no** to "stale is good
enough", with the lens "reduce process toil, pick the cheapest option, add no new gate or token":
[the ruling comment](https://github.com/kamp-us/phoenix/issues/6856#issuecomment-5519865063). This
record transcribes that ruling; the choice is not the author's.

## Decision

**A ruling marker is `current` when its digest matches the whole body, or the body with its
acceptance-criteria block removed.**

This is the append-aware reading, done on the read side only:

- **Minting does not change.** `decision rule` (`packages/fabrika-cli/src/decision/rule-verb.ts`)
  still hashes the whole body with `bodyDigest`. The marker format, its wire grammar and every marker
  already posted stay valid. No new token, flag or gate.
- **The reader gains one fallback.** A new `criteriaFreeDigest(body)` in
  `packages/fabrika-cli/src/decision/digest.ts` finds the contract block the way
  `readSpans` in `packages/fabrika-cli/src/wire/acceptance-criteria.ts` does (the last conforming
  block, per [ADR 0326](0326-amended-criteria-last-block-wins.md)), drops its heading line through
  its last criterion's last line, collapses the blank-line run that leaves, and hashes the result
  with `bodyDigest`. `rules` in `packages/fabrika-cli/src/wire/decision-ruling.ts`, which `stateOf`
  in `packages/fabrika-cli/src/decision/ruling.ts` calls, answers true when the marker equals either
  digest. A body with no readable block has only the whole-body digest.
- **What stays `current`:** criteria added below a body the founder ruled on, including a second,
  amending block below criteria the ruling already saw.
- **What still reads `stale`:** any change outside that block, and any edit to criteria the ruling
  already saw. Both change what was ruled on, so `stale` is the true answer there. #6683 is this
  case: its enrich added a `## The ruling` section as well as criteria, so it stays `stale` until a
  roster account re-runs `decision rule`.

The code change is tracked in [#10269](https://github.com/kamp-us/phoenix/issues/10269); this record
changes no code.

**How a citation check reads ruling state.** The check
[#6235](https://github.com/kamp-us/phoenix/issues/6235) asked for is the `--cites` binding in
`build claim` (`packages/fabrika-cli/src/build/scope-admission.ts`): the cited URL must name a
comment on this repository and this issue. It does not read `decision ruling`'s state, and it keeps
not reading it. Any check that does read that state treats only `absent` as uncited. `stale` means
"the body moved since the ruling, a roster account should look", never "no ruling". With the
fallback above, a decision whose only later edit is its criteria reads `current`, so a correctly
transcribed decision cannot read as uncited by either path.

**Who pays what's left.** fabrika-cli maintainers carry one small pure function, one extra
comparison in `rules`, and their tests. Control-plane accounts still re-rule a decision whose body
changed outside its criteria. That trade is accepted because the founder ruled out a roster
round-trip for the common case, which is every agent-written criteria block, and this is the
cheapest way to remove it: no marker migration, no new token, no new gate. The remaining re-rule only
fires when the ruled text itself moved.

**Binding constraints.**

- `decision rule` keeps minting over the whole body.
- Only the one contract criteria block is removed on read, never other sections.
- No verb refuses on `stale` because of this record. A check that needs "is this ruled" reads
  `absent` as the only uncited answer.

## Consequences

- Agent-written criteria no longer strand a ruling until a human re-runs `decision rule`.
- `digest.ts`'s docblock line "a criterion ... still moves the digest" stays true for the digest
  itself; the fallback lives in the reader, and #10269 updates that docblock to say so.
- An edit that both adds criteria and rewrites other text still reads `stale`, as on #6683. That is
  the honest answer, and re-running `decision rule --cites <url>` is still the fix.

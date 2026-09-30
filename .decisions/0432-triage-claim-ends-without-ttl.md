---
id: 0432
title: A fabrika triage claim is presence-keyed, never ended by a TTL
status: accepted
date: 2026-09-30
tags: [fabrika, pipeline-hardening, claim, triage]
---

# 0432 — A fabrika triage claim is presence-keyed, never ended by a TTL

**What this decides:** ADR 0215 §5's ban on ending a claim because it looks old covers fabrika's
`triage claim` markers too. So the 60-minute timeout that ends a triage claim today has to go. A
triage claim stays binding until someone ends it on purpose, and a stranded one passes to a successor
by a written, ACL-checked adopt marker, the way ADR 0295 lets a build claim pass.

## Context

`fabrika triage claim` posts one issue comment per lane:

```
<!-- fabrika-triage-claim session=<session-id> lane=<nonce> -->
```

That is a different grammar from the ADR [0115](0115-agent-distinguishable-claim-marker.md) lane
claim, `claim: <session> · <ISO>`, and from fabrika's own `build-claim:` marker. No record covered
it. Its liveness rule is a fixed age: `DEFAULT_TTL_MINUTES = 60` in
`packages/fabrika-cli/src/triage/claim.ts` discards every marker older than an hour before the
earliest survivor wins. PR [#6173](https://github.com/kamp-us/phoenix/pull/6173) made that age
decide more than a race: `packages/fabrika-cli/src/triage/target-guard.ts` reads the same constant
when `apply`, `enrich`, `kill`, `park` and `split` check for a live foreign claim before they write.
A session that takes longer than an hour over one issue can now have a second session's `apply` or
`enrich` write over it, the failure class of incident
[#5644](https://github.com/kamp-us/phoenix/issues/5644), shifted in time.

ADR [0215](0215-claim-identity-continuity-proof.md) §5 bans "Evicting a claim on age, on TTL, on
session-id mismatch, or on any inference from absence", because "a TTL evicts a slow-but-live
agent". ADR [0295](0295-board-attested-claim-succession.md) reaffirmed it, "no TTL, no lease, no steal",
while adding board-attested succession as the way a stranded claim ends. Both were written against
lane and build claims, and fabrika reimplements v1 rather than inheriting it
([0238](0238-fabrika-reimplements-v1-never-calls-it.md), [0279](0279-v1-crew-retired-in-full.md)),
so [#6191](https://github.com/kamp-us/phoenix/issues/6191) asked whether the ban reaches the triage
marker at all.

The founder ruled on 2026-08-19, in
[#6191 (comment)](https://github.com/kamp-us/phoenix/issues/6191#issuecomment-5346841834): the ban
reaches fabrika (route 1 of the three the issue laid out). This record transcribes that ruling.

## Decision

**The `<!-- fabrika-triage-claim session=... -->` keyspace is governed by ADR 0215 §5: its liveness
is presence-keyed, and no age, TTL or lease ends a triage claim.**

**Scope.** This record governs every comment matching the `<!-- fabrika-triage-claim session=`
prefix: what `triage claim` posts and resolves, and what the five guarded triage verbs read. It
does not govern the ADR 0115 `claim: <session> · <ISO>` lane marker or the `build-claim:` marker,
which keep their own records. Per the ruling, ADR 0215 §5 is about the GitHub claim keyspace as a
whole, not about one marker grammar, so a new marker grammar does not step outside it.

**Liveness is presence-keyed.** A triage marker that is on the issue is live. It stops binding only
when a positive act removes or supersedes it, never because time passed and nothing was heard from
its session. Age stays what it is for the other markers: the ordering key (`created_at`, earliest
wins), never an eviction key.

**`DEFAULT_TTL_MINUTES` goes, in both readers.** The constant in
`packages/fabrika-cli/src/triage/claim.ts` and its use in
`packages/fabrika-cli/src/triage/target-guard.ts` are replaced by an ADR 0295-style adopt marker. The
race resolution in `triage claim` and the foreign-claim check in the guarded verbs read one live set,
as they do today, so neither may keep an age cut the other dropped.

**What a stranded triage claim's succession looks like.** It follows ADR 0295 in the triage
namespace, the same parity ADR [0325](0325-lane-namespace-claim-succession.md) gave the `lane`
namespace:

- A successor posts one adopt marker on the same issue, naming the stranded session, carrying the
  successor's own fresh `triage:<session>:<uuid>` token and a required, non-empty reason. Its
  keyword is derived from the triage namespace's own prefix, as `build-adopt:` and `lane-adopt:`
  are derived from theirs; the exact literal is the follow-up's to fix in the `triage claim`
  contract.
- The adopt confers the claim on exactly the lane its token names. Any other lane, including another
  lane of the successor's session, still reads the claim as foreign.
- The adopt's author is ACL-checked when it is read. An adopt from an account below `write` is
  counted and reported, and is never a succession.
- The successor then releases: the stranded marker and the adopt marker are deleted together, and a
  fresh `triage claim` races normally.
- An adopt naming the caller's own session is refused. Deleting the adopt marker reverses it.

As in 0295, an adopt does not prove the stranded session is dead. The guard is disclosure plus the
ACL, which is why the reason is required and the marker stays readable on the issue.

**Binding constraints.**
- A triage marker ends only by a positive act: its owner's release, an ADR 0215 §5 ending, or a
  release after an authorized adopt.
- The race reader and the guard reader share one live set and one liveness rule.
- An adopt is a written statement on the issue, ACL-checked and reason-bearing, never an inference.

**Banned.**
- Ending, ignoring or discounting a triage claim marker on age, on TTL, or on any lease.
- Treating silence from a session as proof its triage claim is gone.
- Widening triage-claim eviction past this record without an ADR that supersedes ADR 0215 §5's ban
  for this keyspace.

## Consequences

- The code change is out of this record's scope, because #6173 had already merged when the ruling
  landed. It is [#10255](https://github.com/kamp-us/phoenix/issues/10255): remove
  `DEFAULT_TTL_MINUTES` and every age cut from `claim.ts` and `target-guard.ts`, and add the triage
  adopt marker and its release.
- No triage verb releases a winning marker today; the TTL is the only way one ends
  ([#7263](https://github.com/kamp-us/phoenix/issues/7263) tracks the missing release). With the TTL
  gone a marker would bind forever, so the owner's release, the first ending ADR 0215 §5 lists, has
  to land before or with the TTL removal. Removing the TTL alone would leave every triaged issue
  claimed.
- The `triage claim` contract section (`claude-plugins/fabrika/skills/triage/contract.md`) states
  the fixed 60-minute TTL and the `expired` count. The follow-up rewrites those facts with the code.
- Until the follow-up lands, the TTL still runs. This record names it as the gap, not as sanctioned
  behaviour.

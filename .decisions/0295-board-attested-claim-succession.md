---
id: 0295
title: A dead session's build claim passes to a successor by a board-attested adopt marker
status: accepted
date: 2026-08-18
tags: [fabrika, pipeline-hardening]
---

# 0295 — A dead session's build claim passes to a successor by a board-attested adopt marker

**What this decides:** when a driver session dies and leaves `build-claim:` markers behind, the
successor posts one adopt marker on the same issue or PR, and `build release` then treats that claim
as its own and deletes both comments. No TTL, no lease, no steal. The attestation lives on the board,
ACL-checked like every other marker (ADR [0055](0055-acl-sourced-review-authz.md)).

The marker:

```
build-adopt: <dead-session> by build:<my-session>:<uuid> · <ISO> · reason: <text>
```

This record **amends ADR [0215](0215-claim-identity-continuity-proof.md) §5 in part**. That section
says a claim ends three ways and never any other, and bans "adoption: treating another session's
marker as one's own without releasing it". There is now a fourth ending: an agent successor attests
on the board and releases, where 0215 required a human. ADR
[0272](0272-lane-owns-the-claim.md) §1 restates 0215's closed set in the same terms ("proven dead and
superseded under ADR 0215 §5, or an operator clears the claim under that same section"), so it
inherits the same widening. Everything else 0215 §5 bans stays banned — no TTL, no lease, no steal,
and no eviction inferred from absence. An adopt is a written positive statement, not an inference.

## Context

An Anthropic API outage on 2026-08-18 killed a driver session mid-drain. Its builders' claim markers
stayed on the board. The next driver has a different `CLAUDE_CODE_SESSION_ID`, so `build release`
answered `CLAIM_NOT_MINE` on every one of them, and each stranded lane needed a founder to find and
delete a comment by hand. Two lanes lost hours that day
([#6068](https://github.com/kamp-us/phoenix/issues/6068)): #6037 with PR #6061, and #6007 under epic
#5817.

[#5752](https://github.com/kamp-us/phoenix/issues/5752) had ruled on this case a day earlier: no
lease, no TTL, no steal; the driver releases its own claim; a claim from a gone session is "a rare
human act until the ledger owns claims". An outage makes it not rare.

## Decision

Option 2 of the four #6068 laid out — **board-attested succession**. The successor driver posts an
adopt marker naming the dead session, under a fresh token the verb mints and prints. That token is
the successor's lane identity on this number: `resolveOwnership` answers `Mine` when an
**authorized** adopt marker on the same number names the winning claim's session *and* names the
asking lane as its successor, and `build release --token <that token>` deletes the claim comment and
the adopt comment together.

Guards, all of them in the verb:

- An adopt naming the caller's own session is refused — plain `build release` already covers that.
- The reason is required and recorded; an empty one refuses before anything is written.
- The adopt confers the claim on **exactly** the lane its `by <token>` names — the same whole-token
  test an ordinary win passes. A third session reading the same marker sees `Foreign`, and so does
  another lane of the successor's own session. It does not follow that a claim has one successor:
  two lanes may each post an adopt over the same dead session, and each reads `Mine` through its own
  ([#6113](https://github.com/kamp-us/phoenix/issues/6113)). Whoever releases first ends the claim.
- The adopt's author is ACL-checked at release time. An adopt from an account below `write` is
  counted, reported on stderr, and is never a succession — content is not authority.
- The act is reversible: delete the adopt comment and the claim is foreign again.

**What an adopt does not prove: that the adopted session is actually dead.** Nothing in the protocol
can check that. Any account with `write` may adopt a *live* session's claim and release it. That is
the ruling as given — the guard here is disclosure plus the ACL, not a liveness proof — and it is why
the reason is required and the marker stays on the issue for anyone to read.

**What an adopt confers, beyond `release`.** `resolveOwnership` is one function and every verb reads
it, so an adopted claim answers `Mine` to `build confirm` and to everything `requireClaim` guards —
`branch`, `note`, `scratch`, `tree --issue` — each under the token `adopt` printed, which every one
of those verbs takes as `--token`. That is the intent: the successor inherits the dead lane and may
carry it on, not merely retract it. The one exception is `build claim`, which refuses on `15` over an
adopted claim: on the racing path it retracts the marker it just posted, because claiming would
leave this run's marker beside the dead session's and `release` deletes the claim and the adopt, not
the extra; handed `--token`, it refuses before writing at all, because the winner it would otherwise
answer with is the dead session's token and no later verb of this session accepts that. The
successor's path is adopt → release → claim, and the refusals are what keep it the only one.

## Why the other three lost

- **Option 1, ledger-attested succession** (as originally filed). The lane ledger is
  `.fabrika/lanes/<n>/events.jsonl`, local and gitignored, and it records no session id at all — the
  filing's premise was wrong. Adopting it would have moved claim authority off the board and onto
  unshared local state, which is a different authority model from ADR 0055/0115, not a small read.
- **Option 3, one operator verb that deletes a marker by token.** It widens `claim-verb.ts` into a by-token
  delete with no successor semantics — the shape #5752 §3 declined — and records who released
  nothing about who inherits.
- **Option 4, hold per #5752.** Priced at N founder acts per outage, invisible to the protocol. The founder
  had seen that price twice in one day.

## Relation to #5752

**A narrowing of #5752's cross-session carve-out by exactly one marker kind, not a reversal of it.**
Everything #5752 declined stays declined: no TTL, no lease, no steal by a foreign lane, no eviction
inferred from absence (ADR [0215](0215-claim-identity-continuity-proof.md) §5). The driver still
releases through `build release`. What changes is that a successor can now say on the board that a
named session is gone, and that statement — ACL-checked, disclosed, reversible — is what makes the
release legal.

Same-session residue is unaffected: a spawn that died under the driver's own session id was always
releasable, and stays so with no adopt marker (#5795).

## Consequences

- #5795's cross-session bullet becomes: **post the adopt marker, then `build release`.** Its
  same-session path is untouched.
- Token-level ownership stays exactly as narrow as
  [#6060](https://github.com/kamp-us/phoenix/issues/6060) is making it, on both axes. The adopt
  keyword is derived from each namespace's own prefix, so `lane:` and epic ownership see no adopt
  markers; and the successor test is the same whole-token test the ordinary win uses, so an adopt
  confers a lane's worth of ownership, never a session's.
- The claim protocol grew one verb, `build adopt`, one resolver branch that is read only when the
  winning claim is not this lane's, and two refusals in `build claim` over an adopted claim — one on
  the racing path, one before the write when `--token` is passed. The ordinary path costs what it did.
- ADR 0215's `status:` now records this amendment, so a reader who lands on the older record is sent
  here for the current rule.
- A successor who adopts a claim it should not have is visible on the issue with its reason, which is
  the property the hand-deleted comment never had.

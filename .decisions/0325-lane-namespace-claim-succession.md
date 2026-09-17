---
id: 0325
title: A killed operator seat's lane claim passes to its successor by a board-attested lane adopt
status: amended-in-part by [0389](0389-a-bricked-lane-is-archived-while-its-issue-is-open.md)
date: 2026-08-21
tags: [fabrika, pipeline-hardening]
---

# 0325 — A killed operator seat's lane claim passes to its successor by a board-attested lane adopt

**What this decides:** the `lane` claim namespace gets the succession `build` already has. A
successor operator seat posts one `lane-adopt:` marker on the issue, `lane release` then reads that
claim as its own and retracts both comments, and `lane claim` wins normally after. No TTL, no lease,
no steal — the same closed set ADR [0295](0295-board-attested-claim-succession.md) holds for the
build namespace.

The marker, derived from the `lane:` prefix exactly as the build one is derived from `build:`:

```
lane-adopt: <stranded-session> by lane:<my-session>:<uuid> · <ISO> · reason: <text>
```

Ruled by the founder on
[#6374](https://github.com/kamp-us/phoenix/issues/6374#issuecomment-5346308847): option A,
lane-namespace succession parity. Option B — documenting the read-the-token-off-the-issue
`lane release --token …` escape hatch — was rejected as sanctioning exactly the hand-composed
token-guessing ADR 0295 was built to prevent.

## Context

An outage killed a seat mid-drive on lane 5648. Its `lane-claim:` marker stayed on the issue. The
successor seat ran `lane claim 5648` and was refused on `31` — the marker carries this very session
under another nonce, so `resolveOwnership` reads it `Foreign` — while `lane stale --older-than 60`
listed 5648 as a lane to re-spawn. Two verbs, opposite answers, one lane. The way through was to read
the stranded token out of the comment body by hand and run
`lane release 5648 --token lane:<session>:1f0f21a6-…`, then re-claim.

ADR 0295 had already solved the mirror of this for `build`, and the resolver it added is grammar-
parameterised, so the `lane` namespace inherited the *reading* of an adopt marker and none of the
writing: nothing composed one, `lane release` ignored the field, and `lane claim` had no guard for a
claim held through succession.

## Decision

**One new verb, `lane adopt`, plus the three seams a written adopt needs on the verbs that already
exist.** `resolveOwnership` is untouched — it already resolves an adopt under whatever grammar it is
handed, which is why parity costs a writer and not a protocol.

- `lane adopt <lane> --session <s> --reason "<why>"` writes one comment and nothing else. It takes no
  `--token`: a successor holds no token on a claim it is inheriting, so it mints the identity the
  succession creates and prints it.
- `lane release <lane> --token <that token>` now deletes the adopt comment with the claim, reports an
  unauthorized adopt on stderr, and names the succession route when it refuses a foreign holder.
- `lane claim <lane> --token <that token>` refuses on `31` rather than answering `won` with the dead
  seat's token — the same refusal ADR 0295 put on `build claim`, for the same reason: a second marker
  would outlive the release. The successor's path is adopt → release → claim, and nothing else.
- `lane claim`'s proven-loss refusal now names `lane adopt` on stderr. That is what ends the
  contradiction #6374 reported: `lane stale` says re-spawn, and `lane claim` now says how.

### The one departure from ADR 0295: a same-session adopt is admitted

`build adopt` refuses `--session` naming this very session, on the ground that plain `build release`
already covers a same-session claim. **`lane adopt` admits it, and that arm is the whole point of the
verb**, because what dies in this namespace is a *seat*, not a session. A killed operator seat's
successor boots under the same `CLAUDE_CODE_SESSION_ID`; only its nonce differs. Ownership turns on
the whole token (ADR [0272](0272-lane-owns-the-claim.md), #6060), so that marker resolves `Foreign`
and plain release does not cover it — the only thing that ever did was the hand-composed `--token`
this record's ruling rejects.

What the departure costs is disclosed rather than guarded, exactly as ADR 0295 disclosed its own:
**an adopt proves no seat dead, the same way it proves no session dead.** A driver may adopt a live
sibling seat's claim on the same session and release it. The guards are the poster's repository
permission read at release time (ADR [0055](0055-acl-sourced-review-authz.md)), the required reason,
and the marker sitting on the issue for anyone to read; the act is reversible by deleting the
comment. That is a narrower exposure than the build namespace already carries, not a wider one — a
same-session adopt reaches only the lanes of a session the caller is already running under.

## Consequences

- ADR 0215 §5's closed set of claim endings, already widened by ADR 0295 to include a board-attested
  agent succession, now reads the same in the `lane` namespace. Everything else that ruling bans
  stays banned: no TTL, no lease, no steal, no eviction inferred from absence.
- The operate skill's step 4 documents the route, and step 3's dead-spawn residue passage names the
  lane-claim half beside the build-claim one.
- `lane stale` still reads only build claims when paired with `--claims`, so a stranded *lane* claim
  is not surfaced by the sweep — the verb's own help says so, and `lane claim`'s refusal is where a
  driver meets it. Widening the pairing to both namespaces is a change to that answer's shape and is
  not taken here.
- A successor who adopts a seat it should not have is visible on the issue with its reason, which the
  hand-read token never was.

## Amendment — 2026-09-15 ([#7778](https://github.com/kamp-us/phoenix/issues/7778)): an adopt marker is always reachable, and it fences and confers only over what it postdates

This record says `lane release` "retracts both comments" and that `lane claim` "wins normally after".
Neither held from every state, so the sanctioned remedy this record names did not terminate. Two
readings move; the protocol above — one marker, no TTL, no lease, no steal — is untouched.

**A stranded adopt is retractable by the driver that wrote it.** The ownership read answered
`Unclaimed` the moment no `lane-claim:` marker survived, *before* it looked at any adopt marker, so
an adopt whose claim was already released became a comment no verb could reach: `release` said
"no lane claim exists on #N — nothing to retract" while the adopt stayed on the thread. That read now
names the state — an authorized adopt whose `by <token>` names the asking driver, with no claim
beside it — and `release <lane> --token <that token>` retracts that one comment. It reaches only the
asking driver's own adopt, resolved off the `by <token>` exactly as an ordinary win is, so the
prohibition on retracting another driver's marker is unchanged.

**An adopt fences and confers only over a claim marker posted after it.** The fence that keeps one
succession from answering `Mine` to two drivers read every adopt over the winning marker's session,
whatever their order. A succession adopts a claim that already stands, so an adopt *older* than the
winning marker adopted some earlier claim and says nothing about this one. Ordering is GitHub's `created_at` with
the comment id breaking a same-second tie — the order the marker lists already sort in, and not a
field a marker's author composes.

The rule binds both directions of the same read, because the ownership answer has two arms over one
pair of comments: the fence, which the adopted session's own lane meets, and the conferral, which the
adopting lane meets. An adopt older than the winning marker adopted an earlier claim, so it neither
fences that marker nor confers it — and a rule stated on one arm alone is no rule, since the two
lanes then answer `Mine` over a single marker and `release` under the heir's token deletes a marker
the other lane holds. One order, read the same way by both arms, is what keeps one succession
answering `Mine` to exactly one lane.

Without that second reading the first does not finish the job. `lane adopt` admits this run's own
session, which is the departure §"The one departure" above takes deliberately, and a stray
self-session adopt therefore fenced *every* marker that session would ever post on the number: each
fresh claim lost to it under a new nonce, and the remedy this record prints on the `31` — adopt,
release, claim — minted another marker each pass. The reported loop ended only with
`gh api -X DELETE`, the hand-composed move this record's own ruling rejected.

What is not amended: an adopt still proves no seat dead, the guards are still the poster's repository
permission and the recorded reason, and a same-session adopt is still admitted.

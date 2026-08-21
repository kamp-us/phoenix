---
id: 0324
title: A killed operator seat's lane claim passes to its successor by a board-attested lane adopt
status: accepted
date: 2026-08-21
tags: [fabrika, pipeline-hardening]
---

# 0324 — A killed operator seat's lane claim passes to its successor by a board-attested lane adopt

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

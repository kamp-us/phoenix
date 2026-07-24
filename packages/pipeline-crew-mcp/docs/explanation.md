# Explanation — the coordination model

> **Diátaxis mode: explanation** (understanding-oriented). One mode per doc — shape and
> tradeoffs, not steps. Learn the substrate from zero in the [tutorial](./tutorial.md);
> perform a specific task with the [how-to](./how-to.md); look up an exact contract in the
> [reference](./reference.md).

Why the substrate is shaped the way it is: stigmergic coordination through the shared claim
map, pull-not-push messaging, claim-liveness riding presence, and the two-keyspace registry
design. This quadrant **points to the governing ADR rather than re-deriving it**, so the docs
can never drift from the decision (per CLAUDE.md's "collapse a docblock that re-derives an
ADR's *why* to a pointer" rule). The claim lifecycle — keyspace split, presence-derived
liveness, and the `Release` mechanics — is decided in
[ADR 0191 — crew claim lifecycle](../../../.decisions/0191-crew-claim-lifecycle.md); read it
for the *why*. This page explains the *shape and the tradeoffs* those choices produce.

## The problem the model solves

The crew is a set of **independent agent sessions** — no central dispatcher hands out work.
Several conductors may be alive at once (the engine pool of the settled roster), and their only
deconfliction primitive is "claim a resource before you work it." So the substrate needs one
thing: a way for peers who never talk to each other directly to avoid grabbing the same issue,
without a coordinator in the middle to arbitrate. That is what the tracker registry
([`src/tracker/registry-core.ts`](../src/tracker/registry-core.ts)) is — a soft-state
rendezvous store, not a message bus.

## Stigmergic coordination through the claim map

The crew coordinates **stigmergically** — indirectly, through marks left in a shared
environment — rather than by negotiating with each other. The environment is the tracker's
**claim map**: a peer that wants a lane attempts `claimResource`, and the registry either
`Granted`s it (the resource was free, or its previous holder is gone) or reports a `Collision`
naming the live holder. No peer asks another peer for permission; each reads the shared map and
acts on what it finds there. A holder's claim *is* the coordinating signal — a trace in the
environment that every other peer reacts to when it tries the same resource.

This is why the collision result **leaves state untouched**: a claim is never stolen. The mark
belongs to whoever laid it first and stays until they lift it (or die). Coordination emerges
from the accumulated marks, not from a protocol of agreement — the defining property of a
stigmergic system, and the reason the substrate needs no arbiter.

## Pull-not-push

The tracker **never pushes**. It sends nothing to a peer unprompted — there is no subscription,
no notification, no "someone claimed your resource" callback. A peer learns the state of the
world only by **asking**: it discovers a collision at the moment it tries to claim
(`claimResource` returns the outcome inline), and it discovers who is present by calling
`lookup(role)`, which returns the live holders (or `[]`). Deconfliction is resolved by a **query
at the point of need**, not by a broadcast the tracker fans out.

The only traffic that flows *toward* the tracker is a peer reporting its **own** state —
`announce`, `heartbeat`, `claimResource`, `releaseClaim`. The tracker-to-peer direction is
pull-only. Keeping it that way is what lets the registry stay a passive, soft-state store that
peers poll on demand: it holds no subscriber list, owes no one a delivery, and has no fan-out to
get wrong. A peer that wants fresher knowledge asks again; a peer that never asks is never
interrupted. The seam that speaks these calls on the crew's behalf is
[`src/crew/tracker.ts`](../src/crew/tracker.ts)'s `CrewTracker`.

## Claim-liveness rides presence

A resource claim carries **no clock of its own**. It is live for exactly as long as its
holder's **presence** is live — one liveness clock (presence), and claims ride it. This is the
single most load-bearing choice in the model, and
[ADR 0191 facet 2](../../../.decisions/0191-crew-claim-lifecycle.md) is where it is decided;
the shape it produces:

- A lane runs for an unknown duration — minutes to hours — so any fixed claim TTL is wrong in
  one of two directions: too short cuts a long build off mid-flight, too long strands a dead
  holder's claim so no one else can take the resource. Binding claim-liveness to *holder*
  liveness sidesteps both. A conductor that is still working is still heart-beating, so its
  claim stays live transitively; a conductor that crashed stops beating, its presence lease ages
  out, and its claims are reaped with it.
- Two paths free a claim, and only two: an **explicit `Release`** (the lane finished and the
  holder is still alive for its other lanes — the fast path), or the **holder's presence aging
  out** (it crashed or ended — the safety net). `claimHolder` reads a claim as free the instant
  its holder has no live presence, so a stale claim never blocks a new one.
- The **heartbeat refreshes presence leases only** — it never touches claims. Because claim
  liveness is *derived* from presence and the heartbeat is what keeps presence live, a working
  conductor's claims stay live with no claim-local timer to bump. That is what designs out the
  opposite failure — claims that never expire — without any per-claim keepalive to maintain.

The result is a claim that cannot age out mid-build and cannot outlive its holder — the two
failures a wall-clock TTL forced you to choose between.

## Presence has two phases: reserved vs attached

Presence itself is split so that being *registered* means an inbox is actually serving, not merely
that a process claimed a slot (#3628). A session **reserves** a bare lease at construction — enough
to hold its role slot and back the cardinality claim's liveness clock above — but that bare lease is
**not discoverable**: `lookup` (and so every `channel_send`) skips it. The session only **announces**
an attached lease once its inbox socket is bound and serving, and only then does it appear as a live
peer. The failure this designs out is the *channel-deaf* pane: a role that looks up in tmux but never
attached its inbox half, so it used to register as live while every send to it dead-lettered. Under
the two phases a channel-deaf session never becomes discoverable, and a send to a present-but-unserved
inbox fails fast with a distinguishable `ChannelDeafError` rather than a generic timeout.

## The two-keyspace design

`RegistryState` holds **two maps that never share** — presence leases keyed by `peer`, resource
claims keyed by `resource`:

- A **presence lease** answers "who is alive serving this role" — role-keyed liveness, TTL'd and
  heartbeat-refreshed. `AnnouncePresence` / `LookupRole` / `Heartbeat` touch this keyspace only.
- A **resource claim** answers "who holds this issue" — a deconfliction hold with no TTL of its
  own. `Claim` and `Release` touch this keyspace only.

The two are different lifecycles with different expiry, so they live in different typed maps.
The payoff is structural, not disciplinary: because `lookup` reads the presence map and can only
ever return presence records, "a role lookup surfaces a claim holder" — a category error a
single shared namespace permits — is made **unrepresentable** rather than guarded against after
the fact (the make-invalid-states-unrepresentable house rule). The rejected alternative — one
map with a `role:` / `claim:` string prefix — would re-introduce parse-the-prefix fragility and
leave the lookup structurally able to read a claim; ADR 0191 facet 1 records why it was
rejected. The two typed keyspaces are the whole point.

## What this model is not

The claim lifecycle is **traffic-control, not a privilege boundary**. A claim deconflicts lanes;
it does not authorize anything. The pipeline's trust root — who may review, merge, or act — stays
GitHub's write-ACL, upstream of this substrate and unchanged by it. The crew-mcp package sits
deliberately outside the control plane
([ADR 0187](../../../.decisions/0187-crew-mcp-is-not-control-plane.md)); the coordination model
here is about who works what, never about who is allowed to.

## Grounding

- Claim lifecycle, two-keyspace design, claim-liveness-rides-presence, the `Release` mechanics:
  [ADR 0191 — crew claim lifecycle](../../../.decisions/0191-crew-claim-lifecycle.md).
- The registry model these facets fall out of — the two keyspaces, `claimResource`,
  `claimHolder`, presence-derived liveness, `prune`/`release` reaping:
  [`src/tracker/registry-core.ts`](../src/tracker/registry-core.ts).
- The crew seam that speaks the registry (pull-only lookups, `acquireClaim`'s release-on-scope-
  close, presence-only heartbeat): [`src/crew/tracker.ts`](../src/crew/tracker.ts).

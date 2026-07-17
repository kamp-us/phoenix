---
id: 0189
title: The crew roster law — bridges (fixed-cardinality seam owners) vs engines (N-instance throughput), and why per-kind cardinality falls out of the role KIND, not a global uniqueness invariant
status: accepted
date: 2026-07-16
tags: [pipeline, pipeline-crew, crew-mcp, topology, roster]
---

# 0189 — The crew roster law: bridges vs engines, cardinality-from-kind

## Context

The crew-mcp channel substrate (`packages/pipeline-crew-mcp/`) replaced the tmux relay as
the way standing pipeline sessions address each other (epic #3045; not §CP per ADR
[0187](0187-crew-mcp-is-not-control-plane.md)). Adopting it — retiring tmux for *both*
crews and making the distributable `claude-plugins/pipeline-crew/` plugin the sole crew
definition — was charted and graduated on wayfinder:map #3207. That map carried a chain of
founder rulings (#3213/#3221/#3222/#3224/#3210/#3212/#3220) that together re-derived what
the crew's roster actually *is*. This ADR records that roster **law** so every future agent
and every roster change is held to it rather than re-deriving it. It is the governing
decision of the crew-architecture wave; the four impl siblings gate on it.

Before this law, the roster was a flat list of slugs with an implicit global uniqueness
invariant. `packages/pipeline-crew-mcp/src/crew/roles.ts` names **five** standing roles
(`ea-chief-of-staff` / `engineering-manager` / `triage-guy` / `junior-engineer` /
`cartographer`) as a bare tuple, with a module comment recording the founder ruling "five
standing roles, not four" (pinned by `roles.test.ts`). Uniqueness is enforced structurally
but *uniformly*: the tracker's `RegistryState = ReadonlyMap<string, Lease>`
(`tracker/registry-core.ts`) is keyed by role, so a role maps to at most one live lease —
"named leases for role uniqueness … made unrepresentable-otherwise rather than checked
after the fact." The wire already speaks multi-peer (`lookup` returns an array,
`RoleLookupResult.peers` is a list); only the registry map pins every role to one holder.

That uniform-uniqueness model was phrasing carried from before the roster law, and it is
false: the founder caught it before it was built. The correct rule is **per-kind**
cardinality, and the roles differ in kind.

Charted and graduated on wayfinder:map #3207. This ADR is the governing decision; it is
implemented against by #3234 (land the law in `crew/roles.ts` + the registry), #3235 (rewrite
the plugin crew defs), #3236 (restructure the personalization seam), and #3237 (the stand-up
launcher).

## Decision

The crew roster is **three bridges + an engine pool**, and cardinality falls out of the role
KIND — it is not a separately-configured global uniqueness invariant.

**A bridge owns a unique seam** connecting the factory to something outside its execution
core, and is **singleton (cardinality 1)** because nobody else can own that seam. The three
bridges:

- **`cartographer`** — the founder's fog → charted work (inbound ideation).
- **`intake-desk`** — the world's observations → typed work, *and* it talks back to whoever
  filed. The talking-back is what makes it a bridge, not a filter. (A *desk* is an office
  staffed by whoever is on shift — the seat is standing, the session filling it is transient;
  the noun carries the bridge/session distinction. Renamed from `triage-guy`, which named a
  person, not a seat.)
- **`chief-of-staff`** — factory state → the founder's understanding (outbound awareness);
  the cartographer's mirror, same principle, opposite direction. Owns human-facing comms.
  (Renamed from `ea-chief-of-staff`: "EA" and "chief of staff" named the same office twice.)

**An engine owns no seam and is pure throughput, therefore fungible capacity.** The one
engine, **`engineering-manager`**, has **cardinality N**, deconflicted by resource claims
(the `Claim {resource}` kind), not by a uniqueness lease.

**Cardinality is per-kind: bridge → 1, engine → N.** The tracker enforces the *kind* rule,
not blanket uniqueness — a second `chief-of-staff` must die at boot (two would mean nothing
can resolve `targetRole: "chief-of-staff"`, and two agents would text the approver), while a
second `engineering-manager` must boot cleanly. The tracker is the only authoritative place
to enforce this (a launcher cannot stop a second launcher or a hand-run `claude`), but it
enforces the kind rule; it needs no engine maximum, only "engines are not unique." How many
engines to start is a launcher/config call, not a substrate concern.

**The roster becomes a TYPE.** `crew/roles.ts` stops being a list of slugs and becomes a map
of role → kind (`chief-of-staff`/`cartographer`/`intake-desk` → `bridge`;
`engineering-manager` → `engine`), so cardinality follows the kind and **a bridge with
cardinality 2 is unrepresentable** — the repo's make-invalid-states-unrepresentable law
applied to the roster itself.

**Topology is FLAT peer-to-peer; hub-and-spoke is dead.** A bridge does not route. The
`chief-of-staff` is an outbound *awareness* bridge, not a switchboard — the substrate makes
peers dial each other directly, so non-routing is enforced by construction. Flat was
independently predicted twice: by the substrate (every role a symmetric peer) and by the org
metaphor (an exec team are peers, each owning a seam, each addressing the founder directly).
The consequence for routing: **the EA→EM routing edge is deleted** — the engine no longer
receives execution work through the chief-of-staff; a planned child becomes pickable off the
board (`status:triaged`) and an engine pulls it. Giving an engine a founder-facing seam would
make it a bridge by the law, so the EM banks a §CP PR on the board (assign + label) and the
chief-of-staff carries it out to the human; the EM does not ping.

**`junior-engineer` is killed as a concept, not renamed.** It owned no seam — it was defined
by negative space ("what the EM isn't getting to"), which is why it needed an invented
partition (mechanical / p2 / non-§CP) plus an escalation ladder to justify existing. It was
EM #2 wearing a role costume; with engines multi-instance it is simply a second engine.

**The retired two-agent-pipeline was NOT retired for collisions** — the collision framing is
post-hoc rationalization. The founder retired it because he needed another agent able to just
*talk*, which became the chief-of-staff. Multiple symmetric EMs was never falsified. The EM
def must not carry the collision story forward, and it must not be used to veto the engine
pool as "re-proposing a killed model."

The reasoning worth preserving: **an office is defined by an accountability, not a workload
bucket.** Parallelism in an agent factory lives *below* a conductor (spawned contractors), so
a role that exists only to absorb overflow is capacity, not a seat. A bridge earns a standing
seat because it holds an un-transferable seam (a mailbox to something outside the factory); an
engine is fungible throughput, so it scales by count, not by a named second office.

**Final roster:** `chief-of-staff` / `cartographer` / `intake-desk` (bridges, cardinality 1)
+ `engineering-manager` (engine, cardinality N).

## Consequences

- **Supersedes the "five standing roles, not four" ruling** recorded in the `crew/roles.ts`
  module comment (pinned by `roles.test.ts`). The roster is four kinds-mapped slugs, one of
  them multi-instance; `junior-engineer` is removed from the roster entirely.
- **`crew/roles.ts` changes shape** from a slug tuple to a role→kind map, and the tracker's
  `RegistryState` relaxes from ≤1 lease per role to the per-kind rule (bridges 1, engines N).
  The wire already speaks multi-peer, so this is a registry/type change, not a protocol break.
  Landed by **#3234**.
- **Two `engineering-manager` sessions boot cleanly; a second bridge of any kind dies loudly
  at boot.** Boot-time lease refusal is preserved for bridges and removed for engines.
- **The plugin crew defs are rewritten, not ported** (**#3235**): four channel-native roles,
  flat topology, and the doctrine shipped as the default. `exec-assistant.md` is replaced by
  `chief-of-staff.md` inheriting the verifier charter; the hub-and-spoke "route execution to
  the engineering-manager" prose is deleted, not carried.
- **The personalization seam restructures to one role map** (**#3236**): `roles.<role>.{kind
  is fixed in code, count?, tier, wipCap?}` — config declares HOW MANY engines, `roles.ts`
  declares the KIND, the launcher passes `--role`, the tracker enforces the kind rule. The old
  three-flat-family template (`modelTiers.ea`, `tmux.windows.ea`) dies.
- **The stand-up launcher boots the whole crew from one config** (**#3237**): the tracker + 3
  bridges + N engines, cardinality declared at the launcher.
- **The distributable `claude-plugins/pipeline-crew/` plugin becomes the SOLE crew
  definition** — one artifact; the crew doctrine ships as the plugin's default ("clear cut").
- Adding a fourth bridge, or a second engine *kind*, now requires showing the role owns an
  un-transferable seam — the accountability test above — not merely that there is more work
  to absorb. Overflow is answered by starting another engine, not by minting an office.

Records the crew roster law charted on wayfinder:map #3207 (rulings #3213/#3221/#3222/#3224/
#3210/#3212/#3220). Implemented against by #3234–#3237.

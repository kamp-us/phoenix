---
id: 0204
title: Add the advisory non-routing chief-of-staff → engine `EngineNudge` edge, IntakePing-scoped (amends 0189)
status: accepted
date: 2026-07-24
tags: [pipeline, pipeline-crew, crew-mcp, topology]
---

# 0204 — Add the advisory non-routing chief-of-staff → engine `EngineNudge` edge, IntakePing-scoped (amends 0189)

**What this decides:** The chief-of-staff may send an engine a "please look at this PR/issue" nudge — the same harmless advisory shape it already sends intake-desk — but the nudge is never how an engine gets work: engines still pull everything off the board, and a lost nudge changes nothing.

## Context

ADR [0189](0189-crew-roster-law-bridges-engines.md) (the crew roster law) made the crew topology
flat peer-to-peer and killed hub-and-spoke: it deleted the EA→EM *execution-routing* edge, so an
engine receives work by pulling the board (`status:triaged`), never through the chief-of-staff.
That deletion was correct — an engine that depends on a bridge to receive work breaks
cardinality-N and turns the bridge into a switchboard — but it over-reached in prose, leaving the
chief-of-staff silent to the engine *entirely*.

Meanwhile the chief-of-staff already held exactly the shape being denied: the
`chief-of-staff → intake-desk` `IntakePing`, a non-routing advisory nudge that has never drifted
into hub-and-spoke because the board stays pull-authoritative. The asymmetry (can nudge
intake-desk, not the engine) was the real inconsistency, and its symptom was
human-as-switchboard (#3501): a chief-of-staff acting on the founder's behalf — sending targeted
"please look at / prioritize this" nudges — could not point the engine at a specific item without
a human relaying by hand.

The founder ruled on issue #3534 (2026-07-19): add the edge, scoped identically to `IntakePing`,
and amend ADR 0189. ADRs are immutable, so this ADR is the amendment record; 0189 carries the
corresponding forward `## Amendments` note, its decision text untouched.

## Decision

**The crew gains one narrow `chief-of-staff → engine` message kind, `EngineNudge` — an advisory
nudge scoped identically to `IntakePing` — and no engine ever depends on it: the board stays the
single authoritative pull-source.**

This amends ADR [0189](0189-crew-roster-law-bridges-engines.md). The roster law's flat topology
and its deletion of the execution-routing edge both still stand; what changes is only the
over-reach that read "no routing edge" as "no edge at all." The precedent that settles the
threat-model is `IntakePing` itself: the property that makes an edge safe under 0189 is not its
direction but the receiver's **code-level independence from it**. An edge no peer can become
dependent on is not a hub-and-spoke spine. `EngineNudge` carries no work — only a pointer to a
board item the engine can already see and pull itself — so a dropped nudge changes nothing an
engine does, creates no starvation for a second engine, and confers no authority.

The shipped mechanism (issue #3649) makes the ill-formed nudge unrepresentable:
`packages/pipeline-crew-mcp/src/protocol/schema.ts` defines `NudgeTarget` as a union of
`{pr}` XOR `{issue}` structs — a nudge naming both targets, or neither, does not typecheck — and
`EngineNudge {target, from, note?, at}` mirrors `IntakePing`'s shape. The edge is exposed as the
`engineNudge` seam alongside `intakePing` in `packages/pipeline-crew-mcp/src/crew/catalog.ts` and
rides the same fire-and-forget send path as every other crew edge.

**Binding constraints.**
- The board is the single authoritative pull-source; an engine boots and pulls regardless of any nudge.
- No engine ever takes a code dependency on receiving a nudge; cardinality-N is preserved.
- A dropped/offline nudge is log-and-continue — no retry, no escalation, no ack-required.
- A nudge targets exactly one specific PR or issue (`NudgeTarget`'s pr-XOR-issue union).

**Banned.**
- Using `EngineNudge` as lane-assignment, blanket command authority, or a de-facto routing path.
- Any engine behavior that blocks on, waits for, or is gated by a nudge.

## Consequences

- The chief-of-staff can discharge founder-directed targeting ("look at this banked §CP PR")
  directly over the substrate; the human stops being the relay for it (#3501's symptom).
- The edge is symmetric with `IntakePing` in scope and failure semantics, so the roster law now
  reads consistently: bridges may hold advisory nudge edges; no peer may hold an execution-routing
  edge.
- Sibling #3532 (orphan red PRs enter the board as pullable work) is orthogonal and stands: it is
  the structural fix that works with nobody awake; `EngineNudge` is founder-directed targeting.
  Both coexist.
- Any future "the chief-of-staff already talks to the engine, so let it route" argument is
  answered here: the moment an engine *depends* on the edge, it violates this ADR's binding
  constraints and 0189's flat-topology law alike.

## Records

- Records the founder ruling on #3534 (2026-07-19); attribute: the founder. Implementation landed
  via #3649 (the `EngineNudge`/`NudgeTarget` structs and the `engineNudge` seam cited above).
- ADR [0189](0189-crew-roster-law-bridges-engines.md) carries the matching forward amendment note;
  its decision text is unedited.
- Vocabulary impact: this ruling generalizes `IntakePing`'s shape into a named class — the
  **advisory nudge edge** (non-routing, board-stays-authoritative, log-and-continue). Routed to
  the glossary via report #3863 for a `.glossary/TERMS.md` row with the full "not the routed
  execution edge" disambiguation.

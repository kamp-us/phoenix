---
id: 0217
title: The `pipeline-cli` comment claim is authoritative for lane exclusion; the crew-MCP tracker claim is advisory for that purpose only
status: accepted
date: 2026-07-25
tags: [pipeline, crew, claims]
---

# 0217 — The `pipeline-cli` comment claim is authoritative for lane exclusion; the crew-MCP tracker claim is advisory for that purpose only

**What this decides:** When two mechanisms both say who owns a lane — the GitHub claim comment and the crew tracker's in-memory `channel_claim` — the GitHub comment wins. The tracker keeps every other job it does (presence, lookup, the bridge role lease); it just stops being the answer to "is this lane taken?"

## Context

Two claim systems exist and cannot see each other. The `pipeline-cli` comment claim (ADR
[0115](0115-agent-distinguishable-claim-marker.md); the marker grammar itself is §7 of
`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`) writes a `claim: <session> · <ts> ·
presence <host>/<pid>` marker as a GitHub comment; the crew MCP's `channel_claim` reserves a `resource` key in
the tracker's in-memory registry (ADR [0191](0191-crew-claim-lifecycle.md)). Neither reads the other,
so a lane held under one reads as free under the other. #4074 reported exactly that: `granted: true`
from `channel_claim` on a lane already held by a comment claim.

Both were introduced for good reasons and neither corpus tells an agent which to trust. ADR
[0215](0215-claim-identity-continuity-proof.md) settled identity *within* the comment keyspace, and its
scope note explicitly says the tracker's resource claim is a different keyspace with its own lifecycle
that nothing in 0215 governs — leaving the cross-keyspace question (#3938, epic #3766) open. This ADR
answers only the narrow half of it: which mechanism is authoritative when they disagree about a lane.

This ruling was taken by the operator, who delegated the call to the intake seat's recommendation
after reading a full options brief (posted as a comment on #4074, with the side-by-side mechanism
comparison and three candidate rulings with blast radius). Recorded under ADR
[0078](0078-product-driven-decisions-by-default.md) — engineering leads on platform/infra. Confidence
at the time of the ruling was stated as **moderate**; the named reason is the tension recorded in
Consequences below.

## Decision

**The `pipeline-cli` comment claim (ADR 0115) is authoritative for lane and resource exclusion; the
crew-MCP tracker claim (`channel_claim`) is advisory for that purpose.**

The demotion is scoped to lane/resource exclusion and to nothing else. The tracker retains, unchanged
and unaffected:

- **presence / liveness** (ADR [0191](0191-crew-claim-lifecycle.md)) — announce, heartbeat, TTL aging;
- **`LookupClaim` / `LookupRole`** — the read side of who is where;
- **the role-cardinality lease**, which enforces bridge singleton-ness under ADR
  [0189](0189-crew-roster-law-bridges-engines.md). This one is load-bearing to state explicitly: the
  lease *shares the tracker's claim keyspace* — `makeCrewChannel` acquires it via `tracker.claim({resource:
  cardinalityLeaseKey(role, address), …})` in `packages/pipeline-crew-mcp/src/crew/channel-server.ts` —
  so a blanket "the tracker claim is advisory" would silently disable bridge uniqueness. It does not.
  The role-cardinality lease stays authoritative for role cardinality.

Grounds:

1. **Durability.** The tracker registry is in-memory only: `RegistryLive` is a single `Ref` over a pure
   core (`packages/pipeline-crew-mcp/src/tracker/registry.ts`,
   `packages/pipeline-crew-mcp/src/tracker/registry-core.ts`), living inside whichever peer won the
   socket bind. Host exit means every claim is gone, and there is **no claim event log**, so nothing is
   recoverable. An exclusion guarantee that evaporates on process exit is not a guarantee. The comment
   claim is a GitHub comment: durable server-side, with full history readable.
2. **Reachability.** `channel_claim` is an MCP edge tool, not a CLI. A `write-code` coder in a worktree,
   an ephemeral CLI run, or a human has no crew presence lease and therefore no way to take a tracker
   claim at all. The comment claim is reachable by every actor.
3. **No live ADR is contradicted.** ADR 0215's scope note already disclaims the tracker keyspace. This
   decision is compatible with 0115, 0189, 0191 and 0215 as accepted; none is superseded or amended.
4. **The mechanism already exists.** The engine already runs `pipeline-cli tracker claim` on its repair
   path (`claude-plugins/pipeline-crew/agents/crew-engineering-manager.md`), so this names an existing
   capability rather than requiring a new one.
5. **Trust root and release paths.** The comment claim is ACL-rooted — write+ collaborator, ADR
   [0055](0055-acl-sourced-review-authz.md) — with exactly three release paths (ADR 0215 §5: affirmative
   release presenting the marker's token, proven claimant death, operator clearance) and explicitly no
   TTL. The tracker claim's liveness rides its holder's presence lease, which ages out at
   `DEFAULT_TTL_SECONDS = 30`. That age-out is correct for liveness and wrong for lane ownership.

**Binding constraints.**
- A lane-exclusion decision reads the comment claim; a tracker `granted: true` is not sufficient to open a lane.
- A tracker `collision` remains useful advice — back off — but is not a source of ownership truth.
- Nothing here relaxes the role-cardinality lease or presence/lookup.

## Consequences

- **Two sentences in `claude-plugins/pipeline-crew/agents/crew-engineering-manager.md` become wrong**
  and must be rewritten: it currently calls `channel_claim` "a REAL cross-engine lock" and says the
  claim "frees on its own … there is no manual release you must remember." That corpus reconciliation
  is filed as a child issue, not edited here.
- **Lane checks now cost a GitHub REST round-trip.** There is no local answer. Rate-limit and latency
  handling on a hot dispatch path is deferred to implementation.
- **#3938 is not settled by this, and its shape is different from a missed consultation.** In its
  reported incident every lane key returned `granted: true, collision: false` while two actors
  demonstrably worked the same lanes — a false all-clear from a registry that *was* consulted. Its root
  cause remains undiagnosed (it is an open `type:investigation` discriminating three candidates). This
  ADR names which mechanism is authoritative when the two disagree about a lane; it establishes neither
  that the authoritative mechanism always answers correctly, nor that a dispatcher consults it before
  opening a lane. Those are separate and both open — correctness of the answer in #3938's diagnosis,
  enforcement of consultation in #3816's main acceptance criterion (pull-dispenser vs spawn-gate).

  If #3938's diagnosis lands on the two-registry blindness recorded in #4074 as its root cause, this
  ADR is a *partial* remedy for it — a dispatcher consulting the now-authoritative mechanism would have
  seen the collision the tracker missed. That is not asserted here; it depends on a diagnosis nobody has
  yet completed.
- **#4118 moves onto the critical path for lane exclusion.** It is the ADR 0215 continuity path, and
  0215 now governs the authoritative mechanism.
- **The tracker's founding rationale cuts the other way; that tension is accepted, not hidden.** The
  docblock in `packages/pipeline-crew-mcp/src/edge/claim-tool.ts` justifies the tracker claim precisely
  because the GitHub marker is degenerate under a shared login (incident #3498 → duplicate PRs #3503 /
  #3508; that docblock names #3509 as the *missing seam*, not as the incident). The answer relied on here is ADR 0115's session-id tiebreak. **This decision rests on that
  tiebreak holding, and it was not empirically re-verified when the decision was taken.** If the
  shared-login tiebreak proves insufficient, this ADR is expected to be cheap to amend.
- **That dependency has since been observed failing — the disclosure above, made concrete.** While this
  ADR was in flight, `pipeline-cli claim status --issue 3955` reported owner `fcd74bd3` with
  `liveness=LIVE` while the crew tracker reported the same lane held by a different engine. The two
  systems disagreed, and on that instance the mechanism this ADR promotes was the wrong one.

  **The mechanism is settled, and it is not a liveness defect.** ADR
  [0215](0215-claim-identity-continuity-proof.md) already decided this: `CLAUDE_CODE_SESSION_ID` is "**not
  stable for a process's lifetime** — compaction or a restart rotates it while the process keeps running,"
  and the false-live reading is foreclosed there by name — a stamped claim whose pid probes `running` is
  `live`, an unstamped claim is `unknown`, and "**both branches correctly conclude the claim stands** —
  because the holder genuinely is alive." So the probe is behaving correctly; what is stale is the
  *identity* stamped on the marker. This is the identity-rotation class (ADR 0215 / #4045), already
  decided, with implementation tracked as #4118. #4177 (`type:investigation`, p1) narrows the residual
  exposure to the **identity-supply** path rather than the tiebreak compare, since the pure resolver core
  is already unit-tested while a delegated `--session` token hands the same identity to two engines by
  construction. #4045 (closed p0) is the observed half: a live process locked out of its own claims, six
  lanes stranded. The pid probe is authorized by **ADR 0215 §5** (amending ADR 0115 §5), *not* by ADR
  0191 — 0191 governs the crew-MCP tracker keyspace, whose liveness is presence-lease/TTL-derived with no
  pid probe at all, as 0215's own scope note says. That miscitation is a tracked class, corrected under
  **#4120**; the other ADR 0191 citations in this record are about the tracker keyspace and stand.

  **The residual, at full strength.** A `live` verdict proves a process exists at the stamped
  `<host>/<pid>`; it does not prove the session identity named as owner still exists, nor that anyone is
  still working the lane — the presence witness identifies a long-lived session process that outlives its
  session ids and hosts many lanes concurrently, so it is a necessary condition for continuity and never a
  sufficient one (ADR 0215 §2). The witness is therefore coarser than the owner key by **two independent
  factors** — one process outlives its session ids, and one process concurrently hosts many lanes — so
  `live` cannot distinguish (a) the original session still driving the lane, (b) a rotated successor on
  the same process, (c) a sibling lane's agent sharing the ancestor process, or (d) an idle process that
  abandoned the lane hours ago.

  The #3955 observation above grounds both factors. Its `liveness=live` witness was pid 23523 — a real
  live process whose start (`2026-07-25T23:09:51Z`) *predates by ~2h14m the claim it minted*
  (`2026-07-26T01:23:26Z`), which rules out pid reuse — while an older marker's pid 58975 was genuinely
  gone and correctly read dead-and-superseded. The mechanism works in both directions; what fails is
  identity, not liveness. And at that moment one session held five open lanes (#3955, #4074, #4171,
  #4064, #4168) stamped with the identical witness — factor two, observed directly.

  **How this ADR must therefore be read:** *a claim can read live while the identity that holds it can no
  longer assert ownership, and a live witness says nothing about which of its many lanes anyone is
  actually working — so `liveness=live` is not proof that the claiming identity is still actively working
  the lane.* This ADR carries **no liveness guarantee**. It decides only which mechanism is authoritative when the two
  disagree about a lane; that authority is not a warrant that the authoritative answer is current. The
  stronger gate is ADR 0215's continuity proof rather than a bare pid check, which is a further reason
  #4118 sits on the critical path. None of this reverses the ruling — #3938 records the tracker failing
  in the *other* direction (a false all-clear), so neither mechanism is un-failing; this was a disclosure
  defect in this ADR's body, repaired here, not grounds to re-decide.
- **Lane-key unification is out of scope.** `issue-<N>` vs `pr-<N>` as two unlinked keys is already
  tracked under epic #3766.

## Alternatives considered

- **Tracker authoritative, comment claim retired.** Rejected on durability (in-memory, no event log,
  gone on host exit) and reachability (unreachable from a `write-code` worktree, a CLI run, or a human).
  It would also delete the `write-code` Step 3.5 / R0 mis-attribution guard that actually refused during
  the #4074 incident, supersede ADR 0115, and moot ADR 0215 — merged hours earlier. And the tracker side
  has no claimant-continuity model at all: its claimant is an inbox address with no witness, so claim
  identity would have to be re-decided from scratch.
- **Deliberately layered — both retained, each with a stated scope.** Rejected because it leaves the
  exclusion guarantee partial by construction: the two layers are instructed in disjoint corpora, so
  #4074's reported `granted: true` on a held lane stays reproducible. It changes nothing operationally.

## Records

- **Closes the question in #4074.** Satisfies the appended acceptance criterion in **#3816** requiring
  that the enforcement seam name which mechanism it is authoritative over.
- **Cross-references:** #4045 / ADR [0215](0215-claim-identity-continuity-proof.md), #4000, #4118,
  #4120, #3938, #3766, #4141.
- **Vocabulary impact: none.** This ADR coins and redefines nothing. It re-decides precedence between
  two already-named mechanisms — the *comment claim* / *claim marker* (ADR 0115, ADR 0215) and the
  tracker's *resource claim* / *role lease* pair (ADR 0191) — using each term exactly as its defining
  ADR does. No `.glossary/TERMS.md` row is added or changed.

> Amendment 2026-08-19: the comment claim this ADR makes authoritative now lives at `fabrika lane claim` (`packages/fabrika-cli/src/lane/claim.ts`, `claim-verb.ts`), not `pipeline-cli`; the crew-MCP tracker and `packages/pipeline-crew-mcp/` are deleted, so the advisory half is moot (ADR [0279](0279-v1-crew-retired-in-full.md)) and the v1 plugin paths cited here are gone (ADR [0303](0303-retire-kampus-pipeline-plugin.md)). The ruling itself — the GitHub comment claim is the answer to "is this lane taken?" — is unchanged.

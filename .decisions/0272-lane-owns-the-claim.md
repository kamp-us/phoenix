---
id: 0272
title: The lane owns the claim — release at merge or abandonment, never at run terminus
status: accepted
date: 2026-08-10
tags: [pipeline, concurrency, agents, claim, decisions]
---

# 0272 — The lane owns the claim — release at merge or abandonment, never at run terminus

**What this decides:** A coder run finishing is not the same thing as the work being finished. So the claim that says "this issue is mine" stays put when a run ends — it is only given up when the PR merges or the lane is abandoned. The trade this makes is that a lane nobody is working on any more can sit on its claim, so the thing that reaps dead claims has to actually work.

## Context

This records a founder ruling given 2026-08-10 on [#4145](https://github.com/kamp-us/phoenix/issues/4145), a `type:decision` open since 2026-07-26. It **amends ADR [0215](0215-claim-identity-continuity-proof.md) §5 in part** — the first of its three claim endings — and rests on ADR [0115](0115-agent-distinguishable-claim-marker.md) §3's delegated-ownership contract.

### The fork, and why it was a fork

Two rules in the pipeline's claim contract are each individually deliberate and each backed by its own incident, and they disagree on exactly one thing — the **unit of ownership**:

- **Release at run terminus is mandated.** `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` §7 (*"Release — the claim ends when its run does"*) names exactly two callers: `write-code` Step 8 (`claude-plugins/kampus-pipeline/skills/write-code/SKILL.md`) and the end of repair Step R3 (`claude-plugins/kampus-pipeline/skills/write-code/repair.md`). Both invoke the same release script unconditionally, under the token the run held — the dispatcher's delegated token on the orchestrated path. Added for [#3780](https://github.com/kamp-us/phoenix/issues/3780), where six lanes stalled behind claims whose work was finished and every later dispatch read `lost`.
- **The repair guard refuses an unclaimed lane.** `write-code` Step R0 gates every repair round on the claim resolving to the dispatch's own token, default-deny. Zero authorized claims resolves `no-winner` and the coder stops with zero mutations — and it correctly declines to self-claim to satisfy its own guard, which would be the [#3751](https://github.com/kamp-us/phoenix/issues/3751) fail-open.

Release treats **one coder run** as the unit of work. A lane spans **many coder runs plus the gates between them**. Every one of #4145's six sightings is that gap: a run ended while the lane was still alive, the marker went away, and the next dispatch refused.

### Six sightings over sixteen days

PR #3955 repair rounds 4→5 and 6→7; a board-side sighting of a live lane carrying no marker at all (#4129 / #4031, folded in from #4147's triage); [#4235](https://github.com/kamp-us/phoenix/issues/4235) and [#4421](https://github.com/kamp-us/phoenix/issues/4421), both closed as duplicates *into* #4145; and — 2026-08-10 — issue #5355 / PR #5365. The last is a genuinely new variant: every prior instance was repair-round → repair-round, while this one fired on an **initial build succeeding**. The build passed, Step 8 released, the reviewer FAILed at head, and the repair dispatch refused at R0. A full agent cycle was burned. So the rule written here has to cover *"initial build succeeded, PR open, gate not yet run"*, not only *"repair round handed a FAIL back."*

### This is not a blank fork — ADR 0215 already speaks

#4145's body framed the question as ADR 0115's silence: §3 establishes delegated ownership (the orchestrator posts the claim and threads the token; `write-code` recognizes it as its delegated own rather than re-racing), §5 covered only the crashed-claimant case, and neither says whether a delegate may retract a marker it did not create. #4235's fold-in falsified that framing, and the ADR text bears it out. ADR [0215](0215-claim-identity-continuity-proof.md) §5, accepted 2026-07-25, enumerates the claim endings and scopes the first to the poster — *"Affirmative release by its owner — the run that holds the claim retracts its own marker at its terminus"* — and its binding constraints rule directly on the delegated case: *"the permissive `--session` release is an **operator surface** and agents must not call it with a token they did not mint."* A delegate's release is none of 0215's three endings and is forbidden by that constraint. The skill text contradicts an accepted ADR.

Two further findings from that fold-in are load-bearing here. First, `write-code` Step 8 contradicts *itself*: it instructs the delegated release (*"the token we owned the work under"*) and, fifteen lines below, forbids evicting *"another session's claim"* — both readings are literal, which is why two coders on the same path behaved differently. Second, the release verb (`packages/pipeline-cli/src/tools/claim/`) is not defective: the token **is** the identity, so a delegate holding the dispatcher's token is indistinguishable from the dispatcher. This is a delegation-hygiene defect in the skill text, not a code defect.

#4421's fold-in supplies the sharper frame: an *orphaned* claim self-heals through 0215's liveness supersession, so the wedge is not an orphaned claim — it is an **unowned lane**, a lane with no marker at all between PR-open and merge, because there is nothing for supersession to act on.

## Decision

**The unit of ownership is the lane, not the run: a claim — delegated or self-minted — is released at merge or abandonment, and never at the terminus of a run that leaves the lane alive.**

### 1. Lane terminus, defined

A lane's claim ends when, and only when, one of these holds:

- **Merge** — the lane's PR lands.
- **Abandonment** — the lane's PR is closed unmerged, or its issue is closed without a landed change, or the claimant is proven dead and superseded under ADR [0215](0215-claim-identity-continuity-proof.md) §5, or an operator clears the claim under that same section.

A run ending — an initial build that succeeded and opened a PR, a repair round that pushed a fix and handed the PR back to the gate — is **not** a lane terminus and releases nothing. Whether the run "succeeded" is irrelevant: an open, un-gated PR means another round is still possible.

### 2. A delegate never releases a token it did not mint

This restates ADR 0215's binding constraint rather than inventing a rule, and resolves the Step 8 self-contradiction in 0215's favour. A claim posted by a dispatcher belongs to that dispatcher until lane terminus. The coder it delegates to recognizes the threaded token as its delegated own for the purpose of the R0 guard (ADR [0115](0115-agent-distinguishable-claim-marker.md) §3) and **never** calls the permissive release with it.

### 3. The #3780 direction stays closed

A lane whose work is genuinely finished must not keep a claim that makes every later dispatch read `lost`. Under §1 that is discharged at merge — the point at which the work *is* finished — not by an earlier eager release. The failure #3780 recorded is not re-opened; it is re-timed.

### 4. The guard stays fail-closed

Nothing here makes the R0 claim guard advisory. A coder still never self-claims to satisfy its own guard (#3751), and a claim check that resolves `no-winner` still refuses with zero mutations. The lifecycle is what was wrong, not the guard.

### 5. The reaper is a condition of this decision, not a follow-up

Making a claim outlive its run means a genuinely dead lane now holds its claim until something reaps it. **This ruling is not shipped until the reaper is proven to fire on an abandoned lane** — asserting that it does is not enough. The founder gave the ruling with this caveat explicitly on the table: without a working reaper, this trades a wedged-lane failure for a stuck-claim failure.

The reaping machinery is the one ADR [0215](0215-claim-identity-continuity-proof.md) §5 already authorizes — **proven claimant death** (presence stamp present, host fingerprint matched, `kill(pid, 0)` proving the pid gone), plus **operator clearance** for everything the mechanical path cannot reach. That path has been observed working (a retired session's marker superseded cleanly on #4408). It is deliberately *not* an age-out: 0215 bans evicting a claim on age or TTL, because a TTL evicts a slow-but-live agent, and this ADR does not lift that ban. If an implementer concludes the presence-keyed path cannot reach some class of abandoned lane, widening it needs its own ADR superseding that ban — not a quiet TTL.

**Binding constraints.**
- A claim is released at merge or abandonment only; a run terminus releases nothing.
- An agent never calls the permissive release with a token it did not mint (ADR 0215, unchanged).
- The R0 claim guard stays default-deny and fail-closed; no self-claim to satisfy it.
- Landing this requires a reaper demonstrated to fire on an abandoned lane, not asserted to.
- A repair dispatch that refuses at the claim guard must be distinguishable from a run that completed and changed nothing.

**Banned.**
- Releasing a claim because a run ended, on either the success or the hand-back path.
- Age-keyed or TTL-keyed claim eviction (ADR 0215 §5, untouched here).
- A second claim keyspace or a repair-specific claim mechanism (ADR 0215, untouched here).

## Consequences

- **Easier:** the six-sighting failure class stops being reachable. A lane with an open, un-gated PR keeps an owner, so a directed repair or follow-up dispatch resolves cleanly instead of refusing at the guard. The two contract surfaces stop reading two ways.
- **Harder / accepted:** a dead lane now holds its claim until it is reaped, which is a real new failure mode and the reason §5 is a condition rather than a note. The claim's lifetime also stops being derivable from a single run's control flow — it is now keyed on PR/issue state, which the release path has to read.
- **Contract surfaces change, but not here.** Implementation is out of scope for this ADR: `gh-issue-intake-formats.md` §7, `write-code` Step 8 (including its internal self-contradiction), repair Step R3, and Step R0's dispatcher obligation all have to be reconciled with §1–§4, and the reaper proof of §5 has to be produced. #4145's remaining acceptance criteria carry that work.
- **The release verb is unchanged.** The token is the identity and the verb behaves as documented; nothing here asks it to distinguish an owned token from a delegated one. The witness-checked release that would give ADR 0215's constraint mechanical teeth is #4118, still unimplemented — this decision is enforced in skill text until it exists.
- **Silence is the other half of the harm.** A refused dispatch reads like a completed run that did nothing, which is why six sightings took sixteen days to force a ruling. Surfacing the refusal is a binding constraint above, not a nicety.
- **The sibling issues are untouched.** #4147 (the assignee frees too late, or never) is the inverse polarity of the same seam and is not settled here. #4074 (two claim systems that cannot see each other) and #4141 (the crew-MCP channel claim) are different keyspaces, as ADR 0215 already scopes itself out of by name.
- **Two adjacent ADRs are downstream, not in conflict.** ADR [0217](0217-lane-claim-authority.md) keeps the `pipeline-cli` comment claim authoritative for lane exclusion and its §5 restates ADR 0215 §5's three release paths **by citation**; it decides nothing about *when* the first of those paths fires, so it inherits the re-timing above with no change of its own. ADR [0191](0191-crew-claim-lifecycle.md) governs the crew-MCP resource claim — a separate keyspace with its own lifecycle — and is untouched here.

## Records

- **Rules on [#4145](https://github.com/kamp-us/phoenix/issues/4145)'s first acceptance criterion** — the recorded choice between run and lane. The issue stays open for its contract-surface criteria (formats §7, `write-code` Steps 8 / R3 / R0, the non-silent refusal) plus the §5 reaper proof.
- **Of the three candidate directions #4145 carried:** direction 1 (release only at lane terminus) is taken, generalized to cover the initial-build-success variant. Direction 2 (a delegate never releases a claim it did not create) is taken too, and is not a separate choice — it is ADR 0215's existing binding constraint, which the skill text had been contradicting. Direction 3 (have the repair dispatch re-assert the claim) is rejected as the ruling's mechanism: it leaves the lane markerless in the window between release and re-claim, so a second directed dispatch can still resolve `won` onto a live lane, and it relies on every dispatcher remembering — the reporter's own weakest option, and the path by which two rounds were recovered by hand.
- **Vocabulary impact:** one term is coined — **lane terminus** (the merge-or-abandonment point at which a claim ends, as against a *run* terminus, which ends nothing). Following ADR [0215](0215-claim-identity-continuity-proof.md)'s precedent for *presence witness* / *claim continuity*, this names mechanics inside one keyspace rather than cross-cutting repo vocabulary, so **no `.glossary/TERMS.md` row is added**; its canonical home is this ADR plus `gh-issue-intake-formats.md` §7.

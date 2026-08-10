---
id: 0215
title: Claim identity — the session id owns, the process witness proves continuity, nothing is inferred
status: amended-in-part by [0272](0272-lane-owns-the-claim.md)
date: 2026-07-25
tags: [pipeline, concurrency, agents, claim, decisions]
---

# 0215 — Claim identity — the session id owns, the process witness proves continuity, nothing is inferred

**What this decides:** A claim on an issue keeps naming the claiming agent's session id as its owner, and now also records which long-lived process that agent ran inside. When an agent's session id changes while its process keeps running, it does not silently take its old claims back: it hands in the old token, releases the claim, and claims again under its new name. Whatever it cannot prove that way stays a human's call — and a claim is never taken away merely for looking old or looking unfamiliar.

## Context

This ADR **amends ADR [0115](0115-agent-distinguishable-claim-marker.md) §5 in part** and folds in the amendment issue [#4000](https://github.com/kamp-us/phoenix/issues/4000) asked for. Both concern the same clause — when and how a claim ends — and two live records amending one clause is exactly the fork this avoids.

Its scope is the **GitHub claim-marker keyspace** only: the `claim: <session> · <ts> · presence <host>/<pid>` comment defined in `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` §7 and resolved by `packages/pipeline-cli/src/tools/claim/` over `packages/pipeline-cli/src/tools/epic-lock/`. That marker also backs the `status:planning` epic lock (ADR [0059](0059-epic-plan-lock.md)), so the identity rules below govern a planning claim exactly as they govern an issue claim; 0059's own decisions — the label as the coarse lock, flip-vs-supersede, held-to-PASS-or-park — are untouched. The trust root under every read stays GitHub's write+ repo ACL (ADR [0055](0055-acl-sourced-review-authz.md)): an unauthorized marker is not a claim, here as everywhere. The crew tracker's *resource claim* is a different keyspace with its own lifecycle (ADR [0191](0191-crew-claim-lifecycle.md)); nothing here governs it, and their cross-keyspace reconciliation remains #3938 / epic #3766.

### The defect this answers (#4045)

Ownership is decided by session-id equality alone. `resolveClaim` (`epic-lock/claim-resolution.ts`) returns `won` only when the earliest authorized claim's session equals the caller's, and `claimIsMine` (`claim/claim-is-mine.ts`) default-denies everything else. But `CLAUDE_CODE_SESSION_ID` is **not stable for a process's lifetime** — compaction or a restart rotates it while the process keeps running. The moment it rotates, the same live agent reads `lost` against its own claims.

Liveness cannot rescue this, and that is the point. `claimLiveness` (`epic-lock/claim-presence.ts`) supersedes only on positive evidence of death; a stamped claim whose pid probes `running` is `live`, an unstamped claim is `unknown`, and **both branches correctly conclude the claim stands** — because the holder genuinely is alive. The lockout is total: the release path is session-keyed too (`ownClaimCommentIds`), so the successor can neither win, nor release, nor be superseded out of the deadlock. Rotation emits no error; the first signal is the next claim check.

The reported incident stranded six in-flight lanes at once, one of which was the fix lane for the claim-orphaning class itself. Two are still standing on the live board: issues #3943 and #3870 each carry one authorized claim from session `85123b6c-…`, `liveness: unknown`, with no branch and no PR behind them.

### Two identities, and what each one actually identifies

The fix hinges on a fact about the presence stamp that was never load-bearing before: **the stamp identifies the session process, not the agent run.** `resolveSessionPid` (`epic-lock/claim-presence.ts`) walks from the writing process to its nearest `claude` ancestor, so every run hosted by one long-lived session process stamps the *same* `<host-fingerprint>/<session-pid>` pair. Verified while authoring this ADR: a run under a freshly spawned agent session resolved `currentSessionPresence()` to the identical pair carried on that lane's claim marker, minted by a different run, and `ps` showed that `claude` process had already been alive for seven hours.

So the two recorded identities sit at different granularities, and neither can do the other's job:

| identity | granularity | stable across rotation | agent-distinguishing |
| --- | --- | --- | --- |
| session id | one agent run | no | yes |
| presence witness (`<host>/<pid>`) | one session process, many runs | yes | no |

A session process outlives its session ids and hosts many lanes — sequentially over hours, and concurrently across spawned agents that share it as their nearest `claude` ancestor. That asymmetry is the whole decision: the fine key answers *who owns this*, the coarse witness answers *is that owner's process still here*, and continuity is the only question that needs both.

### Why this record and #4000's are one record

#4000 asks for an ADR authorizing what PR #3986 shipped in skill text: proven-death-only supersession of GitHub-keyspace claim markers, with ADR 0115 §5's "sticky until a human clears it" narrowed accordingly and its Consequences item 92 reconciled. That question and this one are the same question asked from two ends — *how a claim ends* and *what a claim's owner is* — and both amend §5. Folding them keeps one authority for the claim's lifetime; the alternative (ship this narrow and let #4000's land beside it) leaves two live ADRs amending one clause, each silent about the other. So this ADR carries #4000's amendment too, and the [Records](#records) say what that discharges.

## Decision

**A claim records two identities with two jobs — the session id as the owner key, the session process as a liveness and continuity witness — and a successor session never adopts a predecessor's claim by inference: it presents the predecessor's token to release the claim and re-claims under its own, and whatever it cannot prove that way is an operator's call.**

### 1. Ownership stays keyed on the session id

The owner key does **not** move to the process pair. The session id is the finest agent-distinguishable token the runtime exposes (ADR 0115), and the process pair is strictly coarser: every run under one `claude` session process stamps the same witness. Re-keying ownership on it would make two lanes driven by one session process indistinguishable owners, so a run that never claimed #N would resolve `won` on #N. That is not a stricter fail-closed — it is **fail-open**, and it re-creates ADR 0115's #1431 double-implement in a new flavour, silently. The same argument kills pid reuse as an ownership signal: a recycled pid reads `running`, which is the correct fail-safe direction for *liveness* (doubt refuses) and the wrong one for *ownership* (doubt would grant).

The stuck-lane cost of keeping the session id is real and accepted. It is the price of never granting ownership to an actor that did not claim.

### 2. The process witness is recorded as a witness — necessary for continuity, never sufficient

Every claim writer stamps `presence <host-fingerprint>/<session-pid>` (already required, #3987). This ADR promotes that stamp from a liveness-only input to the recorded **continuity witness**: it is what lets a later reader ask "was this claim minted by the process I am running in?" A witness match is a *necessary* condition for continuity and never a sufficient one, because it cannot separate a rotated predecessor from a sibling lane on the same process.

A marker with no witness — the bounded pre-stamping population — can support no continuity claim at all. Those lanes are operator residue (§5), not a mechanism gap to close by relaxing anything.

### 3. Continuity grants release, never adoption

A successor session may act on a predecessor's claim only under **both** conditions, together:

1. the claim's presence witness equals the successor's own `currentSessionPresence()` — same machine fingerprint *and* same session pid, so the same live process minted it; and
2. the successor **presents the predecessor's token explicitly** (`--session <token>`), supplied by the caller and never derived by the resolver from the witness match.

The power those two conditions grant is **release, then re-claim** — retract the predecessor's marker, then claim in the successor's own name and let the ordinary earliest-authorized-claim tiebreak decide contention. Silent **adoption** — treating the predecessor's marker as the successor's own — is banned, because adoption grants ownership by inference and, under a shared session pid, would hand a sibling lane's claim to whoever asked.

Requiring both conditions is what makes this safe against the failure it exists beside. Condition 1 alone is inference over a coarse witness. Condition 2 alone is unbounded: the token is published in a public comment, so anyone can read it. Together, no *mis-attributed issue number* can ever reach the path — the token comes from the caller, not from the number — which is the #1404 accident class the mis-attribution guard was built for.

### 4. Rotation is proven lazily, at the next claim check — there is no rotation event

Nothing observable happens when a session id rotates: no error, no hook, no signal until the next claim check reads `lost`. So continuity is **not** recorded at rotation time; it is proven lazily, at the first check that fails.

That check therefore carries a reporting duty. When ownership resolves `lost`, the resolver states whether the winning claim's witness matches this process — the one datum that separates "this is my own pre-rotation claim" from "this is another agent's live lane". **The verdict itself is unchanged: `is-mine` still default-denies and still exits non-zero.** Surfacing the diagnosis is not granting the claim; the successor still has to run the §3 release explicitly.

### 5. A claim ends three ways, and never any other way

The claim lifetime clause of ADR 0115 §5 is replaced by this enumeration:

- **Affirmative release by its owner** — the run that holds the claim retracts its own marker at its terminus (`claim release`, #3780). A release cannot evict anybody, which is why it sits outside §5's deferral.
- **Proven claimant death** — the claim is superseded when, and only when, all three hold: the marker carries a presence stamp, its host fingerprint matches a *resolved* local machine identity, and a `kill(pid, 0)` probe proves the pid gone (`claimLiveness` / `probePid`). This authorizes what PR #3986 shipped and what `gh-issue-intake-formats.md` §7 already describes. Every other state — unstamped, another machine, an unresolvable local identity, an unprobeable or reused pid — is indeterminate, counts as live, and the reader refuses.
- **Operator clearance** — a human clears a claim on evidence from outside this keyspace (the run's PR landed; the operator knows the session is gone), by deleting the marker or by presenting its token to `claim release`. This is the sanctioned fallback for every residue the two mechanical paths cannot reach, including the rotation case whose witness is missing.

ADR 0115 Consequences item 92 said full crashed-claim reclaim was a deferred follow-up. What that deferral protects is **age-keyed** reclaim, and that stays deferred and banned: a TTL evicts a slow-but-live agent. Presence-keyed supersession is a different mechanism — it cannot fire on a live claimant — which is why it is authorized here where a TTL is not.

**Binding constraints.**
- Ownership resolves on session-id equality against the earliest live-or-indeterminate authorized claim. Unchanged.
- Continuity requires a witness match **and** an explicitly presented token, and grants release only.
- Release retracts only markers carrying the token the caller presents — one retraction mechanism, shared with #3780 and with any #4031 remediation.
- A machine-authorized continuity release must fail closed when the witness does not match; the permissive `--session` release is an operator surface and agents must not call it with a token they did not mint.
- Supersession stays positive-evidence-only: stamp present, host matched, pid provably gone.

**Banned.**
- Keying ownership on the process pair, or on any identity coarser than the session id.
- Adoption: treating another session's marker as one's own without releasing it.
- Evicting a claim on age, on TTL, on session-id mismatch, or on any inference from absence.
- Weakening `is-mine`'s default-deny to report a continuity candidate.
- A second claim keyspace, a second retraction verb, or a repair-specific claim mechanism.

## Consequences

- **Easier:** a rotated session has a defined, auditable way back to its own lanes — release with the old token, re-claim with the new one — and the check that used to fail silently now names why. Stranded lanes stop being unexplainable.
- **Harder / accepted:** rotation is not free. The successor must act deliberately, and a lane whose marker predates presence stamping has no mechanical path at all — it waits for an operator. Keeping the session id as the key is what buys the guarantee that no run is ever handed a lane it did not claim.
- **Fail-closed direction is untouched.** Nothing here makes an alive-and-matching claim supersedable, and no doubt-based eviction is introduced. The one new power is release-by-the-token-you-present, which is an owner-side act, not a reader-side override.
- **Live-lane eviction is bounded, not eliminated.** Someone who deliberately presents a live agent's token can free its lane. That is inherent to a public marker and is why the act is authority-gated (operator, or a witness-matched process) rather than predicate-gated for everyone. The outcome is a re-run contention, resolved by the ordinary tiebreak — never a double-implement, since the evicted agent's own next check refuses.
- **The GitHub keyspace's claim lifetime now has one authority.** ADR 0115 §5's clause is amended in part by this ADR; `gh-issue-intake-formats.md` §7 and `write-code`'s Steps 3.5 / R0 cite ADR 0191 for a mechanism 0191 does not govern, and those citations point here instead (#4120).
- **Multi-host liveness stays out of scope,** unchanged: a claim stamped on another machine is unprobeable and stands. Closing that needs a host-independent presence source (#3938 / epic #3766), not a relaxation here.

## Records

- **Closes #4045.** All five of its acceptance criteria are answered: the identity model (§1–§2), the continuity predicate (§3), the disposition of each of its three facets — stable-key rejected (§1), record-both adopted as a witness (§2), operator-initiated release as the residue fallback (§5) — the rotation-time behaviour (§4, lazy by necessity), the release path (§3, §5; `ownClaimCommentIds` needs no new mechanism), and the follow-up implementation issues below.
- **Discharges #4000's acceptance criteria 1 and 2** by folding its amendment into §5 (its option (a): authorize proven-death-only supersession, scoped to stamp-present + host match + `kill(pid, 0)`), and by reconciling ADR 0115 Consequences item 92 there. Its criterion 3 — re-pointing the skill-text citations — is filed as **#4120**, after which #4000 can close. ADR 0115's body is untouched; only its status line records the amendment, per the accepted-ADR immutability rule.
- **#4031 (unstamped pre-stamping markers) stays a separate issue, and its remediation is bounded by this ADR.** Those markers carry no witness, so they are operator residue under §5. Their remediation must be a one-time audited clearance using the single existing release mechanism — **not** a policy change: an age-out for unstamped claims is banned by §5, whatever its scope. #4031 need not wait on this ADR, but it may not widen past that line.
- **Follow-up implementation issues filed:** **#4118** (the witness-checked continuity release, and the continuity-candidate signal on a `lost` check) and **#4120** (the citation re-point). Implementation is out of scope for this ADR.
- **Vocabulary impact:** two terms are coined — **presence witness** (the `<host-fingerprint>/<session-pid>` pair a claim records, identifying the *session process*, not the agent run) and **claim continuity** (a successor session's proof that the same live process minted an earlier claim, which authorizes release and never adoption). Both are claim-substrate-internal, exactly as ADR 0191's *role lease* / *resource claim* pair is: their canonical home is this ADR plus `gh-issue-intake-formats.md` §7 and the `epic-lock` docblocks. **No `.glossary/TERMS.md` row is added** — these name mechanics inside one keyspace, not cross-cutting repo vocabulary.

## Alternatives considered

- **Re-key ownership on the process pair (`<host>/<pid>`), demoting the session id to informational** — the issue's facet 1, and the reporter's leading guess. Rejected on grounded mechanics: `resolveSessionPid` resolves the nearest `claude` ancestor, so the pair is a property of the *session process*, which hosts many lanes; keying on it grants a `won` to a run that never claimed. It trades a stuck lane (fail-closed) for a silent double-implement (fail-open), which is the trade ADR 0115 exists to refuse.
- **Adopt on a witness match alone** — the successor takes over the predecessor's marker whenever host and pid agree. Rejected: the witness cannot separate a rotated predecessor from a sibling lane on the same process, so adoption would let one lane inherit another's claim by accident. Explicit token presentation is what makes the act deliberate, and release-then-re-claim is what routes the outcome back through the one tiebreak.
- **A per-lane secret: record `H(nonce)` in the marker, prove continuity by presenting the pre-image.** Genuinely unforgeable by a reader of the public comment, and rejected anyway: the successor can only hold the nonce in process-scoped storage that a same-process sibling can read too, so it does not close the case that motivated it — while adding a secret-keeping surface and a filesystem dependency to a path that fires rarely. The token-presentation rule buys the same accident-proofing with no new state.
- **Age-out or TTL for a claim, or eviction on session-id mismatch.** Rejected, and banned in §5. A TTL evicts a slow-but-live agent (ADR 0115 §5's original hazard). Mismatch-eviction is worse: a rotated live agent's marker names a token it no longer carries, so the rule would evict precisely the lane it was written to rescue.
- **Revert the §7 proven-death narrowing** — #4000's option (b). Rejected: the mechanism is sound on its own terms (positive evidence only; it cannot fire on a live claimant) and it is the only thing unshadowing genuinely abandoned lanes. The defect #4000 named was a missing *record*, not a wrong mechanism, and §5 supplies the record.
- **Leave this ADR narrow and let #4000's amendment land separately.** Rejected: both amend ADR 0115 §5, and two live records amending one clause is the fork the folding requirement exists to prevent.

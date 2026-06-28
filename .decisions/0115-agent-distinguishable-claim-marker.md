---
id: 0115
title: The agent-distinguishable claim marker — a session-id-stamped claim comment (tiebreak on earliest authorized claim, recognized by `CLAUDE_CODE_SESSION_ID`) claimed pre-spawn, the one contract three lock surfaces adopt
status: accepted
date: 2026-06-27
tags: [pipeline, skills, concurrency, agents, claim, decisions]
---

# 0115 — The agent-distinguishable claim marker + pre-spawn claim protocol

## Context

This is the keystone decision of epic [#1431](https://github.com/kamp-us/phoenix/issues/1431): when a fleet of agents drains one shared GitHub backlog in parallel, they collide on the same unit of work because the claim protocol cannot tell two concurrent agents apart.

The root cause is precise. The issue-claim protocol (`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` §7) is a **detect-and-tiebreak**, and its tiebreak is the **lexicographic-min assignee login**. But every draining agent in this pipeline pushes as the single git identity `usirin` — `write-code` Step 3 derives `ME=$(gh api user --jq '.login')`, which is always `usirin`. So the tiebreak degenerates to a no-op: two co-racers both `POST` `usirin`, both compute `min == usirin == me`, both pass the checkpoint GET, both proceed. The mechanism that promises "exactly one implementer" assumes distinct logins it does not have. The same shared-login degeneracy defeats `write-code` Step 3's self-assign and `plan-epic`'s `status:planning` lock (ADR [0059](0059-epic-plan-lock.md)).

A second, independent defect compounds it: the claim happens *during* the run, not before it. `write-code` self-assigns at Step 3 — after the coder is already spawned and working — and the orchestrator (`.claude/workflows/drive-issue.js`) lets the coder claim mid-run. Between "an agent decides to work #N" and "that agent claims #N" there is a wide window in which a second agent also picks #N, and the "skip if there's already an open PR" guard is blind to pre-PR in-flight work. In one session this cost a full coder→review→ship cycle (#1333 built twice), a double-claim (#1334), a double-plan via the `status:planning` TOCTOU (#1359 → stray child #1403), and a mis-attribution near-miss (#1404).

This ADR is the **record** the four Phase-2 children trace to (#1453 issue-claim, #1454 orchestrator pre-spawn, #1455 `status:planning` TOCTOU, #1456 mis-attribution guard); it implements none of them. It extends the assign-then-verify, fail-closed prior art of ADR [0074](0074-adr-number-claim-lock.md) (the `/adr`-number reservation lock) and ADR [0059](0059-epic-plan-lock.md) (the `status:planning` epic lock).

### Grounding the mechanism in source

Per the repo's "ground falsifiable platform claims in source, not intuition" convention, the agent-distinguishable identifier is not asserted — it is verified.

- **`CLAUDE_CODE_SESSION_ID` is a per-session UUID Claude Code exposes in every (sub)agent's environment.** It is read today by the `report` skill's footer emitter, `claude-plugins/kampus-pipeline/skills/report/footer.sh`, which stamps `session ${CLAUDE_CODE_SESSION_ID}` into filed issue bodies — prior art that the value is present at runtime, stable for a session's lifetime, and privacy-safe (that footer's contract forbids PII and local paths, and admits this token). Epic #1431's own filing footer recorded a distinct session id (`f4f85017-…`), confirming each agent carries its own.
- **Each spawned subagent is a distinct session.** The runtime environment of a spawned agent sets `CLAUDE_CODE_CHILD_SESSION=1` alongside its own `CLAUDE_CODE_SESSION_ID`, so two concurrent subagents running under the same `usirin` GitHub login still carry two distinct session UUIDs. This is the identifier the bare assignee login cannot provide.
- **The orchestrator spawns agents without threading any identity today.** `.claude/workflows/drive-issue.js` dispatches each role via `agent(prompt, { agentType, isolation })`; the prompt carries the issue number but no claim token, and the coder claims inside its own run. Nothing in the current spawn path moves the claim ahead of the work or distinguishes the spawning orchestrator from the spawned coder — both gaps this ADR closes.

The login is degenerate; the session id is unique per concurrent agent. That is the seam the marker is built on.

## Decision

### 1. The claim marker — a session-id-stamped claim comment

The agent-distinguishable claim is a **structured claim comment** carrying the claiming agent's `CLAUDE_CODE_SESSION_ID`, matched by an emphasis-tolerant regex exactly as the SHA-bound verdict markers are (the `review-(code|doc|skill):` matcher family, ADR [0058](0058-sha-bound-verdict-contract.md)). The marker does **not** live in the GitHub assignee — that field is login-keyed and is precisely the degeneracy. The claim is therefore **two layers**:

- **Coarse availability gate — the assignee field (unchanged).** Self-assign stays as the cheap, list-visible "is this taken at all?" signal the Step-1 picker reads (`skip on any non-null assignee`). It is login-blind by design and decides nothing about *which* agent owns the work.
- **Fine, agent-distinguishable resolution — the claim comment (new).** Canonical grammar, one line, emphasis-tolerant:

  ```
  claim: <CLAUDE_CODE_SESSION_ID> · <ISO-8601-UTC>
  ```

  - **Token source:** the claiming process's `CLAUDE_CODE_SESSION_ID` environment variable (the orchestrator's when it claims pre-spawn; the coder's when `write-code` is invoked directly — see §3).
  - **Write surface:** an issue comment, posted via `gh api repos/$REPO/issues/{N}/comments` (REST, never GraphQL).
  - **Read surface:** list the issue's comments, keep those matching the claim regex **and authored by an account holding write+ on the repo** (the ADR [0055](0055-acl-sourced-review-authz.md) trust root, the same authorized-author set `ship-it` Step 2 and the `write-code` repair scan build). A forged claim from a non-collaborator is ignored; an empty authorized set resolves no claim — **fail-closed**, never a false win.

### 2. The tiebreak under one login — earliest authorized claim wins, recognized by session id

The session id is the **identity** key, not the ordering key. The tiebreak that selects the single winner is the **server-assigned ordering of the authorized claim comments**: the canonical winner is the claim with the minimum `(created_at, comment id)` — i.e. the **earliest authorized claim**, with the strictly-monotonic, server-assigned, globally-unique comment `id` as the unique sub-key when timestamps tie. An agent then recognizes ownership by comparing that winning claim's embedded session id to its own `CLAUDE_CODE_SESSION_ID`:

```
won  ==  earliest-authorized-claim.session  ==  $CLAUDE_CODE_SESSION_ID
```

This swaps the degenerate `lexicographic-min(login)` of §7 step 2/3 for `earliest(authorized claim comment)`, resolved by the same **checkpoint GET against canonical issue state, fail-closed**. The §7 race-case derivation transfers and is *strengthened*:

- **Staggered co-racers.** Each posts a claim comment; the server stamps each with a unique, monotonic `id`. The checkpoint GET re-reads the same canonical comment set, so exactly one finds the earliest authorized claim's session equals its own and proceeds; every other recomputes the same earliest claim, sees it is not theirs, **retracts its own claim comment**, and re-picks. The comment-post detects, the GET resolves — same shape as §7, but the key is now agent-distinguishable.
- **Straggler / rule-0 defer.** A late arrival's comment has a strictly larger `id`, so it is never the earliest authorized claim — it loses the tiebreak by construction **and** Rule 0 (defer to a pre-existing owner) tells it to back off before posting. Crucially, **earliest-claim-wins makes Rule 0 and the tiebreak the same fact**: the pre-existing owner *is* the minimum by construction. This removes the straggler-evicts-owner tension that §7's `min(login)` had to close with a separate non-revocability argument (a lower login could belong to a later arrival; a lower comment id cannot).
- **Transient window.** As under §7, the assignee field may transiently show two assignees and the issue's comments may transiently show two claims before a loser retracts; the picker skips on any non-null assignee, so a transiently double-claimed issue is passed over, never double-picked (safe degradation).

This remains **detect-and-tiebreak, not a kernel mutex** (the epic's honest non-goal): the comment/assignee APIs offer no conditional write, so true single-writer exclusion is not on the table. The guarantee is the one that matters — of any set of co-window racers, exactly one proceeds, deterministically, and every loser self-retracts and re-picks.

### 3. The pre-spawn claim protocol — claim before the coder runs

The claim moves **ahead of work**. The collision window today is open because the claim is mid-run; closing it means claiming before any branch, build, or spawn.

- **Orchestrated path (the common case).** `.claude/workflows/drive-issue.js` acquires the claim in a new pre-step in the `Implement` phase **before** the `agent(coder, …)` dispatch: the orchestrator posts its own session-id-stamped claim comment, runs the §2 detect-and-tiebreak, and **only on a win spawns the coder**, threading the winning claim token into the coder's prompt. On a lost claim it aborts the dispatch (no coder is spawned) and moves on. (For epics it claims before the `agent(planner, …)` dispatch via the `status:planning` surface — see §4.)
- **Delegated ownership.** Because the orchestrator and the coder are distinct sessions (the spawned coder carries `CLAUDE_CODE_CHILD_SESSION=1` and its own id), the claim token is **whoever posted the claim**. The orchestrator threads its claim token to the coder; `write-code` Step 3 then **recognizes the existing claim as its delegated own** (the threaded token equals the earliest authorized claim's session) and proceeds without re-racing — rather than posting a second, redundant claim.
- **Direct path (no orchestrator).** When `write-code` is invoked directly, its claim moves from **Step 3 to a pre-implement Step 1.5** — immediately after the Step-1 pick, before any branch or build — and uses the coder's own `CLAUDE_CODE_SESSION_ID` as the token. Either way the claim precedes work.

### 4. One contract, three surfaces

The claim primitive defined here is **single-sourced in §7 of `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`** (the existing home of issue-claim semantics) and adopted verbatim by all three lock surfaces, so they cannot drift (epic story 7):

- **Issue-claim (§7 + `write-code` Step 1.5/Step 3) — #1453.** The §7 tiebreak becomes earliest-authorized-claim, recognized by session id; `write-code` writes and reads the claim comment.
- **Orchestrator pre-spawn claim (`.claude/workflows/drive-issue.js`) — #1454.** The same primitive, lifted ahead of the coder/planner dispatch, with the winning token threaded to the spawned role.
- **`status:planning` epic lock (`plan-epic` + the §`status:planning` semantics, ADR [0059](0059-epic-plan-lock.md)) — #1455.** The `status:planning` label is the coarse lock (the assignee-analogue); a session-id-stamped **planning-claim comment** disambiguates two co-acquirers and closes the post-`/labels` TOCTOU via the same earliest-authorized-claim resolution.
- **Mis-attribution guard (`write-code`) — #1456.** Before mutating an issue or PR, an agent verifies the target carries **its own** session-stamped claim (the earliest authorized claim's session equals its `CLAUDE_CODE_SESSION_ID`), using the same read surface — so it never pushes to or closes another agent's live work via a mis-attributed number.

### 5. Staleness / reclaim (story 8) — owner-defer, reclaim enforcement deferred

The policy for a claim whose agent crashed mid-run is **owner-defer only: the claim is sticky until a human clears it** (un-assigns the issue / removes the claim, which re-opens it to the picker). Automatic TTL/hybrid reclaim is **explicitly deferred to a follow-up**, not left implicit.

Rationale: GitHub exposes no TTL primitive, and an automated TTL-reclaim risks evicting a slow-but-live agent — a false-positive reclaim re-introduces the exact double-implement this epic exists to prevent. The claim comment's `<ISO-8601-UTC>` timestamp (and the server `created_at`) is the field a future TTL or hybrid policy would key on, so the marker is **forward-compatible** with reclaim without committing to it now.

## Consequences

- **Easier:** a fleet of agents under the single `usirin` login can drain one backlog and exactly one ever implements, plans, or claims a given unit of work; co-racers resolve deterministically to one winner; losers self-retract; the claim is atomic *before* the coder spawns; and an agent can prove a target is its own before mutating it. The wasted-cycle, double-claim, double-plan, and mis-attribution failures of #1431 stop being reachable.
- **Harder / banned:** the bare assignee login may no longer be treated as an agent-distinguishing claim — it is downgraded to a coarse availability gate, and any new claim reader must consult the session-stamped comment for ownership. Relay/message-passing claims and a bare `min(login)` tiebreak are out. Claim comments add a small amount of issue-thread noise (one line per claim; losers retract theirs).
- **Trust + fail-closed:** claim comments count only from write+ collaborators (ADR 0055); a missing or unauthorized claim resolves to no owner, never a false win. If `CLAUDE_CODE_SESSION_ID` is ever absent from an agent's environment, the claim cannot be posted and the agent must abort the claim — never fall back to a login-keyed marker (that is the degeneracy this ADR removes).
- **Honest scope:** this stays detect-and-tiebreak; it narrows the window and resolves co-racers, it does not provide kernel-grade single-writer exclusion. Full crashed-claim reclaim is a stated, deferred follow-up.
- **Migration:** none for existing issues; the four Phase-2 children (#1453–#1456) implement the three surfaces + the guard against this record.

## Alternatives considered

- **Short-TTL claim label (e.g. a `claim:<id>` label that expires).** Rejected: GitHub labels carry no TTL; a label name cannot cleanly hold a 36-char UUID; label add/remove is the same additive, last-write-wins surface as the assignee with *no* server-assigned ordering signal to tiebreak on; and it adds a third distinct lock mechanism instead of reusing the comment-marker matcher the pipeline already operates. A comment carries both the token *and* a server-assigned order (`created_at` + monotonic `id`) for free.
- **Session id as the lexicographic-min *ordering* key** (swap `login`→`session-id` in §7's `min`, keep the rest — the brief's literal suggestion). Rejected as the ordering key: a random UUID's lexicographic order is unrelated to claim-arrival order, so `min(session-id)` can hand the win to a *later* arrival, reintroducing the straggler-evicts-owner tension §7 only closes via a separate non-revocability argument. We keep session id as the **identity** key and use server-assigned comment ordering as the tiebreak, so Rule 0 and the tiebreak collapse into one fact.
- **A new per-agent identity provisioning system** (mint distinct GitHub machine accounts/tokens so logins differ). Rejected: heavyweight, an explicit epic non-goal, and unnecessary — the runtime already exposes a unique per-agent token (`CLAUDE_CODE_SESSION_ID`).
- **The worktree directory name (`agent-<hex>`) as the token.** Rejected: it is a harness filesystem artifact, not exposed as an environment variable and only recoverable by parsing a local path (a local-path-leak risk the repo's no-local-paths invariant forbids in any shared artifact). `CLAUDE_CODE_SESSION_ID` is the first-class, already-consumed identifier.
- **A designated single picker / true CAS.** Rejected: the assignee/label/comment APIs offer no conditional write, and a single-picker daemon is a new always-on component outside this epic's scope and against its "no kernel-grade mutex" non-goal.
- **Relay / message-passing claims between agents.** Rejected: the brief proved messages cross in flight (a HARD PARTITION agreement was violated within seconds); relay does not close the window.

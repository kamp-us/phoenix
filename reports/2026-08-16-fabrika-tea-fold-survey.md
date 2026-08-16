# Which fabrika state could fold through tea — a survey of every verb group and skill

*Dated findings — 2026-08-16, read against the tree at commit `0dd9a537`. Produced for
[#5694](https://github.com/kamp-us/phoenix/issues/5694), which asks which of fabrika's ad-hoc state
re-derivations are genuinely folds over ordered events and which are board-truth reads.*

**This survey rules nothing.** It is the input to the direction question the founder raised
in-session on 2026-08-16 while epic [#5680](https://github.com/kamp-us/phoenix/issues/5680)'s phase 2
was being driven. It migrates nothing and recommends only a sequence.

## Scope, counted

- **25 registered verb groups** in [`packages/fabrika-cli/src/registry.ts`](../packages/fabrika-cli/src/registry.ts),
  carrying **156 leaf verbs** between them (counted as `leafCommand(` declarations across the 25
  `*/command.ts` files, excluding tests and the `excess-operand` helper).
- **24 skills** under [`claude-plugins/fabrika/skills/`](../claude-plugins/fabrika/skills/).

The ticket said "74 registry entries". That is the line count of `registry.ts`, not its entry count —
see [Corrections to the ticket's premises](#corrections-to-the-tickets-premises).

## The benchmark: what a tea fold looks like here

Every candidate below is measured against the one existing fold,
[`packages/fabrika-cli/src/lane/fold.ts`](../packages/fabrika-cli/src/lane/fold.ts). Its shape, in
four properties a candidate has to be able to match:

1. **An append-only local log is the only record.** `store.ts`'s `loadLane` reads
   `.fabrika/lanes/<n>/events.jsonl`; `parseLog` refuses a line it cannot parse rather than skipping
   it. Nothing is stored derived.
2. **The whole log re-folds every invocation.** `foldLog` runs each task's messages through
   `@demlik/tea`'s `foldMsgs`. There is no resident process and no snapshot.
3. **`deriveStatus` is the compound machine, as a pure derivation.** The active phase is the first
   whose tasks are not all final; a completed phase holding an error final trips the workflow. The
   `noErrors` gate is a derivation, never an event.
4. **Retries are machine context, not a counted artifact.** The committed template
   (`lane/templates/coder.workflow.json`) carries `{"retries": 0, "maxRetries": 2}` with a
   `retriesRemaining` guard, so the cap is enforced by the transition rather than by a caller
   remembering a number.

A candidate is **tea-foldable** when its state is an ordering over events *whose log we could own*,
and the derivation is a state machine rather than an aggregate. Two distinct reasons make a
candidate a **no**, and each row that answers `no` names which one applies:

- **`no (board)`** — the board is the shared truth across sessions. The ordering is real, but it
  arbitrates between processes in different checkouts; a per-tree log cannot arbitrate.
- **`no (not an ordering)`** — the state is not an ordering over events at all. It is a pure function
  of a snapshot: a file's bytes, a diff, a label set, a pair of flags.

## Table 1 — the 25 verb groups

| Group | State source today (file · symbol) | Tea-foldable | Why |
| --- | --- | --- | --- |
| `adr` | `adr/next.ts` (`max(union)+1`), `adr/records.ts` `isLive`/`statusOf`, `adr/resolve.ts` (four-state), `adr/sweep.ts` (idf ranking) | no (not an ordering) | Id allocation is a max over filenames plus open-PR claims; liveness is a frontmatter field. There is no event sequence to fold — a log would have to be invented to hold what the files already say. |
| `build` | split — see [Table 1a](#table-1a--build-and-ship-per-verb) | partial | Claim and repair-round state are orderings; tree, branch, pick and check are snapshots. |
| `epic` | `epic/ledger.ts` (append-only `ledger.jsonl`, `EPIC_EVENTS`, `nextSeq`, `countersFor`, `trippedAxis`) + `epic/fold.ts` (`foldSlice`, `foldRun`, `nextAction`) + `epic/graph.ts` (`GraphFacts`) | **yes** | The strongest candidate in the package. It is already an append-only local JSONL log over a closed event set, with state derived at read time and never stored; `nextAction` is `deriveStatus`'s analogue and `trippedAxis` is `maxRetries` by hand. Its own docblock names the open event-log-vs-state-machine question ([#4891](https://github.com/kamp-us/phoenix/issues/4891) Q1). Caveat: `foldRun` also consumes `GraphFacts` (git presence/ancestry), which is a snapshot read and stays one. |
| `glossary` | `glossary/history.ts` (commit-range reads), `drift-verb.ts`, `candidates.ts`, `register.ts` | no (not an ordering) | Drift is a diff between two tree states and the register is a file. Order of commits bounds the window; it does not carry state. |
| `governance` | `governance/scope-verb.ts` (file list at the bound head), `sweep-verb.ts`, `digest-verb.ts` (window walk), `readout-verb.ts` (upserted artifact comment), `head.ts` (imports `review/head.ts` `bindHead`) | no (not an ordering) — readout is no (board) | Scope, sweep and digest are functions of a diff and a commit window. The readout's durable comment is a cross-session artifact, so it stays on the board. |
| `graduate` | `graduate/trail.ts` (normalizes the sibling resolver's output, digests it), `source.ts`, `spec.ts` | no (board) | The trail is `grill`'s or `map`'s answer over a session/map issue, and this group deliberately refuses to re-parse those comments. Its input is another verb's board read. |
| `grill` | `grill/session.ts` (comments → per-question state, ACL-gated), `grill/round.ts` (round number derived from posted comments, plus the round digest) | partial | Question state genuinely folds over posted markers in order, and round numbering is `max(round)+1` over the session's comments. But the founder rules *from GitHub*; a local log could not hold a ruling, and `clear` is the token a downstream skill keys on. Board wins the arbitration half. |
| `handoff` | `handoff/packs.ts` (latest sealed pack by recency + ACL), `handoff/ground.ts` (19 digested git+board fields) | no (board) | The pack exists so a *different* session reads it. Ground is a snapshot digest — no (not an ordering) — and the pack's home has to be the shared surface by construction. |
| `heal-ci` | `heal-ci/stall.ts` (ordered total predicate chain), `heal-ci/marker.ts` (at-most-once rerun marker), `diagnose-verb.ts` (the read set) | partial | `marker.ts` is a degenerate one-event log ("this head was rerun once"), which a fold would hold naturally. `stall.ts` is *ordered* but not a fold: the order is predicate precedence over one snapshot, not a sequence of events — no (not an ordering) for that half. |
| `hook` | `hook/spawn.ts` (pure `(requested, pin)` decision), `declaration.ts`, `harness-exit.ts` | no (not an ordering) | The whole group is a pure function of two values plus a harness envelope. Carries no run state. |
| `lane` | `lane/fold.ts`, `lane/machine.ts`, `lane/store.ts` | **yes — already is** | The benchmark. |
| `ledger` | `ledger/preconditions.ts` (repo + `type:epic` + tree root + `build` claim, run dir keyed by claim nonce), `ground.ts`, `plan-block.ts`, `digest.ts` | no (board) | The plan lives in the epic body and the children are issues. Its claim half inherits `build claim`'s `partial` rather than deriving a second lock. |
| `map` | `map/frontier.ts` (`FrontierRead`: ticket markers + issue `state` + native blocking edges), `map/markers.ts`, `map/record.ts` | partial | Per-ticket state folds over posted markers, but native edges and issue state are GitHub's own record, and a map exists precisely because the fog spans sessions. Board wins. |
| `pattern` | `pattern/drift.ts` (citation resolution), `corpus.ts`, `anchor.ts`, `index-table.ts` | no (not an ordering) | Every answer is a function of file bytes and the paths they cite. |
| `plan` | `plan/load.ts`, `plan/model.ts` (topology), `plan/digest.ts`, `plan/caveats.ts`, `plan/flip-verb.ts` (re-gate then label writes) | no (board) | The plan is the epic body, the children are issues, and `flip` writes labels. The digest binds the scope it graded; it carries no sequence. |
| `report` | `report/dedup.ts` (tokenize + rank), `compose.ts`, `leaks.ts` | no (board) | Dedup is a search over open issues. Compose and the leak scan are pure text — no (not an ordering). |
| `review` | `review/head.ts` `bindHead`, `content-binding.ts` `contentDigestAt`, `write-recency.ts` (`Verdict-written:` stamp as the ordering key), `advisory.ts`, `rollup.ts` (check-run total) | partial | "Which verdict counts now" is exactly an ordering problem, and `write-recency.ts` exists *because* `created_at` was the wrong key — a hand-built sequence number. But the verdicts are written by other sessions and consumed by `ship`, so the ordering has to live where all of them see it. `rollup.ts` is a total over a set of check runs — no (not an ordering). |
| `review-ui` | `review-ui/preview.ts` (newest announcement wins), `render-leg.ts`, `upload-leg.ts` | no (board) | Preview resolution is a recency pick over the PR's comments. The legs are IO over bytes — no (not an ordering). |
| `ship` | split — see [Table 1a](#table-1a--build-and-ship-per-verb) | partial | `queue.ts` is a real timeline fold; the guard chain is not a machine. |
| `spend` | `spend/ledger.ts` (`.fabrika/spend-ledger.jsonl`, append-only, per-line `v`), `spend/rollup.ts` (pure sum) | no (not an ordering) | It already shares the ledger *idiom* — same `.fabrika/` root, same append-only JSONL — but the derivation is Σ over independent measurements. Reorder the rows and the answer is identical, which is the test a fold fails. |
| `spike` | `spike/workspace.ts` + `evidence.jsonl`, `spike/status-verb.ts` (`runs`, `lastCommandExit`, `evidenceDigest`), `spike/bodies.ts` `newestCapture` | partial | `evidence.jsonl` is a third append-only local log, but its derived fields are a tail read and a count, not a machine. The spike *lifecycle* (opened → run → captured → disposed) is a small machine, and today it is inferred from workspace presence plus the newest capture comment rather than folded. |
| `status` | `status/board-verb.ts` (label bucket counts), `config-verb.ts` (four-state file probes), `readout-verb.ts` (decodes the published artifact), `roster.ts` (plugin dir read), `menu-verb.ts`, `bootstrap-verb.ts`, `open-verb.ts` | no (board) | Counts of labels and probes of files. `status readout` re-derives nothing at all — it decodes what `governance` published. |
| `triage` | `triage/claim.ts` (marker race, `MARKER_PREFIX`), `queue-verb.ts` (label bucket + age), `facets.ts` (owned-facet reconcile), `provenance.ts`, `split.ts`, `enrich.ts`, `homes-verb.ts`, `roadmap.ts` | partial | The claim is the same race as `build claim` — see that row. Queue, facets and homes are label reads and label writes: labels *are* the shared truth and the write target, so no (board). `provenance`/`split`/`enrich` are pure predicates over body text — no (not an ordering). |
| `ui` | `ui/lane.ts` (re-seats `build/lane-guard.ts`), `golden-verb.ts` (pointer + content-addressed cache), `manifest-verb.ts`, `law-verb.ts`, `render-verb.ts`, `evidence-verb.ts` | no (not an ordering) | Manifest, law, golden and render are functions of committed bytes and a pointer. The lane precondition is `build`'s, reused, and inherits its row. |
| `wire` | `wire/registry.ts` (the format registry), `format.ts`, `conformance.ts`, `check-verb.ts`, `index-verb.ts` | no (not an ordering) | Pure codecs plus a registry array. The group is stateless by design — it is the byte-level surface two skills meet through. |

### Table 1a — `build` and `ship`, per verb

These two groups do not have one answer, and rolling them up would hide the only rows that matter.

| Verb(s) | State source today (file · symbol) | Tea-foldable | Why |
| --- | --- | --- | --- |
| `build claim` / `confirm` / `release` | `build/claim.ts` `markersIn` (sort by `created_at`, tie on comment id) → `resolveOwnership` → `requireClaim`; authorization from `io/pulls.ts` `permissionFor` | partial | Earliest-authorized-marker-wins *is* a fold over an ordering. But the ordering arbitrates between sessions in different checkouts, and the ACL read is live by design (a failed permission read is UNKNOWN, never a demotion). A local log could cache the outcome; it could never decide the race. |
| `build verdicts` (and the repair loop it drives) | `build/verdicts-verb.ts` + `build/rounds.ts` `countRounds` (FAIL timestamps clustered on a 120 s gap, `ROUND_CAP = 3`) + `wire/verdict-marker.ts` `bindToHead` | partial | `countRounds` is a pure fold over ordered FAIL events and nothing else — the single closest thing in the package to a tea retry counter. See [The retry counter exists three times](#the-retry-counter-exists-three-times). |
| `build tree` | `build/tree.ts` `readTree` / `assertGround` (git porcelain) | no (not an ordering) | A snapshot of the working tree. |
| `build branch` / `scratch` / `commit` / `push` | `build/lane.ts` (the branch name *is* the record: `build/<n>-<slug>-<nonce>`), `build/lane-guard.ts`, `build/git.ts` | no (not an ordering) | Deliberately stateless: the docblock records that there is no stamp file and that the absence is the design. A per-claim nonce in the branch name makes a duplicate lane unconstructible. A fold would reintroduce the state this removed. |
| `build pick` / `eligible` | `build/pick-verb.ts` (paged label buckets), `build/scope-admission.ts` `admit`, `build/dependencies.ts` (the `## Dependencies` grammar) | no (board) | The pool is a label query; admission is a label plus a `ROADMAP.md` focus row; dependencies are open/closed issue states. |
| `build check` | `build/check-verb.ts` (runs the repo's validators, cache bypassed) | no (not an ordering) | A function of the diff and the validators' exits. |
| `build issue` / `pr` / `note` | `io/issues.ts`, `build/pr-body.ts`, `build/content-gate.ts` | no (board) | Reads and writes of board artifacts. |
| `ship gate` | `ship/gate-verb.ts` `inForce` (head-bound first, then the body's write stamp, ACL applied), via `review/content-binding.ts` and `review/head.ts` | partial | Same ordering problem as `review`, with the same board constraint: the verdicts being ordered were posted by other sessions. |
| `ship enqueue` / `reconcile` | `ship/queue.ts` `queueStateOf` (folds `added_to_merge_queue` / `removed_from_merge_queue` / `merged` with a 5 s pairing window), `reconcile-verb.ts`, `dark-ship.ts` | partial | `queueStateOf` is a textbook fold over an ordered event stream — but the stream is GitHub's own timeline, which is the authoritative record of what the merge queue did. We can fold it; we cannot own it. |
| `ship scope` / `cp-approval` / `floor` / `checks` / `evidence` / `threads` / `resolve` / `disarm` / `nudge` / `note` / `release` | `ship/scope-verb.ts`, `ship/codeowners.ts`, `ship/checks-verb.ts` (via `review/rollup.ts`), `ship/threads.ts`, `ship/evidence-verb.ts` | no (not an ordering) | The guard chain is **not a machine**. Each guard is an independent predicate over the PR's current state, evaluated fresh, carrying nothing to the next; the only ordering is the skill's reading order, chosen so the cheapest refusal fires first. This answers the ticket's open question about the chain directly. |

## Table 2 — the 24 skills

A skill "carries state" when its own text asks the agent to hold a position across steps — a loop
counter, a lane position, a lifecycle stage — as opposed to reading each answer off a verb.

| Skill | State it carries | Where it comes from | Tea-foldable | Why |
| --- | --- | --- | --- | --- |
| `adr` | carries no run state | — | no (not an ordering) | Writes one file, then sweeps. Nothing survives a step. |
| `build` | lane position (claimed → built → checked → pushed → PR open → repaired) + repair round | the verbs' answers, the branch name, `build verdicts`' round count | partial | This is precisely the `coder` template's machine, which `operate` already drives. Already covered — see below. |
| `build-epic` | slice position + two circuit-breaker axes | `epic/ledger.ts` fold | **yes** | Same answer as the `epic` group. On #5680's phase-4 freeze list. |
| `build-ui` | lane position + round cap 3 | `build` verbs + `ui` verbs | partial | Same shape as `build`, one modality over. |
| `check-epic-plan` | floor verdict, then the flip | `plan check` / `plan flip` | no (board) | Children's labels are the record. |
| `front-door` | repo bootstrap state | `status config` four-state probes | no (not an ordering) | File-presence probes. |
| `glossary` | register drift | `glossary drift` | no (not an ordering) | A diff between tree states. |
| `governance` | one namespace verdict at a head | posted markers | no (board) | The verdict is a comment other gates read. |
| `graduate` | trail cleared, then emitted-once | `graduate trail` + the emitted marker | no (board) | Both facts live on the source issue. |
| `grilling` | round number + per-question state | `grill/session.ts` | partial | Folds over posted markers; the founder rules from the board. |
| `handoff` | pack sealed / claimed | `handoff/packs.ts` | no (board) | The pack's whole purpose is to cross sessions. |
| `heal-ci` | stall class + at-most-once rerun | `heal-ci/stall.ts`, `heal-ci/marker.ts` | partial | The rerun marker is a one-event log; the classification is a snapshot. |
| `operate` | the lane's folded state, held nowhere | `lane status` on every read | **yes — already is** | Its own text: "the ledger is the only state … a remembered state is a stale one." |
| `plan-epic` | plan authored, then spliced | the epic body | no (board) | The body is the artifact. |
| `prototyping` | spike lifecycle + run count | `spike status` | partial | The lifecycle is a small machine inferred from workspace presence today. |
| `report` | dedup outcome | `report dedup` | no (board) | A search over open issues. |
| `review` | verdict currency + the round-2 criterion freeze | `review verdicts` / `build verdicts` | partial | The round counter again, read rather than held. |
| `review-ui` | verdict currency + preview resolution | `review-ui` verbs | partial | Same as `review`, plus a recency pick. |
| `ship` | guard-chain position + queue membership | `ship` verbs | partial | Queue membership folds; the chain does not. |
| `taste-color` | carries no run state | — | no (not an ordering) | A judgement rubric over bytes. |
| `triage` | claim + facet writes | `triage claim`, `triage apply` | partial | Claim as above; facets are label writes — no (board). |
| `wayfinding` | frontier states across sessions | `map/frontier.ts` | partial | Folds markers; native edges and issue state are GitHub's. |
| `write-pattern` | doc drift | `pattern drift` | no (not an ordering) | A function of file bytes. |
| `writing-for-agents` | carries no run state | — | no (not an ordering) | A pure rubric; no verb, no artifact. |

### Carries no state — the explicit list

Named here so no row is silently omitted. Three skills — `adr`, `taste-color`,
`writing-for-agents` — carry no run state at all. Two verb groups do the same: `wire` (pure codecs
plus a registry array) and `hook` (a pure `(requested, pin)` decision plus a harness envelope).

## The retry counter exists three times

The single most concrete finding, and the one candidate whose duplication is measurable:

| Where | How it counts | Cap |
| --- | --- | --- |
| `build/rounds.ts` `countRounds` | clusters FAIL comment timestamps on a 120 s gap | `ROUND_CAP = 3` |
| `epic/ledger.ts` `countersFor` / `trippedAxis` | counts `verdict-recorded` FAIL lines and `dispatch-dead` lines, on two independent axes | `FAIL_AXIS_CAP = 2`, `DEAD_AXIS_CAP = 2` |
| `lane/templates/coder.workflow.json` | tea machine context, incremented by the `retriesRemaining` guard on `ISSUE.FAIL` | `maxRetries: 2` |

Three implementations, three homes, three caps, one concept. The lane machine's version is the only
one where the cap is enforced by the transition rather than by a caller remembering to check. That is
the payoff a migration would buy, stated concretely.

## What epic #5680's remaining phases already cover

Read off #5680's body and its landed plan block, so the next re-plan does not duplicate them.

**Already owned — do not re-plan:**

- **The claim protocol** (`build/claim.ts`, `triage/claim.ts`) — named in phase 4's freeze list.
- **The verdict/marker stack** (`review/head.ts`, `content-binding.ts`, `write-recency.ts`,
  `ship/gate-verb.ts`) — named in phase 4's freeze list. Note that phase 2 **explicitly cut**
  migrating verdicts into ledger events: the plan's Non-goals say so and the Summary repeats it.
  Frozen and migrated are different acts, and only the freeze is scheduled.
- **`build-epic` and the `epic` conduction subsystem** — named in phase 4's freeze list. This is the
  survey's strongest `yes`, and it is slated for freeze rather than migration. Migrating a subsystem
  that is about to be frozen would be work against the epic's own sequence.
- **The driver loop itself** (`build`'s lane position) — phase 2, landed as `operate` +
  `lane open` / `lane emit` ([#5688](https://github.com/kamp-us/phoenix/issues/5688),
  [#5689](https://github.com/kamp-us/phoenix/issues/5689)).
- **`drive-issue-flow`, `approval-watcher`/`cp-bank`, `resume-policy`** — also on phase 4's freeze
  list; none of them is a fabrika-cli verb group, so none has a row above.

**Not owned by any phase of #5680:** the `spike` lifecycle and its `evidence.jsonl`; the `spend`
ledger; `grill`/`map`/`wayfinding` frontier state; `heal-ci`'s rerun marker; and the retry-counter
unification above, which spans a frozen subsystem and a live one.

## Recommendation on sequencing

Not a ruling. The founder rules the direction after reading this.

1. **Migrate nothing until phase 4's freeze list lands.** Five of the survey's strongest candidates —
   the claim protocol, the verdict/marker stack, `build-epic`, `drive-issue-flow`, `resume-policy` —
   are already scheduled to be frozen. Migrating a subsystem onto tea and then freezing it is the
   same work twice.
2. **The board-truth rows are a closed no, and saying so now saves the argument later.** Claim races,
   label facets, queue position, verdict posting, and every artifact one session writes for another
   to read. These are cross-session arbitration, and a per-tree `events.jsonl` cannot arbitrate
   between two checkouts. The `partial` verdicts on those rows mean "the derivation has a fold's
   shape", never "the log should move local".
3. **The first genuinely new work, if any, is the retry counter.** One concept, three
   implementations, three caps. When the driver owns the loop, the lane machine's counter is the only
   one that has to survive.
4. **Leave the two other local logs alone.** `spend/ledger.ts` (`.fabrika/spend-ledger.jsonl`) and
   `spike`'s `evidence.jsonl` (`<tmpRoot>/fabrika-spike/<nonce>/`, per `spike/workspace.ts`) are both
   append-only local JSONL, but neither derivation is a state machine — one is a sum, the other a
   tail read. Folding them through tea would buy vocabulary and nothing else. They do not share a
   root: with `epic/ledger.ts` at `<epic-tree-root>/.fabrika-epic/<epic>-<nonce>/ledger.jsonl`, the
   package writes local logs under three different roots.
5. **`ship`'s guard chain is a set of predicates, not a machine.** That was an open question in the
   ticket; the source answers it. Nothing carries between the guards, so there is no state for a fold
   to hold.

## Corrections to the ticket's premises

Three claims in #5694's body do not survive a read of the source. All three are recorded here rather
than silently worked around.

- **"74 registry entries in `packages/fabrika-cli/src/registry.ts`."** `registry.ts` is 74 *lines*
  long and registers **25** verb groups. The count that is near 74 is per-group leaf verbs summed
  alphabetically through `heal-ci`; the full package carries **156** leaf verbs. The survey's scope
  is the 25 groups, drilled into per-verb where a group's answer splits.
- **"`review/` derives verdict currency and supersession from `head.ts`, `content-binding.ts`,
  `write-recency.ts` and `rollup.ts`."** The first three are right. `review/rollup.ts` is the
  **check-run** rollup — `rollupOf` over CI conclusions, with `cancelled` bucketed red — and has
  nothing to do with verdict currency.
- **"`ship/` walks a guard chain … whether that chain is a machine or a set of independent predicates
  is exactly the question."** Answered: a set of independent predicates. No guard passes state to the
  next; each re-reads the PR because each is a fresh total over the PR's current state.

The other verified claims hold: `lane/fold.ts` folds per invocation with no snapshot, `build/claim.ts`
re-races markers plus a live permission read on every mutating verb, and there are 24 skills.

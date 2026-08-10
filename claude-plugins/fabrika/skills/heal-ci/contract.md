# `/heal-ci` — derived CLI contract

**Skill:** [`heal-ci`](SKILL.md) · **Authoring brief:** [#4717](https://github.com/kamp-us/phoenix/issues/4717) · **Date:** 2026-08-10

These verbs live in `packages/fabrika-cli/`, binary `fabrika`, grouped under a `heal-ci`
subcommand. (The skill directory and the CLI group are both `heal-ci`, so every invocation reads
as a sentence — `fabrika heal-ci diagnose 4321`. One skill, one group; the mapping is stated here
once. `review-ui` is the shipped precedent for a hyphenated group name.) At the time of writing
the sibling groups are `adr`, `build`, `epic`, `eval`, `grill`, `hook`, `ledger`, `map`, `plan`,
`report`, `review`, `review-ui`, `ship`, `spend`, `status`, `triage`, `ui` and `wire` — though
that list grows most weeks, so read
[`src/registry.ts`](../../../../packages/fabrika-cli/src/registry.ts) rather than this sentence.
The [CLI interface convention](../../docs/cli-interface-convention.md) governs these verbs; where
this spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill**
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Every verb
below is implemented from scratch. v1's `heal-ci` (392 lines, 10 scripts) and the nine
`pipeline-cli` tools the brief's field 4 names were read for their semantics and their scars —
each Grounding section names what the v1 counterpart gets wrong and what this spec does instead —
but no clause defers to one, and none is invoked.

**Substrate.** Effect CLI verbs on the `@effect/platform-node` seam the sibling groups use.
GitHub access is `gh api` REST throughout, per
[skill conventions §11](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql) —
**this group takes no GraphQL carve and no porcelain carve.** Both of `ship`'s carves exist for
surfaces this group never touches (review-thread resolution; auto-merge arming), and every read
below has a REST form. Named because a spec that leaves the substrate open makes the implementer
guess (#4734).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `heal-ci diagnose` | one PR's stall class from the ordered, total predicate chain, with the evidence that proves it | the chain is a transcription of a fixed precedence table over read facts; what to do about a class is judgment |
| `heal-ci sweep` | every open PR classified with its strand age — the scheduled surface | enumeration, per-PR classification and dwell arithmetic are mechanical; which strand to work first is judgment |
| `heal-ci surface` | declared required contexts against the runs that actually post at the head | comparing two enumerated sets is mechanical; changing repository settings is a human's act |
| `heal-ci logs` | the failed-job log text for **every** failing gating context at a head | run resolution, job selection and byte-bounding are mechanical; reading the failure is judgment |
| `heal-ci classify` | **pure**: log text on stdin → one signature from a closed taxonomy, default-deny | a fixed pattern table over text, no network and no state; there is no judgment in a table lookup |
| `heal-ci rerun` | the at-most-once transient rerun, precondition re-derived inside the verb, read-back verified | the guard, the write and the proof are mechanical; whether a transient is worth rerunning at all is judgment |
| `heal-ci note` | the durable stop-path comment | posting with the sibling groups' write protocol is mechanical; what the note says is the skill's |

### Considered and deliberately not derived

Each is a real proposal someone could make again. (Conventions §7 homes these in a plugin-root
`.out-of-scope/`, which no fabrika skill has bootstrapped yet; until it exists they live inline,
the same tracked debt the sibling contracts carry.)

- **A second answer to any CI-enforced question.** `ci-required` is the always-on required status
  context ([`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml), job `ci-required`,
  which the merge queue awaits on the `merge_group` ref). `leak-guard.yml` and `gitleaks.yml` gate
  landed content. A fabrika copy of any of these could only agree redundantly or contradict an
  enforced verdict (ADR 0238). Every verb here reads those gates' **results**; none recomputes
  their judgment.
- **A gate verdict of any kind.** This skill is explicitly outside the SHA-bound verdict contract
  (ADR 0058), so no verb emits a verdict marker, and this spec requests **no widening** of
  `NAMESPACE` / `NAMESPACE_PREFIXES` in
  [`wire/verdict-marker.ts`](../../../../packages/fabrika-cli/src/wire/verdict-marker.ts) or of
  `SHIP_NAMESPACES` in
  [`review/classes.ts`](../../../../packages/fabrika-cli/src/review/classes.ts). `heal-ci` is not a
  member of those closed sets today and does not need to be. A later session reaching for the
  widening should read this bullet first.
- **A merge-blocking check, a required context, or anything that can red a PR.** The explicit
  no-go on both #5307 and #5328. Every artifact this group produces is a comment, a filed issue,
  or a rerun request.
- **A wedge-clearing verb** (cancel the stranded check, re-run it). The lever mutates CI runs this
  lane does not own, and a bounded run cannot supervise the retry it triggers — both halves of the
  #3999 ruling. `diagnose` reports `wedged` and names the contexts; the lever is an operator's.
- **A check-surface *repair* verb** (arm, rename or disarm a required context). That is a
  repository-settings mutation with a human's name on it, and #3377 is what arming a required
  check wrong costs: the entire merge queue wedged. `surface` diagnoses and stops.
- **A dispatch or adoption verb.** A detector converts a strand into claimable work; an engine
  never free-scan-adopts (ADR 0205, founder ruling #3532). No verb here assigns, claims, or
  spawns a lane, and `sweep` writes nothing at all.
- **A tracking-issue minter for an unlinked PR.** A conversation-authored doc or ADR PR may
  legitimately carry no linked issue (ADR 0075), and minting one to satisfy a link guard is
  banned outright (#4820 triage). `diagnose` reads linkage as a fact, never as a requirement.
- **A new issue-reference token.** `linkage-refused` names the state; it proposes no grammar.
  Triage ruled the fix is widening what `Part of #N` is stated to cover, and that `Re: #N`,
  `Refs`, `See` and a bare `#N` stay banned everywhere (#5353).
- **A recurrence / flaky-signature ledger.** "This signature has failed six times this week" is a
  scheduled, cross-run concern with its own storage question; this group answers about one head.
  `sweep` is a stateless re-scan, not a history.
- **A local reproduction, install, build or test run.** §RO in the skill. #4185, #4136 and #4131
  are three incidents where the healing action was itself the damage.
- **An agent-honoured hold.** A hold is label-triggered and platform-enforced, cause-agnostic
  (#5352 founder ruling); a shipper- or healer-read label is the losing side of that fork.

### Filing is the `report` group's, reused rather than respecified

The skill's `FILED — #N` terminal and its `unclassified` route both end at the intake seam, and
this group specifies **no filing verb**. The write is `fabrika report file`'s, in the landed
sibling group, whose contract owns its flags, its six-section body shape, its leak refusals and
its exit codes — the cross-contract reuse `build-ui` established for `build`'s lane mechanics.
Two consequences the implementer needs: the issue number the `FILED — #N` terminal carries is the
one `report file` prints on stdout, read from there and never composed by hand; and `report`'s
exit codes stay `report`'s, so a filing refusal is reported in that group's vocabulary rather than
translated into this one's. This group allocates no seat for a filing outcome, which is why `4`
remains a deliberate gap here.

### Nothing here recomputes an enforced answer

Every question this group answers is ungated today: stall classification, strand age,
required-context-versus-producing-run coverage, failure-signature classification, rerun
eligibility. The enforced ones are named above with the workflow that owns each, and this spec
computes no second verdict on any of them.

### The name and routing situation

v1's `heal-ci` remains the live project-level skill at `claude-plugins/kampus-pipeline/skills/`
until the cutover, which is separate, later work. `DEVELOPMENT.md` routes `heal-ci` by a filesystem
path pinned to `.claude/skills/heal-ci/SKILL.md` — the v1 copy — so **nothing on `main` routes to
this skill**, and it is reached as `/fabrika:heal-ci`. `ship`'s SKILL.md routes red CI to `heal-ci`
by unqualified name, which resolves ambiguously while both exist. That gap is
[#4761](https://github.com/kamp-us/phoenix/issues/4761), already open and not re-filed here; it is
recorded in the authoring PR rather than patched from this spec.

This spec closes the counterpart gap `ship`'s contract records: *"the skill routes red CI to
`heal-ci`, and no fabrika counterpart exists yet"*. Once these verbs are implemented, `ship checks`
→ `red` has a fabrika lane to route to. That is one entry door of several — the sweep and a bare
`heal #N` are the others, and the green-strand classes are reachable through neither `ship` nor CI.

## Shared conventions

Stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else; scope lines, refusal
  reasons, progress and notices go to stderr. **Every "nothing found" case prints a state word** —
  empty stdout is byte-identical to a verb that never ran. v1 broke this in seven of ten scripts,
  printing English diagnostics onto the same stream as the machine answer, and in one case
  interleaving prose *into the log body* a caller was pattern-matching for signatures.
  **One outcome convention for the whole group:** exit `0` means "I produced the answer", whatever
  the answer is — `red`, `wedged`, `no-requirements` and `unclassified` are answers; non-zero
  means "I could not produce one", plus the enumerated proven refusals of the write verbs.
  v1's green head exited `3`, making its most successful outcome a failure to every caller using
  the toolkit's own `|| exit 1` idiom.
- **Common inputs.** `--repo <owner/name>` (default: `$CLAUDE_PIPELINE_REPO`, else
  `$GITHUB_REPOSITORY`, else the `origin` remote; none resolvable → exit `1` — the resolution chain
  the shipped `report`/`triage`/`review`/`ship` groups use, inherited for one config surface rather
  than a second vocabulary). `--json` swaps the line grammar for one object with the named keys.
  **Every GitHub call carries the resolved repo explicitly.** v1's three `gh run` calls omitted it,
  so a run id from one repository silently resolved in another — a misclassification, not an error.
- **Every `<sha>` a verb PRINTS is the resolved 40-hex head**, never the abbreviation the caller
  passed — a caller that cannot tell an echoed flag from a resolved head cannot bind anything to
  the answer. Examples below abbreviate for readability and say so at their first use.
- **`--sha` binds the answer to what the caller verified.** Verbs taking `--sha` accept 7–40
  lowercase hex and **prefix-match it against the live head using the shipped `prefixMatch`
  helper** ([`ship/target.ts`](../../../../packages/fabrika-cli/src/ship/target.ts)) — import it.
  Read verbs report a mismatch as a stderr notice and still answer at the given SHA; the write verb
  refuses `12`. An empty or malformed `--sha` is a usage error, never a matches-everything pattern.
  v1 compared heads with the shell glob `case "$CURRENT_HEAD" in "$RSHA"*)`, which binds a
  truncated review commit to a head it does not equal, and which collapses to `*` on an empty
  capture.
- **Every list read paginates, reports its scanned count on stderr, and carries a completeness
  proof.** Where the platform declares a total (check runs, workflow runs, issue comments, jobs),
  received-short-of-declared is the `13` refusal. Where it declares none (the PR timeline, the
  open-PR list), the proof is a **terminal page carrying no `rel="next"` link**, and a read that
  ends without one is the same `13` refusal; those reads walk pages explicitly and read the `Link`
  header rather than using `--paginate`, which concatenates bodies and drops the headers the proof
  lives in. Any aggregate is computed **after** the pages are joined.
  This is the single highest-value scar in the v1 corpus: its rerun-marker count read only the
  first page at the default `per_page=30`, so on a PR with more than thirty comments the marker was
  invisible, `rerun-markers=0` read as "not yet rerun", and the one-rerun rule silently became an
  **unbounded rerun loop on exactly the most-repaired PRs**. Its round counter had the same hole at
  100, in the opposite direction: an under-count kept `ROUNDS < 3` forever and suppressed the
  defect filing permanently.
- **A failed read is never detected by testing emptiness.** `gh` writes its error document to
  **stdout** when a request fails, so a captured variable is non-empty and an `[ -n "$X" ]` guard
  can never fire on the failure it names. Every capture checks the process exit status before the
  bytes are interpreted; a failed read is `11`. v1 shipped that dead guard in four places, each
  under a comment asserting the opposite, and its own shared library documents the mechanism.
- **A non-zero exit is UNKNOWN**, and carries no answer: `refuse()` in
  [`verb.ts`](../../../../packages/fabrika-cli/src/verb.ts) hardcodes empty stdout, which is why
  every classification in this group is an exit-`0` answer token rather than an exit code. No verb
  substitutes a fabricated value for an unreadable one.
- **Proven-absent and could-not-read never share a code.** `7` is a fact about the repository (a
  404); `11` is the absence of a fact. This group leans on it hard because v1's worst behaviours
  are its collapse: a failed collaborator-permission probe read as "not authorized" (silently
  under-counting repair rounds), a decode failure read as "this PR has no lane" — a reading that
  then **authorized filing an issue** — and a failed staged-deletion probe read as "zero deletions".
- **Reads read; writes write.** No read verb posts a comment or mutates anything. Every write verb
  re-reads its target and verifies. v1 trusted its rerun dispatch (a 2xx taken as proof a new
  attempt exists, then a durable marker written that blocks every future rerun) and discarded both
  comment-creation responses to `/dev/null`.
- **`--json` shapes are normative as key lists.** The line-grammar examples are the byte-level
  contract; each verb's `--json` object mirrors the lines one-for-one. One canonical worked example
  lives on `heal-ci diagnose`; the rest are key lists, deliberately.

### Usage errors: one formatter, one shape, exit `1`

Every verb refuses a malformed invocation through **one shared formatter**, so the spec does not
carry a near-identical row per flag per verb. Its output is exactly:

```
fabrika heal-ci <verb>: <what> — <why>.
usage: fabrika heal-ci <verb> <the verb's Invocation line, verbatim>
```

Both lines go to **stderr**, stdout stays empty, and the exit is `1` (rule 3's usage seat). The
reachable cases and their `<what> — <why>` text, which is the part an implementer must not invent:

| Case | `<what> — <why>` |
|---|---|
| a positional that is not a positive integer | `"<v>" is not a pull-request number — expected a positive integer` |
| `--sha` empty, or not 7–40 lowercase hex | `--sha "<v>" is not 7-40 lowercase hex — an empty or malformed sha is never a wildcard` |
| `--repo` given but not `owner/name` | `--repo "<v>" is not in owner/name form` |
| `--repo` absent and unresolvable from the environment | `no repository resolved — pass --repo, or set CLAUDE_PIPELINE_REPO or GITHUB_REPOSITORY, or run inside a checkout with an origin remote` |
| any integer flag non-numeric or negative | `--<flag> "<v>" is not a non-negative integer` |
| an operand the verb never declared | `unexpected operand "<v>"` |

The `--sha` row is the one with a scar behind it: v1 matched heads with a shell glob that collapsed
to "matches everything" on an empty capture, so an unset variable silently bound every head. Here an
empty `--sha` cannot reach the matching logic at all.

### The shared exit taxonomy

All seven verbs allocate from one internal table, so a code means one thing across this group.
The `3`–`11` seats are **imported from
[`report/codes.ts`](../../../../packages/fabrika-cli/src/report/codes.ts)** and `12`/`13` from
[`review/codes.ts`](../../../../packages/fabrika-cli/src/review/codes.ts) — the import-not-restate
idiom `ship/codes.ts` already ships — never re-typed as numerals and never read off a sibling
`contract.md`, because the checked-in `/report` contract is behind its own binary on `7` and `11`
(#4752).

| Code | Meaning | Verbs that can return it |
|---|---|---|
| `0` | the answer is on stdout — including `red`, `wedged`, `unclassified`, `no-requirements`: answers, not errors | all |
| `1` | usage error, unresolvable repo, or the verb failed to run | all |
| `2` | no implementation could be resolved | all |
| `3` | stdin was read and held nothing | `classify`, `note` |
| `4` | *(deliberate gap — `report file`'s body-section seat; no verb here composes sections)* | — |
| `5` | the **authored** text carries a machine-local path | `note` |
| `6` | the **authored** text is a bare `@` path reference — not redactable | `note` |
| `7` | zero scope: the target is **proven absent (404)**, or a required input is proven empty where emptiness is not a fact — a fail-closed refusal | `diagnose`, `surface`, `logs`, `rerun`, `note` |
| `8` | the write, or the read that confirms it, failed — the outcome is **UNKNOWN** | `rerun`, `note` |
| `9` | the write landed but the read-back does not match | `rerun`, `note` |
| `10` | a supplied value is off a closed vocabulary — an unknown `--signature` | `rerun` |
| `11` | a **precondition read failed** — nothing was proven and (for a write) nothing was written | all except `classify`, which reads no precondition |
| `12` | refused: the live head moved past the inspected `--sha` — a mutation formed over a tree that is no longer the PR | `rerun` |
| `13` | refused: a read completed but its scope is **provably incomplete** — received short of a declared count, or (where the platform declares none) pagination never reached a terminal page | `diagnose`, `sweep`, `surface`, `logs`, `rerun` |
| `14` | refused: **proven not in the state this write acts on** — nothing was mutated | `rerun` |
| `15` | refused: the run's logs are **proven unavailable** (expired or purged by the platform) — a fact about the run, not a failed read | `logs` |
| `16` | the rerun **provably landed** and its durable marker could not be written — the record, not the rerun, is missing | `rerun` |
| `127` | the verb never ran (unresolved binary) | all |

**This matrix owns what a code *means*; the per-verb tables own what *triggers* it.** Every verb
can return `0`, `1`, `2` and `127` with the meanings above, stated here and nowhere else; the
per-verb "Exit status" tables enumerate only that verb's own proven outcomes, `3` and up, phrased
as that verb's trigger.

**`16` is the loudest code in the group, and it exists because the rerun is the one two-legged
mutation here.** A new attempt is confirmed and the marker that would stop the *next* session
spending a second rerun did not land — so the invariant is live but unrecorded, and the next reader
sees a head that looks un-rerun. Folding that into `8` would hide the one fact an operator must act
on immediately, which is the same reasoning `ship nudge` seats its own `17` on.

**`14` and `15` are this group's own proven refusals.** `14` is the write-side state guard: a
rerun aimed at a head that was already rerun, at a run that is not failed, or at a closed PR — the
verb proved the state and declined, which is neither `7` (the target exists) nor `11` (nothing
failed). It is v1's most important scar made structural, and §S19 below is why it must live in the
verb. `15` exists because "GitHub has expired these logs" is a *verdict* about a run — permanent,
actionable, and a different remedy from a transport failure — and folding it into `11` would tell
the caller to retry a read that can never succeed.

**Cross-group note.** `14` and `15` mean something different here than `ship`'s `16`/`17` or
`review`'s `14`/`15`. That is the doctrine, not a collision: the `3`+ band is scoped to the group
that seats it, the alignment check runs each group against the **base** (`report`) and never
pairwise against a sibling, and every invocation names its group. `wire` is the shipped
counter-example that makes this explicit.

**Registering the group's table is part of implementing it.** The seats above live in
`packages/fabrika-cli/src/heal-ci/codes.ts`, and that module must additionally be registered in
[`exit-code-alignment.ts`](../../../../packages/fabrika-cli/src/exit-code-alignment.ts) as an
**aligned** group, with its `SharedSeats` map declaring `4` as a deliberate gap and naming the
seats it takes on the base's numbers. `coverageGaps()` reds on any group `registry.ts` registers
that it cannot classify as base / aligned / unaligned / untabled, so a group that ships a table
without this row fails the alignment guard the moment it is registered — and the guard's row must
land in the same change as the registry row, never after it.

### Read-backs compare normalized text, not bytes

Every write verb re-reads its target and compares through **`normalizeForReadback` from
[`report/compose.ts`](../../../../packages/fabrika-cli/src/report/compose.ts)** — import it; its
third step (strip trailing newlines) is the one a re-derivation drops, and dropping it fires exit
`9` on clean runs.

### Machine-local path detection

`heal-ci note` shares the leak predicate **already implemented** at
[`report/leaks.ts`](../../../../packages/fabrika-cli/src/report/leaks.ts) — import it, never
re-derive it. This is the authored-text guard only; scanning *landed* content is `leak-guard.yml`'s
enforced seam.

### The rerun marker is a specified format, because two steps must agree on it

The at-most-once guard reads a marker that the same verb writes, so an unstated format lets an
implementer ship a writer its own reader cannot match. `heal-ci rerun`'s marker is a comment whose
**first line is exactly**:

```
heal-ci-rerun: <40-hex head sha> <run-id> <signature-id>
```

The detection read in guard step 3 matches **that first line only**, anchored, with the head
compared as a full 40-hex equality — never a prefix, and never a substring search of the body.
This is deliberately **not** the `heal-ci: <terminal> — PR #<n> @ <sha> …` shape `heal-ci note`
writes: a `note` recording a `RERUN-QUEUED` terminal names the same head at the same moment, so a
looser matcher would read the skill's own narration as the machine marker and refuse every first
rerun. Two formats, two readers, no overlap.

### Modules imported rather than re-derived

This group computes a new answer over facts the package already reads. Every module below is
imported; a second copy is the drift this section exists to prevent.

| Module | Used for |
|---|---|
| `review/rollup.ts` — `rollupOf`, `statusOf`, `isInformational`, `isStalled` | the check-run rollup, the ADR 0061 informational carve-out, and half the wedge test |
| `review/classes.ts` — `SHIP_NAMESPACES`, `touchesGovernanceRoot` | which namespaces a diff requires a verdict in |
| `wire/verdict-marker.ts` — `read`, `bindToHead` | reading whether a verdict exists at the head. **Read only — this group emits none.** |
| `ship/gate-verb.ts` — `inForce` | head-bound-first, write-stamp-ordered verdict resolution |
| `ship/queue.ts` — `queueStateOf`, `landedOnBase` | merge-queue entry state off the timeline, with the paired-removal rule |
| `ship/github.ts` — `listShipCheckRuns`, `listRunsAtHead`, `listWorkflows`, `pullTimeline`, `behindBase`, `readMergeability` | the head-bound REST reads |
| `ship/target.ts` — `prefixMatch`, `badNumber`, `scannedLine` | argument guards and SHA matching |
| `io/pulls.ts` — `getPullRequest`, `listPullFiles`, `permissionFor` | PR metadata and the ADR 0055 ACL leg |
| `review/head.ts` — `bindHead` | tying a read to one commit before the read |

**Two reads are genuinely new IO and exist nowhere in the package**: fetching a workflow job's log
text, and requesting a rerun. Both are specified from scratch below.

---

## `heal-ci diagnose`

**Invocation**

```
fabrika heal-ci diagnose 4321 [--sha 03135b91] [--dwell-minutes 45] [--wedge-dwell-minutes 20] [--drift-commits 10] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number to diagnose |
| `--sha` | string | no | the live head | the head to bind the answer to; 7–40 lowercase hex |
| `--dwell-minutes` | integer | no | `45` | how long a claimed PR may go without activity before it reads `claim-stale` |
| `--wedge-dwell-minutes` | integer | no | `20` | how long a queued-never-started check dwells before it reads `wedged` |
| `--drift-commits` | integer | no | `10` | how far a claimed head may sit behind its base before the claim reads stale on ground drift |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line:
`stall\t<token>\t<head-sha>\t<age-minutes>` where `<token>` is exactly one of `attended`,
`ungated`, `gated-unshipped`, `claim-stale`, `red`, `check-surface`, `linkage-refused`,
`blocked-human`, `wedged`, `not-open`, and `<age-minutes>` is the strand age (see below). Then one
line per evidence fact, in this fixed order, each present always:

```
owner	<login|->	<claimed-at|->	<last-activity|->
gates	<satisfied|blocked|none-required>	<pass-count>/<required-count>
ci	<green|red|pending|wedged|no-runs|none>	<failing-or-stranded-context-count>

queue	<queued|armed|none>
link	<fixes:<n>|part-of:<n>|other|none>
facts	scanned-comments:<n>	scanned-checks:<n>	behind-base:<k>
```

With `--json`:
`{"outcome":"stall","token":…,"head":<40-hex>,"ageMinutes":<n>,"owner":{"login":…,"claimedAt":…,"lastActivityAt":…},"gates":{"state":…,"pass":<n>,"required":<n>},"ci":{"rollup":…,"contexts":<n>},"queue":…,"link":{"kind":…,"number":<n|null>},"scanned":{"comments":<n>,"checks":<n>},"behindBase":<k>}`.

**The `ci` line's two zero-signal tokens are distinct facts, not synonyms.** `none` means the
repository has **zero active workflows** — there is no CI here at all, the foreign-repo case the
Required-repo-files table degrades on. `no-runs` means workflows exist and **none fired at this
head** — the dropped-trigger state, which is a defect in the trigger and not an absence of CI.
Collapsing them would tell an adopter with no CI to go chase a dropped trigger.

**The strand age** is minutes between **the later of the head commit's push time and the PR's last
activity** and the local clock at read time, floored at `0`. Both operands go to stderr. It is the
number the sweep orders on, so it is derived here once rather than in two places.

**The classification is an ordered, total predicate chain. First match wins**, and the order is
the contract — two implementers walking it in a different order produce different answers on the
same PR, which is exactly the drift a prose taxonomy invites.

The chain has two phases, and the split is what makes totality provable. **Arms 1–6 are
attention-independent**: they name states that block the PR no matter who is watching, so they are
tested before anyone asks whether somebody is on it. **Arms 7–10 are the attendance phase**: the
PR is open and otherwise able to proceed, so the only remaining question is whether anybody is
moving it.

| # | Token | Fires when |
|---|---|---|
| 1 | `not-open` | the PR's state is `draft`, `closed` or `merged`. An answer, not a refusal |
| 2 | `wedged` | ≥1 **gating** check run is `queued` with a null `started_at` past `--wedge-dwell-minutes` (`isStalled`, plus the dwell) |
| 3 | `check-surface` | ≥1 declared required status context has **no producing run** at this head, or ≥1 gating run answers no declared requirement — `surface`'s exact predicate, shared as one module so the two verbs cannot disagree |
| 4 | `red` | the gating rollup at the head is `red` (`rollupOf` over `listShipCheckRuns`, informational contexts excluded first — ADR 0061) |
| 5 | `linkage-refused` | the diff derives ≥1 namespace whose merge seam requires a linked issue, the body carries neither `Fixes #N` nor `Part of #N`, **and** it carries some other reference form |
| 6 | `blocked-human` | a control-plane approval is outstanding at this head, or ≥1 unresolved review thread has a non-`Bot` participant |
| 7 | `attended` | **any positive signal of motion**: an owner whose last activity is inside `--dwell-minutes`, a live merge-queue entry, an armed merge intent, or a gating rollup of `pending` — CI running at this head *is* the PR moving |
| 8 | `claim-stale` | an owner signal exists and arm 7 did not fire — the claim is there and nothing shows it live. The stderr notice names which of the three proved it: activity older than `--dwell-minutes`, a head more than `--drift-commits` behind the base (`behindBase`), or an activity timestamp that could not be read at all |
| 9 | `gated-unshipped` | no owner signal, and every required namespace holds an in-force `pass` verdict at this head (`inForce`) |
| 10 | `ungated` | no owner signal, and ≥1 required namespace holds no in-force verdict at this head |

**Arm 3 fires above arm 4 deliberately.** A required context that no run produces cannot be healed
by anything a red-log classifier does, so a PR carrying both a config gap and a failing test is
reported `check-surface` first: the gap is the cause the other repair cannot reach. Where the
protection surface is `unprobeable` (see `surface`), arm 3 is **skipped** with a stderr notice
naming the skip, and the chain continues at arm 4 — a permission the token lacks must never read
as a surface that is clean.

**Arm 7 sits above arms 8–10, not below them.** An actively-worked PR is not stranded, and ranking
any strand class above `attended` would report a PR whose author pushed two minutes ago as
abandoned. `pending` belongs in arm 7 for the same reason: a run in flight is motion, not a stall.

**Totality, proved over all ten arms.** Reaching arm 7 means the PR is open, not wedged,
surface-complete-or-skipped, not red, linkage-clean and human-unblocked, so its rollup is one of
`green`, `pending`, `no-runs` or `none`. Arm 7 takes every case carrying any positive signal —
`pending` included. What remains has no positive signal, and arms 8–10 partition it exhaustively on one Boolean:
**an owner signal either exists or it does not.** Where it exists, arm 8 takes it unconditionally —
arm 8 is the whole owner-exists complement of arm 7, not a subset of it, which matters because an
owner whose activity timestamp is *unreadable* is neither provably live nor provably old and must
still land somewhere. Reading unknown as stale is the fail-safe direction: a false strand costs one
look, a false `attended` is the incident. Where no owner signal exists, the required-namespace set
either holds an in-force verdict for every member (arm 9) or fails to for at least one (arm 10). A PR with **zero** required namespaces satisfies arm 9 vacuously and reads
`gated-unshipped` with `gates none-required` — correctly, since nothing gates it and nobody is
shipping it. No input reaches the end of the chain unclassified.

**Attendedness is never keyed on the linked issue's existence or state.** A stranded PR carried a
closing reference to a triaged, prioritised, milestoned and *assigned* issue and stranded exactly
like one with no board row at all. `link` is printed as a fact and consumed only by arm 5.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404), or `--sha` names no commit on this PR |
| `11` | the PR, its comments, its check runs, its verdicts, its timeline or its base could not be read — the stall class is UNKNOWN, never `attended` |
| `13` | the comment, check-run or timeline enumeration is provably short of its declared count, or the timeline read never reached a terminal page |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `heal-ci diagnose: PR #<n> not found in <repo>.` | 7 | refusal |
| `heal-ci diagnose: no commit <sha> on PR #<n> — refusing to classify a tree this PR never had.` | 7 | refusal |
| `heal-ci diagnose: cannot read <what> for #<n>: <reason> — the stall class is UNKNOWN, never "attended".` | 11 | refusal |
| `heal-ci diagnose: received <k> of <m> declared <comments\|check runs> — refusing to classify over a truncated read.` | 13 | refusal |
| `heal-ci diagnose: the timeline read never reached a terminal page — pagination is unexhausted, so a queue entry could sit on a page nobody read; refusing to classify.` | 13 | refusal |
| `heal-ci diagnose: the live head is <live>, you are diagnosing <sha> — the head moved.` | 0 | notice |
| `heal-ci diagnose: claim-stale fired on <inactivity\|ground-drift> — last activity <ts>, behind base <k>.` | 0 | notice |

**Scope** — one PR's metadata, changed files, comments, check runs, workflow runs, review
threads and timeline, each paginated and count-checked, plus its base branch's declared required
contexts. The predicate chain is total over what was read; a read that could not complete is `11`,
never a class.

**Examples**

(Examples abbreviate the head in prose fields for readability; a real run prints the resolved
40-hex head, as the `--json` example below shows.)

```
$ fabrika heal-ci diagnose 4321
stall	gated-unshipped	03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c	35
owner	-	-	-
gates	satisfied	2/2
ci	green	0
queue	none
link	fixes:4287
facts	scanned-comments:14	scanned-checks:12	behind-base:0
```

```
$ fabrika heal-ci diagnose 4322 --json
{"outcome":"stall","token":"ungated","head":"9fe12ab0c7714d9e2b3a6f05812cc4d7e6a09b18","ageMinutes":564,"owner":{"login":null,"claimedAt":null,"lastActivityAt":null},"gates":{"state":"blocked","pass":0,"required":1},"ci":{"rollup":"green","contexts":0},"queue":"none","link":{"kind":"fixes","number":5290},"scanned":{"comments":3,"checks":11},"behindBase":0}
```

```
$ fabrika heal-ci diagnose 4999
heal-ci diagnose: PR #4999 not found in kamp-us/phoenix.
$ echo $?
7
```

**Grounding**

- #5293 / #5328 — `gated-unshipped`. A PR passed its gate and sat 35 minutes un-enqueued because
  the conductor spawned a shipper for a different PR; nothing on the board could express it.
- #5333 / #5307 — `ungated`. Two PRs sat green and ungated for ~9 and ~10.5 hours on one day, both
  found by tracing a downstream hold backwards.
- #5326 — `claim-stale`'s second arm. The PR was claimed while its mergeability read `null` and
  reviewed 14 commits behind base; inactivity alone would not have caught it.
- #4820 triage / ADR 0075 — attendedness is not keyed on the linked issue, and a legitimately
  issueless PR is not a stall.
- ADR 0061 — informational contexts are excluded before the rollup, so a preview-deploy red never
  reads as a healable stall.
- ADR 0058 — this verb reads verdict markers and emits none.
- v1's `resolve-failing-run.sh:43` exited `3` on a green head, so the healthiest outcome was a
  failure to any `|| exit 1` caller; here `attended` is an exit-`0` answer token.
- v1's `orphan-heal` tested CI-red at gate 2 and lane state at gate 3, so a green laneless PR was
  skipped `ci-not-red` and never reached the ownership question at all.

---

## `heal-ci sweep`

**Invocation**

```
fabrika heal-ci sweep [--min-age-minutes 30] [--limit 200] [--include-attended] [--dwell-minutes 45] [--wedge-dwell-minutes 20] [--drift-commits 10] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--min-age-minutes` | integer | no | `30` | omit PRs whose strand age is below this; the grace window before a young PR counts as stranded |
| `--limit` | integer | no | `200` | the maximum number of open PRs to classify; a scan that would exceed it refuses `13` rather than answering over a subset |
| `--include-attended` | boolean | no | `false` | emit `attended` rows too, rather than only the stalled ones |
| `--dwell-minutes` | integer | no | `45` | passed through to each classification |
| `--wedge-dwell-minutes` | integer | no | `20` | passed through to each classification |
| `--drift-commits` | integer | no | `10` | passed through to each classification |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line: `swept\t<scanned>\t<stalled>` — both counts always, so
a zero-stall answer carries the scope it rests on rather than standing as a bare claim. Then one
line per emitted PR, **ordered by strand age descending**, ties broken by ascending PR number:

```
pr	<number>	<stall-token>	<age-minutes>	<head-sha>
```

With `--json`: `{"outcome":"swept","scanned":<n>,"stalled":<n>,"prs":[{"number":<n>,"token":…,"ageMinutes":<n>,"head":…}…]}`.

**This verb writes nothing.** It files no issue, assigns nobody, and spawns nothing — a detector
converts a strand into claimable work and normal pull adopts it (ADR 0205, founder ruling #3532).
v1's counterpart ran `--execute` on every scheduled invocation and POSTed issues against the live
board autonomously, keyed on a lane probe whose decode failure read as "laneless".

**Zero stalled rows at a proven non-zero `scanned` is an answer, not a refusal** — a quiet board
is the expected outcome most of the time, and refusing would red the schedule every calm night.
**Zero *scanned* is different and depends on proof:** a successful, terminal-page-proved open-PR
list holding zero entries is a fact (a repository with no open PRs), answered as `swept 0 0`; a
list read that failed or could not prove completeness is `11`/`13`. v1 printed the same sentence —
"no orphan red PRs to heal" — for both, with the scanned count only on stderr, beside nothing.

**A PR that closes between the list read and its classification** answers `not-open`. It is
dropped from the emitted rows and from the `stalled` count, but **stays in `scanned`** — the list
read genuinely covered it — and a stderr notice names it. Counting it as stalled would report a
merged PR as a strand; dropping it from `scanned` would quietly shrink the scope the answer rests on.

**The sweep's own cost is bounded, and it says so.** Each PR costs `diagnose`'s full read set, so a
200-PR board is a four-figure number of REST calls — against the very rate limit this group's own
taxonomy classifies as a transient. The verb reads the rate-limit headers as it goes and, on
exhaustion, **refuses `11` naming the reset time with nothing partial emitted**: a sweep that
silently covered 60 of 200 PRs and printed a stalled count would be the truncated-scope answer this
group refuses everywhere else. Concurrency is bounded at 4 in-flight classifications, stated here
so an implementer does not pick a number that reaches the limit faster than the board is read.

**Exit status**

| Code | Trigger |
|---|---|
| `11` | the open-PR list, or a per-PR classification read, failed, or the API rate limit was exhausted mid-sweep — the sweep is UNKNOWN, never a shorter list |
| `13` | the open-PR enumeration never reached a terminal page, or the open-PR count exceeds `--limit` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `heal-ci sweep: cannot list open PRs in <repo>: <reason> — the sweep is UNKNOWN, never "none stranded".` | 11 | refusal |
| `heal-ci sweep: rate limit exhausted after <k> of <m> PRs, resets at <ts> — refusing a partial board.` | 11 | refusal |
| `heal-ci sweep: cannot classify #<n>: <reason> — refusing a sweep with a hole in it.` | 11 | refusal |
| `heal-ci sweep: #<n> is gone (404) between the list read and its classification — counted as scanned, not stalled.` | 0 | notice |
| `heal-ci sweep: the open-PR read never reached a terminal page — pagination is unexhausted; refusing to report a partial board.` | 13 | refusal |
| `heal-ci sweep: <k> open PRs exceeds --limit <m> — refusing to answer over a subset; raise the limit.` | 13 | refusal |
| `heal-ci sweep: scanned <k> open PRs, <m> stranded past <n>m.` | 0 | notice |
| `heal-ci sweep: #<n> closed between the list read and its classification — counted as scanned, not stalled.` | 0 | notice |

**Scope** — every open pull request in the repository, paginated to a terminal page, each
classified by `diagnose`'s shared predicate chain. A single unclassifiable PR fails the whole
sweep on `11` rather than being silently dropped: a board report with an unnamed hole in it is the
false-completeness this verb exists to prevent.

**Examples**

```
$ fabrika heal-ci sweep
swept	23	3
pr	4315	claim-stale	631	4a91c07de3b8215f6c0a9e4d7b2318fa5c6e0d94
pr	4322	ungated	564	9fe12ab0c7714d9e2b3a6f05812cc4d7e6a09b18
pr	4321	gated-unshipped	35	03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c
```

```
$ fabrika heal-ci sweep
swept	18	0
```

**Grounding**

- The brief's 2026-08-09 design input — both live strands were found by luck rather than by a
  sweep, so the lane must be reachable on a schedule and must classify green PRs, not only red ones.
- ADR 0205 / founder ruling #3532 — a detector emits claimable work and never adopts or dispatches.
- ADR 0092 — the scanned count travels with the claim; a zero-stall answer over an unproven scope
  is the pass a guard must never emit.
- v1's `orphan-heal` — scheduled `--execute` writes, prose on stdout with the structured ledger on
  stderr, zero-scope reported identically to a real empty result, and idempotency resting on a
  body-text marker greppable across every open issue.

---

## `heal-ci surface`

**Invocation**

```
fabrika heal-ci surface 4321 [--sha 03135b91] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | no | the live head | the head to enumerate producing runs at |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line:
`surface\t<covered|gap|no-requirements|unprobeable>\t<sha>`. Then one line per declared required context:

```
required	<context-name>	<producing|absent>
```

then one line per gating run at the head answering no declared requirement:

```
extra	<context-name>
```

and last `facts\trequired:<n>\tproducing:<n>\textra:<n>`, where **`producing` counts the declared
required contexts that have a producing run** — so `producing <= required`, always, and
`required - producing` is exactly the number of `absent` rows. It is not the size of the producing
set; that number is `producing + extra`.

With `--json`: `{"outcome":…,"sha":…,"required":[{"name":…,"state":…}…],"extra":[…],"counts":{"required":<n>,"producing":<n>,"extra":<n>}}`.

**`unprobeable` is the permission answer, and it is not `no-requirements`.** The two halves of the
declared set do not read alike, and the difference is load-bearing — **probed live against
`kamp-us/phoenix` with a `repo`-scoped token (scopes `repo`, `workflow`, `read:org`, no `admin`)
rather than assumed**:

- `GET /repos/{repo}/branches/{base}/protection` answered **`404 "Branch not protected"`**. That
  status is returned **both** when a branch genuinely has no protection **and** when the caller
  lacks the admin permission to see it. It is ambiguous by construction, so **a 404 here is never,
  on its own, evidence of anything** — treating it as `no-requirements` is the proven-absent /
  could-not-read collapse this contract refuses everywhere else.
- `GET /repos/{repo}/rulesets` answered with the **full ruleset list at ordinary `repo` scope**, no
  admin required.

So the rulesets read is what carries the answer, and the rules are:

- **`no-requirements`** needs a **successful** rulesets read returning zero rules that require a
  status context for this base, *and* the protection endpoint's 404. Both, never the 404 alone.
- **`unprobeable`** is when the rulesets read itself is permission-denied, or when the protection
  404 is the only signal and the rulesets read did not complete. The verb answers at exit `0`,
  prints `required:-` on its facts line, and emits no `required` rows.

Collapsing `unprobeable` into `no-requirements` would tell an adopter their repo gates nothing when
it may gate everything — the single most dangerous wrong answer this verb can give. Collapsing it
into `11` would fail every `diagnose` call made with a token that cannot see protection, leaving
the whole skill inert on the common case.

**`no-requirements` is a proven answer at exit `0`** — a base branch with no protection rule and
no ruleset requiring a status context genuinely gates nothing, which is the ordinary state of a
fresh or foreign repository. It is not a gap and not a failure. A protection surface that cannot be read **for any reason other
than this token's permission** — a transport failure, a 5xx — is `11`; a permission denial is the
`unprobeable` answer above, not a failed read.

**The comparison, precisely.** The declared set is the union of the base branch's
`required_status_checks.contexts` and every `required_status_checks` rule in a repository ruleset
whose ref condition matches the base — both REST, both paginated. The producing set is the gating
check-run context names at `--sha`, informational contexts excluded (`isInformational`). A
declared context with no producing run is `absent`; a producing gating run matching no declared
context is `extra`. `gap` iff at least one `absent` row exists.

**`extra` rows are reported, never judged.** A gating run answering no requirement is normal in a
healthy repo — most CI jobs are not required contexts. The row exists because the *inverse*
mistake is the incident: #3369 armed a required context for an analysis that never runs in the
batch context, and #3377 armed one whose name no run produces, and both wedged the entire merge
queue. Printing both sides is what lets a reader see which of the two they have.

**This verb changes nothing.** Arming, renaming and disarming a required context are repository
settings changes with a human's name on them.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR or the `--sha` commit is proven absent (404) |
| `11` | the branch protection, the ruleset list, or the check runs could not be read — coverage is UNKNOWN, never `covered` and never `no-requirements` |
| `13` | the ruleset or check-run enumeration is provably short of its declared count |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `heal-ci surface: PR #<n> not found in <repo>.` | 7 | refusal |
| `heal-ci surface: no commit <sha> on PR #<n>.` | 7 | refusal |
| `heal-ci surface: cannot read <what> for <base>: <reason> — coverage is UNKNOWN, never "no-requirements".` | 11 | refusal |
| `heal-ci surface: received <k> of <m> declared <rulesets\|check runs> — refusing to compare a truncated set.` | 13 | refusal |
| `heal-ci surface: <base> declares no required status contexts — this repository gates nothing on <base>.` | 0 | notice |
| `heal-ci surface: cannot read <base>'s protection surface at this token's permission — the check-surface axis is UNPROBEABLE, never "no requirements".` | 0 | notice |

**Scope** — the PR's base branch protection, the repository's rulesets filtered to those matching
the base ref, and the check runs at `--sha`. Both sides paginated and count-checked; the
comparison is total over what was read.

**Examples**

```
$ fabrika heal-ci surface 4321
surface	gap	03135b91
required	ci-required	producing
required	code-scanning/codeql	absent
extra	unit tests
facts	required:2	producing:1	extra:1
```

```
$ fabrika heal-ci surface 4330
surface	no-requirements	7c31a0de
extra	unit tests
extra	actionlint
facts	required:0	producing:0	extra:2
```

**Grounding**

- #3377 — a required check armed with workflow-name context wedged the whole merge queue; the
  `absent` row is that state made visible before it is armed, and the verb refuses to arm anything.
- #3369 — arming code-scanning wedged the queue because the default analysis never runs in the
  batch context: a declared context with no producing run, which is exactly the `absent` row.
- #2118 — non-hermetic deployed-worker smoke drift evicted four approved control-plane PRs; the
  `extra` side of the report is what makes a drifting non-required job visible.
- v1 read check-runs at the head and nothing else — a repo-wide search of its skill for
  `protection`, `required_status`, `merge_queue` and `mergeable` returns zero hits — so the entire
  class was invisible to it, and a config-broken red was filed as a code defect against a clean diff.

---

## `heal-ci logs`

**Invocation**

```
fabrika heal-ci logs 4321 [--sha 03135b91] [--context <name>] [--max-bytes 65536] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | no | the live head | the head whose failing jobs to read |
| `--context` | string | no | all failing | read only this gating context's log rather than every failing one |
| `--max-bytes` | integer | no | `65536` | per-context tail budget; the log's **last** N bytes are kept, the failure being at the end |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line: `logs\t<count>\t<sha>` — the number of failing gating
contexts whose log follows. Then, per context, a header line and the log bytes delimited so a
consumer can split without guessing:

```
==== context <name> job <id> bytes <k> truncated <true|false> ====
<log text>
==== end <name> ====
```

`logs\t0\t<sha>` is a valid, proven answer: nothing gating is failing at this head.
With `--json`: `{"outcome":"logs","sha":…,"count":<n>,"contexts":[{"name":…,"jobId":<n|null>,"bytes":<n>,"truncated":<bool>,"text":…}…]}`.

**Every failing gating context is read, not the first.** v1 took `jq '.failing[0]'` and discarded
the rest with no record in any output field, comment or issue, so an N-context red silently became
one routed action and N−1 losses. Where `--context` narrows the read, the header count still
reports the total failing set so a caller can see what it chose not to look at.

**No diagnostic is ever written to stdout.** The log body is the answer channel, and v1 wrote its
own English error text onto the same stream, interleaved with the log — so a caller
pattern-matching the log for failure signatures matched heal-ci's own prose as if it were CI
output. Every scope line, truncation notice and read failure goes to stderr.

**A failing context with no job behind it is an answer, not a refusal.** A check run posted by an
app or an external service has no workflow job and therefore no log. Such a context is emitted with
`job -`, `bytes 0`, `truncated false` and an empty body, and it counts toward the header's total.
Refusing the whole read would let one external check hide the logs of every other failing context —
the opposite of this verb's purpose — and a stderr notice names each context served this way.

**Truncation is declared, never silent.** The `truncated` field is part of the header because a
tail-bounded log that reads as complete is how a classifier concludes "no signature matched" over
bytes it never saw.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR or the `--sha` commit is proven absent (404), or `--context` names a context that does not exist at this head |
| `11` | the check runs, the run list, or a job log could not be read after retries — whether a failure log exists is UNKNOWN, never empty |
| `13` | the check-run or job enumeration is provably short of its declared count |
| `15` | proven: the platform reports the run's logs expired or purged — a fact about the run, and no retry can change it |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `heal-ci logs: PR #<n> not found in <repo>.` | 7 | refusal |
| `heal-ci logs: no gating context "<name>" at <sha> — failing contexts are: <list>.` | 7 | refusal |
| `heal-ci logs: cannot read <what> for <sha>: <reason> — UNKNOWN, never "no failed steps".` | 11 | refusal |
| `heal-ci logs: received <k> of <m> declared <check runs\|jobs> — refusing a partial failure set.` | 13 | refusal |
| `heal-ci logs: run <id>'s logs are expired — the platform no longer holds them; classify from the check-run summary or re-run to regenerate.` | 15 | refusal |
| `heal-ci logs: context <name> truncated to the last <k> bytes of <m>.` | 0 | notice |
| `heal-ci logs: context <name> has no workflow job behind it (posted by an external check) — emitted with an empty body.` | 0 | notice |
| `heal-ci logs: read <k> of <m> failing gating contexts (--context narrowed the read).` | 0 | notice |

**Scope** — the gating check runs at one commit, the workflow runs behind them, and one log per
failing context, each read paginated and count-checked. Informational contexts are excluded before
anything is fetched (ADR 0061), so a preview-deploy failure never enters this lane.

**Examples**

```
$ fabrika heal-ci logs 4322 --sha 9fe12ab0
logs	1	9fe12ab0
==== context unit tests job 44182736450 bytes 66 truncated false ====
FAIL src/cart.test.ts > adds a line
AssertionError: expected 3 to be 2
==== end unit tests ====
```

```
$ fabrika heal-ci logs 4321 --sha 03135b91
logs	0	03135b91
```

**Grounding**

- v1's `resolve-failing-run.sh:63` read `.failing[0]` only; the discarded contexts appear in no
  output, no comment and no issue.
- v1's `failed-logs.sh` wrote its UNKNOWN diagnostic to stdout, into the log stream a caller
  greps for signatures, and its own header documents that an unreadable read must not arrive as
  the documented-empty answer — which is exactly what it does when `gh` exits 0 with no bytes.
- v1's three `gh run` calls omitted `--repo`, so a run id resolved against whatever repository the
  process happened to be standing in.
- ADR 0061 — only gating reds reach this lane.

---

## `heal-ci classify`

**Invocation**

```
fabrika heal-ci classify [--json]
```

The log text arrives on **stdin only** — no `--file`, no `--path`. This verb is pure: it opens no
socket and reads no repository, which is what makes it unit-testable against fixtures and what
keeps a classification reproducible from the bytes alone.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| stdin | text | yes | — | `heal-ci logs`' framed output, or one bare log body |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line `classified\t<n>`, then one line per classified context:

```
class	<context>	<transient|logic|unclassified>	<signature-id>	<matched-line>
```

`<context>` is the name from the `==== context … ====` header the block came from, or `-` when
stdin carried a bare body with no framing. On `unclassified` the last two fields are both `-`; the
field count never varies.
With `--json`: `{"outcome":"classified","count":<n>,"contexts":[{"context":…,"class":…,"signature":…,"line":<n|null>}…]}`.

**This verb consumes the framed multi-context stream, so nothing splits it by hand.** `heal-ci
logs` emits N contexts and this verb emits N `class` lines, in the order received — `fabrika
heal-ci logs 4321 | fabrika heal-ci classify` is the whole pipeline. Leaving the split to the
caller would put a hand-rolled parser on the one surface this skill declares attacker-authorable,
and would let a five-context stream be classified as one signature by whichever pattern matched
first. A bare body with no `==== context` header is classified as a single block under context `-`.

**`<matched-line>` is 1-based within the block it was found in**, counting from the line after that
block's `==== context … ====` header, so a signature's coordinate does not move when an unrelated
context is added upstream. For an unframed stdin it is 1-based over the whole input.

**Default-deny, structurally.** The only path to `transient` is a positive match in a `transient`
row. Everything else is `logic` when a `logic` row matched and `unclassified` when none did.
**`unclassified` is a third token deliberately**, where v1's classifier had only two: fusing "I
recognise this as a deterministic bug" with "I recognise nothing" means a caller can never count
how often the classifier is guessing, and the routing differs — a logic signature goes to repair,
an unrecognised failure is filed for a human. There is no path from ambiguous input to `transient`.

**The taxonomy is a single-sourced, ORDERED table, and it is data.** Each row carries a stable id,
a class, a literal pattern and a rationale, in one module, with the table under unit test against
committed fixture logs. **The first row whose pattern matches, in the order printed, is the
answer** — ordering is part of the contract because the classes genuinely overlap (an OOM-killed
suite prints assertion output before it dies, and a preview target answering `502` matches both a
warmup and a generic network row). Specific rows precede general ones, and transient rows precede
logic rows so that an infrastructure death is not read as the assertion failure it printed on its
way down. Patterns are case-insensitive, applied per line.

| # | id | class | pattern (JavaScript regular expression, `i` flag, per line) |
|---|---|---|---|
| 1 | `runner-oom` | transient | `/\b(sigkill\|out of memory\|oom-killed\|exit code 137)\b/` |
| 2 | `runner-cancelled-infra` | transient | `/\b(the runner has received a shutdown signal\|the operation was canceled by the (?:runner\|server))\b/` |
| 3 | `rate-limited` | transient | `/\b(429\|rate limit exceeded\|secondary rate limit\|api rate limit\|quota exceeded)\b/` |
| 4 | `preview-warmup` | transient | `/(preview\|deployment\|deployed target).{0,80}?\b(not reachable\|did not become reachable\|connection refused\|502\|503\|504)\b/` |
| 5 | `readiness-stall` | transient | `/\b(readiness\|health ?check\|waiting for .{0,40}to be ready)\b.{0,60}\b(timed out\|timeout\|exceeded)\b/` |
| 6 | `network-transient` | transient | `/\b(etimedout\|econnreset\|econnrefused\|enotfound\|eai_again\|socket hang up\|tls handshake timeout)\b/` |
| 7 | `assertion-failure` | logic | `/\b(assertionerror\|expected .{0,40} to (?:be\|equal\|contain)\|toEqual\|toBe)\b/` |
| 8 | `typecheck-failure` | logic | `/\berror TS\d{4,5}\b/` |
| 9 | `lint-failure` | logic | `/\b(eslint\|biome)\b.{0,60}\berror\b\|^\s*error\s+.{0,80}\s+@?[\w/-]+\/[\w-]+$/` |
| 10 | `build-failure` | logic | `/\b(cannot find module\|module not found\|failed to resolve import\|syntaxerror\|unexpected token)\b/` |

An implementer ships exactly these ten rows in this order; the table grows by adding rows, never by
branching inside the verb. Row 4 preceding row 6 is what makes a failure to reach **this PR's own
preview target** a warmup rather than generic network trouble.

**Empty stdin is `3`, not `unclassified`.** A verb that classified nothing and a verb that read
nothing must not answer the same way.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — there is no log to classify |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `heal-ci classify: no log on stdin — an empty read is not an unclassified failure; pipe the bytes.` | 3 | refusal |
| `heal-ci classify: <context>: matched <signature-id> at line <k> — <rationale>.` | 0 | notice |
| `heal-ci classify: <context>: no signature matched over <k> lines — default-deny, never "transient".` | 0 | notice |

**Scope** — the bytes on stdin, nothing else. Not a judging verb over a repository surface, so
ADR 0092's zero-scope rule reaches it as the `3` refusal above rather than as a scan count.

**Examples**

```
$ fabrika heal-ci logs 4322 --sha 9fe12ab0 | fabrika heal-ci classify
classified	1
class	unit tests	logic	assertion-failure	2
```

(The block's own line 1 is `FAIL src/cart.test.ts > adds a line`; the `AssertionError` that matches
row 7 is its line 2.)

```
$ fabrika heal-ci classify <<'EOF'
Error: connect ETIMEDOUT registry.npmjs.org:443
EOF
classified	1
class	-	transient	network-transient	1
```

```
$ fabrika heal-ci classify <<'EOF'
Something went wrong.
EOF
classified	1
class	-	unclassified	-	-
$ echo $?
0
```

**Grounding**

- v1's `failure-classifier` was correct in its default-deny core and ships **dormant with zero live
  callers**; its two-class output could not express "I recognise nothing", and its rationale went
  to stderr as prose, unrecoverable by any pipe.
- #5348 — a green PR went red on a preview-warmup flake and a human had to decide rerun versus real
  regression; row 4 is that signature, and the third token keeps an unrecognised failure from being
  guessed into a rerun.
- ADR 0247 / #4735 — a table of prose descriptions is an uninvented core that passes every presence
  check; the literal patterns and the stated precedence are what make two implementations agree.
- ADR 0061 — the informational carve-out happens upstream in `logs`, so this table never encodes
  which contexts block.

---

## `heal-ci rerun`

**Invocation**

```
fabrika heal-ci rerun 4321 --run 9182736450 --sha 03135b91 --signature preview-warmup [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--run` | integer | yes | — | the workflow run to re-run the failed jobs of |
| `--sha` | string | yes | — | the head the transient was diagnosed at; the at-most-once guard is per head |
| `--signature` | string | yes | — | the `classify` signature id justifying the rerun; recorded in the durable marker |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line: `rerun\t<new-attempt>\t<run-id>\t<marker-url>` where
`<new-attempt>` is the run's `run_attempt` **read back after the request**, never the value the
caller held. With `--json`: `{"outcome":"rerun","attempt":<n>,"run":<id>,"markerUrl":…}`.

**The verb owns the guard, and this is the single most important clause in the contract.** In
order, trusting nothing it was told:

1. **Re-derive the head binding.** The live head must prefix-match `--sha`, else `12`: a rerun
   justified by a diagnosis of one tree must not fire against another.
2. **Re-derive the failure state.** The run must exist, belong to this PR's head, and have
   concluded `failure` (or `timed_out`/`cancelled`). Proven otherwise → `14`, nothing touched.
3. **Re-derive at-most-once, from two independent signals, both fully paginated.** The head has
   already been rerun if the run's `run_attempt` is ≥ 2, **or** a `heal-ci` rerun marker comment
   exists bound to this `--sha`. Either → `14`. The two are kept because each covers the other's
   hole: `run_attempt` can be bumped by a human or another tool, and a marker can be edited away.
4. **Request the rerun** of the failed jobs only.
5. **Read back the run** and require `run_attempt` to have increased. A request that returned 2xx
   without materialising a new attempt is `8` — and critically, **no marker is written on that
   path**, because v1 wrote the durable marker on the strength of the dispatch response and thereby
   blocked every future rerun of a run that never re-ran.
6. **Write the marker comment** in the format specified above, and read it back through
   `normalizeForReadback`. A create that **fails** after a confirmed new attempt is `16`; a create
   that lands but whose read-back does not match is `9`. Both mean the same operationally — the
   rerun is spent and unrecorded — and both are reported at once rather than as a stop.

Steps 4–6 are one logical operation whose ordering is deliberate: the rerun before the marker
means an interrupted run leaves a re-runnable state rather than a permanently blocked one, and the
read-back in step 5 is what makes step 6's marker true.

**Why the guard cannot live in the skill.** v1's `rerun-once.sh` accepted no already-rerun input
and performed no check of its own; the entire one-rerun invariant rested on the model remembering
a number it had read several steps earlier. A session-memory invariant is not an invariant. The
`14` refusal is this verb's structural anchor, and a caller that has convinced itself a second
rerun is warranted still cannot get one.

**A `14` refusal is a success.** The state was proven and nothing was mutated; a second rerun is
escalation, not retry.

**This verb takes no view on whether the rerun is wise.** Where the failing context is itself a
gate checking its own output, a bounded retry can be actively harmful (#5335); that judgment is
the skill's, and it is exercised before this verb is called.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR or the run is proven absent (404) |
| `10` | `--signature` is not one of `classify`'s table ids |
| `8` | the rerun request, or the confirming read-back, failed — whether a new attempt exists is UNKNOWN, and **no marker was written**; re-read before retrying |
| `9` | the rerun landed and the marker comment's read-back does not match — the rerun happened, the durable record did not |
| `11` | the head, the run, or the marker comments could not be read — nothing was requested |
| `12` | the live head moved past `--sha` — the transient you diagnosed belongs to a tree that is gone |
| `13` | the comment enumeration never proved complete — an unexhausted read must not license a second rerun |
| `14` | proven: the run is not in a failed state, or this head was already rerun (`run_attempt` ≥ 2 or a bound marker exists), or the PR is not open |
| `16` | the rerun **provably landed** and the marker comment could not be created — the rerun is spent and unrecorded; escalate before anything else touches this head |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `heal-ci rerun: --signature <v> is not a known classify signature id (see \`heal-ci classify\`'s table).` | 10 | refusal |
| `heal-ci rerun: PR #<n> or run <id> not found in <repo>.` | 7 | refusal |
| `heal-ci rerun: the live head is <live>, you diagnosed <sha> — refusing to rerun against a tree nobody classified.` | 12 | refusal |
| `heal-ci rerun: run <id> concluded <conclusion>, not a failure — refusing to rerun a run that did not fail.` | 14 | refusal |
| `heal-ci rerun: head <sha> was already rerun (<run_attempt=<k>\|marker <url>>) — a second rerun is escalation, not retry.` | 14 | refusal |
| `heal-ci rerun: PR #<n> is <closed\|merged\|draft> — nothing to rerun.` | 14 | refusal |
| `heal-ci rerun: cannot read <what>: <reason> — nothing was requested.` | 11 | refusal |
| `heal-ci rerun: received <k> of <m> declared comments — refusing to license a rerun over a truncated marker read.` | 13 | refusal |
| `heal-ci rerun: the rerun request failed: <reason> — no new attempt, no marker written.` | 8 | refusal |
| `heal-ci rerun: the request was sent and run_attempt did not increase — UNKNOWN whether it re-ran; no marker written, re-read before retrying.` | 8 | refusal |
| `heal-ci rerun: the rerun landed at attempt <k> and the marker read-back does not match — the rerun is real, the record is not; inspect comment <id>.` | 9 | refusal |
| `heal-ci rerun: the rerun landed at attempt <k> and the marker could not be written: <reason> — this head is rerun and UNRECORDED; the next reader will see it as fresh. Escalate now.` | 16 | refusal |

**Scope** — one PR's live head and state, one workflow run's conclusion and attempt count, the
PR's comments paginated and count-checked for a bound marker, one rerun request, one confirming
run read, one comment write, one confirming comment read.

**Examples**

```
$ fabrika heal-ci rerun 4322 --run 9182736450 --sha 9fe12ab0 --signature preview-warmup
rerun	2	9182736450	https://github.com/kamp-us/phoenix/pull/4322#issuecomment-5155001122
```

```
$ fabrika heal-ci rerun 4322 --run 9182736450 --sha 9fe12ab0 --signature preview-warmup
heal-ci rerun: head 9fe12ab0 was already rerun (run_attempt=2) — a second rerun is escalation, not retry.
$ echo $?
14
```

**Grounding**

- v1's `rerun-once.sh` — the guard lived in the agent's head, the marker count read one unpaginated
  page, the dispatch response was trusted as proof, and the reported "new run id" was the old one.
  All four are designed out here: the guard is in the verb, the read paginates and count-checks,
  the read-back gates the marker, and the printed attempt is the one read back.
- #5348 — the flake that only needed a rerun, and the human who had to decide it was one.
- #5335 — a bounded retry is harmful where the failing check is a gate reading its own output;
  the judgment stays in the skill and this verb records the signature that justified it.
- ADR 0198's shape, borrowed but not shared: the one mutation that could compound is guarded by a
  re-derived precondition rather than by caller discipline.

---

## `heal-ci note`

**Invocation**

```
fabrika heal-ci note 4321 [--repo <owner/name>] [--json]
```

The body arrives on **stdin only** — no `--body`, no `--body-file`; a path flag is how a
machine-local path reaches a public surface while the poster reads success.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | markdown | yes | — | the durable note: the terminal token and its reason, as the skill's terminal vocabulary phrases them |

**Output** — machine channel. One line: `noted\t<comment-url>`.
With `--json`: `{"outcome":"noted","commentUrl":…}`.

Leak-scanned (`report/leaks.ts`, imported), posted as a **new** comment — a strand's history is a
history, not a state, and each classification is its own record — then read back through
`normalizeForReadback`. A note on a closed or merged PR is legal: a strand that resolved while the
run was classifying it still deserves the record.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing |
| `5` | the body carries a machine-local path |
| `6` | the body is a bare `@` path reference |
| `7` | the PR is proven absent (404) |
| `8` | the comment create, or its confirming re-read, failed — UNKNOWN whether it landed |
| `9` | the comment landed but the read-back does not match |
| `11` | the PR could not be read — nothing was posted |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `heal-ci note: no body on stdin — a silent classification leaves the strand as invisible as it was found; write the reason.` | 3 | refusal |
| `heal-ci note: the body carries a machine-local path at line <k> (<class>) — cite it repo-relative.` | 5 | refusal |
| `heal-ci note: the body is a bare "@" path reference — the bytes never arrived. Send them on stdin.` | 6 | refusal |
| `heal-ci note: PR #<n> not found in <repo>.` | 7 | refusal |
| `heal-ci note: create failed: <reason> — UNKNOWN whether the note landed; re-read before retrying.` | 8 | refusal |
| `heal-ci note: the read-back does not match — inspect comment <id>.` | 9 | refusal |
| `heal-ci note: cannot read PR #<n>: <reason> — nothing was posted.` | 11 | refusal |

**Scope** — one PR, one comment write, one read-back.

**Examples**

```
$ fabrika heal-ci note 4321 <<'EOF'
heal-ci: ROUTED — PR #4321 @ 03135b91 → ship

Stall class `gated-unshipped`: review-code and review-doc both PASS at this head, CI green,
no merge intent armed and no queue entry. Strand age 35m. Nothing is failing; nobody is holding it.
EOF
noted	https://github.com/kamp-us/phoenix/pull/4321#issuecomment-5155001122
```

**Grounding**

- The durable-signal rule the sibling groups share: a lane that stops without a record leaves the
  next reader with nothing, and for this lane that is the whole defect — an invisible strand is
  what the skill exists to make visible.
- v1's two comment writers discarded their responses to `/dev/null`, so the only routed action of
  an invocation was reported done on the strength of a write response rather than a read-back.
- #2393's class — the leak predicate is generic by design and is imported, never re-derived.

---

## Where this spec leaves questions open

Two decisions bear on this group and are **not** resolved here, because neither is this session's
to make. Each is cited at its site above.

| Question | Where it lives |
|---|---|
| Which surface owns an unpulled PR — this lane, the construction lane, or a new one | [#4820](https://github.com/kamp-us/phoenix/issues/4820), `ready-for:human`, awaiting a founder ruling. This spec answers "how is the state named", never "whose job is it". |
| Whether the red-**main** response layer supersedes, feeds, or is disjoint from this lane | [#5223](https://github.com/kamp-us/phoenix/issues/5223), whose acceptance criteria require an ADR stating the relationship to #4717. A ruling there may re-scope `sweep`. |

## The eval-enumeration obligation (leaf rule)

Stated once, in [`SKILL.md`](SKILL.md)'s "Eval enumeration" section — the single home the #4891
obligation lives in. This spec adds nothing to it; the eval mechanics belong to #4649.

# The fabrika verb reference

One section per registered verb group: what the group does, a row per verb naming the question it
answers, and the exit codes that group produces. The groups are the ones
[`src/registry.ts`](../src/registry.ts) registers — a group appears here by being registered — and
they are listed alphabetically. The `capture` library subpath closes the page, because it ships with
the same package without being a verb group.

The package front door is [`../README.md`](../README.md); for what fabrika is and how to run it,
read [the guide](../../../claude-plugins/fabrika/guide/README.md).

## The interface every verb meets

Governed by
[`claude-plugins/fabrika/docs/interface-convention.md`](../../../claude-plugins/fabrika/docs/interface-convention.md).
Four rules bind a caller:

- **Stdout is the answer; everything else is stderr.** Scope lines, refusal reasons and progress are
  diagnostics.
- **The positive answer is a positive token, never an absence.** `adr sweep` prints `no-overlap`,
  not an empty shortlist.
- **The exit status is the answer; empty stdout never is.** `0` = the answer is on stdout, `1` =
  usage error or the verb failed to run, `126` = the binary started but could not resolve an
  implementation, `127` = the verb never ran, `3`+ = the verb's own proven outcomes below. A
  non-zero exit is UNKNOWN. `2` is allocated by nothing: it is the code a `PreToolUse` hook blocks a
  tool call on.
- **Fail closed on missing scope or state.** A zero-record scan is a failed read, not an answer
  ([ADR 0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)); an unreadable input
  resolves to a refusal, never to a permissive default.

**How a group's exit codes compose with the shared table below.** Most groups seat `3`–`11` on one
imported table, so a code means the same thing whichever group produced it. Each group section then
lists only what it adds on top, plus any shared seat it uses differently — so read a group's
**Exit codes** line against the table here, never instead of it. A group that seats its own table
says so in that line.

## The shared exit table

| Code | Meaning |
| --- | --- |
| `3` | stdin was read and held nothing (a read that *failed* is `1`) |
| `4` | a required section or document is missing, out of order, empty, or does not parse |
| `5` | the authored text carries a machine-local path |
| `6` | the authored text is a bare `@` path reference — not redactable, so a second code |
| `7` | zero scope: the target is proven absent or closed, or there is nothing to judge |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN |
| `9` | the write landed and the read-back does not match |
| `10` | a value is off its closed vocabulary, or claims a classification it may not |
| `11` | a precondition read failed — nothing was written and no outcome is proven |

A group that does not perform a given kind of work leaves its seat as a **deliberate gap** rather
than reusing the number, so the alignment holds across groups a caller drives in one sweep.

## The `adr` group

Record one architecture decision, from id to citations. Contract:
[`skills/adr/contract.md`](../../../claude-plugins/fabrika/skills/adr/contract.md).

| Verb | Answers |
|---|---|
| `adr next` | the next unused id — `max(fetched merged set ∪ open-PR claims) + 1` |
| `adr new` | scaffolds `.decisions/NNNN-slug.md` from the canonical template |
| `adr mint` | `next` and `new` in one call — allocates the id and writes the record with no gap |
| `adr resolve` | each id's real filename and state: `live` / `landed` / `in-flight` / `absent` |
| `adr supersede` | rewrites an older record's `status:` line to a `superseded by` link |
| `adr amend-in-part` | appends this id to an older record's `amended-in-part by` list |
| `adr sweep` | ranks the uncited live-accepted records this one may contradict |

**Exit codes.** `7` the named record is absent · `11` the record directory could not be read ·
`12` the target path already exists · `13` `--by` has no record · `14` no single rewritable
`status:` line · `15` the rewrite would touch a line other than `status:`, aborted before writing ·
`16` already superseded · `17` `--base` unfetchable · `18` open PRs unenumerable · `19` a record
filename with no readable id · `20` two records claim one id · `21` the `origin` remote could not
be read. `5` is a vacated seat and must not be reused.

Three behaviours are worth knowing:

- **`--base` is fetched before it is read.** A stale local ref is the defect class this closes.
- **`mint` exists because an id read in one call is stale by the next.** It is still not a
  reservation — no id is visible to another lane until its pull request opens — so keep the
  re-check before you push.
- **`live` and `landed` are different answers.** `landed` means present on the base ref but
  `proposed`, `superseded` or `retired`. Citing one as settled law is what the split prevents.

## The `build` group

Everything one construction lane needs, from the candidate pool to the opened pull request.
Contract: [`skills/build/contract.md`](../../../claude-plugins/fabrika/skills/build/contract.md).

| Verb | Answers |
|---|---|
| `build tree` | whether the ground is clean and the complete fresh issue or repair PR→explicit issue-in-linkage-set relationship is proven |
| `build pick` | the ranked candidate pool, with every excluded issue under the axis that refused it |
| `build eligible` | whether one issue's dependency gate is open |
| `build claim` / `confirm` / `release` / `adopt` | the lane's claim on an issue: race it, explicitly select a repair PR's served issue, re-prove it, retract it, or take a dead session's |
| `build claimants` | who holds an issue's claim, read by a caller holding none — no token, no write, no clearance |
| `build issue` | the claimed issue's body and its criteria — `found` / `absent` / `malformed`, all on exit 0 |
| `build branch` / `scratch` | the lane's branch off a fresh base, and its scratch directory |
| `build resume-child` | an epic child's standing-`FAIL` repair lane, opened as one operation: claim, confirm, clean tree, resumed branch, armed proof |
| `build commit` / `push` | the commit whose message is proven this lane's, and the push whose ref is proven moved |
| `build check` | this surface's validators, run here with the build cache bypassed |
| `build pr` / `pr-body` / `note` | the guarded, read-back PR write surfaces |
| `build verdicts` | the latest gate verdict per namespace at a PR's live head |
| `build clear` | the founder's clearance of one extra repair round |
| `build reap` | which finished `.claude/worktrees/agent-*` trees are provably safe to remove — a dry run unless `--execute` |
| `build retire-branch` | which of an epic child's lane branches the board attests to, and the rename that moves the rest out of `build/` |

`build reap` is the bulk counterpart to `build retire`. `retire` targets the trees holding ONE
number's lane branch and needs a board statement to release them; `reap` sweeps the whole agent
population, which usually holds no lane branch at all (the harness detaches those trees), and asks
git instead: a tree goes only when it is clean, unlocked, and its HEAD is on the trunk — reachable
from `origin/HEAD`, or landed there as a squash, matched on patch identity. Every other case, and
every read that failed, is KEEP.

`build retire-branch` is the recovery ADR [0324](../../../.decisions/0324-retire-superseded-lane-branch.md)
rules for a clone already in the two-branch state, where `lane prove` refuses because two branches
carry one child's commits. It **renames** the superseded ones into `retired/` and deletes nothing, so
a mistaken retirement costs a rename back rather than a child's only copy of its work. The survivor
is the candidate whose lane nonce an authorized claim marker carries — where the board attests none,
or attests two, it renames nothing and refuses.

**Exit codes.** The shared table, plus: `13` uncommitted changes at a `--require-clean` open ·
`14` the checked-out branch is not this lane's · `15` this session does not hold the claim ·
`16` the issue is blocked · `17` the push ran and the remote ref did not move · `18` this tree's
validation is red · `19` the push is unsafe (detached HEAD, or non-fast-forward with no lease) ·
`20` out of scope · `21` the `ready-for:` audience is not agent · `22` every changed file falls
outside all three surfaces' validators · `23` the local head would drop published commits ·
`24` `git commit` ran and HEAD did not move · `25` this account may not clear a cap · `26` the
quoted authorization is empty or undated · `29` the grant is on the PR and the local lane did not
take it · `30` the deliverable is not a pull request a build lane produces · `31` the claim's mode
and the child's standing verdict disagree · `32` the issue body carries no readable acceptance
criteria · `33` a working tree holds the lane branch and the board licenses no release · `34` the
board attests no single survivor among a child's lane branches. `12` is a retired seat.

## The `campaign` group

Read and write the `## Campaigns` table on the roadmap file — the surface whose `State` cell is the
permission to open lanes against a milestone (ADR
[0304](../../../.decisions/0304-campaign-active-is-the-dispatch-permission.md)). Both writing verbs
go past a `campaign-approve:` marker on a cited founder comment. Contract:
[`skills/campaign/contract.md`](../../../claude-plugins/fabrika/skills/campaign/contract.md).

| Verb | Answers |
|---|---|
| `campaign list` | the table's rows as `#<milestone>\t<state>\t<name>`, in table order, optionally narrowed by `--state` |
| `campaign open` | appends a row pinning a milestone, past the cited approval, and reads it back |
| `campaign state` | rewrites one row's `State` cell to `active`, `paused` or `done`, past the cited approval, and reads it back |

`list` prints the single line `none` at exit `0` for an absent table, an empty one, and a `--state`
that matches nothing. `open` always writes the row `paused` and carries no flag to change that.
`state` selects by `#<milestone>` or by a name matched exactly against the row's first cell, and only
the state token moves — the cell is never re-padded, so every other line stays byte-identical.
`--json` emits the result object instead of the row line grammar on all three.

**Exit codes.** The shared table's `7` the selector matches no row (`state` only) · `8` the roadmap
write failed, so the file may be half-written · `9` the file was written and the read-back does not
hold what the verb wrote · `11` the roadmap file could not be read, so nothing was attempted. Then
this group's own band: `12` a data row under `## Campaigns` will not parse, so the whole table is
unreadable · `13` the cited comment, a team membership, the author's permission or the repository
could not be resolved — authority is UNKNOWN · `14` the cited comment's first line carries no
`campaign-approve:` marker · `15` the marker is malformed, names another milestone or state, or is in
another repository · `16` the comment's author is not in `campaignAuthors` · `17` `campaignAuthors`
is empty or absent — nobody may declare · `18` the selector matches more than one row (`state` only) ·
`19` a row already holds this name or pins this milestone (`open` only) · `20` the row already holds
`--to`, so nothing was written (`state` only) · `21` the author is in `campaignAuthors` but holds
below `write` on the repository
([ADR 0055](../../../.decisions/0055-acl-sourced-review-authz.md)) · `22` `.fabrika.jsonc` could not
be read, or its `roadmapFile` will not decode. `3`, `4`, `5`, `6` and `10` are unallocated: no verb
here reads stdin, composes a body, or classifies anything.

## The `ci` group

The release path and the build path — the workflow plumbing, not guards. A mistake here breaks
cutting a release or breaks the evidence a merge gate reads.

| Verb | Answers |
|---|---|
| `ci changelog` | one Keep-a-Changelog release section derived from a range's closed-issue/merged-PR metadata (ADR [0069](../../../.decisions/0069-derived-changelog-from-shipped-work.md)) |
| `ci pr-body` | a standing Release PR body with every stray HTML tag neutralized, so release-please can parse its own PR back |
| `ci annotate` | a typecheck's output echoed through unchanged, each tsc diagnostic re-emitted as a `::error` workflow command |
| `ci evidence` | the ADR [0054](../../../.decisions/0054-run-evidence-bundle.md) §2 run-evidence manifest for a crabbox run, which `ship evidence` binds to a head SHA |

**Exit codes.** `3` empty stdin · `4` an input document parsed and violated its schema · `8` the
output file could not be written · `11` a read the answer rests on failed.

Two things here do not follow the ordinary verb shape, and both are forced:

- **`ci annotate` writes its own streams** instead of returning a `VerbOutcome`, because the whole
  point of a pass-through filter is that the CI log stays live. It always exits `0`: the
  typecheck's redness rides on the producer's exit code through `set -o pipefail`.
- **`ci-required` is a bare bin, not a verb** — [`src/ci/required-bin.ts`](../src/ci/required-bin.ts),
  the aggregator deciding whether every should-have-run gating job actually ran (ADR
  [0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)). Its job runs on every PR and
  installs no dependencies, so nothing on its entry path may import `effect`. The job set it covers
  is declared once, in `ci.yml`'s `CI_REQUIRED_JOBS`, beside the `needs:` list it must match.

## The `config` group

Own the derived shape of `.fabrika.jsonc` — the per-key JSON Schema fragments assembled into the one
document an editor validates the config file against, kept rendered from the config-key registry in
[`src/config/registry.ts`](../src/config/registry.ts) rather than hand-synced.

| Verb | Answers |
|---|---|
| `config schema` | whether the committed `.fabrika.schema.json` agrees with that registry — and, with `--write`, the document rendered from it |

Stdout is the single line `schema\t<agrees|written>\t<keys>`; `--json` emits the full result object
instead of that line grammar.

**Exit codes.** This group seats its own table, not the shared one: `4` the committed schema is
stale, or was never committed · `6` the repo root could not be resolved, or the file could not be
read or written — UNKNOWN, never a drift · `7` a registered key carries no schema fragment, so the
assembled schema would green a typo under it.

## The `decision` group

Record and read a founder's ruling on a `type:decision` issue, so a decided question re-enters the
normal build lane instead of being hand-driven around its `ready-for:human` park. The ruling is a
marker comment on the issue, bound to a digest of the issue body it ruled on and naming the comment
the ruling is written in — the same marker mechanism `plan approve` uses for an epic plan, over its
second surface (ADR 0289; #5842, consolidated into epic #5843).

| Verb | Answers |
|---|---|
| `decision rule <n> --cites <url>` | records the ruling and flips the audience — **only after** the marker reads back |
| `decision ruling <n>` | whether the issue carries a `current`, `stale` or `absent` ruling |

`rule` derives the digest itself; there is no `--digest`, because a ruling whose scope its caller
supplies attests whatever the caller pleased. Both verbs resolve the `@kamp-us/control-plane` roster
through the same `ship/codeowners.ts` path the merge gate uses: the write gates on the invoking
account, and the read gates on the marker's author, because posting those bytes takes nothing but the
ability to comment. `ruling`'s three states all exit `0` — a missing ruling is the answer.

**Exit codes.** The shared table's `7` / `8` / `9` / `11`, plus one of its own: `20` the invoking
account is off the control-plane roster, or that roster names nobody. A roster that could not be read
is `11`, never "unauthorized" and never "authorized" (#4223).

## The `glossary` group

Maintain the repo's canonical vocabulary registers — `.glossary/TERMS.md` for the domain nouns and
`.glossary/LANGUAGE.md` for the architecture vocabulary. Every verb resolves the register against
the **target** repo's root, never the installed plugin. Contract:
[`skills/glossary/contract.md`](../../../claude-plugins/fabrika/skills/glossary/contract.md).

| Verb | Answers |
|---|---|
| `glossary init` | creates a register that does not exist, so a fresh repo is not a dead end |
| `glossary drift` | the surfaces that moved since a register last changed, and the candidate coinages in them |
| `glossary lookup` | whether a term is already declared, and what overlaps it |
| `glossary sections` | the live section names of a register, and each one's row count |
| `glossary add` | inserts or replaces one row, alphabetically placed and byte-preserving elsewhere |
| `glossary check` | row-shape, duplicate-key, cross-register, ordering and citation-liveness defects |

**Exit codes.** The shared table, plus `12` a term collision · `13` the named section is absent ·
`14` a row's shape is invalid · `15` the edit would have changed a line beyond its own row. `5` is
a deliberate gap.

Three behaviours are worth knowing:

- **Absent and present-and-empty are different facts.** An absent register is `bootstrap` at exit
  `0` — day one in an adopting repo — while a present register holding zero rows reds `check` on
  `7`, because a scan of nothing must never report `clean`.
- **The whole first cell is one key.** `Database (tag)` and `tag` are different terms that
  *overlap*; a parenthetical is a qualifier, not an alias. `lookup` reports the overlap and leaves
  the judgement to the skill.
- **Two defect classes are deliberately not computed.** Machine-local paths and dead internal links
  are each decided by a merge-blocking gate, so `check` states the expectation and leaves the
  verdict where it is enforced. Seats `5` and `6` are held empty for that reason.

This group reaches no network: every read is the local tree. It gates no merge and emits no verdict.

## The `governance` group

Keep the governance corpus honest across a diff. The **governance namespace** is derived from a
diff — named by a PR or by a `--base`/`--tip` range — and is required when any changed path sits
under one of four harness roots (`.decisions/`, `.claude/`, `.github/`, `claude-plugins/`).
Contract:
[`skills/governance/contract.md`](../../../claude-plugins/fabrika/skills/governance/contract.md).

| Verb | Answers |
|---|---|
| `governance scope` | whether the diff derives the namespace, over which roots, with the bound head or range |
| `governance sweep` | the uncited live-`accepted` records whose domain a subject touches, ranked |
| `governance guards` | the anchored invariants the bound diff removes or modifies |
| `governance base` | this skill's own text at the subject's merge base — the self fence's bytes |
| `governance post` | the single sanctioned emit of the `governance` namespace verdict |
| `governance digest` | the decision records that landed in a window, with each landing commit |
| `governance readout` | the digest-publishing protocol: compose, upsert, read back |

**Exit codes.** The shared table, plus `12` the `--sha` given is not the PR's head · `13` a read
completed and its scope is provably incomplete · `14` this diff derives no governance namespace.
`4` is a deliberate gap.

Three behaviours are worth knowing:

- **This is not the §CP answer, and `governance scope` says so on stderr on every run.** fabrika's
  §CP model is CODEOWNERS-only, so a second answer here could contradict a merge-gating verdict.
- **No outcome here is a clearance.** `sweep`'s `no-overlap` carries that sentence verbatim in its
  `reason`, and `guards`'s `no-anchors-in-reach` is the mechanical floor reporting its own silence:
  a guard weakened in prose carrying no anchor is invisible to the scan by construction.
- **The anchor inventory lives in the guarded file.** An anchor is the `<!-- anchor: NAME -->`
  comment a skill already carries, so the set cannot rot while the guards move.

## The `graduate` group

Turn a cleared decision trail — a grilling session or a wayfinding map — into one buildable spec
issue. Contract:
[`skills/graduate/contract.md`](../../../claude-plugins/fabrika/skills/graduate/contract.md).

| Verb | Answers |
|---|---|
| `graduate trail` | one source resolved into a provenance-tagged decision trail |
| `graduate compose` | the four-section spec body, rendered from the trail plus stdin |
| `graduate emit` | the one spec issue filed, and the emission recorded on the source |
| `graduate read` | whether this source already graduated, and into what |

**Exit codes.** The shared table, plus `12` the source carries neither `grilling:session` nor
`wayfinding:map`, or both · `13` the trail holds an unresolved decision · `14` a decision entry has
no digested field · `15` this spec digest already emitted an issue · `16` the trail holds zero
decisions · `17` the stdin body carries a `## Decisions` heading of its own · `18` a ref the spec
carries is absent from the re-derived trail, or its text changed.

## The `grill` group

Run a grilling session on a GitHub issue. A session is one issue carrying `grilling:session`;
rounds, the answers an agent establishes and the rulings the founder makes all live in its
comments. Contract:
[`skills/grilling/contract.md`](../../../claude-plugins/fabrika/skills/grilling/contract.md).

| Verb | Answers |
|---|---|
| `grill open` | opens, or resumes, the session issue for a topic — `created` says which |
| `grill round` | validates one round from stdin, posts it, and returns its number, digest and ids |
| `grill answer` | records an agent-established answer to a `fact` question, behind a kind guard |
| `grill rule` | records a founder ruling, refusing without a verbatim dated authorization |
| `grill read` | per-question state, ACL-resolved and digest-checked, plus the frontier token |

**Exit codes.** The shared table, plus `12` the invoking token is below `write` · `13` the question
id names no question · `14` the round could not be digested · `15` `--authorization` is missing,
empty or undated · `16` more than one open session matches the topic · `17` the question's kind
does not admit this verb · `18` the question was retired by a later round · `19` a `## Came from`
section is present and does not conform. `10` is a deliberate gap.

Three behaviours are worth knowing:

- **A recorded ruling is bound to an authority, not to a string.** Every marker's author is
  resolved against repository permissions
  ([ADR 0055](../../../.decisions/0055-acl-sourced-review-authz.md)), and a permission read that
  *fails* is UNKNOWN, never a demotion.
- **A ruling is bound to the text it ruled.** The round digest covers the round's question text, so
  re-wording a question makes `grill read` report it `stale` — un-ruled again. That rests on a
  prohibition: no verb ever edits an existing comment.
- **A malformed marker is visible, never absent.** `grill read` never refuses on marker content: a
  malformed, unauthorized or unbound marker is a `disregarded` row at exit `0`, so one bad comment
  cannot suppress the whole frontier answer.

All four frontier tokens exit `0`: `awaiting-founder`, `facts-pending`, `clear` and `empty` are
four answers, and an open frontier is this skill working.

## The `guard` group

The repo's fail-closed CI gates. Unlike every other group this one nests — a guard is its own
subcommand and `check` is its leaf — so a workflow step and a human reproducing its red type the
same thing:

```bash
node packages/fabrika-cli/src/bin.ts guard readme-guard check
```

| Verb | Answers |
|---|---|
| `guard readme-guard` | whether every real `packages/*` workspace member carries a `README.md` |
| `guard skill-lint` | whether the `claude-plugins/` skill + agent corpus obeys its four mechanical rules |
| `guard homing-guard` | whether every triaged issue leaves triage with exactly one home |
| `guard pitch-guard` | whether lane-entering work became pickable only with an approved pitch |
| `guard roadmap-guard` | whether `ROADMAP.md` and the milestone projection are in sync |
| `guard unresolved-threads-guard` | whether any unaccounted unresolved review thread reaches merge-ready |
| `guard settings-env-guard` | whether a `settings.json` env value expects an expansion that never runs |
| `guard catalog-guard` | whether every dependency is on `catalog:` or `workspace:` |
| `guard fanout-guard` | whether every fanned mutation publishes its `/fate/live` invalidation |
| `guard patch-guard` | whether every maintained pnpm patch is pinned by a behavior test |
| `guard pointer-guard` | whether backticked `CLAUDE.md` path pointers still resolve |
| `guard publish-isolation-guard` | whether every published package installs from a clean registry |
| `guard leak-guard` | whether a machine-local path reaches a shared artifact |
| `guard path-filter-guard` | whether `deploy`'s run-set stays a superset of `e2e`'s |
| `guard change-detect-guard` | whether change detection is still API-free git mode |
| `guard codeowners-cp` | whether every §CP path is owned by a human team in `.github/CODEOWNERS` |
| `guard decisions-index` | whether the ADR corpus holds a colliding or mismatched number |
| `guard design-token-guard` | whether component CSS consumes the design-token seam |
| `guard design-inventory` | whether the committed component inventory still matches its JSDoc (`check`), and the one write mode that regenerates it (`generate`) |
| `guard no-gh` | whether any `gh` invocation has returned to this package's own source |

**Exit codes.** `0` clean · `7` zero scope (ADR
[0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)) · `11` a read the verdict rests
on failed, so the answer is UNKNOWN · `12` the scan ran over real scope and the rule is broken.
Three refusal numbers rather than one, because CI reds on all of them and a human fixing one needs
to know which.

Three things are shared by the group rather than rebuilt per guard, which is the point of it:

- **Scope.** `members.ts` resolves real workspace members — a directory under a declared
  `pnpm-workspace.yaml` glob that carries a `package.json`. A dead-shell directory is not a member,
  and a read that fails is never an empty scan.
- **The change.** `changed-files.ts` resolves what a change-scoped guard diffs against, per CI leg:
  a PR's target branch, the merge queue's batch base (ADR
  [0132](../../../.decisions/0132-merge-queue-for-base-freshness.md)), a dispatch's default branch, or
  no baseline on `push`. An event it cannot read is `Unresolvable` — never an empty diff.
- **The verdict.** `verdict.ts` seats every guard on the taxonomy above. The report goes to stderr
  with GitHub `::error` annotations beside it, and stdout stays empty on every refusal.

## The `handoff` group

Hand one session's work to the next when the two share no memory, no checkout and possibly no
machine. A **pack** is one comment on the work's issue carrying two halves: the four sections the
model wrote, and the ground state the verb derived. Contract:
[`skills/handoff/contract.md`](../../../claude-plugins/fabrika/skills/handoff/contract.md).

| Verb | Answers |
|---|---|
| `handoff capture` | the ground state — branch, head, reachability, tree, base, issue and PR state |
| `handoff take` | composes the pack from stdin plus a fresh capture, leak-scans it, posts it, reads it back |
| `handoff read` | the latest sealed pack, its two halves, and its drift field by field |
| `handoff claim` | claims that pack, keyed on the run nonce — `held` or `resumed` |

**Exit codes.** The shared table, plus `12` the work is unreachable by a successor and the loss was
not declared · `13` the issue carries no sealed pack · `14` a pack exists and does not parse, or
its digest disagrees with its fields · `15` another nonce holds the latest pack's claim. `10` is a
deliberate gap.

Four behaviours are worth knowing:

- **The caller cannot supply the proven half.** `take` derives it itself; the body arrives on stdin
  only, so a machine-local path has no route into a posted artifact.
- **The section set is closed.** A fifth heading, prose before the first heading, or text after the
  JSON fence is refused on the way in and on the way out — an artifact whose section set is open
  can steer its receiver past the artifact.
- **There is no way to read a pack without its drift.** `read` re-derives the ground against the
  **packed** branch, never the successor's `HEAD`.
- **Unreachable work refuses rather than warns.** An unpushed commit and a modified tracked file
  are invisible to a fresh checkout. `--declare-unreachable` records the loss instead of silencing
  it.

This group applies no label, closes nothing, opens no PR and pushes nothing. Nothing it records can
block a merge.

## The `heal-ci` group

The repair lane: take a stranded or red pull request and drive it toward green without a human
reading logs. A **strand** is a PR nobody is moving; a **signature** is the one row of a closed
table a failure log matches. Contract:
[`skills/heal-ci/contract.md`](../../../claude-plugins/fabrika/skills/heal-ci/contract.md).

| Verb | Answers |
|---|---|
| `heal-ci diagnose` | one PR's stall class from an ordered, total predicate chain, with its evidence |
| `heal-ci sweep` | every open PR classified with its strand age and its note arrow — the scheduled surface |
| `heal-ci surface` | declared required contexts against the runs that actually post at the head |
| `heal-ci logs` | the failed-job log text for **every** failing gating context at a head |
| `heal-ci classify` | pure: log text on stdin → one signature from a ten-row ordered table, default-deny |
| `heal-ci rerun` | the at-most-once transient rerun, precondition re-derived inside the verb |
| `heal-ci note` | the durable stop-path comment, suppressed once per `<pr>:<class>:<head>` |
| `heal-ci scratch` | the per-lane path a healer's note bodies go under |

**Exit codes.** The shared table, plus `12` the live head moved past the inspected `--sha` · `13` a
read completed and its scope is provably incomplete · `14` proven not in the state this write acts
on · `15` the run's logs are proven expired or purged · `16` the rerun provably landed and its
durable marker could not be written. `4` is a deliberate gap.

Six behaviours are worth knowing:

- **Every classification is an exit-`0` answer**, `red` and `wedged` and `not-open` included. A
  non-zero exit means the verb could not produce an answer at all.
- **The chain is ordered, and the order is the contract.** `check-surface` fires above `red`
  because a required context no run produces cannot be healed by a log classifier, and `attended`
  sits above every strand class because a PR whose author pushed two minutes ago is not abandoned.
- **`unprobeable` is not `no-requirements`.** The branch-protection endpoint answers `404` both
  when a branch is unprotected and when the token cannot see it, so `no-requirements` also needs a
  successful rules read that returned nothing.
- **`unclassified` is a third token, deliberately.** There is no path from ambiguous input to
  `transient`, and fusing the two would make it impossible to count how often the classifier is
  guessing.
- **`sweep` writes nothing.** It files no issue, assigns nobody and spawns nothing (ADR 0205): a
  detector emits claimable work and normal pull adopts it. Filing is `report file`'s, which is why
  `4` stays a deliberate gap here.
- **The note's arrow is a lookup, and `sweep` emits it.** Each row's sixth column is the lane the
  stall class hands the work to (`build`/`review`/`ship`/`author`/`human`/`nobody`), so the note's
  first line relays a lane instead of a caller deriving one in a `run:` block (ADR 0228).

## The `hook` group

The envelope Claude Code writes to a hook's stdin, read once here instead of in every hook. This is
the group [fabrika's hook surface](../../../claude-plugins/fabrika/hooks.json) declares against; the
surface's convention lives in
[`docs/hook-surface.md`](../../../claude-plugins/fabrika/docs/hook-surface.md).

| Verb | Answers |
|---|---|
| `hook check` | whether the envelope on stdin is one fabrika can act on |
| `hook codes` | the exit taxonomy every verb in the group allocates from |
| `hook worktree-create` | the absolute path of the provisioned worktree the envelope named |

**Exit codes.** `3` stdin held nothing · `12` bytes arrived and are provably not an envelope ·
`13` fd 0 could not be read · `14` a readable envelope arrived and is not the event this verb
judges. Three failure codes rather than one, so an unread pipe cannot pass for a bad payload.
`worktree-create` adds four proven refusals of its own: `15` the envelope names no creatable
worktree · `16` the base could not be fetched · `17` `git worktree add` failed · `18` the tree was
created and arrived dep-less.

- **The required fields are captured, not assumed.** They are the keys present in every real
  envelope committed at `src/hook/__fixtures__/`, with each capture's method and harness version
  beside it (ADR 0180). The golden test runs the argv it reads out of the committed declarations, so
  a green test cannot be exercising a verb no surface declares.
- **`hook worktree-create` is the one verb that writes.** It creates the `isolation: worktree` tree
  and prints the path the harness adopts, so every failure arm refuses and a refusal blocks the
  spawn — including the last one, which reds when `git worktree add` succeeded and
  `node_modules/.pnpm` is still absent. It is declared in phoenix's own `.claude/settings.json` and
  deliberately **not** in the plugin's `hooks.json`, because a plugin-declared provider preempts git
  worktree creation in every adopting repo (ADR 0337).
- **Its base never travels through `FETCH_HEAD`.** That name is one file in the shared `.git` dir and
  every parallel spawn fetches the same clone, so a sibling's fetch truncated it mid-read and the
  loser's spawn died on `fatal: invalid reference: FETCH_HEAD`. The fetch lands in a per-spawn ref
  under `refs/fabrika/worktree-base/`, which is resolved to a commit id and dropped before the slow
  `git worktree add` runs at that id ([#6081](https://github.com/kamp-us/phoenix/issues/6081)).
- **No verb here decides anything about a spawn.** `hook spawn` — the model-allowlist guard on
  `PreToolUse` — is retired, decision and declaration both (ADR
  [0331](../../../.decisions/0331-fabrika-spawn-hook-retired.md)). Model choice is a per-run human
  call; [`src/models.ts`](../src/models.ts) survives as the model vocabulary only, enforcing nothing.

## The `lane` group

The lane ledger the operator loop drives. A lane is a directory —
`.fabrika/lanes/<n>/workflow.json` plus an append-only `events.jsonl` — and **fold = state**: every
verb is a fresh process that re-folds the whole log through a
[@demlik/tea](https://github.com/kamp-us/demlik) Transitions machine. No resident process, no
snapshot. Lane state is local and never committed.

| Verb | Answers |
|---|---|
| `lane status` | the derived state: compound `stateValue`, active/done, per-task context, tripped tasks |
| `lane transition` | records one operator event after the machine accepts it |
| `lane report` | a shell's terminal token, mapped to one operator event |
| `lane prove` | whether the board agrees with a lane event, before it is recorded |
| `lane history` | the log verbatim, one `{task, event, at}` per event |
| `lane print` | the compiled topology: phases, terminals, and each state's legal events |
| `lane open` / `emit` | boot a lane from a committed template, or generate an epic's machine from its board topology — `open` refuses an epic at `46`, typed `type:epic` or carrying sub-issue links, since the coder template has one task; `emit` refuses a lane already on disk at `14` and names the two-step remedy, retire the directory then re-run |
| `lane brief` | the spawn prompt for one task's current leaf state |
| `lane assembly` / `push` | an epic run's assembly worktree, and its published branch |
| `lane integrate` | one reviewed child merged into that worktree, its dependencies reconciled from the merged lockfile, then judged by the repo's `codeValidators` — last stdout line on exit 0 is `INTEGRATE-VERDICT: MERGED`, the line above it the merged head; every refusal below the merge resets the branch to `ORIG_HEAD` and pushes nothing |
| `lane stale` | which lanes have gone quiet with something owed on them — offline, or `--claims` to pair each non-terminal lane with the claim standing on its issue |
| `lane claim` / `release` | who is driving this lane |

**Exit codes.** `4` the lane read in full and is not the shape · `7` the lane is absent · `8` the
append or claim write did not land · `9` a claim marker landed and does not read back · `11` the
lane could not be read · `12` the event is refused and the log is left unappended · `13` the task
is unknown or `--task` was omitted on a multi-task lane · `14` the lane directory already exists ·
`15` no readable `## Dependencies` topology · `16` the topology names a non-child · `17` the
topology holds a cycle · `18` the leaf state routes to no shell · `19` the task's issue could not
be resolved · `20` several open PRs claim the task's issue · `21` the lane key is malformed ·
`22`–`25` the proof `lane prove` needed is absent, in flight, contradicted or ambiguous · `26` the
tree is not on the run's assembly branch · `29` the push would not fast-forward · `30` the push ran
and the ref did not move · `31` this session does not hold the driver's claim · `32` the terminal
token is no shell's · `33` an assembly git write was aimed at the main working tree · `34` the
assembly branch tracks another ref and clearing that upstream did not take · `35` the `--cause` is
outside the closed park-cause set · `36` the `UNBLOCKED` would restore a state with no budget left
— read the refusal for which budget: retries want a recorded `CLEARED` (`build clear`), waits want
the grant on this same resume (`--grant-wait`, else `recipe unpark`) · `47` the `--grant-wait` is
not a whole grant of at least one wait, or rides on an event that is not `UNBLOCKED`
· `37` a booted lane's machine cannot be replaced by the template without moving the lane · `38`
the `--class` is outside the review classes · `39` the cwd is not in a repository · `40` another
writer held the lane's lock for the whole wait · `41` no working tree holds the run's assembly
branch · `42` the child conflicts and the merge was aborted · `43` the merged lockfile does not
install, or the install changed a tracked file · `44` the merged tree failed a code validator · `45`
the assembly worktree already held modified tracked files before the merge, so nothing was merged.

To open a lane, copy a template in and speak the operator's six events — `DONE` / `PASS` / `FAIL` /
`BLOCKED` / `WIP` / `UNBLOCKED`:

```bash
mkdir -p .fabrika/lanes/5673
cp packages/fabrika-cli/src/lane/templates/coder.workflow.json .fabrika/lanes/5673/workflow.json
fabrika lane transition 5673 WIP     # queued → build (--task is implied on a single-task lane)
fabrika lane status 5673
```

Three behaviours are worth knowing:

- **An invalid event refuses loudly and appends nothing.** An event the current state holds no cell
  for surfaces tea's own `NoCellError` verbatim at exit `12`, and `events.jsonl` is left
  byte-identical — where XState silently swallows an unhandled event, this machine names it.
- **The compiler recognizes shapes, never guard names.** An array on an event reads structurally as
  `[retry-while-retries-remain, else-fallthrough]`; a transition targeting a `history` node resumes
  the state the task left; a phase's `onDone` pair names the workflow terminals. `guard`/`actions`
  strings in `workflow.json` are inert data.
- **One committed template today.**
  [`src/lane/templates/coder.workflow.json`](../src/lane/templates/coder.workflow.json) is the
  single-issue coder machine: `queued → build → review → ship`, review `FAIL` retried on a budget
  of 2 then frozen, `BLOCKED`/`UNBLOCKED` suspend-resume from any working state, and ship `BLOCKED`
  parking in `human:cp-approval` until the approval lands as `UNBLOCKED`. A shipper that leaves the
  PR in the merge queue records `WIP` into `ship:queued`, which re-enters itself on a separate wait
  budget and escalates to `human:queue-stall` when that budget is spent — a park `recipe unpark`
  clears, granting the resumed lane one fresh read on the same event (ADR 0313).

## The `ledger` group

Author an epic's plan and its children — the write half of epic planning. Contract:
[`skills/plan-epic/contract.md`](../../../claude-plugins/fabrika/skills/plan-epic/contract.md).

| Verb | Answers |
|---|---|
| `ledger open` | the ground proved and the plan run opened for an epic |
| `ledger draft` | the plan block on stdin, validated and staged |
| `ledger child` | one child issue minted with every birth attribute at once |
| `ledger topology` | the declared topology validated, and its Dependencies block rendered |
| `ledger write` | the staged plan and topology spliced into the epic body |
| `ledger edges` | the epic's declared dependencies reconciled into GitHub's native blocked_by graph |
| `ledger supersede` | a child the re-plan no longer contains, retired |

**Exit codes.** The shared table and the `build` lane seats (`13`–`19`), plus `20` the ground moved
under the run · `21` the epic body moved — the recomputed digest differs from `--body-digest` ·
`22` the plan region is unresolvable — a duplicated anchor, or a mode the body contradicts ·
`23` the child was created and its sub-issue link could not be proven · `24` the declared topology
is invalid — a cycle, a dangling ref, or an unplaced child · `25` a document this verb must splice
was never staged in this run · `26` a child was created and the run manifest could not record it.

## The `map` group

Chart one destination's fog. The map is a GitHub issue carrying `wayfinding:map`; its frontier is
that issue's **sub-issues**, and the topology between them is GitHub's **native issue-dependency
edges**, never prose in a body. Contract:
[`skills/wayfinding/contract.md`](../../../claude-plugins/fabrika/skills/wayfinding/contract.md).

| Verb | Answers |
|---|---|
| `map open` | the map for a destination — minted or resumed, refusing one that is not fog |
| `map read` | the whole state: five sections, one row per frontier ticket, the frontier token, the digest |
| `map ticket` | one frontier ticket, filed and linked and edged and spliced onto the map, as one act |
| `map lane` | a research lane on one ticket, claimed under this run's nonce |
| `map finding` | a lane closed with an outcome from a closed set of three |
| `map fork` | where a question is being answered instead — a `grilling` session or a `spike` |
| `map record` | the lockstep: the answer under `## Decisions`, the row off the frontier, the ticket closed |
| `map descope` | a rejected direction appended to the never-graduating out-of-scope section |

**Exit codes.** The shared table, plus `12` the body moved since `--digest` was taken · `13` the
number names no frontier ticket · `14` an edge target is not a ticket of this map, or would close a
cycle · `15` the nonce does not hold this ticket's lane · `16` more than one open map matches ·
`17` no supplied line is stated as a question, so the destination is not fog · `18` the ticket
already left the frontier · `19` already descoped · `20` the ticket's kind does not admit this verb
· `21` the lane returned no answer. `10` is a deliberate gap.

Five behaviours are worth knowing:

- **A line's section is not its state.** State is resolved from the ticket's marker, its `state` on
  GitHub and its edges; the body rows are re-rendered from that answer
  ([`src/map/frontier.ts`](../src/map/frontier.ts)).
- **All four frontier tokens exit `0`.** `awaiting-founder`, `lanes-pending`, `clear` and `empty`
  are four answers; a frontier holding open questions is the skill working.
- **Every body write is a compare-and-set slice.** `--digest` guards the write and the write
  replaces one section's bytes, so a concurrent edit to another section survives.
- **Lane traffic goes to the ticket, never to the map body.** Only `map record` touches the body,
  so a parallel burndown sees one body write per *resolution* rather than one per lane event.
- **The lane key is the caller's run nonce**, eight lowercase hex, passed explicitly. A session id
  is shared across sibling subagents, so two lanes of one run would key onto one namespace.

A `404` on a dependency read is a verdict about the issue, not about its edges: every edge read is
preceded by an existence read, every list pages, and an empty read that cannot be *proven* empty is
`11`, never an empty frontier.

## The `pattern` group

Read and write the pattern library. A **pattern doc** is one flat `<slug>.md` under a doc directory
(`.patterns` by default), registered by one row in that directory's `index.md`. Contract:
[`skills/write-pattern/contract.md`](../../../claude-plugins/fabrika/skills/write-pattern/contract.md).

| Verb | Answers |
|---|---|
| `pattern corpus` | the library at a base ref: every doc, its registration, its section, its last-touching commit |
| `pattern drift` | whether the in-repo source a doc cites moved since the doc was last written |
| `pattern anchor` | whether the dependency version a doc declares still matches what the workspace pins |
| `pattern new` | scaffolds a current or prospective doc; optional local-source inspection emits portable grounding evidence |
| `pattern register` | inserts the doc's row into `<dir>/index.md` under a named section |

**Exit codes.** `8`–`11` from the shared table, plus `12` the named slug has no doc file · `13` the
target path already exists · `14` the edit would have changed a line beyond the one row, aborted
before writing · `15` the index is absent or holds no parseable table · `16` the named section
matches more than one heading · `17` a supplied source checkout cannot yield complete portable
evidence, so nothing is written.

Four behaviours are worth knowing:

- **Every outcome exits `0`, including the empty ones.** `corpus` answers `absent` for a directory
  that is not in the tree and `none` for one that holds nothing. Exit `7` is deliberately unseated:
  no verb here judges over a corpus, so none has a vacuous pass to prevent, and refusing on an
  empty library would leave a repo adopting fabrika unable to write its first doc.
- **`unanchored` is not a clearance.** It says the doc cites nothing the verb can follow, so drift
  is *unanswerable* — read the source by hand.
- **Registration is three-valued.** `unknown` — the index is absent, or holds no markdown table —
  is its own value. A doc counts as registered only when a table row's **first cell** links its
  filename; a mention in prose is not a registration.
- **An unresolved citation is counted, never a finding.** Pattern prose legitimately cites external
  dependency source trees, and such a path is indistinguishable from a deleted in-repo one by
  resolution alone.

`corpus`, `drift` and `anchor` read at a fetched `--base`; `new` and `register` write the **working
tree**, so a doc created by `new` is invisible to `corpus` until it is committed. `pattern new
--decision <url>` selects the prospective scaffold. `--source-repo <path>` validates a local Git
checkout and records only its canonical origin, full HEAD, relevant package/version and
repo-relative source/test/docs paths; use `--source-package` when a monorepo is ambiguous. The local
path never enters the scaffold or JSON evidence, and the derived package token also uses the
existing dependency anchor so pin bumps still demand re-verification.

## The `plan` group

Gate an epic's plan before its children build — the read-and-verdict half of epic planning, where
`ledger` is the write half. Contract:
[`skills/check-epic-plan/contract.md`](../../../claude-plugins/fabrika/skills/check-epic-plan/contract.md).

| Verb | Answers |
|---|---|
| `plan read` | the epic, its children and its parsed ledger |
| `plan check` | the deterministic floor over the fourteen hard defect types |
| `plan flip` | every planned child flipped to triaged, re-gated first |
| `plan verdict` | the plan gate's verdict, posted bound to the scope digest |

**Exit codes.** The shared table, plus `15` this session does not hold the claim · `20` the floor
found a hard defect · `21` the recomputed scope digest differs from the `--digest` the caller
carried · `22` at least one child is `unchanged` — the flip did not fully apply · `23` a label the
flip must write is absent from the repository's taxonomy.

## The `recipe` group

The standing driver recipes, versioned once instead of retyped nightly. A recipe is one
deterministic verb with named exits over a fixed sequence that has no judgment in it: it relays a
decision another verb already owns and never derives one (ADR
[0228](../../../.decisions/0228-scripts-relay-never-derive.md)). Every mutation is proven by a
read-back.

| Verb | Answers |
|---|---|
| `recipe unpark` | whether a parked lane's park is a known recipe, and on a known one clears it — and on the queue-stall row grants the waits that clear buys, on the same recorded event |
| `recipe rerun` | the failed workflow runs at a PR's live head, rerequested only behind a head-bound `governance` PASS |
| `recipe route` | which recipe a chore-lane state applies, and which of the six events one exit folds to |

**Exit codes.** `4` a record read in full is not the shape · `7` the target is absent · `8` the
fix's own write did not land · `9` the write landed and the read-back contradicts it · `11` a
precondition read failed · `12` the park's cause is outside the known-recipe set · `13` a known
recipe whose clearing condition is not met yet · `14` the task's leaf state is not a park · `15`
the task could not be resolved · `16`–`18` the `governance` verdict is absent, stale, or FAIL ·
`19` no run at the head concluded in failure · `20` the machine refused the `UNBLOCKED` · `21` the
rerun was requested and its outcome could not be re-read · `22` the state applies no recipe.

**Known clears, novel escalates, and both are exit codes.** `12` is nothing-written, route it to a
human; `13` is wait. `recipe route --exit` folds the first to `BLOCKED` and the second to `WIP`, so
how autonomous a chore drive is never depends on a caller's reading.

## The `report` group

File one follow-up observation into the intake queue. Contract:
[`skills/report/contract.md`](../../../claude-plugins/fabrika/skills/report/contract.md).

| Verb | Answers |
|---|---|
| `report dedup` | ranks the open issues that may already cover an observation — `candidates` / `none` / `indeterminate`, all three at exit 0 |
| `report file` | composes the intake issue from the six sections on stdin, guards it, creates it, and reads back what landed |
| `report note` | adds a note to an existing issue over the same guarded path, and reads the comment back |
| `report amend` | appends a dated amendment to an existing issue's **body** over that path, leaving the prior body verbatim above it, and reads the body back |

**Exit codes.** The shared table this group defines, plus `27` the intake queue could not be read ·
`28` the search index could not be read.

Six behaviours are worth knowing:

- **`dedup` ranks against more tokens than it searches with.** Scoring gets sharper with every token
  and GitHub's AND-joined search gets narrower, so ranking receives up to 12 and the search query
  receives only the leading 4. Twelve AND-joined terms matched nothing on essentially every real
  call, which made `none` a negative resting on one source. The stderr scope line and `--json`'s
  `searchTokens` both name the narrower list whenever it differs.
- **The body is a value, never a path.** The three writing verbs take it on **stdin only** — no
  `--body`, no `--body-file`. A flag that accepts a path turns the body into a string the verb
  could post verbatim. A shell redirect is fine: the *shell* reads the file.
- **An empty stdin is a refusal, not an empty body.** A read that failed exits `1` (the body is
  UNKNOWN) and a pipe read that held nothing exits `3` (a proven refusal).
- **A missing `--label` is a refusal on `dedup` too, not a `none`.** `GET /issues?labels=…` answers
  HTTP 200 with `[]` for a label that does not exist, so an unchecked `dedup` would print a proven
  negative over a scope of zero. Both reading and writing verbs check the label first and exit `7`.
- **The write is not finished until it is read back.** A create call's own response is the server
  echoing the request; exit `9` is the landed artifact failing to match what was composed.
- **A body is amended, never replaced.** GitHub keeps no issue-body history, so `report amend`
  appends under a separator and a dated heading it composes itself, and its read-back proves both
  halves — the amendment landed *and* the prior body survived.

Intake applies **no type and no priority**, defended mechanically: exit `10` refuses a `--label` or
a title prefix that resolves to the target repo's own type/priority vocabulary.

## The `review` group

Everything a text review needs off one pull request, plus the one sanctioned way to write a verdict
back. Contract:
[`skills/review/contract.md`](../../../claude-plugins/fabrika/skills/review/contract.md).

| Verb | Answers |
|---|---|
| `review scope` | head SHA, linked issue, the code / doc / skill partition of the changed files, and the `self` / `harness` flags |
| `review diff` | the diff bytes at the bound commit, with truncation refused rather than passed through |
| `review criteria` | the linked issue's acceptance-criteria block, through the registered wire format |
| `review ci` | the live check-run rollup at a head, fail-closed on incomplete enumeration; `--wait` bounds a `pending` one in-verb and prefixes `settle\t<settled\|budget-exhausted\|head-moved>` |
| `review verdicts` | every verdict marker on the PR, each with its `current` / `stale` / `unbindable` binding |
| `review deviations` | the PR body's `## Deviations` state, its entries, and the Tier-M token scan |
| `review post` | the single sanctioned verdict emit — compose, bind, one comment per namespace, read back |
| `review append-criterion` | one reviewer-authored criterion appended under ADR 0079's four fences |
| `review scratch` | the per-lane directory a reviewer's staged files go under — `<temp root>/fabrika-review/<session-id>/<pr>-<lane-nonce>/<slug>` |

**Exit codes.** The shared table, plus `12` the live head moved past the inspected `--sha` · `13`
the read completed and its scope is provably incomplete · `14` the invoking token is below `write`,
or the ACL lookup failed (ADR 0055) · `15` the write is not provably the prior rows plus one — the
append-only fence. `4` is a deliberate gap.

- **A check that cannot see what it is looking for does not return a plausible value.** An
  unreadable response, a provably short read and a non-conforming payload each resolve to their own
  refusal — `11`, `13` and `7` — and never to a clean pass.
- **The overlapping exit codes are imported, not restated**, so they cannot drift from the shipped
  values.
- **`current` / `stale` / `unbindable` stay three outcomes.** Folding any two together is how a
  stale PASS reads as a current one.
- **Four modules are imported rather than re-derived**: the AC parser, the verdict-marker parser,
  `normalizeForReadback`, and the machine-local-path predicate.
- **Every guard is demonstrated failing.**
  [`src/review/mutation.unit.test.ts`](../src/review/mutation.unit.test.ts) plants a counterexample
  per guard, breaks exactly that guard, and asserts the verb returns the specific wrong answer.
- **`scratch`'s nonce is derived, not claimed.** This group ships no claim verb, so there is no
  token to key on: the nonce is twelve hex of `sha256(--lane, --sha)` — `--lane` separating two
  reviewers of one session, `--sha` separating two rounds of one lane. Both are required, and a
  blank `--lane` refuses rather than degrading to the session-wide directory two reviewers share
  (#7246).

## The `review-ui` group

Judge a UI pull request over its preview deployment. Contract:
[`skills/review-ui/contract.md`](../../../claude-plugins/fabrika/skills/review-ui/contract.md).

| Verb | Answers |
|---|---|
| `review-ui render` | the named surfaces captured from a PR's preview deployment — a route, or a route plus a realized state (`/pano:auth` renders signed in as the test moderator, refusing on `11` unless the session proves it took). `--flag <key>=<on\|off>` forces a dark-shipped flag for the run, refusing on `10` unless every surface is `:auth` and on `11` unless the preview's own evaluation says the key took |
| `review-ui post` | the `review-ui` verdict on stdin, posted as one comment |
| `review-ui note` | a typed blocker note when the surfaces cannot be seen |
| `review-ui route` | a head-bound `routed-elsewhere` record: this PR renders nothing, so no verdict is owed |

**Exit codes.** The shared table (with `4` a required file that does not parse or violates its
schema), plus `12` the artifact is not the PR's current tree · `13` a surface threw an uncaught
page error · `14` a surface is unreachable — status ≥ 400 or a failed navigation · `15` a capture
was produced and is invalid — zero bytes, undecodable, or zero area · `16` no preview deployment
exists for this PR, the skill's CANT-SEE route · `17` an evidence upload or its verification
failed, with **nothing posted**.

## The `ship` group

Everything the merge path needs off one pull request, plus the writes that arm, watch, disarm and
record it. Contract:
[`skills/ship/contract.md`](../../../claude-plugins/fabrika/skills/ship/contract.md).

| Verb | Answers |
|---|---|
| `ship scope` | head, lifecycle state, linked issue, artifact classes with their required namespaces, and the three-state §CP classification |
| `ship cp-approval` | the ADR 0175 cardinality discharge — `discharge` / `stop` / `n/a`, from head-bound signals only |
| `ship gate` | the verdict conjunction over every required namespace |
| `ship floor` | whether a governance-root diff carries its head-bound `governance` verdict |
| `ship checks` | the head CI rollup, with the running-vs-wedged split, the zero-checkset facts, and the gate-coverage floor under `green` |
| `ship evidence` | the SHA-bound run-evidence bundle as `present` / `pending` / `failed` / `absent` / `unknown`, with the manifest's checks collapsed to a status tally |
| `ship threads` | every unresolved review thread, both pagination layers count-proved |
| `ship resolve` | the sanctioned thread-resolution write, refusing any thread not positively bot-classed |
| `ship enqueue` | the queue arm at a pinned head, method-flag-free by construction, proven landed, refusing a provably not-mergeable PR before the arm |
| `ship merge` | the landing on a base no merge queue governs, proof read back |
| `ship reconcile` | the bounded post-enqueue watch — `landed` / `ejected` / `unresolved` / `parked` |
| `ship disarm` | the four-site merge-intent lifecycle (ADR 0198), read-back-verified |
| `ship nudge` | the at-most-once dropped-trigger remedy, precondition re-derived here |
| `ship note` | the durable stop-path comment, leak-scanned and read back |
| `ship release` | dark-ship detection and the `status:awaiting-release` label |

**Exit codes.** The shared table, plus `12` the live head moved past the inspected `--sha` · `13` a
read completed and its scope is provably incomplete · `16` proven not in the state this write acts
on, nothing mutated · `17` the nudge's close landed and its reopen is unconfirmed — the PR may be
left closed · `18` a governance-root diff has no head-bound `governance` PASS · `19` the repository
permits no merge method at all · `23` a label this run would POST is absent from the taxonomy.
`4` is a deliberate gap.

- **The §CP boundary is derived from `.github/CODEOWNERS` itself**, read at the base branch, so this
  group and the merge gate read one artifact and cannot disagree. A *trivial* boundary — no
  team-owned rows, or a row covering everything — is a printed hold, never a match-everything
  verdict; an *unreadable* one is `11`.
- **Three modules are extended rather than forked**: the class map and the check-run rollup are the
  `review` group's own, and `normalizeForReadback` and the leak predicate come from `report`. Ship
  and review cannot disagree about what a file is.
- **`17` is the loud one.** It says the nudge's close landed and its reopen is unconfirmed, a state
  so much worse than a failed write that folding it into `8` would hide the one fact an operator
  must act on now.
- **GraphQL is a three-item carve** (ADR 0315): review-thread state and its mutations (`threads`,
  `resolve`), the auto-merge mutation, and the closing-issue edge `lane`/`recipe` read. Everything
  else is a REST read, paginated, and it carries the proof its endpoint declares — an envelope read
  a `total_count` beside what arrived, a bare-array read the `Link` header's exhaustion. Both come
  back with `exhausted`, and a walk that stopped at the 50-page cap is a refusal, never a short list.

## The `spend` group

What one fabrika run cost, in tokens, read from its transcript. `billed` is *specified* by ADR 0112
§2, not chosen, so the implementation is held to that ruler by a committed transcript fixture the
unit tier asserts against ([`src/spend/token-spend.ts`](../src/spend/token-spend.ts)).

| Verb | Answers |
|---|---|
| `spend read` | one run's billed token spend, its four `usage` components, the ex-cache-read comparator, its billed turn count and its model |
| `spend rollup` | what **all** of fabrika's recorded runs cost, summed out of the durable ledger and broken down by day, by skill and by stage-and-arm |

**Exit codes.** `7` the input is proven absent · `11` the input could not be read, or its absence
could not be established · `12` the input was read in full and carries nothing to measure · `13`
the ledger holds rows and this window selects none.

Three behaviours are worth knowing:

- **The cache-read share stays its own number.** It dominates `billed` and grows with turn count,
  which makes it the context-bloat signal; folding it into one total hides what the measurement
  exists to show.
- **"I could not measure it" is never a zero.** `12` is a real transcript a failed run writes, and
  reporting it as a measured zero would price a broken run as a free one.
- **It cannot gate.** No threshold, no budget flag, and no exit code that varies with a spend
  magnitude — asserted by a test that a very large total still exits `0`.

### The spend ledger

`spend read` prices one transcript on demand; the ledger is where measured runs survive. A producer
appends one **JSON Lines** row per completed run to `.fabrika/spend-ledger.jsonl` (repo-relative,
gitignored, `--spend-ledger` overrides it). **There is no in-repo producer today**, so `spend
rollup` reads whatever an operator or a future producer wrote and reports an empty ledger
otherwise. The core is [`src/spend/ledger.ts`](../src/spend/ledger.ts): `readSpendLedger` reads back
the well-formed rows **and the count of lines it skipped**, so a truncated tail costs one line
rather than the file. Every line stamps its own `v`.

```bash
fabrika spend rollup                                    # everything recorded so far
fabrika spend rollup --since 2026-08-01 --until 2026-08-09
fabrika spend rollup --json
```

`--since`/`--until` are **inclusive at both edges**, and a bare `YYYY-MM-DD` widens to that whole
UTC day. stdout is one record per line, the first field naming the kind:

```
billed        <n>          exCacheRead <n>   assistantTurns <n>
runs          <n>          measuredRuns <n>
skipped       <n>          skippedMalformed <n>   skippedNewerVersion <n>
undatedRows   <n>
day        <YYYY-MM-DD>        <billed> <exCacheRead> <assistantTurns> <runs> <measuredRuns>
dayMore       <n>
skill      <name>              …
skillMore     <n>
stage-arm  <stage> <arm>       …
stageArmMore  <n>
```

Three things about that output are load-bearing:

- **Every number it could not count is a number it reports.** The unread-line counts ride on the
  answer itself, not just on stderr, because a total that quietly omits 40 unreadable lines is
  wrong and looks whole. `undatedRows` is the same rule for a bounded window.
- **The skipped count is split, because the halves ask for opposite things.** `skippedMalformed` is
  damage — those measurements are gone. `skippedNewerVersion` is intact data written by a newer row
  shape, and the fix is to upgrade this CLI.
- **The three breakdowns are bounded evidence, not the whole row set** (ADR 0308). Each prints its
  ten biggest-billing rows and then a `…More` count of the rows the cap dropped — `0` included, so a
  missing remainder never looks like a breakdown that fit. The scalar totals above them are whole.
  `--json` carries the same shape: `byDay`, `bySkill` and `byStageArm` are each `{rows, more}`.

## The `spike` group

Settle one empirical question by building a throwaway. A **spike** is one GitHub issue carrying
`prototyping:spike`, bound to a workspace under the OS temp root — **never inside the repository** —
and keyed on a per-run nonce. Contract:
[`skills/prototyping/contract.md`](../../../claude-plugins/fabrika/skills/prototyping/contract.md).

| Verb | Answers |
|---|---|
| `spike open` | mints the spike issue and this run's workspace, and binds the two in a manifest |
| `spike run` | executes one command in the workspace and appends an immutable evidence record |
| `spike capture` | posts the decision plus the log's own run table, reads it back, and closes the spike |
| `spike dispose` | proves the tree is unchanged and the capture still covers the log, removes the workspace, and proves it is gone |
| `spike status` | one run's spike state, workspace presence and evidence count |

**Exit codes.** The shared table (with `11` covering a failed read *or* execution), plus `12` no
workspace for this nonce · `13` the resolved workspace path is inside the working tree, refused
before any write · `14` the evidence log holds zero runs · `15` disposal asked on an uncaptured
spike · `16` the workspace was removed and is still present on re-probe · `17` the working tree
does not match what `spike open` recorded · `18` this nonce's workspace belongs to different work ·
`19` the capture author is below `write` (ADR 0055) · `20` the issue landed and its manifest could
not be completed · `21` the log moved after the decision was captured.

Four behaviours are worth knowing:

- **"Ran and answered no" and "could not run" are opposite answers.** `spike run` exits `0`
  whatever the command returned — the command's own status rides in the payload as `commandExit` —
  and exits `11` only when the command could not be executed at all.
- **The key is a per-run nonce, minted from a cryptographic source.** No verb reads a session
  variable and no verb asks a caller to invent a value, so two concurrent spikes cannot collide.
- **Disposability is a property, not an intention.** `spike open` records a digest of
  `git status --porcelain=v1 --untracked-files=all --ignored=matching`, and `spike dispose`
  recomputes it *before* it removes or posts anything. `--ignored=matching` is load-bearing: a
  build cache or a `node_modules/` is exactly where a prototype writes.
- **A decision with no recorded run is a self-report.** `spike capture` reds on a log holding zero
  runs, and the comment it posts transcribes each run's command and status.

`spike status` is near-total on purpose: its consumer is a session resuming cold, so an absent
workspace is a fact at exit `0` while the same absence is a refusal in the mutating verbs.

## The `status` group

What state the factory is in — the verbs the
[front door](../../../claude-plugins/fabrika/skills/front-door/SKILL.md) drives. Contract:
[`skills/front-door/contract.md`](../../../claude-plugins/fabrika/skills/front-door/contract.md).

```
status open                       # the composite five-field readout the skill injects
status settings                   # every config key, its resolved value and where that came from
status menu                       # the landed skill roster, derived from the skills tree
status readout                    # the landed-decision digest, as published
status board                      # counts of the board's decided buckets
status bootstrap readout-artifact # create one missing surface, then read it back
```

**Exit codes.** The shared table (with `7` an **explicitly passed** `--skills-dir` proven absent),
plus `12` the named surface is not in `status bootstrap`'s buildable-surface registry. `4` is a
deliberate gap.

Three things are load-bearing:

- **The three-state law.** Every field, row and bucket is a live value, a **proven negative**
  (`empty` / `absent` / `missing` / `unprobeable` / `malformed`), or **`unknown`** with its reason —
  and the third never renders as the second. An absent label is `unknown`, never `0`.
- **`status open` is total.** It is injected before a session reads a token, and `refuse()`
  hardcodes empty stdout — so a refusal would leave the front door silent on exactly the cold start
  it exists for. Every source it cannot read becomes a field state; its one refusal seat is a bad
  `--field`. It composes by **importing** the sibling cores, never by spawning a verb. The `lanes`
  field renders the `lane stale` sweep at that verb's 60-minute threshold, so a dead operator's
  silent lane surfaces on every cold session. It reports; it never resumes.
- **`7` and `11` are the pair.** An *implicitly* resolved roster holding zero skills is neither —
  it is `empty` at exit `0`.

The roster resolves in six tiers — an explicit `--skills-dir`, `$CLAUDE_PLUGIN_ROOT`'s skills tree,
a plugin tree the CLI itself sits inside, `claude-plugins/fabrika/skills` in-repo, that same path in
the checkout the CLI runs from, then the installed fabrika plugin in Claude Code's plugin cache —
and prints which one served. The cache rung is what answers the marketplace shape, where the plugin
and the globally-installed CLI share no path at all; it sits last so a phoenix checkout keeps
reading its own working tree.

## The `triage` group

Take one intake-queue issue from arrival to triaged. Contract:
[`skills/triage/contract.md`](../../../claude-plugins/fabrika/skills/triage/contract.md).

| Verb | Answers |
|---|---|
| `triage codes` | the exit taxonomy every verb in the group allocates from |
| `triage queue` | the claimable intake queue, oldest first |
| `triage claim` | one lane's claim on one issue |
| `triage provenance` | whether an issue was reported by an agent or a human |
| `triage homes` | the assignable homes: open milestones and standing lanes |
| `triage split` | one child of a bundled report, created exactly once |
| `triage enrich` | an issue body replaced with the rewrite on stdin, refused when it states an unwired ordering |
| `triage apply` | type, priority, audience, status, home and `--blocked-by` edges stamped as one owned-facet reconcile, read back |
| `triage park` | an issue demoted to needs-info with the questions on stdin |
| `triage kill` | an agent-filed issue — or any issue folded into a survivor with `--duplicate-of` — closed not-planned, with a reason |
| `triage repair-criteria` | an acceptance-criteria block's shape repaired mechanically |
| `triage scratch` | the per-lane directory a triager's working files go under |

**Exit codes.** The shared table, plus `12` the issue is human-filed and no `--duplicate-of` fold
was named · `13` close-eligible, but the kill is unconfirmed (ADR 0159) · `14` the criteria block is
drifted in a way no mechanical repair covers · `15` the composed body's authored region carries a
`Malformed` criteria block · `16` `--ready-for agent` over a body whose criteria block does not
read `Found` · `17` a live claim marker names another session · `18` no value of `.fabrika.jsonc`
may be used · `19` the asking lane holds no live claim on the target · `20` the composed body states
an ordering the live `blocked_by` graph carries no edge for · `21` a `--blocked-by` target is a pull
request. `4` is a deliberate gap.

**`triage apply --blocked-by` is the one triage route to the dependency graph.** ADR 0301 makes the
native `blocked_by` graph the one carrier of "do not start this yet", and until this flag only
`map ticket` could write an edge — so an ordered slice set shipped its ordering as prose and both
build gates admitted work nobody could start (#6728). The flag is repeatable, resolves each target's
internal `id` (never the issue number the POST would silently misread), skips the edges already live
so a re-run is idempotent, and proves the result by re-reading the graph rather than by trusting the
POST. Its last column reports what *that run* read back, so it is empty on any call without the flag
— an empty column is never "the issue waits on nothing". A target that is a pull request refuses on
`21`, because ADR 0301 names a blocking PR by the issue its merge closes. `triage enrich` is the
other half: it refuses on `20` when the body it composed states an ordering the graph has no edge
for, with no override — wire the edge or reword. It reds only on the issue's own voice and only on
issue references; a third-person report ("it is already blocked on #N") and a PR number are neither.

Two repairs are worth spelling out, because they are what `repair-criteria` will and will not do.
It rewrites a level-drifted `## Acceptance criteria` heading to the conforming `###`, and, when the
block carries no checkbox at all, rewrites its list items to unchecked checkboxes with each item's
text byte-for-byte unchanged. `--sweep` runs it over every open issue; `--dry-run` plans everything
and writes nothing. Every repaired body gets one disclosure comment naming its repairs, because
GitHub keeps no history of an in-place body edit. Anything that is not a pure shape rewrite is
refused on `14`, never guessed.

Three properties of the substrate are worth knowing:

- **Every verb in the group allocates from one table**
  ([`src/triage/codes.ts`](../src/triage/codes.ts)), and where it overlaps the two `report` writing
  verbs the meanings match **code for code**, so a caller driving both groups in one sweep reads
  one meaning. A check over every verb file keeps a verb from seating its own numerals unseen.
- **`4` is a deliberate gap.** It once fused "the target issue is proven absent" with "the target
  issue could not be read". `7` and `11` took the halves, and the slot is left unallocated rather
  than compacted — a gap is cheaper than a collision.
- **Every list read pages and reports its scanned count** on stderr
  ([`src/triage/scope.ts`](../src/triage/scope.ts)). Printing what was scanned is what makes the
  reach checkable from outside the process.

`--ready-for agent` additionally asserts the issue's live body carries a criteria block the wire
reader answers `Found` on, refusing on `16` before any label is written. `--type epic` is exempt
(its criteria arrive per child from the plan ledger) and `--ready-for human` is unaffected.

## The `ui` group

What the visual modality adds to a construction lane — the verbs
[`build-ui`](../../../claude-plugins/fabrika/skills/build-ui/SKILL.md) drives. The lane mechanics are
the `build` group's, reused as-is. Contract:
[`skills/build-ui/contract.md`](../../../claude-plugins/fabrika/skills/build-ui/contract.md).

```
ui manifest                                   # the repo's design surfaces, by convention
ui law                                        # the typed prohibition registry, schema-validated
ui render --out after --surface /pano         # render + capture one validated PNG per surface
ui golden --surface /pano [--candidate <png>] # resolve the blessed golden, diff a candidate
ui evidence --pr 4318 --before before --after after   # upload, verify, post, read back
```

**Exit codes.** The shared table, plus `12` no design manifest at the convention path — the repo is
un-bootstrapped · `13` the manifest exists and no typed prohibition registry does — the law is
untyped · `14` a surface rendered with an uncaught page error · `15` a surface is unreachable ·
`16` a capture was produced and is invalid · `17` an evidence upload failed, nothing posted · `18`
this session does not hold the claim the checked-out lane branch names · `19` no render harness is
declared. `3` is a deliberate gap.

Four things are load-bearing:

- **A verb's ceiling is the golden diff.** No `ui` verb emits a PASS/FAIL token, a composition
  score, or any judgement over pixels — the rendered-surface verdict is `review-ui`'s gate. `ui
  golden` measures; it never decides.
- **Everything the group reads is a convention path in the repo it runs in** —
  `design-system-manifest.md`, `design-prohibitions.json`, `design-harness.json`,
  `packages/design-capture/golden-pointer.json` — never a hardcoded URL. That is what makes the
  group portable.
- **The headless browser is provisioned by installing the package.** `postinstall` runs
  [`scripts/provision-browser.mjs`](../scripts/provision-browser.mjs), so no operator ever runs a
  browser-install step by hand. It is best-effort and never fails the install; it skips when the
  browser is already there, when `PLAYWRIGHT_BROWSERS_PATH` names a managed install, when `CI` is
  set, or on `FABRIKA_SKIP_BROWSER_PROVISION=1`. A run that then finds no browser exits `11`
  **carrying the exact remediation command**.
- **Absence is answered three ways, never one.** `12`, `13` and `11` are different facts, and the
  skill's prose fallback is legal only in the middle case.

`ui render` and `ui evidence` both guard the lane precondition; `ui manifest`, `ui law` and `ui
golden` are pure reads and take none. Evidence is all-or-nothing: one failed upload or verification
is `17` with **nothing posted**.

## The `wire` group

A **wire format** is the byte-level agreement two skills meet through on a GitHub artifact — the
acceptance-criteria block on a sub-issue body, the verdict marker on a PR, the handoff pack one
session leaves the next. Each is owned by a typed schema module under [`src/wire/`](../src/wire/)
with an `emit` and a `read`, registered as one row in
[`src/wire/registry.ts`](../src/wire/registry.ts). The formats used to live as prose in a skill
body, which is why fabrika could not pin one.

| Verb | Answers |
|---|---|
| `wire formats` | the registered formats, derived from the registry — key, purpose, producers, consumers |
| `wire codes` | the exit taxonomy every verb in the group allocates from |
| `wire emit` | the format's bytes, composed from the fields on stdin |
| `wire read` | the format's fields, read out of the artifact on stdin |
| `wire check` | whether the artifact on stdin carries a conforming block, without the fields |
| `wire doc-section` | one markdown section of the document on stdin (or `--file`), by ATX heading |
| `wire index` | whether the index doc agrees with the registry — and, with `--write`, the doc's table rendered from it |

**Exit codes.** This group seats its own table, deliberately not the shared one: `3` the block is
proven absent · `4` the block is present and does not conform · `5` stdin was read and held nothing
· `6` fd 0 carried nothing readable, or the read failed · `7` `--format` names no registered
format, or the registry holds no rows · `8` the fields on stdin hold nothing this format can
compose from.

Five behaviours are worth knowing:

- **`read` is total, and `found` is its only positive answer.** The return type is
  `Found | Absent | Malformed`, with `Found` carrying a non-empty list by construction. A heading
  that drifted is `Malformed`, never a `Found` holding nothing — the prose-owned era's failure was
  not a crash, it was a *plausible* empty answer a grader read as a pass over nothing.
- **Absent, malformed and never-seen are three different exit codes.** `3` is a proven negative
  over an artifact read in full; `4` is a proven defect; `6` means nothing is proven at all.
- **The artifact arrives on stdin only.** No `--body`, no `--body-file` — a flag that accepts a
  path turns the artifact into a string the verb could echo onto a public surface.
- **A `found` verdict marker is well-formed, not current.** Whether a marker binds the head you
  hold is [`verdict-marker.ts`](../src/wire/verdict-marker.ts)'s `bindToHead` — `Current` / `Stale`
  / `Unbindable`, because a head the caller could not resolve is not a comparison anyone made.
- **A registered format is a conforming format.** A registry row carries the fixtures its laws are
  driven from and the brands its value is built from, both required by the row type, so
  [`conformance.ts`](../src/wire/conformance.ts) holds every row to the same laws without naming it.

The per-format table in `claude-plugins/fabrika/docs/wire-formats.md` is rendered from the registry
by `wire index --write` and reconciled by `wire index`, which reds on a registered format with no
section, a section for no registered format, and a stale region. The protocol narrative under each
heading stays hand-written.

```bash
printf 'the read is total\n[x] the registry is the seam\n' \
  | node src/bin.ts wire emit --format acceptance-criteria \
  | node src/bin.ts wire check --format acceptance-criteria
```

## The capture machinery

Not a verb group — a **library subpath**, `@kampus/fabrika-cli/capture`. It is the screenshot /
render / golden-diff machinery `build-ui` and `review-ui` drive: shoot a surface over a preview or
a local build, store and resolve a blessed golden, and diff rendered-vs-golden. Its own docs are
[`src/capture/README.md`](../src/capture/README.md).

```ts
import {captureAndUpload, diffRasters, loadGoldenPointer} from "@kampus/fabrika-cli/capture";
```

**The repo-specific data is not here**: golden bytes live in the consuming repo's asset store and
the pointer naming them stays in that repo
([ADR 0183](../../../.decisions/0183-golden-screen-storage-depo-git-pointer.md)). This package ships
the machine, never a repo's goldens.

Three consequences worth knowing before you install it:

- **`@playwright/test` is a hard dependency**, inherited from the machinery, so a fabrika install
  pulls it in even for a caller that never captures. The browser binary rides the install too — see
  [the `ui` group](#the-ui-group)'s provisioning note.
- **Storing golden bytes is an injected `StoreLeg`, not a dependency.** Anything naming a host or a
  credential stays with the consuming repo. That is also what keeps the package installable: a
  published artifact may depend only on what a clean registry resolves (ADR
  [0201](../../../.decisions/0201-pipeline-tenant-phoenix-first.md) §3).
- **The adopter-facing surface is the `ui` verb group** — see [the `ui` group](#the-ui-group).

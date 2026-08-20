# `/ship` — derived CLI contract

**Skill:** [`ship`](SKILL.md) · **Authoring brief:** [#4709](https://github.com/kamp-us/phoenix/issues/4709) · **Date:** 2026-08-08

These verbs live in `packages/fabrika-cli/`, binary `fabrika`, grouped under a `ship`
subcommand, beside the `adr`, `report`, `review`, `triage` and `wire` groups already
implemented there. (The skill directory and the CLI group are both `ship`, so every
invocation reads as a sentence — `fabrika ship enqueue`. One skill, one group; the mapping is
stated here once.) The [CLI interface convention](../../docs/cli-interface-convention.md)
governs them; where this spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill**
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Every verb
below is implemented from scratch. v1's ship-it (2077 lines, 21 scripts) and the fourteen
`pipeline-cli` tools it drives were read for their semantics and their scars — each Grounding
section names what the v1 counterpart gets wrong and what this spec does instead — but no clause
defers to one, and none is invoked.

**Substrate.** Effect CLI verbs on the `@effect/platform-node` seam the sibling groups use.
GitHub access through the `gh api` REST shape — with **two sanctioned carves**, both stated
because the REST-only rule needs its boundary written down, and neither widening past the verbs
named here.

1. **The GraphQL exception — `ship threads` and `ship resolve`, and no other verb.** Review-thread
   resolution state (`reviewThreads.isResolved`) and the `resolveReviewThread` mutation have no
   REST equivalent, and the org's GraphQL breakage is live-verified Projects-scoped, not blanket.
   Exactly two verbs issue a GraphQL request; every other verb is REST.
2. **The auto-merge porcelain carve — `ship enqueue` and `ship disarm`, and no other verb.**
   Enabling and disabling auto-merge have **no REST surface at all**, so both go through `gh`'s own
   `gh pr merge --auto` / `--disable-auto` porcelain ([ruled on
   #5067](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953)). Without this
   carve the Substrate clause forbade the only way `ship enqueue` can do the arming the same
   contract requires of it. It is named as a **porcelain** carve, not a second GraphQL exception:
   this spec issues no auto-merge GraphQL mutation of its own, and the carve does not license one.

Named because a spec that leaves the substrate open makes the implementer guess (#4734).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `ship scope` | one PR's state, head, linked issue, class set with required namespaces, and §CP three-state classification | path partition against single-sourced maps, count-checked reads, and closing-keyword resolution are mechanical; what each state means for the run is judgment |
| `ship cp-approval` | the ADR 0175 cardinality discharge: `discharge` / `stop` / `n/a` from head-bound signals only | the roster-cardinality case split and head-binding are a transcription of a ruled table; nothing in it is judgment (#2435 is what judgment did) |
| `ship gate` | the verdict conjunction: every required namespace's in-force, current-head verdict, §CP advisory resolution and native-review fold included | in-force resolution (write-stamp ordering, staleness, authorization) is mechanical; what to do with `blocked` is judgment |
| `ship floor` | whether the governance floor binds on this diff and is discharged at this head — `n/a` / `satisfied` / a refusal CI reds on | asking `ship gate` for the one `governance` namespace and seating the answer on an exit code is mechanical; nothing about the verdict itself is decided here |
| `ship checks` | the head CI rollup — green/red/pending with the running/wedged split and the zero-checkset facts; `--wait` adds the bounded settle poll | latest-per-context dedupe, status vocabulary, and a budgeted poll are mechanical; the wedge remedy is a human's |
| `ship evidence` | the SHA-bound run-evidence bundle read as five states: present / pending / failed / absent / unknown | the lookup chain and the positive-evidence rules for each state are mechanical; none of it is judgment |
| `ship threads` | every unresolved review thread, fully paginated, with per-thread class facts | pagination, count proof, and author-type classification are mechanical; nit-vs-substantive is THE retained judgment and never enters this verb |
| `ship resolve` | the sanctioned thread-resolution write: rationale reply, resolve mutation, read-back — refusing any thread not positively bot-classed | the protocol and the bot-only structural anchor are mechanical; deciding a bot thread is a nit is the skill's |
| `ship enqueue` | arm the queue's auto-merge at a pinned head, method-flag-free by construction, and prove the arm landed | the arm, its error discrimination, and the entry read are mechanical; whether the PR should ship was settled by the gates |
| `ship merge` | the second landing path: land directly on a base branch no merge queue governs, with the method read off the repository, and prove the landing | reading the regime, picking a permitted method and proving `merged` + the merge commit are mechanical; whether the PR should ship was settled by the gates |
| `ship reconcile` | the bounded post-enqueue watch: `landed` / `ejected` / `unresolved` / `parked`, each a proven answer at exit 0 | multi-signal terminal classification against timeline + base-branch evidence is mechanical; what ejection means for the lane is judgment |
| `ship disarm` | the four-site merge-intent lifecycle (ADR 0198): `kept` / `disarmed`, read-back-verified | the site policy table and the verified write are mechanical |
| `ship nudge` | the at-most-once dropped-trigger remedy: re-derive the zero-runs state, close→reopen, verify both legs | the precondition re-derivation and the guarded PATCH pair are mechanical; the verb refuses rather than trusting its dispatch (#4816) |
| `ship note` | the durable stop-path comment: stdin body, leak-scanned, read back | posting with the sibling groups' write protocol is mechanical; what the note says is the skill's |
| `ship release` | dark-ship detection and the `status:awaiting-release` label, read-back-verified | the three ground-truth signals and the label write are mechanical; the flip is a human's (ADR 0083) |

### Considered and deliberately not derived

Each is a real proposal someone could make again. (Conventions §7 homes these in a plugin-root
`.out-of-scope/`, which no fabrika skill has bootstrapped yet; until it exists they live
inline, the same tracked debt the sibling contracts carry.)

- **A second answer to any CI-enforced question.** `ci-required` is the always-on required
  status context (`.github/workflows/ci.yml`, the merge queue awaits it on the `merge_group`
  ref); `codeowners-cp.yml` gates the §CP-boundary↔CODEOWNERS drift;
  `unresolved-threads-guard.yml` gates thread *accounting* against the review verdict;
  `leak-guard.yml` and `gitleaks.yml` gate landed content. A fabrika copy of any of these could
  only agree redundantly or contradict an enforced verdict (ADR 0238). `ship checks` reads
  those gates' *results* at the head; it recomputes none of their judgments. `ship threads`
  reads resolution *state* (which threads are open, who wrote them) — a different question from
  the guard's accounting check, needed because the skill's one judgment consumes it.
- **A §CP membership verdict.** The merge-time enforcement of control-plane review is
  CODEOWNERS plus the ruleset, server-side, and stays there. `ship scope`'s `cp` line is not a
  second verdict on that gated question — it is the routing input the skill's own law (the ADR
  0135 approval-aware path) cannot run without, and it is **derived from `.github/CODEOWNERS`
  itself** (the artifact the gate enforces, read from **the PR's base ref** — the branch the PR
  targets; see the verb block), so
  there is no second vocabulary to drift. It **holds on a trivial or empty boundary rather
  than matching everything** — the match-everything sentinel is the #4336 adopter-repo
  incident and the #4401 empty-capture class — and a *failed* boundary read is the `11`
  refusal, never "ordinary". No `ship` verb re-states the §CP path list in prose; prose copies are how the
  list drifts (#4954, #375's class).
- **A wedge-clearing verb** (cancel the stranded check, re-run it). The lever mutates CI runs
  the shipper does not own, and a bounded run cannot supervise the retry it triggers — both
  halves of the #3999 ruling. `ship checks` diagnoses `wedged` and names the check; the lever
  is an operator's.
- **A CI-repair or flake-classification verb.** Red CI routes to the heal seam (v1's
  `heal-ci` lane); this group reports `red` with the failing gating runs named on the notes
  channel and stops.
- **A flag-flip or release-execution verb.** Agents deploy, humans release (ADR 0083).
  `ship release` ends at the label.
- **An approval-watcher / banked-§CP ledger verb.** The watch loop over parked §CP PRs is separate
  machinery with its own open decisions (#4790, #4753, #4103); building it into the merge verb
  group would freeze those decisions from the wrong side. `ship cp-approval` answers "now,
  at this head"; durable watching is not this group's.
- **A terminal-ledger composer verb.** The run report is the skill's own text under the
  terminal vocabulary; a composing verb would just relay strings the skill already holds. One
  rule reaches it from outside: any elapsed duration quoted in a ship report derives from two
  timestamps quoted in the same report (#4442) — a pointer, not a verb.
- **A local-checkout sync or push verb.** This skill never touches local git (§RO); v1's
  `main-sync` / `verified-push` solve another lane's problem. Nothing here shells to git.
- **A repair-entry state machine for §CP.** What re-keys repair when a §CP advisory is stale
  and no current-head FAIL exists is an open decision (#4555, residual after ADR 0226 settled
  the emit side). The contract does not resolve it: a §CP FAIL posts and routes as an ordinary
  FAIL, and the residual stays cited, not silently answered.

### Nothing here recomputes an enforced answer

Every question this group answers is ungated today: verdict-conjunction state, §CP approval
discharge, head-CI rollup shape, run-evidence presence, thread resolution state, queue terminal
classification, intent lifecycle, dark-ship detection. The enforced ones are listed above with
the workflow or ruleset surface that owns each, and this spec computes no second verdict on any
of them.

### The name situation

At authoring time v1's `ship-it` was still the live project-level skill at
`claude-plugins/kampus-pipeline/skills/` (routed from `CLAUDE.md` / `DEVELOPMENT.md` as
`.claude/skills/ship-it/`), the routing gap recorded for the sibling rebuilds (#4761, #4829).
The cutover has since happened: the v1 plugin tree is deleted (ADR
[0303](../../../../.decisions/0303-retire-kampus-pipeline-plugin.md), #5937) and this skill,
reached as `/fabrika:ship`, is the one merge authority.

The same applies to the **heal seam**: the skill routes red CI to `heal-ci`, and no fabrika
counterpart exists yet — until one ships, that route resolves to the durable stop note plus a
filed report for a human, and the gap is recorded here rather than patched by pointing at the
v1 lane.

## Shared conventions

Stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else; scope lines, refusal
  reasons, progress and notices go to stderr. Every "nothing found" case prints a state word —
  empty stdout is byte-identical to a verb that never ran, and v1's callers consumed exactly
  that as proof (the assert-bundle script whose *pass* was silence; the `NAME=value` lines
  whose absence was the refusal signal). **One outcome convention for the whole group**: exit
  `0` means "I produced the answer", whatever the answer is — `stop`, `red` and `ejected` are
  answers; non-zero means "I could not produce one", plus the enumerated proven refusals of
  the write verbs. v1 ran three outcome conventions at once and spent ~15 comment blocks
  re-teaching them per script; this group runs one.
- **Common inputs.** `--repo <owner/name>` (default: `$CLAUDE_PIPELINE_REPO`, else
  `$GITHUB_REPOSITORY`, else the `origin` remote; none resolvable → exit 1 — the resolution
  chain the shipped `report`/`triage`/`review` groups use, inherited for one config surface
  rather than a second vocabulary). `--json` swaps the line grammar for one object with the
  named keys.
- **`--sha` binds the answer to what the caller verified.** Verbs taking `--sha` accept 7–40
  lowercase hex and prefix-match it against the live head. Read verbs report a mismatch as a
  stderr notice and still answer at the given SHA (a moved head is a fact worth seeing at the
  read); write verbs refuse it on `12` (a mutation formed over one tree must not land on
  another). The empty-SHA degeneration is designed out at the type layer: an empty or
  malformed `--sha` is a usage error, never a matches-everything pattern — v1's
  `case "$H" in "$SHA"*)` collapsed to `*` on an empty capture, twice, in two different
  scripts (#4223; the native-fold's unguarded `CURRENT_HEAD`).
- **Every list read paginates, reports its scanned count on stderr, and carries a completeness
  proof** — changed files, check runs, reviews, comments, threads, timeline events. **Which proof
  depends on what the platform declares, and a verb never prints a denominator it cannot derive**
  ([ruled on #5067](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953)):
  - **A declared count, where one exists.** Changed files, check runs, workflow runs, artifacts,
    issue comments and review threads all arrive with a total the platform states, so received
    short of declared is the `13` refusal, never a narrower answer (#4193's 30-of-N timeline;
    v1's 100-thread silent cap).
  - **Exhausted pagination, where none exists.** The PR's **reviews** and its **timeline** arrive
    as bare arrays with no total at all, so `received <k> of <m>` over them has no derivable
    `<m>` — any `<m>` printed beside them was invented, and an invented denominator proves
    nothing. Their proof is a **terminal page carrying no `rel="next"` link**: seeing one is
    positive evidence every page is held, and a read that ends without one is the same `13`
    refusal. These reads walk pages explicitly and read the `Link` header rather than using
    `--paginate`, which concatenates bodies and drops the headers the proof lives in.

  Any
  aggregate computed over a paginated read is computed **after** the pages are joined — v1's
  per-page `group_by` picked a stale approval from page 1 and its per-page `length` printed
  `0\n0` (#725's class, live in two v1 scripts).
- **A non-zero exit is UNKNOWN.** No verb prints a partial or permissive answer on a non-zero
  exit (`packages/fabrika-cli/src/verb.ts`'s answer-channel rule). No verb substitutes a
  fabricated count for an unreadable one — v1's empty-checkset probe printed invented
  fail-safe numbers indistinguishable from real ones; here an unreadable input is `11`.
- **`--json` shapes are normative as key lists.** The line-grammar examples are the byte-level
  contract; each verb's `--json` object is specified by its named-keys list — the object
  mirrors the lines one-for-one, and a second byte-level surface per verb would be a second
  home for the same facts. One canonical worked example lives on `ship scope`; the rest are
  key lists, deliberately.
- **Reads read; writes write.** No read verb posts a comment, mutates a label, or touches the
  PR (v1's CI rollup posted a PR comment from inside a read script — a caller that peeked at
  CI state mutated the conversation). Every write verb re-reads its target and verifies —
  v1's release-queue label POST and its nudge's reopen PATCH both reported success unverified,
  and each has a false-positive incident shape waiting in it.
- **`gh` exit statuses are read, always.** Every `gh api` capture checks the exit status
  before the bytes are interpreted; a failed read is `11`, never an empty string flowing
  onward. Roughly a third of v1's captures were unguarded, and every scar in this family
  (#4216, #4223, the fold's empty head) is that one omission wearing a different symptom.

### The shared exit taxonomy

All the verbs allocate from one internal table, so a code means one thing across this
group. Where the codes overlap the shipped `report`/`triage`/`review` seats (`3`, `5`, `6`,
`7`, `8`, `9`, `10`, `11`, `12`, `13`) they are **imported from the shipped package**
(`packages/fabrika-cli/src/report/codes.ts`, `src/triage/codes.ts`, `src/review/codes.ts` —
the `review` group's `codes.ts` shows the import-not-restate idiom), never re-typed as
numerals and never read off a sibling contract.md — the checked-in `/report` contract is
behind its own binary on `7` and `11` (#4752), which is why prose copies are not the
authority.

| Code | Meaning | Verbs that can return it |
|---|---|---|
| `0` | the answer is on stdout — including `stop`, `red`, `ejected`, `n/a`: an answer, not an error | all |
| `1` | usage error, unresolvable repo, or the verb failed to run | all |
| `126` | no implementation could be resolved | all |
| `3` | stdin was read and held nothing | `resolve`, `note` |
| `4` | *(deliberate gap — `report file`'s body-section seat; no verb here performs one)* | — |
| `5` | the **authored** text carries a machine-local path | `resolve`, `note` |
| `6` | the **authored** text is a bare `@` path reference — not redactable | `resolve`, `note` |
| `7` | zero scope: the target is **proven absent (404)**, or the PR is closed/draft where the verb requires an open one, or it has zero changed files — a fail-closed refusal | all except `disarm` |
| `8` | the write, or the read that confirms it, failed — the outcome is **UNKNOWN** | `resolve`, `enqueue`, `merge`, `disarm`, `nudge`, `note`, `release` |
| `9` | the write landed but the read-back does not match | `resolve`, `merge`, `note`, `release` |
| `10` | a supplied classification value is off the closed vocabulary — an unknown `--require` namespace, a bad `--site` | `gate`, `disarm` |
| `11` | a **precondition read failed** — nothing was proven and (for a write) nothing was written | all |
| `12` | refused: the live head moved past the inspected `--sha` — a mutation formed over a tree that is no longer the PR | `enqueue`, `merge`, `nudge` |
| `13` | refused: a read completed but its scope is **provably incomplete** — received short of a declared count, or (where the platform declares none) pagination never reached a terminal page | `scope`, `cp-approval`, `gate`, `checks`, `evidence`, `threads`, `nudge`, `release`, `reconcile`, `floor` |
| `14`, `15` | *(deliberate gaps — `review`'s ACL and append-only seats; no verb here performs either)* | — |
| `16` | refused: the target is **proven not in the state this write acts on** — nothing was mutated | `resolve`, `merge`, `nudge` |
| `17` | refused: the nudge's close landed and the reopen is **unconfirmed — the PR may be left closed**; a human re-opens before anything else happens | `nudge` |
| `18` | refused: the diff touches a governance root and its `governance` verdict is **not** a head-bound PASS — `absent`, `stale` or `fail`. The one red that means *a human owes this PR a verdict*, kept off `16` so a CI job can tell it from "the floor could not be resolved" | `floor` |
| `19` | refused: the repository permits **no merge method at all** — squash, merge-commit and rebase are all disabled, so nothing can land directly. Its own seat rather than a fold into `16`, because the two route opposite ways: `16` sends the run to `ship enqueue`, `19` ends it at a human with repository-settings access (#6018) | `merge` |
| `23` | refused: a label this run would POST is absent from the repository's taxonomy — `plan flip`'s seat, imported, because both verbs prove one fact over one board's labels (#4285) | `release` |
| `127` | the verb never ran (unresolved binary) | all |

**This matrix owns what a code *means*; the per-verb tables own what *triggers* it.** Every
verb can return `0`, `1`, `126` and `127` with the meanings above, stated here and nowhere else;
the per-verb "Exit status" tables enumerate only that verb's own proven outcomes, `3` and up,
phrased as that verb's trigger. (The one-fact-one-home rule; the `/triage` contract shipped the
ten-places drift this prevents.)

**`11` is the shipped `PRECONDITION_UNKNOWN`**, matched rather than reinvented: a read the
verb needed failed, so nothing is proven — not `7` (which is *proven* absence: a 404 is a fact
about the repository, an unreachable GitHub is not a fact about anything) and not `1` (which
would fuse an unreachable GitHub with a bad flag). This group leans on the distinction harder
than its siblings because v1's worst incidents are exactly its collapse: a failed §CP read
reported as "awaiting approval" (#4223), a failed file read reported as "no §CP, no classes"
(#4216), a 503 body reported as "no run-evidence bundle" (#3716).

**`16` and `17` are this group's own proven refusals.** `16` is the write-side state guard: a
nudge dispatched at a head that has runs, a resolve aimed at a thread that is not
positively bot-classed or is already resolved, a direct merge aimed at a queue-governed base or a
provably unmergeable PR — the verb proved the state and declined, which
is neither `7` (the target exists) nor `11` (nothing failed). It is the #4816 fix made
structural: the verb that mutates re-derives its own precondition and refuses without
touching the PR. `17` exists because the nudge is the group's one two-legged mutation: v1's
unguarded PATCH pair could close a PR, fail the reopen, and still report "nudged" — a state
so much worse than a failed write that folding it into `8` would hide the one fact the
operator must act on immediately.

### Read-backs compare normalized text, not bytes

Every write verb re-reads its target and compares through **`normalizeForReadback` from
`packages/fabrika-cli/src/report/compose.ts`** — import it; its third step (strip trailing
newlines) is the one a re-derivation drops, and dropping it fires exit `9` on clean runs.

### Machine-local path detection

`ship resolve` and `ship note` share the leak predicate **already implemented** at
`packages/fabrika-cli/src/report/leaks.ts` — import it, never re-derive it. This is the
authored-text guard only; scanning *landed* content is `leak-guard.yml`'s enforced seam. A
note that must cite a leak cites it by class root or repo-relative form; the refusal message
says so. Two known open issues sit on this seam and are inherited, not resolved here: a body
that proves path-cleanliness *by example* trips the generic detector (#4994 — the detector is
generic by design, #2393), and no verb can rewrite a foreign comment (#4995); both route to a
human, and the refusal text names the issue numbers.

---

## `ship scope`

**Invocation**

```
fabrika ship scope 4321 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number to scope |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line:
`scoped\t<head-sha>\t<open|draft|merged|closed>\t<issue-ref>` where `<issue-ref>` is
`fixes:<n>`, `part-of:<n>`, or `-` (none). Then one line per present artifact class —
`class\t<code|doc|skill|ui>\t<file-count>` — then one line per required namespace —
`namespace\t<review-code|review-doc|review-skill|review-ui|governance>` — then
`cp\t<control-plane|not-control-plane|unknown>`,
`landing\t<queue|direct|none|unknown>\t<squash|merge|rebase|->` and `files\t<scanned>`.

With `--json`: `{"outcome":"scoped","head":<40-hex>,"state":…,"issue":{"kind":"fixes"|"part-of"|"none","number":<n|null>},"classes":[{name,files}…],"namespaces":[…],"cp":…,"landing":{"path":…,"method":…},"scanned":<n>}`.

**A `merged` PR is an answer, not a refusal** — the skill reports idempotent success and ends.
`draft` and `closed` are likewise answers here; this verb reports state, the skill acts on it.
(The write verbs downstream refuse non-open PRs themselves — no verb trusts its dispatch.)

**The class map and the namespace derivation are one derivation, printed once.** The class
partition extends the `review` group's fixed map (code / doc / skill, `code` the residual —
same rows, same order, shared as one implemented module with `review scope`, never a second
copy) with the `ui` class. That class is **two** tests, not one: a changed path matching the UI
surface map (`apps/web/src/**` excluding `*.test.tsx?` / `*.spec.tsx?`) **whose diff carries at
least one line a user could see rendered** derives `review-ui`. A file whose every changed line
is a comment, a docblock or a wrapped prose string derives nothing — `review-ui` can emit no
honest verdict where there is no rendered delta, so raising it there blocks a merge on a gate
nobody can clear (#6376). Everything the render test cannot read counts as rendering, and a UI
path the diff shows no changed lines for — a rename, a mode change, a binary asset — raises too;
the direction that stays closed is the blind one. This costs the verb one extra read: with a UI
path present the diff is fetched, and an unreadable diff is `11`, never a guess. Namespaces are
derived from classes by one table in one module; v1 printed the class set from one derivation
in one script and hand-copied it in another, and the copy dropped a class on a live PR
(#4730). A non-empty diff deriving an empty namespace set is refused (`13`-adjacent but
proven, so: the verb reds on `7`'s vacuous-conjunction arm below) — a merge gated on zero
gates is vacuously green (#2765).

**`governance` is appended to that set, not mapped from a class.** A diff with at least one
changed path under one of the repo's governed roots — `governedRoots` in `.fabrika.jsonc`, shipping
as `.decisions/`, `.claude/`, `.github/`, `claude-plugins/` and the config file — additionally
derives `namespace\tgovernance`; a diff under none of those roots derives exactly the
namespaces it derived before, unchanged. Those paths already carry a file class, so this is a
second, orthogonal question about the same files rather than a fifth class — and the predicate
is the one `governance scope` computes, shared as code so the two cannot disagree. A namespace
`ship gate` can require but `ship scope` never names would be admissible-but-unreachable, which
is the fail-open half of the same gap (#5199). The third leg is the reader: the `verdict-marker`
format admits the `governance` namespace, so a posted `governance: PASS @ <sha> — <clause>` from
an authorized author satisfies it at `ship gate` like any `review-*` marker. Required, emitted
and readable move together — a required namespace no marker can carry blocks every
governance-root PR permanently, which is the fail-**closed** half of the same gap (#5199).

**The `cp` line** is the three-state routing input (see "Considered and deliberately not
derived"), and its source is the **enforced artifact itself**: `.github/CODEOWNERS`, read at run
time from **the PR's base ref — the branch the PR targets** ([ruled on
#5067](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233160017), founder-direct).
Naming a trunk branch literally was the bug: the base ref *is* that branch in this repo, and it is
the honest generalization in an adopter repo whose trunk is called something else. The #981
property — a PR must not reclassify itself — holds unchanged, because the base ref is never the
PR's head. A changed path
covered by a CODEOWNERS row whose owner is a control-plane owner is `control-plane`. A
control-plane owner is `@<org>/<team>` **or** an individual `@<login>` — both parsed off the file,
never hardcoded (`@kamp-us/control-plane` in this repo). Individual owners count exactly as team
owners do (founder ruling on #5603 "rule a", built as #6299): GitHub discharges a row when any
listed owner approves, and counting only team-shaped owners made every PR in a personal repo
`unknown` — the HOLD state — so nothing in it could ever ship. A bare email owner is not one:
it names no account a roster or an approval resolves against.
A change set with no owned-path match — including one entirely under
`.decisions/**` — is `not-control-plane` (founder ruling, 2026-08-15 on #5531: ADRs are not
control-plane; the required `governance` verdict floor is what stands behind an ADR PR, per ADR
0274 §2). A CODEOWNERS that reads fine but is **trivial** — zero owned rows, or a row set that
covers everything — → `unknown` (a printed hold — the match-everything boundary is the #4336
adopter incident and the #4401 trivial-pattern class).

**An absent CODEOWNERS and an unreadable one are different answers, and neither is
`not-control-plane`.** A **proven-absent** (404) boundary parses to zero rows and lands on the
`unknown` hold. An **unreadable** boundary is the absence of a fact rather than a fact, so it is
the `11` — unconditionally, in every repo. Here CODEOWNERS *is* the control-plane gate, and a
transient read fault shipping a control-plane PR unreviewed is the failure #4216 exists to
prevent; ADR [0220](../../../../.decisions/0220-cp-surface-declared-at-standup.md) §4 names
collapsing `unknown` → `not-control-plane` the recurring fail-open defect. A per-repo
`unreadableCodeowners` key briefly made this configurable (#6299, ADR
[0307](../../../../.decisions/0307-unreadable-codeowners-is-per-repo.md)); the founder reverted it
on #5631 and nothing reads the key now.

Deriving from CODEOWNERS rather than any prose or regex copy
means this verb and the merge gate read one artifact and cannot disagree; the
`codeowners-cp.yml` CI gate keeps that artifact in sync with the rest of the governance
surface. `unknown` is the one HOLD state, and the skill treats it as §CP until proven otherwise.

**The linked issue** resolves from the PR body's closing keywords (`Fixes/Closes/Resolves #N`,
first match), else an explicit `Part of #N` (an intentional partial split — the skill merges
without auto-close), else `-`. Which classes may ship issueless is the skill's law (ADR 0075),
not this verb's.

**The `landing` line names which of the two landing paths this base branch has**, so the shipper
reads its route from one verb instead of composing it from two API reads nobody currently performs
(#6018). `queue` — a merge queue governs the base, so `ship enqueue` lands it and the method is the
queue's; `direct` — no queue and the repository permits at least one merge method, named beside the
path, so `ship merge` lands it; `none` — no queue and no permitted method, so nothing in this
repository can land this branch and a human owes it a settings change.

`landing` is **the one field that degrades instead of refusing**: an unreadable branch-rule or
repository read prints `unknown` with the reason on stderr, and the rest of the scope still answers.
That is deliberate and it is not fail-open, because this line licenses nothing — `ship merge`
re-derives the same fact from the same reads and refuses `11` exactly where this printed `unknown`.
Refusing the whole scope here would cost a run its head, classes and §CP state over a fact only one
downstream verb consumes, and that verb guards itself.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404); or it has zero changed files; or its non-empty diff derives zero required namespaces — a vacuous conjunction (#2765, ADR 0092) |
| `11` | the PR, its file list, or the §CP boundary could not be read — the scope is UNKNOWN. **Not** the landing read, which degrades to `unknown` |
| `13` | the changed-file enumeration is provably short (received < declared count) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship scope: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship scope: PR #<n> has zero changed files — nothing to ship (ADR 0092).` | 7 | refusal |
| `ship scope: #<n>'s diff derives zero review namespaces — a merge gated on nothing is vacuously green (#2765); the class map has a hole, file it.` | 7 | refusal |
| `ship scope: cannot read <what> for #<n>: <reason> — the scope is UNKNOWN.` | 11 | refusal |
| `ship scope: cannot read <base>'s landing path: <reason> — reporting it unknown; `ship merge` refuses on the same read rather than landing.` | 0 | notice |
| `ship scope: file list shows <k> of <m> declared files — refusing to partition a truncated read.` | 13 | refusal |

**Scope** — one PR's metadata and changed-file list, paginated and count-checked, plus one
boundary read from the PR's base ref and one `governedRoots` read from the checkout the verb runs
in. A boundary read that failed refuses `11` on the spot and reads no config. The partition is total
over what was read.

**Examples**

```
$ fabrika ship scope 4321
scoped	03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c	open	fixes:4287
class	code	3
class	doc	1
namespace	review-code
namespace	review-doc
cp	not-control-plane
landing	direct	squash
files	4
```

```
$ fabrika ship scope 4321 --json
{"outcome":"scoped","head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","state":"open","issue":{"kind":"fixes","number":4287},"classes":[{"name":"code","files":3},{"name":"doc","files":1}],"namespaces":["review-code","review-doc"],"cp":"not-control-plane","landing":{"path":"direct","method":"squash"},"scanned":4}
```

```
$ fabrika ship scope 4999
ship scope: PR #4999 not found in kamp-us/phoenix.
$ echo $?
7
```

**Grounding**

- #4730 / #2765 — one derivation printed once; the vacuous-conjunction refusal is executable,
  not five comment lines ("born dead" is the v1 scar's own phrase).
- #4216 — a failed file read once answered "no §CP, no classes present" in one stroke; here it
  is `11`.
- #981 / #4336 / #4401 — boundary from the PR's base ref, trivial/empty boundary is a hold.
- #663 / #644 / #912 / #2470 — the class-map deadlock family: every changed file maps to a
  class, every class to a namespace some gate can actually emit; the map is shared code with
  `review scope`, so ship and review cannot disagree about what a file is.
- ADR 0075 — issue-linkage legality (which classes may ship issueless) stays in the skill
  deliberately: this verb prints the facts (`class` lines, the `issue-ref`), and the mapping
  is one sentence of product law subject to future rulings — baking it into a verb would put
  a moving rule behind a rebuild.

---

## `ship cp-approval`

**Invocation**

```
fabrika ship cp-approval 4321 --sha 03135b91 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head the run is shipping; every discharge signal must bind to it |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line:
`cp-approval\t<discharge|stop|n/a>\t<mechanism-or-reason>` where the third field is one of
`member-approval:<login>@<sha>` / `self-approval-marker@<sha>` (discharge),
`awaiting-approval` / `zero-owners` (stop), or `not-control-plane` (n/a — the PR is proven
ordinary and there is nothing to discharge). A stderr notice
`base-drift: head is <k> commits behind <base>` fires when the banked head is behind the live
base — the skill routes rebase → re-gate → re-bank *before* an approval is solicited, so the
approval is never spent on a head that must move (#4477).

With `--json`: `{"outcome":…,"mechanism":…,"sha":…,"roster":<n>,"baseDrift":<k|0>}`.

**The decision is the ADR 0175 cardinality table, verbatim:** roster = **the union of every owner
the CODEOWNERS control-plane rows name**, over both owner shapes. An `@<org>/<team>` owner is
expanded through the REST team-members endpoint (`/orgs/<org>/teams/<team>/members`, paginated),
read fresh once per named team. An individual `@<login>` owner **is** a roster entry and no roster
is read for it — that endpoint needs an org a personal repo does not have, which is why counting
only teams left such a repo unable to discharge the gate at all (#6299). The owner set is the same
derivation `ship scope` uses, one shared module, so the roster this verb consults is the set the
merge gate actually asks (`@kamp-us/control-plane` is the only team in this repo, never
hardcoded). **The union is not a fabrika policy — it is GitHub's own any-listed-owner semantics**
([ruled on #5067](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233188966),
founder-direct): GitHub discharges a CODEOWNERS row when *any* listed owner approves, so a roster
narrower than the union would refuse approvals the merge gate accepts, and fabrika mirrors the
platform here rather than adding a rule of its own.
N=0 → `stop` `zero-owners` (an empty roster is a proven
stop; an *unreadable* roster for **any** named team is the `11` refusal, never a stop — a union
missing one arm is not a smaller union, it is an unknown one). A CODEOWNERS parse yielding
no control-plane owner of either shape at all is N=0 — `stop` `zero-owners`, and a **proven-absent**
CODEOWNERS reaches that same branch through its empty row set. An **unreadable** one is `11`, the
same answer `ship scope` gives it. N=1 and the sole owner authored the PR → discharge only on the
sole owner's head-bound self-approval marker comment (`control-plane-self-approval @ <sha>`,
a token deliberately outside every auto-merge namespace). N=1 non-author, or N≥2 → discharge
only on a non-author member's APPROVED review whose `commit_id` prefix-matches `--sha`. Every
signal is head-bound; a stale approval on a superseded head never counts (ruleset
`dismiss_stale_reviews_on_push` backs this but is not relied on — #3769 proved dismissal
behavior is inconsistent, so the head-binding is checked here, always). Membership is a
three-outcome probe: active / proven-404 / UNKNOWN — an UNKNOWN member read is `11`, never
"not a member" (#4223).

**Latest-per-author review resolution is computed after all pages are joined** — v1's
per-page `group_by` could surface a page-1 stale approval past a page-2 revocation (#725's
class, live in v1's approval scan).

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) or closed |
| `11` | the CODEOWNERS boundary, the roster, the reviews, the marker comments, or the live head could not be read — the discharge is UNKNOWN, never `stop`, never `awaiting approval` (#4223) |
| `13` | the changed-file or comment enumeration is provably short of the declared count, or the review read — for which the platform declares no count — never reached a terminal page |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship cp-approval: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship cp-approval: PR #<n> is closed — nothing to discharge.` | 7 | refusal |
| `ship cp-approval: cannot read <what>: <reason> — the discharge is UNRESOLVED, not "awaiting approval" (#4223).` | 11 | refusal |
| `ship cp-approval: received <k> of <m> changed files — refusing the partial sweep.` | 13 | refusal |
| `ship cp-approval: received <k> of <m> comments — refusing the partial sweep.` | 13 | refusal |
| `ship cp-approval: the review read never reached a terminal page — pagination is unexhausted, so an approval could sit on a page nobody read; refusing the partial sweep.` | 13 | refusal |

**Scope** — the control-plane roster (the union over every named team and every individual owner), the PR's changed
files and comments (paginated, count-checked) and its reviews (paginated to exhaustion), and the
live head. `n/a` is a proven answer computed from the same `cp`
derivation `ship scope` prints (one shared module).

**Examples**

```
$ fabrika ship cp-approval 4321 --sha 03135b91
cp-approval	discharge	member-approval:cansirin@03135b91
```

```
$ fabrika ship cp-approval 4322 --sha 9fe12ab0
cp-approval	stop	awaiting-approval
```

**Grounding**

- #2435 — identical single-owner PRs merged in one run and were refused in another when this
  was judgment; the case table ended it, and this verb is that table.
- #4223 — the empty-HEAD glob degeneration and the failed-read-as-"awaiting-approval" scar;
  both designed out (typed SHA, `11` on any failed read).
- #3769 — head-binding checked here rather than delegated to `dismiss_stale_reviews_on_push`,
  because a live counterexample showed a patch-changing push surviving approval.
- #4477 — the base-drift notice; an approval spent on a must-move head is destroyed by the
  rebase (#4521 is three §CP approvals destroyed in one night by exactly this).
- ADR 0135 / 0175 — the approval-aware gate and the cardinality table this transcribes.

---

## `ship gate`

**Invocation**

```
fabrika ship gate 4321 --sha 03135b91 --require review-code [--require review-doc …] [--cp] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head every verdict must bind to |
| `--require` | string, repeatable | yes (≥1) | — | a required namespace; repeat the flag once per namespace, exactly as `ship scope` printed them. A **floor the verb may raise**, never a ceiling (see the governance floor below) |
| `--cp` | boolean | no | `false` | resolve §CP advisory carriers for the code namespace; pass iff `ship cp-approval` discharged |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line: `gate\t<satisfied|blocked>\t<sha>`. Then one line
per required namespace, in the order required:
`ns\t<namespace>\t<pass|fail|absent|stale>\t<marker|advisory|review-fold|->` — the fourth
field names which carrier produced the in-force verdict (`-` on `absent`). `satisfied` iff
every required namespace reads `pass`.

With `--json`: `{"outcome":…,"sha":…,"namespaces":[{name,state,carrier,commentId}…],"required":<n>}`.

**The flag-collapse and coverage scars are designed out at two layers.** `--require` is a
repeatable flag whose values accumulate — a single-valued parse that keeps the first and
drops the rest is the #4520 incident (the gate said enqueueable past a live FAIL). And the
affirmative answer carries its own proof: before `satisfied` is printed, the verb asserts the
namespace lines cover exactly the distinct required set — a plausible value with silently
narrowed coverage is the defect's signature, so the assertion runs *before* the answer is
believed, not after.

**The `governance` requirement is the diff's floor, not the caller's option.** The verb reads the
PR's changed-file list itself, and a diff with at least one path under one of the repo's governed
roots gates on `governance` **whether or not `--require` named it** — the same predicate `ship
scope` prints the namespace from, over the same declared list, shared as code, so the two cannot
disagree. Every other namespace stays caller-asserted; the floor only ever *adds*, so a diff under
none of those roots requires exactly what it required before. When the floor fires, a stderr notice names it.

This is the whole ruling on #5036, and it is what a §CP row would otherwise have had to enforce.
`claude-plugins/fabrika/**` is deliberately **not** control-plane — no CODEOWNERS row, no boundary
widening ([founder veto, #5036](https://github.com/kamp-us/phoenix/issues/5036#issuecomment-5234614633),
2026-08-10). The protection is this machine floor plus the §CP digest readout that carries every
fabrika-tree landing to a human: **visibility after landing replaces blocking before it**, and the
trade is explicit — the readout makes a gate-weakening landing *visible*, not *impossible* (#5216 is
a live instance of the machine chain missing one). `.github/**`, CODEOWNERS included, and everything
the existing §CP boundary already covers stay §CP, unchanged and enforced server-side regardless.

The floor is `governance` only. Deriving the whole `review-*` set here would be a second answer to
what `ship scope` already prints, and widening it is its own decision — recorded as considered, not
silently taken.

**In-force resolution, per namespace:** candidates are this namespace's verdict comments,
head-bound first (a live-head-bound verdict strictly outranks recency — #4189), then ordered
by the body's write-stamp, never `created_at` (#4200: a FAIL upserted after a PASS must win).
Authorization is the ACL rule: a verdict counts only when its author resolves to `write`+ on
the repo (ADR 0055, fail-closed on lookup failure → that namespace is `11`, not `absent`).
With `--cp`, the code namespace additionally resolves the §CP advisory carrier (body-bound
`Reviewed-head:` + all-`[PASS]` rows — an advisory carrying any `[FAIL]` row is an invalid
emission, ADR 0226, reported on stderr and treated as `fail`); the same `--cp` value must
reach every resolution in one run — v1 passed it to the gate and not the fold, and a
discharged FAIL stayed in force forever (#4049). The native-review fold is inside this verb:
a decisive native review (APPROVED / CHANGES_REQUESTED) whose `commit_id` prefix-matches
`--sha` folds into the code namespace newest-wins by write time — never FAIL-precedence,
which wedges the repair loop.

`absent` and `stale` are distinct tokens because their remedies differ (run the gate vs
re-run it at this head), and both block — absence-is-refusal is the #3944 law (a PR enqueued
with no live-head verdict at all).

**`--cp` is caller-asserted, deliberately** — the one input in this verb the caller vouches
for, an exception to the group's re-derive habit and stated as such. Gate is a read: a wrongly
passed `--cp` changes which *carrier* can satisfy the code namespace, never whether the §CP
approval itself is discharged — that discharge is `ship cp-approval`'s answer and is enforced
server-side (CODEOWNERS + ruleset) regardless. Re-deriving §CP-ness here would be the second
answer this contract bans.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) or closed, or its diff has zero changed files — a conjunction over an empty diff proves nothing (ADR 0092) |
| `10` | a `--require` value is not a known gateable namespace |
| `11` | the changed-file list, comments, reviews, or ACL could not be read — the conjunction is UNKNOWN, never `blocked`, never `satisfied` |
| `13` | the changed-file or comment enumeration is provably short of the declared count, or the review read — for which the platform declares no count — never reached a terminal page |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship gate: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship gate: PR #<n> is closed — nothing to gate.` | 7 | refusal |
| `ship gate: PR #<n> has zero changed files — a conjunction over an empty diff proves nothing (ADR 0092).` | 7 | refusal |
| `ship gate: --require <v> is not a gateable namespace (known: review-code, review-doc, review-skill, review-ui, governance).` | 10 | refusal |
| `ship gate: cannot read <what> for #<n>: <reason> — the conjunction is UNKNOWN.` | 11 | refusal |
| `ship gate: received <k> of <m> changed files — refusing to derive the required floor from a truncated read.` | 13 | refusal |
| `ship gate: received <k> of <m> comments — refusing the partial resolution.` | 13 | refusal |
| `ship gate: the review read never reached a terminal page — pagination is unexhausted, so the native-review fold would rest on a truncated set; refusing the partial resolution.` | 13 | refusal |
| `ship gate: #<n>'s diff touches a governance root, so governance is required whether or not it was passed — the diff's floor, not the caller's option (#5036).` | 0 | notice |
| `ship gate: #<n> carries a §CP advisory with a [FAIL] row — an invalid emission (ADR 0226); treated as fail, report it.` | 0 | notice |

**Scope** — one PR's changed-file list (paginated, count-checked — the floor may not rest on a
truncated read), its verdict comments (paginated, count-checked) and native reviews (paginated to
exhaustion), each candidate ACL-resolved. The verdict-marker and advisory grammars are the registered wire
formats (`packages/fabrika-cli/src/wire/verdict-marker.ts`, `src/review/advisory.ts`) —
imported, never re-parsed; a hand-rolled marker regex is the drift the registry ended.

**Examples**

```
$ fabrika ship gate 4321 --sha 03135b91 --require review-code --require review-doc
gate	satisfied	03135b91
ns	review-code	pass	marker
ns	review-doc	pass	marker
```

```
$ fabrika ship gate 4322 --sha 9fe12ab0 --require review-code
gate	blocked	9fe12ab0
ns	review-code	absent	-
$ echo $?
0
```

```
$ fabrika ship gate 4323 --sha 7c31a0de --require review-skill
ship gate: #4323's diff touches a governance root, so governance is required whether or not it was passed — the diff's floor, not the caller's option (#5036).
gate	blocked	7c31a0de
ns	review-skill	pass	marker
ns	governance	absent	-
```

**Grounding**

- #5036 — the governance floor. `--require` was caller-asserted end to end, so a fabrika-tree PR
  shipped with no governance verdict simply by never passing the flag; the founder vetoed making
  the tree §CP and ruled the machine floor instead.
- #4520 — the repeated-flag collapse and the coverage assertion; both layers here.
- #3944 / #3982 — the set-level absence check is not expressible as N separate reads; one verb
  owns the conjunction.
- #4189 / #4200 / #2102 — head-bound-first, write-stamp ordering, staleness folded into one
  resolution rather than a separate marker test to keep in sync.
- #4049 — one `--cp` value for the whole resolution; the seam that diverged in v1 is gone
  because the fold lives inside the same verb.
- #1932 / #2005 / ADR 0111/0151/0226 — the advisory carrier's resolution rules, including the
  forged-marker workaround this forbids and the PASS-only rule.

---

## `ship floor`

**Invocation**

```
fabrika ship floor 4321 --sha 03135b91 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head the answer binds to (7–40 lowercase hex) |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. Two lines: `floor\t<satisfied|n/a>\t<sha>` then
`ns\tgovernance\t<pass|->`. With `--json`, an object with keys `outcome`, `sha`, `namespace`,
`state` and `scanned`.

**`n/a` is an answer about the diff, never a discharged verdict.** It means the changed files touch
none of this repo's governed roots, so the floor does not bind — and the verb says so on stderr, in
those words, because "the check was green" is exactly the reading that would make this gate
decorative for the diffs it does not cover.

<a id="the-mechanism-choice"></a>
### Why a caller verb, and not a new exit code on `ship gate` (#5408)

The floor had to become **machine-binding**: CI must read the governance verdict on a governance-root
diff and red without it (founder ruling, 2026-08-11, routed onto #5408). Two mechanisms were on the
table and the choice decides whether `gate-verb.ts` changes at all. **The caller was chosen.**

- **Rejected — reseat `blocked` on the `3`+ proven-outcome band inside `ship gate`.** `blocked` is an
  answer the verb *produced*, and `../../docs/cli-interface-convention.md` reserves `0` for exactly
  that; moving it would break the convention's answer/refusal split for every caller at once — the
  `ship` skill's step 3, which reads the `ns` lines to route repair, most of all. A gate that
  refuses instead of answering also cannot report *which* namespace blocked, because `refuse()`
  hardcodes empty stdout.
- **Rejected — parse `gate\tblocked\t<sha>` in the workflow's `run:` step.** That puts the decision
  in bash, which ADR 0228 forbids: a script relays a verb's answer and never derives the decision
  itself. It would also need a second step to decide whether the floor applies at all, and that step
  would be a second copy of the governed-root list that nothing reds when it drifts (#4604).
- **Chosen — `ship floor`, a caller verb whose refusal *is* the decision.** `ship gate` is untouched
  and keeps answering; `ship floor` asks it for the one `governance` namespace, reads the row back
  and seats a non-PASS on `18`. The workflow relays an exit code and derives nothing. The verdict
  resolution stays in one place, so there is no rival answer to drift.

`ship floor` is therefore **not** a second conjunction and **not** an enqueue decision — `ship gate`
remains the single merge authority. It reads one namespace, its own group's floor, and decides
nothing about the others.

### It refuses on WRONG, not only on MISSING

The recurring defect is a guard that fires when the guarded thing is *absent* and stays silent when
it is *present and wrong* (#5416, #4887). All four of these red on `18`, and each has a unit test:

| The PR carries | Resolves | Why it still reds |
|---|---|---|
| no governance marker at all | `absent` | the #5293 / #5333 shape — the fail-open this verb closes |
| `governance: FAIL @ <head>` | `fail` | a verdict was formed and it said no |
| `governance: PASS @ <other-head>` | `stale` | the PASS attests a tree that is not this one (ADR 0058) |
| `governance: PASS @ <head>` from an author without write+ | `absent` | the ADR 0055 ACL gate drops it before the polarity is read |

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) or closed, or has zero changed files — whether it touches a governance root is unanswerable (ADR 0092) |
| `11` | the PR, its changed-file list, or the conjunction underneath could not be read — the floor is UNKNOWN, never `n/a` |
| `13` | the changed-file enumeration is provably short — a governance root could sit in the part nobody read |
| `18` | the diff touches a governance root and its `governance` verdict at this head is `absent`, `stale` or `fail` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship floor: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship floor: PR #<n> has zero changed files — whether it touches a governance root is unanswerable (ADR 0092).` | 7 | refusal |
| `ship floor: cannot read PR #<n> in <repo>: <reason> — whether the floor binds is UNKNOWN, never "n/a".` | 11 | refusal |
| `ship floor: cannot read the changed-file list for #<n>: <reason> — whether the floor binds is UNKNOWN, never "n/a".` | 11 | refusal |
| ``ship floor: `ship gate` answered without a resolvable governance row — the floor is UNKNOWN, never discharged.`` | 11 | refusal |
| `ship floor: received <k> of <m> changed files — a governance root could sit in the part nobody read.` | 13 | refusal |
| `ship floor: #<n> touches a governance root and its governance verdict at <sha> is <state> — <remedy> (#5408).` | 18 | refusal |
| `ship floor: #<n>'s diff touches no governance root, so the floor does not bind — this is an answer about the diff, not a discharged verdict.` | 0 | notice |

**Scope** — one PR's changed-file list, count-checked against the declared total, plus whatever
`ship gate` scans for the one required namespace (its own file list, the comments, the reviews and
the comment authors' ACL). Both scanned counts reach stderr, this verb's first.

**Where it is enforced.** `.github/workflows/governance-floor.yml`, job `floor`, on every
`pull_request` with no `paths:` filter — the verb's own read of the changed files is the path
decision, so there is no YAML copy of the root list to drift. The job relays the exit code and does
nothing else. Making that context **required** is a repository-ruleset change and therefore a
human's; until it is required the check is red-but-not-blocking, which is a weaker state than the
ruling asks for and is recorded here rather than glossed.

**Examples**

```
$ fabrika ship floor 5237 --sha be0ece1aac259dd906e257529ce3294441f16e85
ship floor: scanned 8 changed files; 8 declared.
ship floor: #5237's diff touches no governance root, so the floor does not bind — this is an answer about the diff, not a discharged verdict.
floor	n/a	be0ece1aac259dd906e257529ce3294441f16e85
ns	governance	-
$ echo $?
0
```

```
$ fabrika ship floor 5481 --sha c9deb6047acc69da85b033a46b1fe05d2e0f5b91
ship floor: scanned 1 changed file; 1 declared.
ship gate: scanned 1 changed file; 1 declared.
ship gate: scanned 2 comments; 2 declared.
ship gate: scanned 0 reviews; pagination exhausted.
ship floor: #5481 touches a governance root and its governance verdict at c9deb6047acc69da85b033a46b1fe05d2e0f5b91 is absent — no authorized governance verdict at this head — run the `governance` skill and emit one with `fabrika governance post` (#5408).
$ echo $?
18
```

**Grounding**

- #5408 — the substituted control did not bind. `requiredWithFloor` was wired and correct, no
  workflow invoked `ship gate` at all, and `blocked` exited 0, so #5293 and #5333 merged with no
  governance verdict after the floor was live. The gap was the missing caller, not the floor.
- ADR 0228 — a script relays a verb's answer and never derives the decision; that is why the
  decision is a verb and the workflow step is one line.
- #4604 — a path filter matching nothing presents as a pass, which is why this job has no `paths:`.
- ADR 0055 / ADR 0058 — the write+ author gate and the SHA binding, both inherited from `ship gate`
  rather than re-derived, which is what makes an unauthorized or stale PASS red here.
- ADR 0092 — an unreadable answer reds. `11` and `13` are not softer than `18`; they are a different
  fact, and neither is a pass.

---

## `ship checks`

**Invocation**

```
fabrika ship checks 4321 --sha 03135b91 [--wait] [--budget-seconds 600] [--cadence-seconds 30] [--wedge-dwell-seconds 120] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head to enumerate check runs at |
| `--wait` | boolean | no | `false` | poll until a terminal state or the budget expires |
| `--budget-seconds` | integer | no | `600` | `--wait` only: total wall-clock budget, gh-call latency included |
| `--cadence-seconds` | integer | no | `30` | `--wait` only: sleep between polls |
| `--wedge-dwell-seconds` | integer | no | `120` | `--wait` only: how long a queued-never-started check dwells before it reads `wedged` |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line:
`checks\t<sha>\t<green|red|pending|wedged|no-runs|no-producer>`. Second line: `run\t<count>` — the count
of latest-per-context check runs read (gating and informational both), the line channel's own
completeness proof. Then the **collapsed tally** of those runs, one line per class, count-descending
with ties broken on the class:
`check\t<success|failure|neutral|cancelled|skipped|timed_out|action_required|in_progress|queued|stale>/<gating|informational>\t<count>`.
`checks` is an evidence-array under ADR [0308](../../../../.decisions/0308-bounded-evidence-output-shape.md):
step 4 routes off the rollup and nothing reads a run by name, so the rows collapse to counts. The
gating axis stays inside the key because status alone would leave the rollup underivable from the
answer — a `red` head and a head whose only `failure` is an ADR 0061 informational run would tally
identically. The two runs the skill's terminals read by name are still **named**, on the notes
channel, where the skill already reads them: the wedged run, and — wherever a gating run has failed,
which is `red` and also the `wedged` head that carries a failure too — the failing gating runs,
`ship checks: failing gating checks: <name>, … — route these to heal-ci.`, name-sorted. Informational
failures are excluded from that line for the same reason the gating axis exists: they do not make
the head red, and naming them there would send the operator to `heal-ci` over a check that gates
nothing.
Last line: `facts\tworkflows:<n>\truns:<n>` — `workflows` counts the repository's **active**
workflows (the inventory's `state == "active"` rows, nothing more: no trigger matching, no YAML
parser — [ruled on
#5067](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953)); `runs` counts the total workflow runs recorded at this
head across all workflows, **pre-dedupe** (which is why it can exceed the `run` line count:
that one counts latest-per-context check-run rows). These are the zero-checkset
discriminators (`no-runs` requires workflows ≥ 1 and runs = 0 at this head: Actions exist
and none fired — the dropped-trigger state `ship nudge` re-derives).

**Zero workflows is `no-producer`, and it no longer collapses into `pending`** (#6298). A repo with
no CI and a repo whose CI has not reported yet are different facts, and printing the second over the
first tells an operator to wait for a run nothing will ever start. Workflow *existence* is the whole
test — nothing inspects what a workflow does (#5603, R17.1). That case refuses on `7` unless the
repo declares `ci.noProducer: "degrade"` in `.fabrika.jsonc`, which prints the `no-producer` rollup
at exit `0` with the fact on stderr. With `--wait`, progress goes to stderr and
the final stdout adds `settle\t<settled|budget-exhausted|head-moved>` before the first line's
shape is emitted at the terminal state.

With `--json`: `{"outcome":…,"sha":…,"rollup":…,"checks":{"<status>/<gating|informational>":<count>…},"workflows":<n>,"runs":<n>,"settle":…}` —
`checks` is the same tally the `check` lines carry, so the two channels cannot desync. `settle` is
`null` without `--wait` (the line grammar emits the settle line only under it).

**The rollup is total over the status vocabulary, fail-closed on the ambiguous rows** — the
same bucket rules as the shipped `review ci` (`red` on `failure`/`timed_out`/
`action_required`/`cancelled`; `pending` when any queued/in-progress; `green` only when every
declared run concluded `success`/`neutral`/`skipped`; unrecognized conclusion → `red`) —
**implemented as one shared rollup module with `review ci`** (`src/review/rollup.ts` ships
today; extend it, never fork it), plus this group's two additions on top: the
running-vs-wedged split (`queued` with a null `started_at` past the dwell → the whole answer
is `wedged`, with the stranded checks named — diagnosis only; the cancel-and-rerun lever is
an operator's, #3999) and the informational carve-out (a fixed, single-sourced list of
non-gating deploy/cleanup contexts — ADR 0061 — maintained in the module, not duplicated;
v1 hardcoded it in two scripts' jq and they drifted). The read is REST check-runs
latest-per-context — the GraphQL rollup lags ~15 minutes behind reality and refused green
PRs for it (#3999); the aggregate `.conclusion` is never bound (red-wins-over-pending masks
an unfinished gating check).

**`--wait` semantics:** re-read each cadence tick; budget accounts wall-clock including call
latency (v1 counted only sleeps and silently overran); a mid-wait `red` exits at the next
tick (falling through to green was the enqueue-a-red-PR hazard); a mid-wait head move exits
`head-moved` (the answer is about a tree the PR no longer is; #1928's secondary); budget
exhaustion is the `budget-exhausted` settle token with the last rollup — an answer, exit 0.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR or the `--sha` commit is proven absent; **or the repo has zero workflows** under the shipped `ci.noProducer: "refuse"` |
| `11` | the check-run read, the workflow read, or `.fabrika.jsonc`'s `ci` key failed — CI state is UNKNOWN, never `green`, and no substituted count is printed |
| `13` | entries received < declared `total_count` — never read as "no red checks" |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship checks: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship checks: no commit <sha> on PR #<n>.` | 7 | refusal |
| `ship checks: <repo> has zero workflows — no CI producer, so no head can be evidenced (ADR 0092). A repo that runs no workflows declares \`ci.noProducer: "degrade"\`.` | 7 | refusal |
| `ship checks: cannot read \`ci\` from the repo config (<reason>) — whether <repo> produces CI is UNKNOWN, never green.` | 11 | refusal |
| `ship checks: <repo> declares \`ci.noProducer: degrade\` and has zero workflows — no producer, so there is nothing to roll up.` | 0 | notice |
| `ship checks: cannot enumerate <what> at <sha>: <reason> — CI state is UNKNOWN, never green.` | 11 | refusal |
| `ship checks: received <k> of <m> declared check runs at <sha> — refusing the partial enumeration.` | 13 | refusal |
| `ship checks: the live head is <live>, you are enumerating <sha> — the head moved.` | 0 | notice |

**Scope** — the check runs and workflow inventory at one commit, paginated,
count-verified. Zero *declared* check runs with zero workflows is `green`-ineligible and
`no-runs`-ineligible too — it is the repo that produces no CI at all, and what it costs is
`ci.noProducer`'s answer. Under the shipped `refuse` it is exit `7`: a head whose checks will
never report is not a head to wait on. Where the repo declared `degrade` it is rollup
`no-producer` at exit 0, printed with `facts	workflows:0	runs:0`. Neither arm greens, and
neither prints `pending` — that collapse is what made this state read as *wait longer* forever.

**Examples**

```
$ fabrika ship checks 4321 --sha 03135b91
checks	03135b91	green
run	3
check	success/gating	2
check	success/informational	1
facts	workflows:12	runs:14
```

```
$ fabrika ship checks 4322 --sha 9fe12ab0
checks	9fe12ab0	no-runs
run	0
facts	workflows:12	runs:0
```

```
$ fabrika ship checks 4323 --sha 7c04ef19   # a repo declaring "ci": {"noProducer": "degrade"}
checks	7c04ef19	no-producer
run	0
facts	workflows:0	runs:0
```

```
$ fabrika ship checks 4321 --sha 03135b91 --wait
settle	settled
checks	03135b91	green
run	3
check	success/gating	2
check	success/informational	1
facts	workflows:12	runs:14
```

(With `--wait`, the `settle` line leads the terminal-state emission; the rest of the shape is
unchanged.)

**Grounding**

- #3999 — REST latest-per-context over GraphQL; the wedge split; the lever left human.
- #1016 / #4816 — the `no-runs` facts line feeds `ship nudge`, which re-derives them itself;
  this verb's copy is for the skill's routing, not the nudge's authority.
- ADR 0061 — informational contexts carved out in one module; v1's two drifting jq copies.
- v1's settle-wait sourced its sibling script and could exit from its preamble with half its
  contract unprinted; a single verb with `--wait` has no preamble seam.
- #2118 — deployed-worker smokes stay out of the gating set; hermetic merge gates (ruled).

---

## `ship evidence`

**Invocation**

```
fabrika ship evidence 4321 --sha 03135b91 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head the bundle must be bound to |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line:
`evidence\t<present|pending|failed|absent|unknown>\t<sha>`. Then the evidence tuple, always:
`lookup\trun:<id|->\tartifact:<id|->\tstatus:<status|->` — every claim carries the lookup
evidence that makes it falsifiable from the report. On `present`, the manifest's checks as a
**status tally**, one line per status, count-descending with ties broken on the status:
`check\t<status-string>\t<count>` — and the same lines on `failed`, which is a bundle that was read,
so its check counts are what make the answer falsifiable. `checks` is an evidence-array under ADR
[0308](../../../../.decisions/0308-bounded-evidence-output-shape.md): step 5 routes off the five
states alone and no reader reads a check by name, so the rows collapse to counts. On `failed` the
non-passing checks are still **named**, on the notes channel.

With `--json`: `{"outcome":…,"sha":…,"run":…,"artifact":…,"checks":{"<status-string>":<count>…}}` —
the same tally the `check` lines carry, so the two channels cannot desync.

**The five states carry positive-evidence rules, verbatim from the #3991 law** (the fifth,
`failed`, [ruled on
#5067](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953))**:**

- `present` — the artifact fetched, unzipped (magic-number-checked: a 503 body saved as
  `.zip` is not a bundle, #3716), schema-version understood, `manifest.commit` exactly
  `--sha`, and every `checks[]` entry passing. The producer is the `run-evidence` workflow
  (`.github/workflows/run-evidence.yml`) publishing an actions artifact named
  `run-evidence`; the manifest's required keys are `schemaVersion` (numeric, `1`), `commit`,
  and `checks[]` of `{name, status}` (ADR 0054). `checks[]` entries carry a string `status`
  field, **not** a boolean `pass` — the wire shape is the producer's, and prose that says
  "boolean" ships a parser that reads everything falsy (#4392). Passing is the producer's own
  word, `pass`, and nothing else: `crabbox-manifest`'s `deriveChecks` writes `pass`/`fail` and the
  producer workflow appends its `bundle-node-core-free` entry in the same words. GitHub's
  check-conclusion vocabulary (`success`/`neutral`/`skipped`) belongs to `ship checks`, which
  reads check runs; against a bundle it matches nothing, so every passing check counted as
  failing and no bundle could attest a passing run (#5563). An unrecognized `status` reads as
  failing, never as passing — the same fail-closed posture the check-run rollup takes (#4552) —
  and accepting both vocabularies at once is not the fix, because it re-opens the same silent
  disagreement.
- `pending` — a producer run for this head exists and has not completed, **or** it completed
  **within the freshness window** and lists no `run-evidence` artifact. **Pending is not absent** —
  reporting it absent invents a CI gap (#3913).
- `absent` — positive evidence only: no producer workflow exists in the repo (the
  foreign-repo degradation, confirmed by a successful workflow-inventory read, never by a
  failed one), or no producer run exists at this head at all, or a run completed **outside the
  freshness window** and lists no `run-evidence` artifact, or the artifact is expired.
- `failed` — the artifact fetched and parsed, `manifest.commit` is exactly `--sha`, and at
  least one `checks[]` entry did not pass. The bundle is about **this** tree and it attests a
  failing run; the failing check names go to stderr. This is deliberately **not** `unknown`:
  widening `unknown` to cover it would make one word mean both "cannot bind this head" and
  "binds this head definitively", which is the opposite of the case it would be admitting.
- `unknown` — the lookup chain completed but the answer cannot bind this head: schema
  version unrecognized, or `manifest.commit` ≠ `--sha` (a bundle about some other tree is
  not evidence about this one). A *failed* read is not `unknown` — it is `11`.

**The freshness window is 120 seconds, and the clock it reads is named** ([ruled on
#5067](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953)). "A completed
producer run listing zero artifacts" is two different facts wearing one shape — a producer that
published nothing, and a producer whose upload has not surfaced in the artifact listing yet — and
without a window they collapse onto the wrong side of the pending-is-not-absent law. So: compare
the run's own `completed_at` against **the local clock at read time**; within 120s the missing
artifact is listing lag and the answer is `pending`, outside it the run published nothing and the
answer is `absent`. A run reporting no `completed_at` at all has nothing to compare, so it cannot
be shown fresh and reads `absent`. Which side a run fell on, with both operands, goes to stderr.

Transient-vs-absent is decided during the fetch (retry with backoff on 5xx, stderr captured,
never discarded — the swallowed 503 stderr is how #3716 shipped), and a transient that
survives the retries is `11`, never `absent`.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR or the `--sha` commit is proven absent |
| `11` | the run list, artifact list, or artifact content could not be read after retries — whether a bundle exists is UNKNOWN, never `absent` |
| `13` | a run or artifact enumeration is provably short of its declared count — a short list must not read as "no run for this head" |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship evidence: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship evidence: no commit <sha> on PR #<n>.` | 7 | refusal |
| `ship evidence: cannot read <what> for <sha>: <reason> — whether a bundle exists is UNKNOWN, never "absent" (#3716).` | 11 | refusal |
| `ship evidence: received <k> of <m> declared <runs|artifacts> — refusing the partial enumeration.` | 13 | refusal |

**Scope** — the producer workflow inventory, the head-SHA-bound run list (exact `head_sha`
match only), one artifact, one manifest. All fetch intermediates live under a per-run
`mktemp -d` — a fixed or PID-derived path lets two racing shippers read each other's bundle
(#3718, #2281).

**Examples**

```
$ fabrika ship evidence 4321 --sha 03135b91
evidence	present	03135b91
lookup	run:9182736450	artifact:2211334455	status:completed
check	pass	2
```

```
$ fabrika ship evidence 4322 --sha 9fe12ab0
evidence	pending	9fe12ab0
lookup	run:9182736999	artifact:-	status:in_progress
```

```
$ fabrika ship evidence 4323 --sha 7c31a0de
evidence	failed	7c31a0de
lookup	run:9182737111	artifact:2211334999	status:completed
check	fail	1
check	pass	1
```

The names the collapse drops from stdout ride the notes channel, which is what keeps the tally
honest: `ship evidence: the bundle binds 7c31a0de and 1 of its checks did not pass (unit) — it
attests a run, not a passing one.`

**Grounding**

- #3991 / #3913 — the state split and the pending-is-not-absent law; #5067's clause 6 is what
  keeps the second honest, by giving the listing lag a window instead of a coin flip.
- #3716 / #3693 — retries, captured stderr, the zip magic check; a 503 body reported as "no
  bundle" for a bundle present the whole time.
- #4392 — `checks[]` `status` is a string on the wire; the contract says so, so the parser
  cannot be written against invented prose.
- #5563 — which vocabulary that string is written in: the producer's `pass`/`fail`, not GitHub's
  conclusions, and unrecognized reads as failing.
- #4013 — the thin-skill rule: the skill never hand-rolls this fetch; this verb is the only
  reader.
- ADR 0054 / 0086 — the bundle contract and the foreign-repo degradation this transcribes.

---

## `ship threads`

**Invocation**

```
fabrika ship threads 4321 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line: `threads\t<count>` (`0` is a valid, proven answer:
nothing unresolved). Then one line per unresolved thread:
`thread\t<id>\t<bot|human>\t<path:line|pr-level>\t<opening-author>\t<first-160-bytes-of-body>`.

With `--json`: `{"outcome":"threads","count":<n>,"threads":[{id,class,site,author,authors,excerpt}…],"scanned":<n>}`.

**Class is a whitelist computed over the whole thread, not its first comment.** A thread is
`bot` only when **every** comment author in it has GraphQL `__typename == "Bot"` — v1 classed
by the first comment alone, so a human's "no, this matters" reply on a bot thread stayed
bot-resolvable; here one human participant makes the thread `human`. Everything not
positively `Bot` — User, Mannequin, Organization, a null/ghost author, an absent field — is
`human` by construction, never by enumeration: no login-suffix inference, no allowlist of
known bots. `human` unlocks nothing; only positive `bot` reaches the skill's judgment, and
`ship resolve` re-derives this same class before it writes (the structural anchor).

**The read is the sanctioned GraphQL exception** (see Substrate) — and it paginates both
layers: threads *and* each thread's comments, count-proved. v1 read `first: 100` threads and
one comment, unpaginated: a 101st unresolved human thread was invisible to the merge gate.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) |
| `11` | the thread read failed or the payload fails shape validation — whether unresolved threads exist is UNKNOWN, never `0` |
| `13` | the thread or comment enumeration is provably short of the declared count |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship threads: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship threads: cannot read #<n>'s review threads: <reason> — UNKNOWN, never zero.` | 11 | refusal |
| `ship threads: received <k> of <m> threads — refusing the partial sweep.` | 13 | refusal |
| `ship threads: received <k> of <m> comments on thread <id> — refusing the partial sweep.` | 13 | refusal |

**Scope** — every review thread on the PR with `isResolved: false`, both pagination layers
count-checked, every comment author's `__typename` read.

**Examples**

```
$ fabrika ship threads 4321
threads	1
thread	PRRT_kwDOLxx1	bot	src/cart.ts:14	github-advanced-security	Unused import: `Effect` is imported but never used.
```

```
$ fabrika ship threads 4322
threads	0
```

**Grounding**

- #2123 / #2121 — the bot thread that shipped past every gate; the read this feeds is the
  gate's input.
- v1's 100-thread cap and first-comment-only class — both real gate holes, both designed out
  by whole-thread pagination and all-authors classification.
- #4408 — the `__typename` ground truth (`github-advanced-security`,
  `copilot-pull-request-reviewer` are `Bot`), verified live in v1; the whitelist framing (only
  positive `Bot` unlocks anything) carried unchanged.
- `unresolved-threads-guard.yml` owns the *accounting* question (is every open thread named
  in the verdict); this verb never recomputes it — it answers "which, and by whom", the
  question the retained judgment consumes.

---

## `ship resolve`

**Invocation**

```
fabrika ship resolve 4321 --thread PRRT_kwDOLxx1 [--repo <owner/name>] [--json]
```

The rationale arrives on **stdin only** — no `--body`, no `--body-file`; a path flag is how a
machine-local path reaches a public surface while the poster reads success.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--thread` | string | yes | — | the review-thread node id to resolve |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | markdown | yes | — | the written rationale; it is the post-hoc audit trail and is not optional |

**Output** — machine channel. One line: `resolved\t<thread-id>\t<comment-url>`.
With `--json`: `{"outcome":"resolved","thread":…,"commentUrl":…}`.

**What the operation does, in order — each step gates the next:**

1. **Re-derive the thread's state and class** with the same read `ship threads` performs —
   never trusting the caller's dispatch. Already resolved, or not positively bot-classed
   (any non-`Bot` comment author), is the `16` refusal: the judgment this verb serves is
   scoped to bot threads by founder ruling, and the verb is that scope's enforcement — a
   confused caller cannot resolve a human's objection.
2. **Leak-scan the rationale** (`report/leaks.ts`, imported) — `5`/`6` as in the shared
   section.
3. **Post the rationale reply** to the thread.
4. **Fire the `resolveReviewThread` mutation** (the second half of the sanctioned GraphQL
   exception).
5. **Read back**: re-read the thread; require `isResolved: true` and the reply present
   (compared through `normalizeForReadback`). A resolve that trusts the mutation's response
   instead of the re-read is the trust-the-response defect this group bans everywhere.

Steps 3–4 are one logical write: a reply that lands without the resolve is reported by the
read-back as `9` with the state named (the thread keeps the rationale; a human resolves or
the verb is re-run — re-running is safe, the reply upserts by rationale identity rather than
duplicating).

**Deliberately no `--sha` and no `12` seat**, unlike the group's other write verbs: a thread —
unlike a verdict or an enqueue — is not head-bound, and step 1 re-derives the thread's LIVE
state at write time, so there is no stale carried observation for `12` to guard. The
head-sensitivity lives in the *judgment* (a nit because the diff already complies), and a
moved head re-enters at the skill's step 1 by the skill's own law.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — a resolve with no written rationale is unauditable and refused |
| `5` | the rationale carries a machine-local path |
| `6` | the rationale is a bare `@` path reference |
| `7` | the PR or the thread is proven absent (404) |
| `8` | the reply post, the resolve mutation, or the confirming re-read failed — UNKNOWN what landed; re-read before retrying |
| `9` | the write landed but the read-back does not show the thread resolved with the rationale present |
| `11` | the thread's state or class could not be re-derived — nothing was written |
| `16` | proven: the thread is already resolved, or is not positively bot-classed — this verb only resolves bot threads; a human thread routes to its author |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship resolve: no rationale on stdin — a silent resolve discards an objection unauditably; write why.` | 3 | refusal |
| `ship resolve: the rationale carries a machine-local path at line <k> (<class>) — cite it repo-relative (#4994's class routes to a human, see the shared section).` | 5 | refusal |
| `ship resolve: the rationale is a bare "@" path reference — the text never arrived. Send its bytes on stdin.` | 6 | refusal |
| `ship resolve: thread <id> not found on PR #<n>.` | 7 | refusal |
| `ship resolve: thread <id> is not positively bot-classed (author <login> is <typename>) — only a bot thread is resolvable here; a human objection is theirs to resolve.` | 16 | refusal |
| `ship resolve: thread <id> is already resolved — nothing to do.` | 16 | refusal |
| `ship resolve: cannot re-derive thread <id>'s state: <reason> — nothing was written.` | 11 | refusal |
| `ship resolve: <reply|resolve> failed: <reason> — UNKNOWN what landed; run \`fabrika ship threads <n>\` before retrying.` | 8 | refusal |
| `ship resolve: the read-back does not show <id> resolved with the rationale — inspect the thread.` | 9 | refusal |

**Scope** — one thread: its full comment list (for the class re-derivation), one reply
write, one mutation, one re-read.

**Examples**

```
$ fabrika ship resolve 4321 --thread PRRT_kwDOLxx1 <<'EOF'
Resolving: the unused import this flags was removed by the follow-up commit at this head.
EOF
resolved	PRRT_kwDOLxx1	https://github.com/kamp-us/phoenix/pull/4321#discussion_r5154991
```

**Grounding**

- Founder ruling (brief #4709, 2026-08-08): the nit-vs-substantive call stays in the skill;
  this verb is the mechanics under it, and its `16` is the ruling's structural anchor — the
  judgment is unreachable outside positively-bot threads.
- The ruleset's `required_review_thread_resolution` makes this the pipeline's only
  thread-clearing mechanism; the deadlock alternative (route to repair, which cannot resolve)
  was rejected on the same ruling.
- v1's resolve was a raw GraphQL mutation in prose, unverified; the read-back and the
  reply-then-resolve ordering (rationale first, so an interrupted run never leaves a silent
  resolve) are the rebuild.

---

## `ship enqueue`

**Invocation**

```
fabrika ship enqueue 4321 --sha 03135b91 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head every gate verified; the arm binds to it |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line: `enqueued\t<sha>\t<queued|settling>` — `queued` when
the entry is already visible, `settling` when the arm landed and the queue entry has not yet
surfaced (the normal race; `ship reconcile` owns everything after this line).
With `--json`: `{"outcome":"enqueued","sha":…,"entry":"queued"|"settling"}`.

**The arm carries no merge-method flag, by construction** — there is no flag to pass: the
queue owns the method, and v1's documented hazard is that a `--squash` alongside `--auto`
conflicts with the queue and no-ops the enqueue silently at exit 0. The verb re-resolves the
live head first and refuses `12` on drift — the enqueue is the one action every gate's
`--sha` was protecting; arming at a moved head ships a tree nobody verified.

**A definite `mergeable_state` is asserted BEFORE the arm** ([ruled on
#5067](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233191264)). The precondition
sits here and not in the post-arm confirm step, which already owns a different question (whether
the intent parked) and where an assertion would arrive after the write it was meant to prevent.
The residual window it closes is measured, not assumed: **probed live, GitHub accepts the arm on a
conflicted PR under a queue-governed base and parks the intent on it** — no platform-side refusal,
`mergeable_state` unchanged at `dirty` — so without this precondition a PR that cannot merge is
armed and reported as `enqueued … settling`, indistinguishable from a healthy arm.

The assertion and its indefinite-value handling are **one unit, and neither ships without the
other**: `mergeable` is computed lazily by GitHub, so a `null` / `unknown` read is routine and is
**not an answer**. An indefinite read is re-read up to **3 times, 2 seconds apart**; if it is
*still* indefinite the answer is UNKNOWN and the verb refuses `11` with nothing armed. A gate that
read the indefinite value as green would be worse than no gate — a read that could not produce a
definite answer must never resolve to one. A read that *fails* is likewise `11`, never a pass.
What the verb does **not** do is judge the definite value: a definite `dirty` is an answer, and the
arm proceeds to its own error discrimination on `8`. Definiteness is the precondition; the
platform's verdict on mergeability is not this verb's to overrule.

After the arm,
the verb reads the PR back: `auto_merge: null` **post-enqueue is expected** (the queue
consumes the intent) and is never read as a jam — the jam discriminator is the arm's error
response, quoted verbatim on `8`.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404), closed, or already merged (an idempotent success belongs to `ship scope`'s answer, not to an arm) |
| `8` | the arm request, or its confirming post-arm read-back, failed — the error quoted; whether an intent is parked is UNKNOWN, so the caller runs `ship disarm --site refuse` before stopping |
| `11` | the live head could not be read, the mergeability could not be read, or the mergeability was still indefinite after the polls — nothing was armed |
| `12` | the live head moved past `--sha` — every verdict upstream bound a tree that is gone; re-enter at step 1 |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship enqueue: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship enqueue: PR #<n> is <closed|merged> — nothing to enqueue.` | 7 | refusal |
| `ship enqueue: cannot read #<n>'s live head: <reason> — nothing was armed.` | 11 | refusal |
| `ship enqueue: cannot read #<n>'s mergeability: <reason> — nothing was armed.` | 11 | refusal |
| `ship enqueue: #<n>'s mergeable_state is still indefinite after <k> polls — mergeability is UNKNOWN, never green; nothing was armed.` | 11 | refusal |
| `ship enqueue: mergeable_state is <state> (mergeable: <true|false>) — a definite read; arming.` | 0 | notice |
| `ship enqueue: the confirming timeline read never reached a terminal page — the entry is unproven, so this answers settling.` | 0 | notice |
| `ship enqueue: the live head is <live>, gates ran at <sha> — refusing to arm a tree nobody verified.` | 12 | refusal |
| `ship enqueue: the arm failed: "<error>" — whether an intent is parked is UNKNOWN; disarm before stopping.` | 8 | refusal |
| `ship enqueue: the arm was sent and the confirming read-back failed: <reason> — whether an intent is parked is UNKNOWN; disarm before stopping.` | 8 | refusal |

**Scope** — one PR's live head, its mergeability (re-read until definite or refused), one arm
request, one read-back of the PR's merge state.

**Examples**

```
$ fabrika ship enqueue 4321 --sha 03135b91
enqueued	03135b91	queued
```

**Grounding**

- The method-flag no-op hazard (v1 SKILL step 4) — designed out by having no method surface
  at all.
- #1930 — `mergeQueueEntry --json` is rejected by shipped `gh`; the entry read here is the
  REST shape `ship reconcile` shares.
- `auto_merge: null` post-enqueue is expected (v1 step 5's law); the jam discriminator is the
  error string, so the false-jam re-arm loop is unreachable.
- ADR 0198 — this is the only verb that arms; every other path is a disarm site.
- #5067 clause 8 / #5144 — the pre-arm mergeability precondition and its probe: the arm is not
  refused by the platform on a conflicted PR, so the gate is load-bearing rather than redundant.

---

## `ship merge`

**Invocation**

```
fabrika ship merge 4321 --sha 03135b91 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head every gate verified; the landing binds to it |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line: `merged\t<merge-commit-sha>\t<squash|merge|rebase>`.
With `--json`: `{"outcome":"merged","sha":…,"method":…,"mergeCommit":…}`.

**This is a second landing path, not a merge-method flag on the first.** `ship enqueue` argues,
correctly, that a method flag alongside the queue arm conflicts with the queue and no-ops the
enqueue silently at exit 0 — but that argument is entirely about a queue-governed base, and says
nothing about a base with no queue. Where no queue exists, `ship enqueue` had nothing to arm and no
other verb could land anything, so a lane in a consuming repo built, reviewed and gated correctly
and then stopped one inch short of shipped (#6018, observed on the first non-phoenix lane). The
method surface therefore lives here, on the path where the queue is **proven absent**, and
`ship enqueue` still carries none.

**The queue check is a refusal, never a fallback.** A base a merge queue governs is `ship enqueue`'s
and this verb refuses `16` pointing there — a direct merge into a queue-governed base walks past the
gate the queue exists to run. The regime is read off the **branch's** active rules, the same read
`ship disarm` uses, never this PR's queue history. An unreadable regime refuses `11`: this verb never
lands on a base whose regime it could not read, which is also what makes `ship scope`'s degraded
`landing unknown` safe.

**The method is read, never guessed.** The repository's `allow_squash_merge` /
`allow_merge_commit` / `allow_rebase_merge` decide it, preferring squash, then the merge commit,
then rebase. Squash leads because its default subject ends `(#<pr>)`, which is the anchor
`ship reconcile`'s base-branch cross-check proves a landing with; a rebase landing publishes the
branch's own subjects and that cross-check cannot see it. A repository permitting none of the three
refuses `19` — its own seat rather than a fold into `16`, because the two route opposite ways: `16`
sends the run onward to `ship enqueue`, `19` ends the lane at a human with repository-settings
access.

**A definite `mergeable_state` is asserted before the write**, on the same poll policy
`ship enqueue` uses and out of the same shared read — indefinite is re-read up to 3 times, 2 seconds
apart, and a still-indefinite value is UNKNOWN and refuses `11`. Unlike the arm, this verb also acts
on the definite value: a definite `mergeable: false` refuses `16` rather than sending a call the
endpoint will reject with a 405 that is indistinguishable, from the outside, from a write whose
outcome nobody knows.

**The landing is proven, not claimed.** The write hands the platform the **full** live head as its
`sha` parameter, so the platform rejects it if the head moved — a second drift guard under the
verb's own `12`. After the write, `merged` **and** the merge commit are read back off the PR: the
merge call's own response is the writer's claim about its own write, and a `merged: true` with no
commit behind it is a claim with no evidence. An unreadable read-back is `8` and never a success,
because whether the PR landed is exactly what is UNKNOWN there.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404), closed, or already merged (an idempotent success belongs to `ship scope`'s answer, not to a landing) |
| `8` | the merge request, or its confirming read-back, failed — whether the PR landed is UNKNOWN; re-read the PR before stopping |
| `9` | the merge was sent and the read-back does not show it merged at a commit — the landing is not proven |
| `11` | the live head, the landing path or the mergeability could not be read, or the mergeability was still indefinite after the polls — nothing was merged |
| `12` | the live head moved past `--sha` — every verdict upstream bound a tree that is gone; re-enter at step 1 |
| `16` | proven: a merge queue governs the base (run `ship enqueue`), or the PR is definitely not mergeable — nothing was merged |
| `19` | the repository permits no merge method at all — a human enables one in the repository settings |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship merge: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship merge: PR #<n> is <closed\|merged> — nothing to merge.` | 7 | refusal |
| `ship merge: <base> is not queue-governed and <repo> permits <method> — landing directly.` | 0 | notice |
| `ship merge: mergeable_state is <state> (mergeable: true) — a definite read; merging.` | 0 | notice |
| `ship merge: cannot read #<n>'s live head: <reason> — nothing was merged.` | 11 | refusal |
| `ship merge: cannot read <base>'s landing path: <reason> — nothing was merged.` | 11 | refusal |
| `ship merge: cannot read #<n>'s mergeability: <reason> — nothing was merged.` | 11 | refusal |
| `ship merge: #<n>'s mergeable_state is still indefinite after <k> polls — mergeability is UNKNOWN, never green; nothing was merged.` | 11 | refusal |
| `ship merge: the live head is <live>, gates ran at <sha> — refusing to merge a tree nobody verified.` | 12 | refusal |
| ``ship merge: a merge queue governs <base> — the queue owns the method and the landing; run `fabrika ship enqueue` instead.`` | 16 | refusal |
| `ship merge: #<n> is not mergeable (mergeable_state: <state>) — a definite read; nothing was merged.` | 16 | refusal |
| `ship merge: <repo> permits no merge method — squash, merge-commit and rebase are all disabled, so nothing can land on <base>; a human enables one in the repository settings.` | 19 | refusal |
| `ship merge: the merge failed: "<error>" — whether #<n> landed is UNKNOWN; re-read the PR before stopping.` | 8 | refusal |
| `ship merge: the merge was sent and the confirming read-back failed: <reason> — whether #<n> landed is UNKNOWN; re-read the PR before stopping.` | 8 | refusal |
| `ship merge: the merge was sent and the read-back shows merged: <bool> at merge commit <sha\|-> — the landing is not proven.` | 9 | refusal |

**Scope** — one PR's live head, its base branch's active rules, the repository's permitted merge
methods, the PR's mergeability (re-read until definite or refused), one merge request, one
read-back of `merged` plus the merge commit.

**Examples**

```
$ fabrika ship merge 4321 --sha 03135b91
merged	5c7d1e930a2b4f6d8e0c1a3b5d7f9e1c3a5b7d9f	squash
```

```
$ fabrika ship merge 4321 --sha 03135b91
ship merge: a merge queue governs main — the queue owns the method and the landing; run `fabrika ship enqueue` instead.
$ echo $?
16
```

**Grounding**

- #6018 — the gap itself: `ship`'s only landing verb armed a queue, so a repo with
  `allow_auto_merge: false` and `mergeQueue: null` had no verb that could land a PR, and every
  stage before the merge was already portable.
- `ship enqueue`'s method-flag argument, kept intact — the reason this is a second path rather
  than a flag on the first.
- ADR 0198 — arming is `ship enqueue`'s alone and every other path is a disarm site; a direct
  landing arms nothing, so it opens no new disarm site.
- The `operate` skill names `ship` the pipeline's single merge authority and the merge into the
  default branch "the shipper's, once" — so the answer to a queueless repo is a verb here, not a
  driver reaching for `gh pr merge`.

---

## `ship reconcile`

**Invocation**

```
fabrika ship reconcile 4321 [--polls 16] [--cadence-seconds 30] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--polls` | integer | no | `16` | classification attempts before the horizon |
| `--cadence-seconds` | integer | no | `30` | sleep between polls (between only — no trailing sleep) |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line:
`reconcile\t<landed|ejected|unresolved|parked>\t<polls-used>\t<horizon-seconds>`. All four
are proven answers at exit `0` — **`ejected` is an answer, not an error**, so no loop shape
around this verb can launder it into a success or a crash (#4557: v1's healthy KEPT path
exited 1 off a trailing conditional, and its reconcile loop's predicate could not see the
ejection marker). `unresolved` means still-queued at the horizon — neither a landing nor a
failure; the honest words are the contract, and "auto-merges on green" is not in the
vocabulary (#4403). `parked` means the arm never entered a queue on a queue-governed base —
the enqueue did not take effect.

With `--json`: `{"outcome":…,"polls":<n>,"horizonSeconds":<n>}`.

**Per-poll classification, precedence order, all signals REST + paginated:** `landed` on PR
`merged:true`, or on a base-branch squash whose subject **ends with** `(#<pr>)` (the
timeline lags the truth by up to ~65 minutes, #4057; the ending anchor keeps `… (#3924)
(#4010)` from crediting #3924). `ejected` only on a timeline `removed_from_merge_queue`
event **not paired** with a `merged` event — the queue consuming an entry emits the same
removal ≤1s before the merge, and reading the bare removal is the #4155 false-ejection.
`queued` on a live entry or an `added_to_merge_queue` newer than any removal. Anything
unreadable in a poll classifies that poll `pending` — a miss can only keep polling, never
mint `landed` or `ejected` (the fail-safe direction). The timeline read paginates **to a terminal
page**, and a read that never reaches one refuses `13` rather than polling on: a 30-event first
page read as the whole history is #4193, and an unexhausted read is that same hole with the
pages joined.

**The horizon is stated, not defended:** default 16×30s ≈ 7.5 minutes of dwell against a
measured queue dwell of 5–10 minutes; `unresolved` at the horizon is the expected outcome of
a healthy long dwell, and the caller's report says so in those words. The verb never disarms
— it is a read; the skill fires `ship disarm --site ejected` / `--site post-enqueue` on the
`ejected` / `parked` answers (the sites exist precisely for these two answers, and the skill
text carries the pairing).

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) |
| `11` | every poll in the budget failed to read — the outcome is UNKNOWN, distinct from `unresolved` (which is a *successful* observation of a still-queued PR) |
| `13` | the timeline read — for which the platform declares no count — never reached a terminal page, and the classification would rest on it |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship reconcile: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship reconcile: every poll failed to read #<n>: <last reason> — the outcome is UNKNOWN, not "unresolved".` | 11 | refusal |
| `ship reconcile: the timeline read never reached a terminal page — pagination is unexhausted; refusing to classify over a truncated history.` | 13 | refusal |

**Scope** — one PR's merge state, timeline (paginated), and the base branch's recent
commits, re-read per poll.

**Examples**

```
$ fabrika ship reconcile 4321
reconcile	landed	3	450
```

```
$ fabrika ship reconcile 4322
reconcile	unresolved	16	450
$ echo $?
0
```

**Grounding**

- #4557 — both defects named there die here: `ejected` is a first-class exit-0 answer the
  caller cannot miss, and no trailing conditional exists to launder a healthy exit.
- #1906 / #1921 / #4155 / #4057 / #4193 — the settle window, the paired-removal rule, the
  base-branch cross-check with its ending anchor, and full pagination: the four
  wrong-but-plausible queue states the classifier must not emit, each with its incident.
- #4403 — the horizon honesty rule and the banned vocabulary, carried as contract.

---

## `ship disarm`

**Invocation**

```
fabrika ship disarm 4321 --site preflight [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--site` | enum | yes | — | `preflight` \| `refuse` \| `post-enqueue` \| `ejected` — the ADR 0198 lifecycle site; the policy differs per site |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line: `disarm\t<kept|disarmed>\t<site>\t<reason>` where
`kept` reasons are the closed set `merged` / `live-queued` / `not-armed` /
`pre-queue-regime` (a queue-less base branch where `--auto` *is* the merge mechanism —
post-enqueue only), and the `disarmed` reason is the single token `cleared` (proven by the
confirming re-read). With `--json`: `{"outcome":…,"site":…,"reason":…}`.

**The policy is fail-closed at every indeterminate probe:** an unreadable armed-state reads
armed (clearing a never-armed intent is a no-op; leaving a parked one is an ungated enqueue —
#3700's one-second window); an unreadable queue regime reads queue-governed (so a failed read
cannot grant the pre-queue keep); the regime is the **base branch's**, never this PR's queue
history (a per-PR proxy exempts exactly the parked intent this exists to clear). A `disarmed`
answer is proven by **re-reading `auto_merge` after the write** — the disable call's own exit
status fuses failure with nothing-armed and is never trusted. A live queue entry is never
disturbed (`kept` `live-queued`).

**Exit status**

| Code | Trigger |
|---|---|
| `8` | the disarm was attempted and the re-read cannot confirm the intent is clear — the caller's report carries `merge intent: NOT cleared`; a failed disarm never rewrites the stop's disposition, only its report |
| `10` | `--site` is not one of the four lifecycle sites |
| `11` | the armed-state read failed before any write — whether an intent exists is UNKNOWN, nothing was attempted |

(No `7` seat: a disarm aimed at a merged or absent PR answers `kept` with the reason — the
intent is structurally moot, which is a proven answer, and refusing would make the safety
verb the fragile one on exactly the cleanup paths that need it.)

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship disarm: --site <v> is not a lifecycle site (preflight, refuse, post-enqueue, ejected).` | 10 | refusal |
| `ship disarm: cannot read #<n>'s merge state: <reason> — whether an intent is armed is UNKNOWN.` | 11 | refusal |
| `ship disarm: disarm attempted, re-read cannot confirm clear: <reason> — report "merge intent: NOT cleared".` | 8 | refusal |

**Scope** — one PR's `auto_merge` state, its queue entry, the base branch's queue regime;
one disable write on the disarm branch; one confirming re-read.

**Examples**

```
$ fabrika ship disarm 4321 --site preflight
disarm	kept	preflight	not-armed
```

```
$ fabrika ship disarm 4322 --site ejected
disarm	disarmed	ejected	cleared
```

**Grounding**

- ADR 0198 / #3700 / #3723 — the four-site lifecycle and the one-second-after-approval
  incident that minted it.
- v1's disarm read `--disable-auto`'s fused exit code scar (failure ≡ nothing-armed) and
  fixed it with the re-read; the re-read is the contract here, the fused code never consulted.
- #4758 (open) — what an *entry-path* refusal emits to the board is an undecided fork; this
  verb keeps Site-1 mechanical and takes no position on the board signal.

---

## `ship nudge`

**Invocation**

```
fabrika ship nudge 4321 --sha 9fe12ab0 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head whose zero-runs state is being remedied |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line: `nudged\t<sha>` — the close→reopen landed, both legs
verified, CI re-trigger now the platform's. With `--json`: `{"outcome":"nudged","sha":…}`.

**The verb trusts nothing it was told.** In order:

1. **Re-derive the precondition itself**: at `--sha`, zero check runs, zero commit statuses,
   ≥1 workflow with a matching trigger, PR open. Any of those reads failing is `11`; the
   state *proven otherwise* — runs exist, no workflows, PR not open — is `16`, refused
   without touching the PR (#4816: a mis-dispatched nudge close→reopened a live green head
   and left a false comment on it; the caller's `ship checks` output is routing, never
   authority).
2. **Prove at-most-once per head**: count `reopened` events since the head commit's push
   date; ≥1 refuses on `16` (this head was nudged; a second nudge is escalation, not retry).
3. **Close, verify closed, reopen, verify open** — each leg read back. The close landing
   without a confirmed reopen is `17`, the loudest code in the group: the PR may be left
   closed, and the message says to reopen by hand *now*. The head ref is untouched by
   construction (close/reopen preserves it, so SHA-bound verdicts survive — the reason this
   remedy and not a rebase).

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) |
| `11` | a precondition read failed — nothing was proven, nothing touched |
| `12` | the live head moved past `--sha` — the zero-runs state being remedied belongs to a tree that is gone |
| `13` | the timeline read for the reopened-event count never reached a terminal page — the platform declares no count for it, and an unexhausted history must not license a second nudge |
| `16` | proven: not in the dropped-trigger state (runs exist / no workflows / PR not open), or this head was already nudged once |
| `17` | the close landed and the reopen is unconfirmed — **the PR may be closed; reopen it by hand before anything else** |
| `8` | the close itself failed — nothing changed state |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship nudge: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship nudge: cannot read <what>: <reason> — the dropped-trigger state is UNKNOWN; nothing was touched.` | 11 | refusal |
| `ship nudge: the live head is <live>, not <sha> — the state you diagnosed is another tree's.` | 12 | refusal |
| `ship nudge: #<n> is not in the dropped-trigger state (<why>) — refusing to touch it (#4816).` | 16 | refusal |
| `ship nudge: head <sha> was already nudged (<k> reopened events since push) — a second nudge is escalation, not retry.` | 16 | refusal |
| `ship nudge: the timeline read never reached a terminal page — pagination is unexhausted; refusing to count reopens over a truncated history.` | 13 | refusal |
| `ship nudge: the close failed: <reason> — nothing changed state.` | 8 | refusal |
| `ship nudge: the close landed and the reopen is UNCONFIRMED: <reason> — PR #<n> may be CLOSED. Reopen it by hand now.` | 17 | refusal |

**Scope** — one PR's check runs, statuses, workflow inventory, timeline (for the reopened
count), and the two PATCH writes with their read-backs.

**Examples**

```
$ fabrika ship nudge 4322 --sha 9fe12ab0
nudged	9fe12ab0
```

```
$ fabrika ship nudge 4321 --sha 03135b91
ship nudge: #4321 is not in the dropped-trigger state (14 check runs exist at 03135b91) — refusing to touch it (#4816).
$ echo $?
16
```

**Grounding**

- #1016 / PR #1013 — the dropped `pull_request: synchronize` trigger this remedies.
- #4816 / #4830 / #4482 — self-derived precondition, refusal-without-mutation, and the
  mutant-tested teeth v1 grew after trusting its dispatch once; here the shape is the verb's
  unit tests.
- v1's unguarded PATCH pair — close-succeeded-reopen-failed reported "nudged" with the PR
  left closed; `17` exists so that state is unmissable.

---

## `ship note`

**Invocation**

```
fabrika ship note 4321 [--repo <owner/name>] [--json]
```

The body arrives on **stdin only**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | markdown | yes | — | the durable stop-path note: the terminal token and its reason, as the skill's terminal vocabulary phrases them |

**Output** — machine channel. One line: `noted\t<comment-url>`.
With `--json`: `{"outcome":"noted","commentUrl":…}`.

Leak-scanned (`report/leaks.ts`, imported), posted as a new comment (stop-path notes are a
history, not a state — each run's refusal is its own record), read back through
`normalizeForReadback`. A note on a closed or merged PR is legal — refusals happen at every
lifecycle stage, and the durable record is the point (#1928: the silent dead shipper).

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
| `ship note: no body on stdin — a silent stop is the #1928 defect; write the reason.` | 3 | refusal |
| `ship note: the body carries a machine-local path at line <k> (<class>) — cite repo-relative (#4994's class routes to a human).` | 5 | refusal |
| `ship note: the body is a bare "@" path reference — the bytes never arrived; pipe them.` | 6 | refusal |
| `ship note: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship note: create failed: <reason> — UNKNOWN whether the note landed; re-read before retrying.` | 8 | refusal |
| `ship note: the read-back does not match — inspect comment <id>.` | 9 | refusal |
| `ship note: cannot read PR #<n>: <reason> — nothing was posted.` | 11 | refusal |

**Scope** — one PR, one comment write, one read-back.

**Examples**

```
$ fabrika ship note 4322 <<'EOF'
ship: refused — head CI red at 9fe12ab0 (`unit tests` failure). Routed to heal-ci. Merge intent disarmed at site refuse.
EOF
noted	https://github.com/kamp-us/phoenix/pull/4322#issuecomment-5155001122
```

**Grounding**

- #1928 — every non-enqueue path leaves a durable signal; this verb is the signal's single
  sanctioned emitter (a freelanced `gh api -f body=@file` is the #3018 bypass class).
- #4758 (open) — the board-signal shape for entry-path refusals is undecided; this verb posts
  what the skill words and takes no position on that fork.

---

## `ship release`

**Invocation**

```
fabrika ship release 4321 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number (merged or landing) |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. One line: `release\t<queued|n/a|no-issue>\t<flag-key|->` —
`queued` means the linked issue now carries `status:awaiting-release` (read back); `n/a`
means not a dark ship, a proven answer, third field `-`; `no-issue` means a dark-ship signal
FIRED and there is no linked issue to label — the flag key is printed and the skill
escalates to a human, because a dark ship the release queue cannot see is the exact hazard
this verb exists to prevent (never folded into `n/a`).
With `--json`: `{"outcome":…,"flagKey":…,"issue":<n|null>}`.

**Detection is three ground-truth signals over the PR itself, any one sufficient:** (a) the
diff adds a flag declaration (a `FlagshipFlag(` / `defaultVariation:` addition in the flag
registry module, `apps/web/worker/features/flagship/resources.ts`); (b) the PR body carries a
`Flag:` / `Flag key:` line with a kebab-case key (heading/bold tolerated); (c) the body names
a key **declared in that same registry file at the PR's base ref** inside a gating-context line
(fence-stripped, whole-token, gating-word-scoped — the context scoping is what keeps a prose
mention of an old flag from minting a phantom release). The linked
issue's inherited `Containment:` stamp is **never** read — it describes the epic, not this
PR, and reading it queued a phantom release (#1257). No signal → `n/a`; a signal with no
linked issue → `no-issue` (see Output — a proven answer, never `n/a`).
The label write is read back; a failed or unconfirmed write is `8`/`9`, never `queued` —
v1's unverified label POST could report a release queued that no human would ever find.
The write is taxonomy-guarded first: `status:awaiting-release` absent from the repo's labels
refuses on `23` rather than let GitHub's POST mint it (#4285, #6054), and the taxonomy is read
only on the path that would post — `n/a` and `no-issue` read none.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) |
| `8` | the label write, or its confirming re-read, failed — UNKNOWN; the release queue may be missing a real dark ship, say so loudly |
| `9` | the label write landed but the read-back does not show it |
| `11` | the diff, body, flag registry, or linked issue could not be read — dark-ship-ness is UNKNOWN, never `n/a` |
| `13` | the changed-file or diff enumeration is provably short — a partial diff must not read as "no flag declaration added" |
| `23` | `status:awaiting-release` is absent from the repository's taxonomy — refused rather than let the POST mint it (#4285); guarded only on the path that would post, so `n/a` and `no-issue` read no taxonomy |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ship release: PR #<n> not found in <repo>.` | 7 | refusal |
| `ship release: cannot read <what>: <reason> — whether this is a dark ship is UNKNOWN, never "n/a".` | 11 | refusal |
| `ship release: label write failed: <reason> — a real dark ship may be missing from the release queue; escalate.` | 8 | refusal |
| `ship release: label read-back does not show status:awaiting-release on #<issue> — inspect it.` | 9 | refusal |
| `ship release: received <k> of <m> declared files — refusing to scan a truncated diff for flag signals.` | 13 | refusal |
| `ship release: label "status:awaiting-release" is absent from <repo>'s taxonomy — refusing to create it (#4285). A real dark ship is not queued; run `fabrika status bootstrap label-taxonomy` and re-run.` | 23 | refusal |
| `ship release: cannot read <repo>'s label taxonomy: <reason> — nothing was written, and a real dark ship is not queued; escalate.` | 11 | refusal |

**Scope** — one PR's diff and body, the flag registry file at the PR's base ref, the repository's
label taxonomy (read only when a write is due), one linked issue's labels; one label write with
read-back.

**Examples**

```
$ fabrika ship release 4321
release	n/a	-
```

```
$ fabrika ship release 4330
release	queued	sozluk-vote-widget
```

**Grounding**

- ADR 0083 / 0062 — agents deploy, humans release; the label is the seam and the whole
  action.
- #1257 / #1211–#1213 — the phantom release from the inherited containment stamp; the stamp
  is unread by contract.
- #2086 / #2897 / #2843 — signal (c)'s coverage and its context scoping: the reused-flag miss
  and the prose-mention phantom, both named so the implementer keeps both edges.
- v1's unguarded label POST and `|| true`-blanketed registry read — the false-positive and
  silent-miss shapes this verb's `8`/`9`/`11` exist for.

---

## Where the eight under-determined clauses were ruled

[#5067](https://github.com/kamp-us/phoenix/issues/5067) collected eight clauses this spec left
under-determined and closed them. Each is cited at its own site above; the index is here so a later
reader can tell a **founder-direct** ruling from an **agent-delegated** one without re-reading the
thread, which is the one thing the inline citations cannot show at a glance.

| Clause | Ruled | Grade |
|---|---|---|
| 1 — the completeness proof for reads with no declared count | [comment 5233120953](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953) | agent-delegated |
| 2 — what `facts workflows:<n>` counts | [comment 5233120953](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953) | agent-delegated |
| 3 — the auto-merge porcelain carve in Substrate | [comment 5233120953](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953) | agent-delegated |
| 4 — the ref the CODEOWNERS read uses | [comment 5233160017](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233160017) | **founder-direct** |
| 5 — `failed` as the fifth evidence state | [comment 5233120953](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953) | agent-delegated |
| 6 — the 120s freshness window and its clock | [comment 5233120953](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233120953) | agent-delegated |
| 7 — the roster when CODEOWNERS names more than one team | [comment 5233188966](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233188966) | **founder-direct** |
| 8 — the pre-arm mergeability precondition | [comment 5233191264](https://github.com/kamp-us/phoenix/issues/5067#issuecomment-5233191264) | agent-delegated |

## The eval-enumeration obligation (leaf rule)

Stated once, in [`SKILL.md`](SKILL.md)'s "Eval enumeration" section — the single home the
#4891 obligation lives in. This spec adds nothing to it; the eval mechanics belong to #4649.

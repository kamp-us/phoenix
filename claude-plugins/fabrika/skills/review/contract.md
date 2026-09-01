# `/review` — derived CLI contract

**Skill:** [`review`](SKILL.md) · **Authoring brief:** [#4959](https://github.com/kamp-us/phoenix/issues/4959) · **Date:** 2026-08-08

These verbs live in `packages/fabrika-cli/`, binary `fabrika`, grouped under a `review`
subcommand, beside the `adr`, `report`, `triage` and `wire` groups already implemented
there. The [CLI interface convention](../../docs/cli-interface-convention.md) governs them; where
this spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill**
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Every verb
below is implemented from scratch. v1's four review gates and their 62 `scripts/` were read for
their semantics and their scars — each Grounding section names what the v1 counterpart gets wrong
and what this spec does instead — but no clause defers to one, and none is invoked.

**Substrate.** Effect CLI verbs on the `@effect/platform-node` seam the sibling groups use;
GitHub access per
[skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql).
Named because a spec that leaves the substrate open makes the implementer guess (#4734).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `review scope` | the PR's head SHA, linked issue, artifact-class partition of its changed files, the namespace set that partition requires and which of those are routed to another gate, the `self` / `harness` flags, and whether the diff requires the `governance` namespace | partitioning paths against a fixed class map, deriving the merge gate's own required set from it, and failing closed on an empty file list is mechanical; what to do with each class is judgment |
| `review diff` | the PR's diff bytes, with truncation refused rather than silently passed through | fetching and proving completeness is mechanical; reading the diff is the whole judgment layer |
| `review criteria` | the linked issue's acceptance-criteria block, read through the registered `acceptance-criteria` wire format | fetch + registered parse + checkbox states are mechanical; grading a criterion is judgment |
| `review ci` | the live CI check-run rollup at a head, fail-closed on incomplete enumeration | classifying check runs and proving the enumeration complete is mechanical (#4552, #3999); weighing a red check is judgment |
| `review verdicts` | every verdict marker on the PR, per namespace, each with its `Current` / `Stale` / `Unbindable` binding against the live head and the content it bound | comment sweep + registered parse + `bindToContent` is mechanical; what a stale marker means for this round is judgment |
| `review deviations` | the PR body's `## Deviations` section state (found / absent / malformed), its entries, and the Tier-M token scan over the diff | section detection and token scanning are mechanical; matching entry *substance* against findings is judgment (Tier R) |
| `review post` | the single sanctioned verdict emit: compose through the `verdict-marker` wire format, bind to the inspected head at post time, post one comment per namespace at that head, read it back | marker composition, head re-resolution, leak scan and read-back are a protocol; the polarity and clause are judgment |
| `review append-criterion` | append one reviewer-authored acceptance criterion to the linked issue under the four fences (append-only · ACL-gated fail-closed · frozen at `src/retry-budget.ts`'s `CAP_ROUND`), with provenance tag | the fences and the diff-guarded append are mechanical (ADR 0079); whether a finding is in-scope is judgment |
| `review scratch` | the per-lane directory this reviewer's staged files go under, allocated fail-closed | deriving a namespace no second lane resolves to, and refusing when it cannot be derived, is mechanical; what to stage there is judgment |

### Considered and deliberately not derived

Each is a real proposal someone could make again. (Conventions §7 homes these in a plugin-root
`.out-of-scope/`, which no fabrika skill has bootstrapped yet; until it exists they live inline,
the same tracked debt the sibling contracts carry.)

- **A typecheck / lint / test execution verb, or any head worktree.** Typecheck, lint, unit
  tests, secret scan, leak scan and unresolved-thread accounting are required CI gates
  (`.github/workflows/ci.yml`, `gitleaks.yml`, `leak-guard.yml`,
  `unresolved-threads-guard.yml`). A fabrika copy could only agree redundantly or contradict an
  enforced verdict, and a local re-run has returned another checkout's cached green three times
  in one session (#4106). v1's ADR 0067 made the in-tree typecheck authoritative; that
  posture is **deliberately not carried** — the brief's scope rule ("no second answer to
  anything a CI gate already enforces") supersedes it for fabrika, and `review ci` is the
  structural read of the same facts. Dropping the worktree also removes the #3607 /tmp-collision
  and #4544 fixed-name-scratch classes by construction, and closes the self-review instruction
  hole without a denylist: a head that is never checked out is a head whose instructions are
  never loaded. **The commit binding does not reverse this** (#5117, #5122): `review scope`,
  `review diff`, `review deviations` and `review post`'s namespace recompute fetch the PR head
  and read the artifact out of the **object database**
  (`git diff <base>...<head>`), which writes objects and no working tree. Nothing is checked out,
  so no head instruction file is ever on disk to be loaded — a diff that adds a worktree or a
  checkout is still the wrong fix and should be red at review.
- **A dead-link / ADR-index / skill-frontmatter checker.** `doc-links.yml`,
  `decisions-index.yml`, and `ci.yml`'s `validate-skills.sh` step already gate each. The rubrics
  state the expectation; the verdict stays where it is enforced.
- **A control-plane classifier.** `cp-classify` routes §CP membership and CODEOWNERS enforces it
  at merge (#4227 is the cost of a second opinion). `review post` takes the carrier as an
  **input** (`--carrier advisory`); it never computes the §CP verdict.
- **A `review trivial` verb or namespace.** Triviality is a *mode* of the skill (founder ruling,
  #4891): it changes which judgment runs, not which namespaces are emitted, and v1's
  `review-trivial` already proved the mode needs no fourth namespace. Nothing mechanical is left
  once the fan-out is skipped.
- **A second parser for the AC block or the verdict marker.** Both are registered wire formats
  (`packages/fabrika-cli/src/wire/registry.ts`); `review criteria` and `review post` / `review
  verdicts` import `read` / `emit` from `acceptance-criteria.ts` and `verdict-marker.ts`. A
  hand-rolled marker regex is the #3173 incident and the drift the registry landed to end.
- **A governance sweep.** The ADR contradiction sweep and gate-invariant preservation (v1
  `review-doc`'s sweep, `review-skill`'s rigor check 4) are the `governance` skill's, guarding
  from outside (#4949). The skill invokes it at the seam; this group computes nothing for it.

### Nothing here recomputes an enforced answer

Every question this group answers is ungated today. The enforced ones — typecheck/lint/tests,
leaks, secrets, dead links, ADR-index integrity, skill frontmatter validity, thread accounting,
§CP membership — are listed above with the workflow file that owns each, and this spec computes
no second verdict on any of them.

### The name situation

No v1 skill is named bare `review`, so this skill has no direct name collision — unlike
`/triage` and `/report`. The four v1 gates (`review-code`, `review-doc`, `review-skill`,
`review-trivial`) remain live project-level skills until the cutover, which is separate, later
work; until then nothing on `main` routes to this skill and it is reached as `/fabrika:review`.
The routing gap is recorded in the authoring PR rather than patched from here.

## Shared conventions

Stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else; scope lines, refusal
  reasons and progress go to stderr. Every "nothing found" case prints a state word — empty
  stdout is byte-identical to a verb that never ran, and v1's callers consumed exactly that as a
  proven negative (the S10 else-less classifier; #4060's zero-file `has-code`).
- **Common inputs.** `--repo <owner/name>` (default: `$CLAUDE_PIPELINE_REPO`, else
  `$GITHUB_REPOSITORY`, else the `origin` remote; none resolvable → exit 1 — the resolution
  chain the shipped `report`/`triage` groups already use, inherited for one config surface
  rather than a second vocabulary). `--json` swaps the line grammar for one object with the
  named keys.
- **Every list read paginates and reports its scanned count** on stderr — comments, check runs,
  changed files. A verdict driven by a silently truncated read is a verdict over unknown scope
  (#3999's pagination-honesty rule, applied group-wide).
- **A non-zero exit is UNKNOWN.** No verb prints a partial or permissive answer on a non-zero
  exit (`packages/fabrika-cli/src/verb.ts`'s answer-channel rule).

### The shared exit taxonomy

All nine verbs allocate from one internal table, so a code means one thing across *this group*.
Repo-wide the same number does not — `wire`'s `3`–`8` are its own — but where this group's codes overlap
**`report`'s and `triage`'s writing verbs** (`3`, `5`, `6`,
`7`, `8`, `9`, `11`) they match them deliberately, code for code, read from the **shipped
package** (`packages/fabrika-cli/src/report/codes.ts`, `src/triage/codes.ts`), never from a
sibling contract.md — the checked-in `/report` contract is behind its own binary on `7` and `11`
(#4752), which is exactly why prose copies are not the authority.

| Code | Meaning | scope | diff | criteria | ci | verdicts | deviations | post | append-criterion |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, unresolvable repo, or the verb failed to run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `126` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `3` | stdin was read and held nothing | — | — | — | — | — | — | ✓ | ✓ |
| `4` | *(deliberate gap — kept as the body-section seat `report file` uses; no verb here performs one)* | — | — | — | — | — | — | — | — |
| `5` | the **authored** text carries a machine-local path | — | — | — | — | — | — | ✓ | ✓ |
| `6` | the **authored** text is a bare `@` path reference — not redactable | — | — | — | — | — | — | ✓ | ✓ |
| `7` | zero scope: the target is **proven absent (404)** or closed, the PR has zero changed files or zero declared check runs, or a required block is proven absent or malformed — a fail-closed refusal | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `8` | the write itself failed — the outcome is **UNKNOWN** | — | — | — | — | — | — | ✓ | ✓ |
| `9` | the write landed but the read-back does not match | — | — | — | — | — | — | ✓ | ✓ |
| `10` | a supplied classification value is off the closed vocabulary — a namespace outside this PR's derived class set, a bad polarity or carrier, a `--sha` that is not a head SHA | ✓ | ✓ | — | — | — | ✓ | ✓ | — |
| `11` | a **precondition read failed** — nothing was written and the outcome is UNKNOWN | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `12` | refused: the `--sha` given is not the PR's head — a read taken over, or a verdict bound to, a tree that is no longer the PR | ✓ | ✓ | — | — | — | ✓ | ✓ | — |
| `13` | refused: the read was completed but its scope is **provably incomplete** — a truncated file list or diff, a check-run enumeration short of `total_count` | ✓ | ✓ | — | ✓ | ✓ | ✓ | — | — |
| `14` | refused: the invoking token resolves below `write`, or the ACL lookup failed — authorization denied, fail-closed (ADR 0055) | — | — | — | — | — | — | — | ✓ |
| `15` | refused: the write is not provably the prior rows plus one — the append-only fence, whose causes carry distinct messages | — | — | — | — | — | — | — | ✓ |
| `16` | refused: the enumeration is complete and **no gate inspected the bytes** — the rollup is not `red`, yet no workflow this repo authors produced a run at the head, so a `green` would report coverage that does not exist | — | — | — | ✓ | — | — | — | — |
| `17` | refused: the write would retire a standing verdict of the **opposite polarity** at this head and `--supersede` was not passed — nothing written (#7247) | — | — | — | — | — | — | ✓ | — |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**This matrix owns what a code *means*; the per-verb tables own what *triggers* it.** Every verb
can return `0`, `1`, `126` and `127` with the meanings above, stated here and nowhere else; the
per-verb "Exit status" tables enumerate only that verb's own proven outcomes, `3` and up, phrased
as that verb's trigger. (The one-fact-one-home rule; the `/triage` contract already shipped the
ten-places drift this prevents.)

**`11` is the shipped `PRECONDITION_UNKNOWN`** (`report/codes.ts`), matched rather than
reinvented: a read the verb needed failed, so nothing is proven — not `7` (which is *proven*
absence: a 404 is a fact about the repository, an unreachable GitHub is not a fact about
anything) and not `1` (which would fuse an unreachable GitHub with a bad flag).

**`12` and `13` are this group's own proven refusals**, in the band `triage` used for its
kill-guards. `12` is the stale-head refusal — the one code whose absence would let a verdict
formed over one tree land on another (#3769 / #4338's class). It seats at both ends of a review:
at the emit seam (`review post`, where the live head has moved past the judged one) and at the
read seam (`review scope` / `review diff`, where a `--sha` that is not the PR's head would have
a human spend a review on a tree the PR has left — #5117). `13` is the
incomplete-enumeration refusal: the read *succeeded* and is *provably short* — a diff carrying
fewer files than the PR declares, a check-run page count below `total_count` — which is neither
`11` (nothing failed) nor `7` (scope exists; it just was not all seen). Folding `13` into either would render a
half-seen PR as a fully-judged one, the exact class of #3925 (a gate PASSing on 100% upload
failure) and #4060.

**`5` and `6` apply only to text the caller just wrote** (a verdict body, an appended
criterion) — authored text is refusable because the author can fix it. Their fixes are opposite
(redact-and-resend vs send-the-bytes), which is why they stay two codes, exactly as in `report`.

### The read verbs bind to a commit before they read (#5117, #5122)

`review scope`, `review diff` and `review deviations` serve the artifact a whole review is formed
over, so **the bytes have to come from a named commit, not from an endpoint that takes a
pull-request number and no commit at all.** The platform's PR reads are the second thing: a push
landing between scoping and reading serves the *new* head's artifact under the *old* head's SHA,
and the result is a well-formed, confident verdict over code nobody judged. `review post`'s `12`
cannot close that — it fires after the judging, and a rewind that lands back on the recorded SHA
passes it clean. So `review post` binds too, at the one read that is not the head re-resolve: the
file list its derived namespace set comes from.

The three read verbs therefore take an optional `--sha`, `review post` binds to the `--sha` it
already requires, and all four run one shared binding step
(`packages/fabrika-cli/src/review/head.ts`) before any artifact read:

1. An explicit `--sha` must be **the PR's head**, or the verb refuses on `12`. Malformed is `10`.
2. A configured git remote in this checkout must serve the target repo, `pull/<pr>/head` must
   fetch, the commit must resolve in the **object database**, and `git rev-parse` must resolve it
   to *itself* — a local ref or tag spelled as hex resolves elsewhere, which is how a name that
   verifies still names the wrong tree. The base ref must resolve too, since a diff is a range,
   **and so must the merge base of that branch tip and this head** — the binding carries the tip
   and the branch point as two separate values, and every verb's `base` is the branch point
   (#5770). Any of these unmet is `11`, naming what is UNKNOWN. There is no permissive fallback to
   the PR-number endpoints: unbindable is a refusal, never a plausible value.
3. The artifact is then read with `git diff <base>...<head>`, where `<base>` is that branch point
   — bytes for `review diff` and `review deviations`'s Tier-M scan, the `--name-only -z` path list
   for `review scope` and `review post`'s namespace recompute — under flags that pin the output to
   the two commits rather than to the invoking user's own git configuration (`--no-ext-diff`,
   explicit `a/`/`b/` prefixes).

Every one of them prints the bound commit and its base on stderr, and `review scope`'s `scoped`
line prints **the commit it read the files out of**, so the head named and the files partitioned
are never two different trees.

**`review post` binds underneath its `12`, not instead of it.** The stale-head refusal stays this
verb's first step and keeps its own message: `12` is what says the verdict's tree is gone. The
binding is what makes the namespace set provably the bound tree's — a separate property, since a
force-push that rewinds back onto `--sha` passes `12` clean while the PR-number file endpoint
still answers with some other head's list.

**Nothing is checked out.** A fetch writes objects, not a working tree, so this binding and the
no-head-worktree decision above hold together rather than trading off.

### Read-backs compare normalized text, not bytes

Every write verb re-reads its target and compares through **`normalizeForReadback` from
`packages/fabrika-cli/src/report/compose.ts`** — import it; its third step (strip trailing
newlines) is the one a re-derivation drops, and dropping it fires exit `9` on clean runs.

### Machine-local path detection

`review post` and `review append-criterion` share the leak predicate **already implemented** at
`packages/fabrika-cli/src/report/leaks.ts` — import it, never re-derive it. A verdict body that
must *cite* a leak found in the diff cites it by class root or repo-relative form; the refusal
message says so (#3785 is the incident where review prose tripped the guard). `review scratch`'s
answer is a path under one of those roots, so a verdict quoting where the diff was staged reds on
`5` — the same refusal `build pr` and `build note` make.

---

## `review scope`

**Invocation**

```
fabrika review scope 4321 [--sha <head>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number to scope |
| `--sha` | string | no | the PR's live head | the head to read the changed files at; see the binding step above |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel, in this line order. First line:
`scoped\t<head-sha>\t<fixes:n|part-of:n|->`, where the head is the commit the file list was actually
read out of and the third field is the issue reference — the same token `ship scope` prints. Then one
line per present class — `class\t<name>\t<file-count>` where `<name>` is one of `code`, `doc`,
`skill`, `ui`. Then one `namespace\t<ns>` line per namespace the diff requires, then one
`routed\t<ns>` line per required namespace this gate may not emit — a subset of the `namespace` rows,
re-printed rather than removed. Then two flag lines `self\t<true|false>` and
`harness\t<true|false>`, then `governance\t<required|not-required>`.

With `--json`, an object with keys `outcome`, `head` (full 40-hex), `issue` (an object
`{kind, number}` where `kind` is `fixes` / `part-of` / `none` and `number` is an integer, or `null`
on `none`), `classes` (array of `{name, files}`), `self` (boolean), `harness` (boolean), `governance`
(the string `required` or `not-required`), `scanned`
(changed files seen), `namespaces` (array — the required set, e.g. `["review-code","review-doc"]`),
and `routed` (array — the subset of `namespaces` routed to another gate).

**The required set is `ship scope`'s own.** Both verbs call one pair of functions over one file list
(`partitionWithUi` + `shipNamespacesOf` in
[`packages/fabrika-cli/src/review/classes.ts`](../../../../packages/fabrika-cli/src/review/classes.ts)),
so they cannot report different sets for the same diff. That is why `ui` is a class here at all: the
reviewer's set was short one namespace and the merge gate refused, once per rendered-surface PR
(#6664). `self` and `harness` still come off the three-class partition.

**`routed` is what the wider set costs, and it costs nothing else.** Today the one routed namespace
is `review-ui`: `review` derives it, prints it, and still may not emit it — `review post`'s fence is
the three text classes, unchanged. `governance` is never routed; it is derived-required and fired
inside the review run (ADR 0293). What a reviewer does with a `routed` row is `SKILL.md` §1's, not
this verb's.

**The class map is a fixed path partition, stated here so two runs cannot disagree:**

| Class | Paths |
|---|---|
| `skill` | `claude-plugins/**` (SKILL.md, rubric/reference files, contract specs), `.claude/**` agent and skill definitions, `skills/**`, and any file named `SKILL.md` wherever it sits — the last two rows are what keep the map honest on a repo that homes its skills elsewhere (found live by an eval run: a toy repo's `skills/deploy-notes/SKILL.md` partitioned to `doc` under the first two rows alone) |
| `doc` | `*.md` outside `claude-plugins/**` — `.decisions/`, `.patterns/`, `.glossary/`, `reports/`, `README`/`DEVELOPMENT`, docs directories |
| `code` | everything else — source, tests, config, workflows, manifests |
| `ui` | a rendered `apps/web/src/**` surface — an **overlay**, not a fourth bucket: such a file is `code` as well, and is counted in both rows. It is the only class a file can hold beside another, which is why the row counts can exceed `scanned` |

Every changed file maps to exactly one class of the first three, `code` the residual — a file the map cannot place
is `code`, never dropped, because an unclassified file silently excluded from every rubric is a
review that never saw it. `self` is true when any changed path is under
`claude-plugins/fabrika/skills/review/`. `harness` is true when any changed path is under
exactly `.claude/`, `.github/`, or `claude-plugins/` — this repo's governance surface, a closed
three-root list of its own. The class map's two portability rows (`skills/**`, any `SKILL.md`)
deliberately do **not** set it: they classify a foreign repo's skill text for the rubric, while
`harness` marks *this* harness. The *decision* of what governance does with the flag belongs to
the `governance` skill; the flag only makes the seam mechanical.

**`governance` is a fourth-root answer, and it is why `harness` must not be read as one.** The line
is `touchesGovernanceRoot` over the same file list, against the **declared** governance roots
(`governedRoots`, whose shipped value here is `.decisions/` plus the three `harness` roots) — the
one derivation `governance scope` prints, imported rather than recomputed (#4730). So a
`.decisions/`-only diff prints `harness\tfalse` and `governance\trequired`, which is exactly the
pair a reviewer keying the governance obligation off `harness` got wrong on PR #5604: a clean PASS,
then the ship gate blocking on `ns governance absent` with nobody told to fill it (#5607). The token
vocabulary matches `governance scope`'s on purpose — one word, read the same in both places.

**The issue reference** is resolved from the PR body in two passes, and the kinds are reported
apart rather than collapsed. First the closing keywords (`Fixes/Closes/Resolves #N`), first match
⇒ `fixes:<n>`; failing that, an explicit `Part of #N` ⇒ `part-of:<n>`; failing both, `-` /
`{kind: "none"}`. The second pass exists because `build --partial` emits `Part of #N` **by
contract**, so a partial-split PR this gate must grade was reported issueless while `ship scope`
called the same body linked (#5446). Both kinds name the issue whose acceptance criteria bind the
PR; only `fixes` auto-closes it on merge, which is why the kinds stay distinct. This derivation is
shared code with `ship scope` (`packages/fabrika-cli/src/review/classes.ts`) — one definition, two
verbs — and it does not widen `linkedIssueOf`, which stays closing-keyword-only.

`none` is a fact, not a verdict: what a genuinely issueless PR means is the skill's decision, and
the skill states it (`SKILL.md` step 2).

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404), or closed, or has **zero changed files** — a review over nothing (ADR 0092; #4060) |
| `10` | `--sha` is not a head SHA |
| `11` | the PR could not be read, or the commit could not be bound — the scope is UNKNOWN |
| `12` | `--sha` is not the PR's head — re-scope at the head, never partition a tree the PR has left |
| `13` | git reports no changed files for the bound commit's range — an empty read, with nothing to partition |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review scope: PR #<n> not found in <repo>.` | 7 | refusal |
| `review scope: PR #<n> is closed — nothing to review.` | 7 | refusal |
| `review scope: PR #<n> has zero changed files — refusing to derive an empty review (ADR 0092, #4060).` | 7 | refusal |
| `review scope: --sha "<v>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |
| `review scope: cannot read PR #<n> in <repo>: <reason> — the scope is UNKNOWN.` | 11 | refusal |
| `review scope: <what> — the artifact cannot be bound to a commit, so what it shows is UNKNOWN.` | 11 | refusal |
| `review scope: cannot read the changed files of #<n> at <sha>: <reason> — the scope is UNKNOWN.` | 11 | refusal |
| `review scope: PR #<n>'s head is <live>, not <asked> — the tree you scoped is not the one under review; re-scope at <live> (ADR 0058).` | 12 | refusal |
| `review scope: git reports no changed files for the range <base>...<sha>, so <sha> has nothing to partition — refusing to scope an empty read (#3999).` | 13 | refusal |

**Scope** — one PR's metadata, and the path list git reports for one bound commit's range. That
list is the scope itself, so it has no second count to be checked against: it is refused when
**empty**, and GitHub's declared changed-file count is reported beside it as a cross-check that
never refuses. The class partition is total over what was read; the refusals exist so it is never
run over less than everything, and never over a different tree than the head it prints.

**Examples**
```
$ fabrika review scope 4321
scoped	03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c	fixes:4287
class	code	3
class	doc	1
namespace	review-code
namespace	review-doc
self	false
harness	false
governance	not-required
```

A rendered surface raises `ui` beside `code`, and its namespace comes back on a `routed` row:

```
$ fabrika review scope 4322
scoped	6f7b834bcf1cf16fc465389d8f45cc21bd23a3fe	part-of:5434
class	code	5
class	doc	1
class	ui	2
namespace	review-code
namespace	review-doc
namespace	review-ui
routed	review-ui
self	false
harness	false
governance	not-required
```

```
$ fabrika review scope 4323
scoped	6a562f751a5d4d0e2efa277286f793b7ece3a008	fixes:5599
class	doc	1
namespace	review-doc
namespace	governance
self	false
harness	false
governance	required

```

```
$ fabrika review scope 4321 --json
{"outcome":"scoped","head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","issue":{"kind":"fixes","number":4287},"classes":[{"name":"code","files":3},{"name":"doc","files":1}],"self":false,"harness":false,"governance":"not-required","scanned":4,"namespaces":["review-code","review-doc"],"routed":[]}
```

**Grounding**

- #4060 — v1's `class-probe` read 0 files and silently classified `has-code` exit 0; the zero-file
  case here is a `7` refusal.
- #3170 — one namespace filled on a mixed diff; `namespaces` is printed as a set precisely so the
  emission checklist is machine-derived, not remembered. It is that set minus the `routed` rows.
- #6664 — the two verbs derived different required sets from one map, so the reviewer PASSed one
  namespace short and the merge gate refused. `namespace` and `routed` are that fix's output.
- v1's `classify-skills-only.sh` prints nothing on its code-PR branch and falls off the end (the
  S10 else-less classifier) — every outcome here is a token.
- ADR 0052 — `self` is the input the skill's BASE-revision fence keys on.
- #5446 — `ship scope` read `Part of #N` and this verb did not, so the shape `build --partial`
  emits by contract was linked to the shipper and issueless to the gate, leaving the
  acceptance-criteria step with no issue to grade and the skill with no stated behaviour for it.
- #5117 — the file list is the namespace set's only input, and the set is both floor and ceiling:
  a list read at a later commit than the printed head derives a namespace nobody judged, or drops
  one. The list and the head are one commit or the verb refuses.
- #5154 — this verb has no second count of the range, because the list it reads *is* the scope, and
  GitHub's `changed_files` cannot stand in for one: it is a different computation over its own merge
  base with its own rename pairing, which counts two files where git's list carries one path. So the
  disagreement is reported and never refused on, and the only short read git alone establishes — an
  empty one — is the `13`.

---

## `review diff`

**Invocation**

```
fabrika review diff 4321 [--sha <head>] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | no | the PR's live head | the head to read the diff at; see the binding step above |
| `--repo` | string | no | resolved | the repository |

**Output** — machine channel. The unified diff bytes, read out of the object database at the bound
commit. There is no empty answer: a PR with zero changed files is `review scope`'s `7`, and this
verb reds the same way. No `--json`: the diff is the object.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) or closed, or has zero changed files — the same refusal `review scope` makes, so neither verb serves a review over nothing |
| `10` | `--sha` is not a head SHA |
| `11` | the diff could not be read, or the commit could not be bound — UNKNOWN |
| `12` | `--sha` is not the PR's head — re-review at the head, never judge a tree the PR has left |
| `13` | the diff is provably incomplete — the file count in the diff at the bound commit is short of the file list git reports for the same range |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review diff: PR #<n> not found in <repo>.` | 7 | refusal |
| `review diff: PR #<n> is closed — nothing to review.` | 7 | refusal |
| `review diff: PR #<n> has zero changed files — refusing to serve an empty diff as a reviewable one (ADR 0092).` | 7 | refusal |
| `review diff: --sha "<v>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |
| `review diff: <what> — the artifact cannot be bound to a commit, so what it shows is UNKNOWN.` | 11 | refusal |
| `review diff: cannot read the diff for #<n> at <sha>: <reason> — UNKNOWN.` | 11 | refusal |
| `review diff: PR #<n>'s head is <live>, not <asked> — the tree you scoped is not the one under review; re-scope at <live> (ADR 0058).` | 12 | refusal |
| `review diff: the diff at <sha> carries <k> of the <m> files git reports for the same range <base>...<head> — both counts from git, so this diff is provably short; refusing to serve a partial diff as the whole (#3925's class).` | 13 | refusal |

**Scope** — one commit's diff, completeness-checked against the file list git reports for the same
range. The bound commit, the scanned byte and file counts, and GitHub's declared changed-file count
(reported as a cross-check, never refused on) go to stderr on the answer path.

**Examples**

```
$ fabrika review diff 4321 | head -3
diff --git a/apps/web/src/cart.ts b/apps/web/src/cart.ts
index 0b1c2d3..a1b2c3d 100644
--- a/apps/web/src/cart.ts
```

**Grounding**

- The `13` refusal is about a diff that arrives short, not about a platform that serves prefixes.
  `application/vnd.github.diff` does **not** truncate: over its limits it refuses with HTTP `406`
  and `errors[].code = "too_large"`, and under them it serves the diff whole — established by live
  probe and recorded on #4993. This verb does not read that endpoint anyway; its bytes are local
  `git diff <base>...<head>` at the bound commit (#5117), and its denominator is a second read of
  that same range — `git diff --name-only -z`, one path per `diff --git` entry — so both counts come
  from git under one set of flags rather than from two systems (#5139). GitHub's declared
  `changed_files` is still read and reported beside them as a cross-check that never refuses; it is a
  third party's answer over its own merge base and its own rename detection. What `13` still buys is
  real: the served bytes can carry fewer files than git lists for that range, and serving that prefix
  as the whole PR is the #3925 blind-PASS class one layer down.
- State the guarantee at its real precision: the proof is a **cardinality** test, never an
  entry-identity one. It establishes that the scanned bytes carry at least as many entries as the
  `--name-only` read lists — not that the two reads name the same files, and not that the range is
  the right range. A fault that shortens both reads alike stays invisible to it.
- The proof counts whole files, so it does not see a diff cut inside the last file's hunks — every
  `diff --git` header is still present, and the count passes. That is a stated bound of the proof,
  not a failure mode defended against: no producer for that shape is known.
- The split test is honest: this verb is not a relay because its whole job is the completeness
  proof — v1's `pr-diff.sh` was the relay, and nothing checked what it served.
- #5117 — the completeness proof says the read was not cut short; it says nothing about which
  commit the bytes came from. A verdict's whole value is that it binds a tree, so the bytes are
  read at a commit rather than stamped with one afterwards.

---

## `review criteria`

**Invocation**

```
fabrika review criteria 4287 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue number carrying the acceptance-criteria block |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line: `criteria\t<count>`. Then one line per criterion —
`<checked|open>\t<text>` — the same line grammar `wire read --format acceptance-criteria`
prints, because it **is** that read: the verb fetches the issue body and hands it to the
registered format's `read` (`packages/fabrika-cli/src/wire/acceptance-criteria.ts`), importing
the module. No second parser.

With `--json`: `{"outcome":"criteria","issue":<n>,"count":<n>,"criteria":[{"text":…,"checked":…}…]}`.

The count is never `0`: the wire format holds a conforming block's criteria as a non-empty
array — a heading with zero checkbox rows reads `Malformed`, so "a gradeable contract with
nothing in it" is unrepresentable and lands on `7` like any other malformed block.

An issue's open/closed state is deliberately **not** a precondition here, asymmetric with
`review append-criterion` (which refuses a closed target): reading the contract off a closed
issue is a legitimate re-review case, while writing to one buries the row where nobody looks.
The state is reported on stderr as a notice so the caller sees it.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the issue is proven absent (404); **or** the body was read and the AC block is proven absent or malformed — reported with the wire distinction on stderr, never invented around |
| `11` | the issue could not be read — whether a block exists is UNKNOWN |

**`Absent` and `Malformed` share `7` but never share a message.** Both are fail-closed refusals
of the same judgment ("there is no gradeable contract here"), and the skill's response to both is
the same routing (a finding about the issue, not licence to invent criteria) — but the stderr
names which, with the wire reason verbatim, because their *repairs* differ (write the block vs
fix the drift).

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review criteria: issue #<n> not found in <repo>.` | 7 | refusal |
| `review criteria: #<n> carries no acceptance-criteria block — absent: <wire reason>. Grade nothing; the contract is missing.` | 7 | refusal |
| `review criteria: #<n>'s acceptance-criteria block is malformed: <wire reason> — a drifted heading is a defect to report, not "there were none".` | 7 | refusal |
| `review criteria: cannot read #<n> in <repo>: <reason> — whether a block exists is UNKNOWN.` | 11 | refusal |

**Scope** — one issue body, read as typed JSON (never `jq -r .body`, which errors on the control
characters GitHub bodies carry and yields empty in a loop).

**Examples**

```
$ fabrika review criteria 4287
criteria	2
open	the first retry delay equals `base`
open	the retry guide documents the delay table
```

**Grounding**

- The registry row names `review` as this format's consumer; this verb is that row discharged.
- The near-miss window (`NEAR_MISS_EDITS = 3`) is the format's own; a drifted heading reds as
  malformed here rather than reading as "no criteria" — the wire module's design carried to the
  fetch seam.

---

## `review ci`

**Invocation**

```
fabrika review ci 4321 [--sha <head>] [--wait] [--budget-seconds <n>] [--cadence-seconds <n>]
                       [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | no | the PR's live head | the head to enumerate check runs at; give the inspected head so the answer binds to what is being judged |
| `--wait` | boolean | no | `false` | poll a `pending` head until CI concludes or the budget expires, instead of answering with this moment's read |
| `--budget-seconds` | integer | no | `600` | `--wait` only: total wall-clock budget, gh-call latency included |
| `--cadence-seconds` | integer | no | `30` | `--wait` only: sleep between polls |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. Under `--wait`, a first line
`settle\t<settled|budget-exhausted|head-moved>`; without it that line is absent. Then
`ci\t<sha>\t<green|red|pending|no-producer>`, then `run\t<count>` — how many check runs were
enumerated, so the line channel carries its own completeness proof. Then one line per status present
—
`check\t<success|failure|neutral|cancelled|skipped|timed_out|action_required|in_progress|queued>\t<count>`.

With `--json`:
`{"outcome":"ci","sha":…,"rollup":…,"checks":{<status>:<count>…},"scanned":<n>,"declared":<m>,"gates":{"declared":<g>,"covered":<c>}|null,"settle":<token>|null}`.

`checks` is an **evidence-array collapsed to a status tally** under ADR
[0308](../../../../.decisions/0308-bounded-evidence-output-shape.md): this skill acts on `rollup`,
and nothing here or in `SKILL.md` iterates a check row. What the rows carried that a reader does act
on — **which** check is red or still running — moves to the notes channel, where the verb names the
failing runs and the in-flight runs on their own lines. A passing check's name was the bulk of the
old payload and no reader ever wanted it.

**The one caller that did want a passing name reads it elsewhere now.** `review-ui`'s §5 named three
design gates and read their live state here; a green name reaches neither channel after the collapse,
so it would have read a gate that never ran as a gate that passed. That read moved to
`fabrika heal-ci surface`, which prints every declared required context as `producing` or `absent`
and every undeclared gating run as `extra`. That is an answer this verb could never give even
uncollapsed: a check run that does not exist has no row here, so a required gate that never ran and
a gate the repo does not declare at all were always the same silence. This verb answers "is the head
green"; `heal-ci surface` answers "is the gate armed and did it post".

**The rollup is total over the status vocabulary, fail-closed on the ambiguous rows:** `red`
when any completed run concluded `failure`, `timed_out`, `action_required` or `cancelled` (a
cancelled check proved nothing, and "proved nothing" must not read green); `pending` when none
red and any run is `queued`/`in_progress`; `green` only when every declared run completed and
each concluded `success`, `neutral` or `skipped` (the two conclusions GitHub defines as
non-blocking). No status falls outside these three buckets; an unrecognized conclusion string
is `red`, never silently dropped.

**An empty enumeration asks one further question: does this repo produce CI at all?** The two
facts are different and no longer share an answer — a repo whose checks have not reported yet is
still going to report, and a repo with no Actions workflows never will. The evidence is the
workflow *inventory* and nothing else: **existence is the whole test, and nothing inspects what a
workflow does** (#5603, R17.1 — "only if workflows exist is fine dude"). Zero workflows refuses on
`7`, unless the repo declares `ci.noProducer: "degrade"` in `.fabrika.jsonc`, which rolls up
`no-producer` at exit `0` with `run\t0` — its own token, never `green` and never `pending`. The
inventory is read only when the enumeration came back empty: a check run that reported already
proves a producer.

**A passing check set is not gate coverage, and the verb no longer lets the two share a word.**
A complete, all-green enumeration that came from no workflow this repo authors is refused on `16`
— not `green`, not `pending`. The set of gates is the **live workflow inventory**: a workflow
checked into the repo is addressed by its file path (`.github/workflows/ci.yml`), one the platform
provides on the repo's behalf by a synthetic `dynamic/<provider>/<name>`, and coverage is the
intersection of the first with the workflows that actually produced a run at this head. No job
names, no expected set — nothing here knows what a gate is called. A repo that authors no workflow
of its own has no gate to have missed, and says so on stderr at exit `0`. The read is skipped over a
`red` rollup, which is already the answer a caller must act on; `green` and `pending` are the two
words that read as "nothing to do here", and both are wrong over bytes no gate inspected (#6522).

**`--wait` is the bounded in-verb wait, and it polls a `pending` and nothing else.** A `pending` is
the ordinary state of a PR minutes after a push — exactly when a reviewer is spawned — so a caller
that can only take this moment's read has a park on a human to offer for a condition that clears
itself in minutes (#7282). The verb owns the loop, which is what keeps the ban in
[`docs/skill-conventions.md` §14](../../docs/skill-conventions.md#14-a-skill-never-sleeps-and-never-polls-on-a-timer)
whole: the skill makes one call and never sleeps. The budget is **wall clock**, gh-call latency
included, so the verb cannot overrun the bound it claims to hold.

The settle token says how the wait ended, and it is the whole difference between a proven answer and
a bound that ran out:

- `settled` — CI concluded inside the budget; the rollup beside it is `green` or `red` and is a
  verdict.
- `budget-exhausted` — the budget ran out with the head still `pending`. **Nothing was proven**, and
  the rollup says so by still reading `pending`: this is a stuck or very slow queue, not a race with
  it.
- `head-moved` — the PR left the head this answer binds during the wait. The last read still binds
  what it inspected; the caller re-reads at the new head rather than trusting a stale `settled`.

Every refusal and the `no-producer` answer are states no waiting changes, so `--wait` returns them
on the **first** read rather than burning the budget: the `16` head has no gate of this repo's coming
at all, and a repo with no producer has no run to wait for.

If `--sha` is given and does not prefix-match the PR's live head, a stderr notice names both —
the caller is enumerating a head that has moved, which is a fact worth seeing at the read even
though the `12` stale-refusal seat belongs to `review post`, the write seam.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR or the `--sha` is proven absent — no commit to enumerate; **or zero check runs are declared at the commit** — a vacuous green is the ADR 0092 fail-open and is refused; **or the repo has zero workflows** under the shipped `ci.noProducer: "refuse"` |
| `11` | the check-run read, the workflow-inventory read, the runs-at-head read, or `.fabrika.jsonc`'s `ci` key failed — CI state is UNKNOWN, never `green` |
| `13` | entries received < declared `total_count` — the enumeration is provably incomplete and is never read as "no red checks" |
| `16` | the rollup is not `red` and **no workflow this repo authors produced a run at the head** — the enumeration is complete, no gate inspected the bytes, and the CI state is UNKNOWN, never `green` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review ci: PR #<n> not found in <repo>.` | 7 | refusal |
| `review ci: no commit <sha> on PR #<n> in <repo>.` | 7 | refusal |
| `review ci: zero check runs declared at <sha> — refusing to report green over an empty enumeration (ADR 0092).` | 7 | refusal |
| `review ci: <repo> has zero workflows — no CI producer, so no head can be evidenced (ADR 0092). A repo that runs no workflows declares \`ci.noProducer: "degrade"\`.` | 7 | refusal |
| `review ci: cannot enumerate check runs at <sha>: <reason> — CI state is UNKNOWN, never green.` | 11 | refusal |
| `review ci: cannot enumerate the workflow inventory of <repo>: <reason> — whether a producer exists is UNKNOWN, never green.` | 11 | refusal |
| `review ci: cannot read \`ci\` from the repo config (<reason>) — whether <repo> produces CI is UNKNOWN, never green.` | 11 | refusal |
| `review ci: <repo> declares \`ci.noProducer: degrade\` and has zero workflows — no producer, so there is nothing to roll up.` | 0 | notice |
| `review ci: received <k> of <m> declared check runs at <sha> — refusing the partial enumeration (#3999).` | 13 | refusal |
| `review ci: none of the <g> workflow(s) <repo> authors produced a run at <sha> — the <n> check run(s) here came from elsewhere, so no gate inspected these bytes: the CI state is UNKNOWN, never green (#6522).` | 16 | refusal |
| `review ci: cannot enumerate the workflow inventory of <repo>: <reason> — which gates exist is UNKNOWN, never green.` | 11 | refusal |
| `review ci: cannot enumerate the workflow runs at <sha>: <reason> — which gates ran is UNKNOWN, never green.` | 11 | refusal |
| `review ci: <c> of <g> workflow(s) <repo> authors produced a run at <sha>.` | 0 | notice |
| `review ci: <repo> authors no workflow of its own — every run at <sha> is platform-provided, so there is no gate coverage to judge.` | 0 | notice |
| `review ci: the live head is <live>, you are enumerating at <sha> — the head moved; a verdict still binds only what was inspected.` | 0 | notice |

**Scope** — the check runs at one commit, paginated, count-verified against `total_count`, and the
workflows that produced a run there, against the repo's live inventory.

**Examples**

```
$ fabrika review ci 4321 --sha 03135b91
ci	03135b91	green
run	3
check	success	3
```

A head still queued at the read, waited out to its verdict:

```
$ fabrika review ci 4321 --sha 03135b91 --wait
settle	settled
ci	03135b91	green
run	3
check	success	3
```

The same call on a queue that never finishes — `pending` beside the token, and never a verdict:

```
$ fabrika review ci 4321 --sha 03135b91 --wait --budget-seconds 120
settle	budget-exhausted
ci	03135b91	pending
run	3
check	success	1
check	queued	2
```

**Grounding**

- #4552 — the CI-at-head read was dispatch-prompt-dependent in v1; a gate ruled on a live RED
  check as a prose question because one sentence was omitted. This verb is that read made
  structural.
- #3999 / ship-it's pagination-honesty rule — received < declared is an explicit refusal, the
  same shape reused rather than a divergent second CI read.
- #6522 — a conflicted branch stops producing `pull_request` runs while CodeQL's default setup
  keeps reporting on its own trigger. The verb read `green` over four CodeQL runs at an epic
  assembly head that `ci.yml`, `migrations-guard` and `design-token-guard` had never seen. `green`
  and "no gate ran" were one word, and the second is the dangerous one.

---

## `review verdicts`

**Invocation**

```
fabrika review verdicts 4321 [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line: `verdicts\t<live-head>\t<count>`, where `<count>` is
the number of verdict rows found (`0` is a valid, proven answer: the PR carries no
verdict). Then one line per marker, newest first:
`<namespace>\t<polarity>\t<marker-sha>\t<current|stale|unbindable>\t<comment-id>\t<standing|superseded>`
— the marker SHA
is the head the verdict was formed at, which under ADR 0276 need not be the live head for the row
to read `current`, and the sixth field says whether the verdict is the one in force or one retired
below its comment's supersede fence. Advisory
carriers (a `Reviewed-head: @ <sha>` body line under an advisory first line) print with polarity
`ADVISORY` and the body-bound SHA. Malformed markers — bytes reaching for the format that fail
it — print as `malformed\t-\t-\t-\t<comment-id>\t-` with the wire reason on stderr: **a drifted
marker is surfaced as a defect, never dropped from the sweep** (a dropped row is how a FAIL'd PR
reads as unreviewed, #4103/#4105).

**A superseded verdict gets its own row.** `review post` retires the prior verdict below the
`<!-- fabrika:superseded -->` fence rather than over it, so those bytes are still on the PR;
printing only the survivor would report exactly the erasure the append exists to prevent (#7247).
Only a `standing` row is a verdict in force, and `ship gate` reads no other kind.

With `--json`: `{"outcome":"verdicts","head":…,"markers":[{namespace,polarity,sha,binding,commentId,standing}…],"malformed":[{commentId,reason}…],"scanned":<comments>}`.

**Binding is computed here, per marker** — `bindToContent` from
`packages/fabrika-cli/src/wire/verdict-marker.ts`, imported, and the same derivation `ship gate`
uses so the two cannot disagree. The three outcomes reach stdout as three tokens. A marker at the
live head is `current`; one at another head is `current` only while the content digest it carries
is still this head's (ADR 0276), and `stale` otherwise. A head this verb cannot resolve — or a
content-bound marker whose head digest cannot be read — prints `unbindable`, never `current` and
never `stale`, because a comparison that could not be made is not a negative result (ADR 0058).

The digest read is **lazy**: it runs only when a content-bound marker has already failed the head
test, so an ordinary sweep touches no `git` at all.

<!-- anchor: ABSENCE-IS-NEVER-A-BINDING --> **A marker carrying no content field is head-bound, and
that is the stricter answer, not a free pass.** Absence of the field never widens what a verdict
survives: a legacy marker, a hand-written one and a typo'd one all fall back to head equality, and a
`content:` token that reaches for the field and misses reads `malformed` rather than head-only. Any
change that lets a missing or unreadable content field resolve `current` inverts this and needs its
own record (ADR 0276).

Each comment's **first non-blank line** is what is read (the format's anchoring rule); a marker
quoted further down a body is not a marker, which is why one comment carries one namespace.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) |
| `11` | the comment list could not be read — whether verdicts exist is UNKNOWN, never `0` |
| `13` | the comment enumeration is provably short of the declared count |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review verdicts: PR #<n> not found in <repo>.` | 7 | refusal |
| `review verdicts: cannot read #<n>'s comments: <reason> — whether verdicts exist is UNKNOWN, never zero.` | 11 | refusal |
| `review verdicts: received <k> of <m> comments — refusing the partial sweep.` | 13 | refusal |
| `review verdicts: comment <id> reaches for a marker and fails the format: <wire reason>.` | 0 | notice |

**Scope** — every issue comment on the PR, paginated and count-checked; each body's first
non-blank line tested through the registered format's `read`, imported. The live head resolution
that feeds `bindToHead` is part of this verb's read — its failure is the all-rows-`unbindable`
answer, not an exit, because the markers themselves were seen and are reportable facts.

**Examples**

```
$ fabrika review verdicts 4321
verdicts	03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c	2
review-code	PASS	0b1c2d3e	stale	5154891644	standing
review-doc	PASS	03135b91	current	5154902211	standing
```

```
$ fabrika review verdicts 7081
verdicts	77f61ce9c9f95e660ecf56d55fcecbb6f4997e85	2
review-ui	PASS	77f61ce9	current	5460446728	standing
review-ui	FAIL	77f61ce9	current	5460446728	superseded
```

**Grounding**

- #4520 — a dropped namespace read as a pass; the sweep prints every marker it saw, and a short
  read refuses rather than narrowing.
- #3769 / #4338 — staleness read as current; the binding column is the three-outcome type on the
  wire, computed against the live head at read time.
- `wire check` exits 0 on a stale PASS by construction (binding is deliberately not a property of
  the bytes); this verb is the caller-side half the type was designed for, so no consumer needs
  to fold the three outcomes to use them.

---

## `review deviations`

**Invocation**

```
fabrika review deviations 4321 [--sha <head>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | no | the PR's live head | the head to read the diff at; see the binding step above |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line: `deviations\t<found|none-declared|absent|malformed>`.
On `found`, one line per entry: `entry\t<class-label-or-->\t<Said>` (the null
token is the ASCII hyphen `-`, the same one `review verdicts` uses; a **Said** authored across
wrapped lines is carried in full, collapsed to one line, so the answer never holds a partial clause). Then the
Tier-M scan over the head diff, one line per hit:
`tier-m\t<suppression|removed-assertion>\t<file>:<line>\t<token>` — the mechanically-detectable
§DEV classes (an in-diff `biome-ignore` / `@ts-expect-error` / `test.skip` / `.only`; a deleted
assertion line), each a fact the judgment layer matches against the disclosed entries.

`none-declared` is the literal `None.` body; `absent` is **no `## Deviations` heading at all**;
`malformed` is a heading whose section fits neither shape. Which shapes those are is not stated
here: the grammar is the registered `deviations` wire format
([`packages/fabrika-cli/src/wire/deviations.ts`](../../../../packages/fabrika-cli/src/wire/deviations.ts)),
which `build pr` refuses against at creation, so a body that verb accepted never reaches this one as
`malformed` (#5566). On `malformed` and `absent` the verb prints the format's own reason as a
diagnostic — a gate that answers a bare `malformed` never tells an author which field is missing.
The three stay distinct on the wire
because the skill's verdict vocabulary depends on the distinction: absent-on-owing fails closed,
`None.` is a checked claim, and this verb is what makes the claim checkable — a `None.` printed
beside a non-empty Tier-M list is a falsified disclosure the caller can see in one read.

With `--json`: `{"outcome":…,"entries":[{label,said}…],"tierM":[{kind,file,line,token}…]}`.

**The class-label vocabulary is this contract's, enumerated closed** — never a pointer into
v1's prose (ADR 0238). An entry's optional label is one of `1`–`7`:

| Label | Class |
|---|---|
| `1` | scope narrowing |
| `2` | governing-ADR departure (including narrowing an invariant that lives only in skill prose, with no amending ADR in the diff) |
| `3` | known defect left unfixed |
| `4` | declined guidance |
| `5` | guard or gate bypassed |
| `6` | pre-existing test or fixture changed |
| `7` | out-of-scope change |

The classes overlap; the label is a routing hint, not the disclosure — a gate matches an
entry's substance, never its label. An entry carrying no recognizable label prints `-`.

The Tier-M scan reads the same diff `review diff` serves and applies both of its proofs to it. Its
**completeness** proof is the one `review diff` states: the denominator is a second read of the same
range — `git diff --name-only -z`, one path per `diff --git` entry — so both counts come from git
under one set of flags. That makes it a **cardinality** test and nothing more: it establishes that
the scanned bytes carry at least as many entries as the `--name-only` read lists, not that the two
reads name the same files, and not that the range is the right range — a fault that shortens both
reads alike stays invisible to it. A scan short of that denominator is refused on `13`, because an
under-reported hit list beside a `None.` reads as a checked-clean disclosure that was never checked.
GitHub's declared `changed_files` is read and reported beside the two counts as a cross-check that
never refuses. Its **commit binding** (#5122): the bytes come from the object database at the bound
commit, because a hit list read at a head nobody scoped is under- or over-reported against the
disclosure it is printed beside — and it fails open, answering `none-declared` at exit 0.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) |
| `10` | `--sha` is not a head SHA |
| `11` | the PR body or the diff could not be read, or the commit could not be bound — the disclosure state is UNKNOWN |
| `12` | `--sha` is not the PR's head — re-scope, never re-bind |
| `13` | the Tier-M scan is provably incomplete — the diff scanned at the bound commit carries fewer files than the file list git reports for the same range, and a partial scan must not print beside a `None.` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review deviations: PR #<n> not found in <repo>.` | 7 | refusal |
| `review deviations: --sha "<v>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |
| `review deviations: PR #<n>'s head is <live>, not <sha> — the tree you scoped is not the one under review; re-scope at <live> (ADR 0058).` | 12 | refusal |
| `review deviations: <what> — the artifact cannot be bound to a commit, so what it shows is UNKNOWN.` | 11 | refusal |
| `review deviations: cannot read #<n>'s body or diff: <reason> — the disclosure state is UNKNOWN, never "none".` | 11 | refusal |
| `review deviations: cannot read the file list of the range <base>...<head> for #<n>: <reason> — the disclosure state is UNKNOWN, never "none".` | 11 | refusal |
| `review deviations: the scan at <sha> covers <k> of the <m> files git lists for the same range <base>...<head> — both counts from git, so these bytes are provably short of the range they were read from; refusing a partial Tier-M scan beside a disclosure claim.` | 13 | refusal |

**Scope** — one PR body's `## Deviations` section plus the bound commit's diff for the Tier-M token
scan, completeness-checked against the file list git reports for the same range. The bound commit,
the scanned file count, that range count and GitHub's declared changed-file count (reported as a
cross-check, never refused on) go to stderr on the answer path.
Whether the PR *owes* the section, and whether an entry's substance covers a finding (Tier R),
are the skill's judgment; this verb reports states and facts, never the §DEV verdict row.

**Examples**

```
$ fabrika review deviations 4321
deviations	none-declared
```

```
$ fabrika review deviations 4322
deviations	found
entry	6	replaced the two-decimal rendering assertion
tier-m	removed-assertion	src/cart.test.ts:14	expect(renderTotal(10)).toBe("10.00")
```

**Grounding**

- gh-issue-intake-formats §DEV (v1) — the four fields, seven classes and M/R/D tiers this verb
  arms; read for semantics, reimplemented here (ADR 0238). Its canonical Tier-M scan was
  specified as a shared script that **no gate actually calls** (the S8 scar) and its heading
  detection is triplicated in awk across three surfaces; one verb ends both.
- "A `deviation-disclosure: PASS` means 'nothing undisclosed that this gate could see'" — the M
  tier is exactly what this gate *can* see deterministically; the verb is that clause's
  mechanical floor.
- #5157 — the completeness denominator is a second local-git read of the same range, not GitHub's
  declared `changed_files`: GitHub computes over its own merge base with its own rename detection,
  which counts two files where git's list carries one path. So the disagreement is reported in the
  diagnostics and never refused on, and the `13` rests on git alone.

---

## `review post`

**Invocation**

```
fabrika review post 4321 --namespace review-code --polarity PASS --sha 03135b91 --clause "merge-ready" [--carrier marker|advisory] [--supersede] [--repo <owner/name>] [--json]
```

The verdict body arrives on **stdin only** — no `--body`, no `--body-file`, for the reason the
sibling write verbs give: a path flag is how a machine-local path reaches a public surface while
the poster reads success.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--namespace` | string | yes | — | the namespace this verdict fills; must match the wire format's class and be in this PR's derived class set |
| `--polarity` | enum | yes | — | `PASS` or `FAIL` — a third token is not a polarity |
| `--sha` | string | yes | — | the head the reviewer actually inspected (7–40 lowercase hex) |
| `--clause` | string | yes | — | the human clause; blank is not a clause |
| `--carrier` | enum | no | `marker` | `marker` (first-line head- and content-bound marker) or `advisory` (§CP: advisory first line, `Reviewed-head: @ <sha>` in the body). `advisory` is a PASS path only |
| `--supersede` | boolean | no | `false` | acknowledge that this verdict retires a standing one of the **opposite** polarity at this head; without it that post is the `17` refusal |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | markdown | yes | — | the verdict body below the first line: per-criterion table, findings, the §DEV row |

**Output** — machine channel. One line:
`posted\t<namespace>\t<polarity>\t<sha>\t<content>\t<created|superseded>\t<comment-url>` — counting
`posted` as the first field, the **fifth** is the content digest the verdict binds (ADR 0276) and
the **sixth** says whether the write opened a fresh comment or appended into this namespace's
existing comment at this head, retiring the verdict that was there.
With `--json`: `{"outcome":"posted","namespace":…,"polarity":…,"sha":…,"content":…,"upsert":"created"|"superseded","carrier":…,"commentUrl":…}`.

**What the operation does, in order — each step gates the next.**

1. **Re-resolve the live head.** `--sha` not prefix-matching it is the `12` refusal: a verdict
   formed over a moved-past tree is re-reviewed, never re-bound. This is `bindToHead`'s `Stale`
   arm applied at the write seam, where its absence costs the most.
2. **Recompute the class set at the bound commit** (the same partition `review scope` prints,
   read through the shared binding step above) and refuse a `--namespace` outside it on `10`.
   This is the disjointness guarantee made structural: v1 got "a gate never emits another gate's
   marker" free from one-skill-per-namespace; under one owner the emit path itself enforces it,
   so a namespace this run did not derive cannot be filled even by a confused caller. The set is
   documented as both floor and ceiling, which is why it is derived from `--sha`'s commit and not
   from the PR-number file endpoint: `12` above proves the tree is still the live one, not that
   the list came from it (#5122).
3. **Compose the first line through the wire format's `emit`**
   (`verdict-marker.ts`, imported — fields `namespace`/`polarity`/`sha`/`content`/`clause`), or with
   `--carrier advisory` the fixed advisory line with the `Reviewed-head: @ <sha>` body line;
   `advisory` with `--polarity FAIL` is a `10` refusal (ADR 0226 — a §CP FAIL posts the ordinary
   FAIL marker).
4. **Leak-scan the assembled comment** (`report/leaks.ts`, imported) — an authored machine-local
   path is the `5` refusal.
5. **Append into one comment per namespace *at this head*, matched under the carrier this post
   uses**: an existing comment by this bot that already carries this namespace **under this carrier,
   bound to the head being posted**, receives the fresh verdict on its first line with its prior
   verdict retired verbatim below the `<!-- fabrika:superseded -->` fence, under a dated
   `## Superseded verdict — YYYY-MM-DD` heading; otherwise a new comment is created. **The prior
   verdict is never replaced.** GitHub keeps no comment-body history, so a PATCH over a verdict is
   that verdict gone: on PR #7081 a FAIL became a PASS at an unchanged head and nothing anywhere
   showed a gate had ever blocked (#7247). The fresh verdict goes on top because the marker is the
   comment's first non-blank line, so every reader — `ship gate`, `review verdicts`, `lane prove` —
   resolves the newest one without knowing the envelope exists. When the write would retire a
   standing verdict of the **opposite** polarity at this head, the post is the `17` refusal unless
   `--supersede` is passed, and nothing is written on that refusal — the flip is legitimate and
   routine, but it is the one that decides the merge, so it is said out loud. A post at a moved head
   appends a new comment, leaving the prior head's verdict intact — a
   verdict is SHA-bound, so a new head's verdict is a different fact, not a revision, and editing
   the old comment destroys the only record of what was true over that tree (ADR 0213 named this
   half of rule 2's key as still open; #4007 closed it in v1). With `marker` the match key is the
   format's `read` over the first non-blank line, plus its `sha` compared prefix-tolerantly to the
   posted head. With `--carrier advisory` it is the ADR-0151 pair — the advisory first line plus the
   `Reviewed-head: @ <sha>` body line, read through `readAdvisory`, whose SHA carries the same head
   dimension — because the advisory first line withholds the SHA, so the marker `read` can never
   match one and a marker-keyed upsert would post a **second** advisory on every re-post. The two
   keys are disjoint: a `marker` post never edits an advisory comment, and an `advisory` post never
   edits a marker one. One namespace at one head, one comment, the carrier's anchor on its literal
   first line — a second marker stacked on line 2 is un-anchored, resolves its namespace empty, and
   fail-closes a substantively-passing PR (the live PR #2456 stall).
6. **Read it back, unconditionally, from live PR state**, under the same carrier — re-fetch the
   comment and, with `marker`, hand its body to the format's `read` and require `Found` with
   exactly the five fields posted; with `--carrier advisory`, require both ADR-0151 anchors —
   `readAdvisory` yielding this namespace and a `Reviewed-head:` SHA equal to the one posted, since
   the format's `read` calls an advisory `Malformed` by design. Either way the whole comment is
   then compared against the bytes sent (through `normalizeForReadback`). A read-back that trusts a
   carried variable instead of the live state re-ships #3173's false PASS; the mismatch is the `9`
   refusal.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — an empty verdict body would read as UNGATED |
| `5` | the assembled comment carries a machine-local path |
| `6` | the body is a bare `@` path reference — the body never arrived |
| `7` | the PR is proven absent (404) or closed |
| `8` | the create/edit failed — UNKNOWN whether a comment landed |
| `9` | the comment landed but the read-back does not yield this marker |
| `10` | `--namespace` off the wire format's class or outside this PR's derived set; a bad `--polarity`; `--carrier advisory` with `--polarity FAIL` |
| `11` | a precondition read failed — the PR, the live head, or the commit binding / bound file list the class set is derived from |
| `12` | the live head moved past `--sha` — re-review at the new head, never re-bind |
| `17` | a standing verdict of the opposite polarity at this head would be retired and `--supersede` was not passed — nothing written |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review post: no body on stdin — an empty verdict reads as UNGATED; pipe the verdict body in.` | 3 | refusal |
| `review post: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.` | 6 | refusal |
| `review post: PR #<n> not found in <repo>.` | 7 | refusal |
| `review post: PR #<n> is closed — a verdict on a closed PR gates nothing.` | 7 | refusal |
| `review post: --polarity must be PASS or FAIL — got "<v>". A third token is not a polarity.` | 10 | refusal |
| `review post: --namespace <ns> is not derived by #<n>'s diff (present: <set>) — a gate never emits a namespace it did not judge.` | 10 | refusal |
| `review post: --carrier advisory is a PASS path only (ADR 0226) — post the FAIL marker instead.` | 10 | refusal |
| `review post: the live head is <live>, not <sha> — the tree you judged is gone; re-review at <live> (ADR 0058).` | 12 | refusal |
| `review post: the assembled comment carries a machine-local path at line <k> (<class>) — cite it repo-relative or by class root.` | 5 | refusal |
| `review post: cannot read <what> for #<n>: <reason> — nothing was posted.` | 11 | refusal |
| `review post: create/edit failed: <reason> — UNKNOWN whether the verdict landed; run \`fabrika review verdicts <n>\` before retrying.` | 8 | refusal |
| `review post: posted, but the read-back does not yield this marker (<wire reason>) — the PR may carry a garbled verdict; inspect comment <id>.` | 9 | refusal |
| `review post: a standing <PASS\|FAIL> for <ns> at <sha> would be superseded by this <PASS\|FAIL> — pass --supersede to retire it on the record. Nothing was posted.` | 17 | refusal |

**Scope** — one PR: its live head (step 1), the bound commit's file list (step 2), its comments
(steps 5–6), plus the caller's stdin. Steps 1, 2 and 5's reads failing is `11` — nothing written,
outcome known-unwritten.

**Examples**

```
$ fabrika review post 4321 --namespace review-doc --polarity PASS --sha 03135b91 --clause "guide matches shipped behavior" < verdict.md
posted	review-doc	PASS	03135b91	2f1a9c4e0b7d	created	https://github.com/kamp-us/phoenix/pull/4321#issuecomment-5154902211
```

```
$ fabrika review post 4321 --namespace review-skill --polarity PASS --sha 03135b91 --clause "ok" < verdict.md
review post: --namespace review-skill is not derived by #4321's diff (present: review-code, review-doc) — a gate never emits a namespace it did not judge.
$ echo $?
10
```

```
$ fabrika review post 4321 --namespace review-doc --polarity PASS --sha 03135b91 --clause "the correction landed" < verdict.md
review post: a standing FAIL for review-doc at 03135b91 would be superseded by this PASS — pass --supersede to retire it on the record. Nothing was posted.
$ echo $?
17
```

```
$ fabrika review post 4321 --namespace review-doc --polarity PASS --sha 03135b91 --clause "the correction landed" --supersede < verdict.md
posted	review-doc	PASS	03135b91	2f1a9c4e0b7d	superseded	https://github.com/kamp-us/phoenix/pull/4321#issuecomment-5154902211
```

**Grounding**

- #3173 — a hand-rolled `gh api` emit posted a literal path and self-reported a false PASS; this
  verb is the single sanctioned path, and the unconditional live-state read-back is v1
  §READBACK's one good idea kept.
- #3945 — the classifier forced a contract-forbidden posting form; a first-class verb with stdin
  is the shape that never needs one.
- #4285's class at the emit seam — the closed `--polarity` / namespace-set enums stop a
  well-formed-looking wrong write before it lands.
- v1 emitted through four per-gate scripts with three conventions and one gate (trivial) skipping
  read-back entirely (S2/S6); one verb, one protocol, no skippable branch.
- ADR 0151 / §ADVISORY — the advisory carrier's fixed shape; ADR 0226 — advisory is PASS-only.
- #7247 / PR #7081 — the upsert replaced a standing FAIL with a PASS and the record of the block
  was unrecoverable; the append and the `17` refusal are that incident's two answers. #6708 / #6736
  settled the same question for issue bodies, and `report amend` is the precedent this follows.

---

## `review append-criterion`

**Invocation**

```
fabrika review append-criterion 4287 --pr 4321 --round 1 [--repo <owner/name>] [--json]
```

The criterion text arrives on **stdin** — one checkbox row's text, without the leading `- [ ]`.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the linked issue receiving the criterion |
| `--pr` | integer | yes | — | the PR whose review round produced the finding — half the provenance tag |
| `--round` | integer | yes | — | this review round's number; at or past the freeze (`src/retry-budget.ts`'s `CAP_ROUND`) the verb escalates instead of appending |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | markdown | yes | — | the criterion text |

**Output** — machine channel. One line: `appended\t<issue>\t<row-count-after>`, or
`escalated-frozen\t<issue>\t<round>` when `--round` is at or past `CAP_ROUND` — the escalation comment landed and the
AC did **not** (fence 4: append-rate stays bounded by fix-rate; a finding raised at the freeze
routes to a human). Both are proven answers at exit 0, discriminated by the token.

With `--json`: `{"outcome":…,"issue":…,"rows":…,"round":…,"acl":"write+"}`.

**The four fences, enforced in this order:**

1. **ACL-gated, fail-closed** (ADR 0055): resolve the invoking token's repository permission;
   below `write`, or any ACL lookup failure, refuses — authority comes from the ACL check, never
   from the text being plausible.
2. **Append-only**: the new body is the old body plus exactly one row (`- [ ] <text>
   <!-- ac:review pr:#<pr> round:<round> -->`) under the existing conforming heading; a diff
   guard refuses any write that would drop or mutate a prior byte. The row lands after the last
   criterion's **last physical line**, taken from the parser's own span — a criterion that wraps
   spans several lines and its text appears on none of them, so matching text against lines found
   no anchor and refused every append on such a body (#5716).
3. **Frozen at ADR 0079's round K**, read from `src/retry-budget.ts`'s `CAP_ROUND`: a `--round` at
   or past it posts the escalation comment instead of appending.
4. **In-scope-only is the caller's** (the trace-to-stated-goal test is judgment); the provenance
   tag is what makes a routed row auditable after the fact.

The row enters the **next** review cycle's conjunctive verdict; the verb does not touch the PR.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing |
| `5` | the criterion text carries a machine-local path |
| `6` | the text is a bare `@` path reference |
| `7` | the issue is proven absent (404) or closed; or its body carries no conforming acceptance-criteria block to append under (the wire read's `Absent`/`Malformed`, distinguished on stderr) |
| `8` | the body PATCH, or on the frozen path the escalation comment, failed — UNKNOWN; the message names which |
| `9` | the write landed but the read-back does not show exactly the old rows plus this one |
| `11` | the issue body, the ACL, or the block could not be read — nothing was written |
| `14` | refused: the invoking token resolves below `write`, or the ACL lookup failed (ADR 0055, fail-closed) — an authorization denial, never mistakable for an absent target |
| `15` | refused: the composed write is not provably the old body plus one row — the append-only fence. Its three causes carry three different messages: no row to append under, a line the diff guard says would move (named), or a composed body the format re-reads as something other than the prior rows plus this one |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review append-criterion: no criterion on stdin.` | 3 | refusal |
| `review append-criterion: the criterion carries a machine-local path at line <k> (<class>) — rewrite it repo-relative.` | 5 | refusal |
| `review append-criterion: the criterion is a bare "@" path reference — the text never arrived. Send it on stdin.` | 6 | refusal |
| `review append-criterion: issue #<n> not found in <repo>.` | 7 | refusal |
| `review append-criterion: issue #<n> is closed — an appended row there enters no cycle; file the finding instead.` | 7 | refusal |
| `review append-criterion: #<n> carries no conforming acceptance-criteria block (<absent|malformed>: <wire reason>) — nothing to append under.` | 7 | refusal |
| `review append-criterion: token resolves below write on <repo>, or the ACL could not be read — refusing the append (ADR 0055, fail-closed).` | 14 | refusal |
| `review append-criterion: cannot read <what>: <reason> — nothing was written.` | 11 | refusal |
| `review append-criterion: no row to append under — <reason>; nothing was written.` | 15 | refusal |
| `review append-criterion: the append would drop or mutate an existing row — <which line moved>; refusing (append-only fence).` | 15 | refusal |
| `review append-criterion: the composed body does not re-read as the <k> prior row(s) plus this one — it re-reads as <what>; refusing (append-only fence).` | 15 | refusal |
| `review append-criterion: PATCH failed: <reason> — UNKNOWN whether the row landed; re-read #<n> before retrying.` | 8 | refusal |
| `review append-criterion: the escalation comment failed: <reason> — UNKNOWN whether it landed; nothing was appended either way. Re-run.` | 8 | refusal |
| `review append-criterion: read-back does not show the prior rows plus this one — inspect #<n>.` | 9 | refusal |

**Scope** — one issue body (through the registered AC format), the invoking token's ACL, and on
the frozen path one comment write. The read-back re-reads the block through the same format and
compares row-by-row.

**Examples**

```
$ printf 'a regression test covers qty > 1' | fabrika review append-criterion 4287 --pr 4321 --round 1
appended	4287	3
```

```
$ printf 'anything' | fabrika review append-criterion 4287 --pr 4321 --round 3
escalated-frozen	4287	3
```

**Grounding**

- ADR 0079 — reviewer-authored acceptance criteria: routed binary, appended under fences, frozen
  at K = N = 3 (the value the ADR set; the fence reads it from `src/retry-budget.ts`'s
  `CAP_ROUND`); v1's `reviewer-append-ac.sh` was mandated at four call sites and called at none
  (the S8 scar) — a first-class verb is the difference between a fence and a fence description.
- ADR 0055 — authority from the ACL check; a below-write author or a failed lookup skips the
  append entirely, fail-closed.

---

## `review scratch`

**Invocation**

```
fabrika review scratch 4321 --slug <leaf> --lane <lane-key> --sha <head>
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull request this lane is reviewing |
| `--slug` | string | yes | — | the file's leaf name: kebab-case, no path separators |
| `--lane` | string | yes | — | the lane key from this reviewer's spawn brief |
| `--sha` | string | yes | — | the head `review scope` bound, 7–40 hex |

**Output** — machine channel. One absolute path on stdout:
`<temp root>/fabrika-review/<session-id>/<pr>-<lane-nonce>/<slug>`. The directory is created if
absent; the leaf is not. `<lane-nonce>` is twelve hex of `sha256(<lane> \n <sha>)`. No `--json`:
the path is the answer.

**Exit status**

| Code | Trigger |
|---|---|
| `1` | the directory could not be created, `--lane` is blank, the positional is not a PR number, or no session id is set (the `FABRIKA_SESSION_ID` → `CLAUDE_CODE_SESSION_ID` → `PI_SUBAGENT_PARENT_SESSION` chain) or the id is not one path segment |
| `10` | `--slug` carries a path separator or is not kebab-case, or `--sha` is not a head SHA |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review scratch: <n> is not a pull-request number.` | 1 | refusal |
| `review scratch: --lane is blank — this run names no lane, so the only namespace left is the session's, which is the one two reviewers share; refusing to allocate it.` | 1 | refusal |
| `review scratch: no session id is set — … — refusing to key a scratch namespace on an unattributable session.` | 1 | refusal |
| `review scratch: the session id is not one path segment — it cannot name a directory of its own.` | 1 | refusal |
| `review scratch: cannot create <dir>: <reason>` | 1 | refusal |
| `review scratch: --slug "<v>" must be a kebab-case leaf, no path separators.` | 10 | refusal |
| `review scratch: --sha "<v>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |

**Scope** — one directory, allocated. It writes no file, reads no board state, and makes no network
call.

**Examples**

```
$ fabrika review scratch 4321 --slug diff --lane 4287 --sha 03135b91
/var/folders/kx/T/fabrika-review/s-9f2e/4321-8c9e018c5568/diff

$ fabrika review scratch 4321 --slug diff --lane "" --sha 03135b91
review scratch: --lane is blank — this run names no lane, so the only namespace left is the
session's, which is the one two reviewers share; refusing to allocate it.
$ echo $?
1
```

**Grounding**

- #7246 — a reviewer redirected `review diff` to a generic `diff.txt` in the session scratchpad and
  read it in two passes; between the reads a concurrent lane replaced the bytes with another PR's
  diff. The verdict would have graded one PR's criteria against another PR's bytes while carrying
  the correct head, which nothing downstream — `ship`'s re-derivation included — can detect. Caught
  only by an unrelated cross-check against `gh pr view --json files`. Live on PR #7232.
- `build scratch` (#4516, #4544, #4875, #4692, #6037) and `triage scratch` (#6630) took the same
  fix before this group did, both keyed on a claim token's nonce. This group ships no claim verb, so
  the key is derived from `--lane` and `--sha` instead: same namespace shape, a source this lane can
  actually name.
- The alternative — have `review diff` verify staged bytes on re-read — was offered on #7246 and not
  filed. It re-derives *detection* where the namespace makes the collision unconstructible, which is
  the route both prior fixes took.

---

## The eval-enumeration obligation (leaf rule)

Stated once, in [`SKILL.md`](SKILL.md)'s "Eval enumeration" section — the single home #4891's
obligation lives in. This spec adds nothing to it; the eval mechanics belong to #4649.

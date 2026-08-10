# `/handoff` — derived CLI contract

**Skill:** [`handoff`](SKILL.md) · **Authoring brief:** [#5021](https://github.com/kamp-us/phoenix/issues/5021) · **Date:** 2026-08-09

**Where these verbs land.** `packages/fabrika-cli/`, under a **`handoff`** subcommand group
registered in [`src/registry.ts`](../../../../packages/fabrika-cli/src/registry.ts). Each leaf is
built with `leafCommand` from
[`src/excess-operand.ts`](../../../../packages/fabrika-cli/src/excess-operand.ts) so an undeclared
operand is refused rather than ignored. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill.** No verb here invokes
anything under `claude-plugins/kampus-pipeline/` or `packages/pipeline-cli/`, in a fence, behind a
wrapper, or as a contract clause (ADR
[0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Every v1 module
named in a **Grounding** block below is cited as a **scar to design out**, never as a dependency —
those citations are non-normative and an implementer opens none of them to build this.

**The group name.** `handoff`, free against
[`src/registry.ts`](../../../../packages/fabrika-cli/src/registry.ts) when this was written; the
registered groups were `adr build epic eval hook ledger plan report review review-ui ship spend
triage ui wire`. That list grows most weeks, so read the file rather than this sentence. Unlike its
quintet siblings — whose groups are the domain noun rather than the skill name (`wayfinding`→`map`,
`grilling`→`grill`, `prototyping`→`spike`) — the skill name *is* the domain noun here, and the
obvious short alternative `pack` was rejected as ambiguous with packaging.

**A note on the literals printed below.** Nonces, comment ids and commit SHAs in the examples are
**illustrative placeholders conforming to the stated grammars**, not values recoverable from
anything. Digests are different and are held to a higher bar: the digest computation is specified
completely in *The ground state* below, and the worked example there prints its **exact pre-image**
so a reader can compute the digest and check it rather than trusting a literal (ADR
[0247](../../../../.decisions/0247-a-spec-example-value-is-derivable-or-absent.md)). Every **packed**
digest printed below is that computed value. The one **live** digest — in `read`'s drift example,
where the live ground state is deliberately not printed in full — is a placeholder, marked as one
there.

**What fabrika already ships, reused — never respecified.** Each is imported, not restated, because
a transcription drifts and a pointer to code cannot:

- [`src/verb.ts`](../../../../packages/fabrika-cli/src/verb.ts) — `answer` / `refuse`. **Their shape
  bounds this whole spec**: `refuse` hardcodes empty stdout and `answer` hardcodes code `0`, so a
  non-zero exit carrying a machine payload is not constructible and is specified nowhere below.
  Every proven outcome a caller must *parse* therefore lands as a state token at exit `0`. (The
  `emit` adapter that writes the streams and exits is **not** exported from `verb.ts` — it is a
  module-private constant each group declares for itself, e.g. `report/command.ts`; this group
  declares its own.)
- [`src/io/stdin.ts`](../../../../packages/fabrika-cli/src/io/stdin.ts) — `readStdin`. The fd-0
  boundary, where `Text("")` and `Failed` are different answers and never collapse. The by-value
  seam.
- [`src/report/leaks.ts`](../../../../packages/fabrika-cli/src/report/leaks.ts) — `scanBody`,
  `isBareAtReference`, `renderLeaks`. Pure, zero imports; three structural shapes, no name list.
- [`src/report/compose.ts`](../../../../packages/fabrika-cli/src/report/compose.ts) —
  `normalizeForReadback`. Read-backs compare normalized, never byte-identical.
- [`src/io/issues.ts`](../../../../packages/fabrika-cli/src/io/issues.ts) — `getIssue`,
  `listComments`, `createComment`, `pagedJson`. Its
  **`Existence<A>` = `Present | Absent | Unknown`** keeps a proven 404 apart from an unreachable
  GitHub, which every read below rests on.
- [`src/io/pulls.ts`](../../../../packages/fabrika-cli/src/io/pulls.ts) — `permissionFor`,
  `viewerLogin`. The ACL read `handoff read` resolves a pack's author with.
- [`src/io/git.ts`](../../../../packages/fabrika-cli/src/io/git.ts) — `resolveCommit`,
  `isObjectName`. Every commit is a resolved object name, never a ref string.
- [`src/io/exec.ts`](../../../../packages/fabrika-cli/src/io/exec.ts) — `execCapture`, the one
  subprocess seam, where a non-zero exit is **data** in `ok` rather than an `E`-channel failure.
  Every `git` read below goes through it.
- [`src/ledger/digest.ts`](../../../../packages/fabrika-cli/src/ledger/digest.ts) — `bodyDigest`,
  the first 12 hex of SHA-256 after `normalizeForReadback`. The ground digest is this function over
  a different input, not a second implementation.
- [`src/wire/format.ts`](../../../../packages/fabrika-cli/src/wire/format.ts) — `WireRead<A>` =
  `Found | Absent | Malformed`, with `Found` carrying a `NonEmptyReadonlyArray` **by construction**.
  This is why a malformed pack can never be reported as an absent one.

**Read for its shape, NOT imported.**
[`src/wire/slice-handoff.ts`](../../../../packages/fabrika-cli/src/wire/slice-handoff.ts) is the
closest prior art in the package and the **inverse** of this format, which is what makes it
instructive rather than reusable. Its posture is *in-session, never posted*: its `## Ground` paths
are machine-local by construction, so the leak scan the posting verbs run would red on exactly the
values it exists to carry. The pack is the opposite — **posted by definition**, so it carries no
machine-local path at all and the leak scan is precisely right for it. What *is* inherited is that
module's load-bearing discipline, stated in its own docblock: **the read side refuses an artifact
carrying content outside its closed section set**, because a coordination artifact whose section set
is open can steer its receiver past the artifact — an extra heading, a sentence appended under a
known one, a "note from the maintainer" — and the receiver cannot tell the format's own words from
someone else's. That is the injection defence the pack needs, and it is why the five sections are
closed rather than merely expected. It cannot be *called*: its fields are a slice id, a branch and a
worktree root, none of which a pack carries.

[`src/build/claim.ts`](../../../../packages/fabrika-cli/src/build/claim.ts) is the model for
marker-based claiming and cannot be called either: `composeMarker` hardcodes the `build-claim:`
prefix, `MARKER_RE` matches only that grammar, and `resolveOwnership` compares a **session** token,
so `markersIn` would find zero markers on a pack and every claim would read as unclaimed. This group
authors its own marker grammar and keys on a run nonce.

**Considered and deliberately not derived.**

- **A `handoff drift` verb.** An earlier draft had one, reading a pack and comparing it against
  live. Folded into `handoff read`, because separating them makes the dangerous call the *easy* one:
  a caller who runs `read` and skips `drift` holds a pack that reads current while being stale,
  which is the #3330 class this group is largely built against. One verb answering both questions
  makes "read without checking drift" unrepresentable rather than merely discouraged.
- **A verb that decides whether a session is worth handing off.** That judgment is the wrapper's
  ([`SKILL.md`](SKILL.md) §1). A verb guessing it would be a stochastic answer wearing a
  deterministic exit code.
- **A verb that writes, summarizes, or grades the asserted half.** The four sections are the model's
  words. A verb that generated them would be composing the document from the same session memory the
  two-half split exists to distrust, and one that graded them would be a second reviewer nobody
  asked for.
- **A verb that commits, pushes, or otherwise makes unreachable work reachable.** `take` refuses
  `12` and names the remedy; performing it is the caller's act outside this group, which pushes
  nothing (`SKILL.md` §CAP). A push verb here would put the widest capability in the group in
  service of its narrowest need.
- **A verb that files anything.** `handoff` creates no work. If the session's observation is *new
  work someone should do*, the model fires the `report` Skill and this group is not involved (#4636,
  #4640). A filing verb here would rebuild the self-filing side door the quintet exists to close,
  under a new name.
- **A verb that closes, labels, or retires a pack.** A later `handoff take` supersedes an earlier
  pack by ordering — `read` resolves the **latest** sealed pack — so a retirement verb would add a
  second, drift-prone way to express what ordering already expresses. This group applies no label of
  any kind.
- **A merge-gating verdict.** `handoff` is deliberately absent from `SHIP_NAMESPACES`
  ([`src/review/classes.ts`](../../../../packages/fabrika-cli/src/review/classes.ts)) and emits no
  verdict marker, so `wire/verdict-marker.ts`'s `NAMESPACE` regex and its separate
  `NAMESPACE_PREFIXES` gate are **not** widened. Nothing recorded here can block a merge — stated
  because a session state that gated a merge would make every interrupted session a blocked one.
- **A second answer to triage's classification, to control-plane membership, or to pitch approval.**
  Each is enforced at its own gate. This group states expectations and computes none of them.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `handoff capture` | derive the ground state — branch, head, reachability, tree, base, issue and pull-request state — as one JSON object | every field is a total function of the git repository and the board; *what any of it means for the work* is the caller's |
| `handoff take` | compose the pack by value from the caller's asserted half plus a fresh capture, leak-scan it, post it as one marker-bearing comment, and read it back | the compose, the scan, the reachability guard, the post and the read-back are mechanical; *what to say in the four sections* is irreducibly the model's |
| `handoff read` | resolve the latest sealed pack, parse it into its two halves, re-derive the ground state now, and report the drift field by field | a parse, an ACL read, and a field-by-field comparison of two derived records; *whether the drift makes the pack unusable* is the caller's |
| `handoff claim` | claim the latest sealed pack, keyed on the run nonce | a compare-and-set on a marker; *whether to take up the work* is the caller's |

## The pack document this group WRITES

One comment. The marker line, then the asserted half, then the proven half — in this order and
nothing else:

```markdown
<!-- fabrika:handoff pack nonce=7f3a9c21 sealedAt=2026-08-09T18:36:48Z groundDigest=368842989186 -->

## Intent
Make the fanout guard classify a mutation that writes through a helper.

## Established
The guard reads the mutation's own file only, so a write reached through `applyEdit` is invisible
to it. Confirmed by a failing case added to the guard's unit test; the case is committed.

## Next act
Widen the guard's scan to follow one level of local helper call, then re-run the failing case.

## Unsure
Whether one level is enough. I did not survey how deep the real call chains go.

## Ground state — proven
```json
{"issue":5021,"repo":"kamp-us/phoenix","capturedAt":"2026-08-09T18:36:48Z","git":{"branch":"umut/fanout-helper","head":"4f1c8a2b9d3e5607182934abcdef5566778899aa","upstream":"origin/umut/fanout-helper","reachable":"pushed","aheadBy":0,"behindBy":2,"base":{"branch":"main","head":"11223344556677889900aabbccddeeff00112233"},"tree":{"state":"clean","trackedModified":0,"untracked":0}},"board":{"issue":{"state":"open","labels":["p2","type:chore"]},"pull":{"number":5290,"state":"open","head":"4f1c8a2b9d3e5607182934abcdef5566778899aa","checks":"failing"}},"groundDigest":"368842989186"}
```
```

**The asserted half is a closed set of exactly four sections**, in this order, each present and
non-empty: `## Intent`, `## Established`, `## Next act`, `## Unsure`. The proven half is the single
section `## Ground state — proven`, holding one fenced JSON object and nothing else, written by the
verb and never by the caller.

<!-- anchor: THE-SECTION-SET-IS-CLOSED --> **Content outside those five headings is refused, not
ignored.** A fifth heading, prose before the first heading, or text after the JSON fence is `4` on
the way in and `14` on the way out. This is `slice-handoff`'s discipline and it is the pack's whole
injection defence: an open section set lets an author append a paragraph a successor reads as part
of the format, and the successor has no way to tell the format's own words from someone else's.

<!-- anchor: UNSURE-IS-NEVER-SILENT --> **An empty asserted section is `4`.** A section skipped and
a section with nothing to say are the same bytes and opposite facts, so the format refuses to
represent the ambiguity; `## Unsure` is the row this exists for. The instruction that follows from
it is the skill's ([`SKILL.md`](SKILL.md) step 3), not restated here.

**The caller supplies only the four asserted sections on stdin.** `handoff take` appends the proven
half itself, from its own fresh capture — a caller-supplied ground state would be exactly the
premise-inheritance (#4133) the two-half split exists to prevent.

## The pack marker, and its wire format

One line, the first line of the comment:

```
<!-- fabrika:handoff pack nonce=7f3a9c21 sealedAt=2026-08-09T18:36:48Z groundDigest=368842989186 -->
```

and the claim, the first line of its own separate comment:

```
<!-- fabrika:handoff claim nonce=4b8e2f01 packComment=9234567891 claimedAt=2026-08-09T19:02:11Z -->
```

Fields: `nonce` matches `^[0-9a-f]{8}$` and is **authored by the caller**, never minted by a verb and
never read from the environment; `sealedAt` / `claimedAt` are ISO-8601 UTC with a trailing `Z`;
`groundDigest` is exactly 12 lowercase hex; `packComment` is the comment id of the pack being claimed — the bare key `pack` is never an id anywhere in this group, in a marker or in an answer. A
comment whose first line does not match is not a pack and not a claim — it is not a near-miss to be
tolerated.

**This lands as a registered wire format, key `handoff-pack`**, with a sibling schema module and one
row in [`src/wire/registry.ts`](../../../../packages/fabrika-cli/src/wire/registry.ts)
(`producers: ["handoff"]`, `consumers: ["handoff"]`). The registry is the right home precisely
because this artifact crosses the widest boundary in the corpus — one session to another that shares
no memory, no worktree, and possibly no machine — and `WireRead<A>`'s three answers are what that
boundary needs: **a malformed pack must never read as an absent one**, or a successor concludes
nobody handed off and starts over. The key is deliberately distinct from the shipped `slice-handoff`,
a different format with an inverted posture.

**Not widened, deliberately.** `wire/verdict-marker.ts`'s `NAMESPACE` regex and its separate
`NAMESPACE_PREFIXES` gate are left alone. Those govern **verdict markers** specifically; a registered
format need not be a member, and the shipped `slice-handoff` is the proof — it is registered
(`wire/registry.ts`) and appears in neither. This group emits no verdict, so widening either would
admit a merge-gating namespace for a skill that gates nothing.

## The ground state, and its neutrality invariant

`capture` emits one JSON object with a fixed key set of **nineteen digested fields** plus the two
undigested ones (`capturedAt`, `groundDigest`). Every field's derivation:

| # | Field | Derivation | Shape / closed set |
|---|---|---|---|
| 1 | `issue` | the `--issue` operand | integer |
| 2 | `repo` | `--repo`, or the `origin` remote's `owner/name` | string |
| 3 | `git.branch` | `git rev-parse --abbrev-ref HEAD` | string; `"HEAD"` when detached |
| 4 | `git.head` | `git rev-parse HEAD`, resolved with `resolveCommit` | 40 lowercase hex |
| 5 | `git.upstream` | `git rev-parse --abbrev-ref --symbolic-full-name @{u}` | string, or `null` when unset |
| 6 | `git.reachable` | `pushed` when `upstream` resolves and `git merge-base --is-ancestor HEAD @{u}` exits `0`; `unpushed` when it exits non-zero; `unknown` when `upstream` is `null` | `pushed` / `unpushed` / `unknown` |
| 7 | `git.aheadBy` | the right count of `git rev-list --left-right --count @{u}...HEAD` | integer, or `null` when `upstream` is `null` |
| 8 | `git.behindBy` | the left count of the same command | integer, or `null` when `upstream` is `null` |
| 9 | `git.base.branch` | `--base`, defaulting to the repository's default branch from the `getIssue` repo payload | string |
| 10 | `git.base.head` | `git rev-parse <base.branch>` | 40 lowercase hex |
| 11 | `git.tree.state` | `clean` when `git status --porcelain=v1 --untracked-files=all` prints nothing; `dirty` otherwise | `clean` / `dirty` |
| 12 | `git.tree.trackedModified` | count of porcelain lines whose status is not `??` | integer |
| 13 | `git.tree.untracked` | count of porcelain lines whose status is `??` | integer |
| 14 | `board.issue.state` | the issue payload's `state` | `open` / `closed` |
| 15 | `board.issue.labels` | the issue payload's label names, sorted ascending by code point | array of strings |
| 16 | `board.pull.number` | the most recently created pull request whose head ref equals `git.branch`, whatever its state; the whole `board.pull` object is `null` when there is none | integer |
| 17 | `board.pull.state` | `merged` when the payload's `merged_at` is non-null; else the payload's `state` | `open` / `closed` / `merged` |
| 18 | `board.pull.head` | the payload's `head.sha` | 40 lowercase hex |
| 19 | `board.pull.checks` | `failing` if any check run on `board.pull.head` concluded `failure`, `cancelled` or `timed_out`; else `pending` if any is `queued` or `in_progress`; else `passing` if at least one concluded `success`; else `none` | `passing` / `failing` / `pending` / `none` |
| — | `capturedAt` | the wall clock at derivation | ISO-8601 UTC, trailing `Z`. **Not digested, not compared** |
| — | `groundDigest` | see below | 12 lowercase hex. **Not digested, not compared** |

<!-- anchor: A-FAILED-READ-IS-NEVER-A-VALUE --> **No field carries `unknown` to mean "the read
failed".** A git or board read that fails is `11` for the whole verb — the ground is UNKNOWN and no
object is emitted. The single `unknown` in the table, `git.reachable`, is a **fact** about a
repository with no configured upstream, not a failure; `aheadBy` and `behindBy` are `null` in the
same case for the same reason. Conflating the two is how a guard vouches for a tree it never read
(ADR [0092](../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

**The digest pre-image is the nineteen numbered fields, in that order**, one per line as
`<path>=<json>` where `<json>` is the field's JSON encoding (`null` for an absent one, and all four
`board.pull.*` lines carry `null` when `board.pull` is), LF-joined with a trailing newline.
`groundDigest` is `bodyDigest` of that string. For the worked example above the pre-image is exactly:

```
issue=5021
repo="kamp-us/phoenix"
git.branch="umut/fanout-helper"
git.head="4f1c8a2b9d3e5607182934abcdef5566778899aa"
git.upstream="origin/umut/fanout-helper"
git.reachable="pushed"
git.aheadBy=0
git.behindBy=2
git.base.branch="main"
git.base.head="11223344556677889900aabbccddeeff00112233"
git.tree.state="clean"
git.tree.trackedModified=0
git.tree.untracked=0
board.issue.state="open"
board.issue.labels=["p2","type:chore"]
board.pull.number=5290
board.pull.state="open"
board.pull.head="4f1c8a2b9d3e5607182934abcdef5566778899aa"
board.pull.checks="failing"
```

<!-- anchor: THE-GROUND-EXCLUDES-WHAT-THIS-GROUP-WRITES --> **Named invariant — the digested set
excludes exactly the fields this group's own writes move, and nothing more.** The pack and the claim
are both **comments**, so the fields a write of ours could move are the issue's `updated_at`, its
comment count and its comment ids; none of the nineteen is one of them. Walk them: rows 1–2 are
operands; 3–13 are git state no comment touches; 14–15 are the issue's `state` and labels, and this
group applies no label and closes nothing; 16–19 are pull-request fields no comment on an *issue*
can move. One honest qualification on row 15: the claim is that **no write of this group's** moves a
digested field, and a host repository whose own automation relabels in response to a comment can
move it anyway. That is someone else's write, but it is drift a successor will see, so the invariant
is stated against this group's writes rather than against the world. Therefore a successor's drift check never fires on the handoff's own footprint, and
`drift: "none"` is a statement about the *work* rather than an artefact of the recording. `capturedAt`
is excluded for a different reason — it differs on every derivation by construction, so digesting or
comparing it would make drift permanently `moved`. Every exclusion is drift you can no longer
detect, so the set is held to those two. The implementation owes a deterministic test that `take`
followed immediately by `read` yields `drift: "none"`.

**The compared set is the same nineteen fields.** `read`'s drift is a field-by-field comparison over
exactly the digest pre-image, so the digest and the drift can never disagree about what counts.

## Shared conventions

Every `handoff` verb obeys these; stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries one JSON object and nothing else. Scope lines, refusal
  reasons and progress go to stderr. **A non-zero exit prints nothing on stdout** — the shipped
  `refuse` helper hardcodes empty stdout, so a partial answer beside a failure code is not
  constructible here and is specified nowhere.
- **A proven outcome is a state word at exit `0`, never a non-zero code.** `read`'s `pack` token is
  the worked case: `none`, `sealed` and `claimed` are three answers and **all three exit `0`**. An
  issue nobody handed off is the ordinary case, and seating it on a non-zero code would make a
  caller's `[ $? -ne 0 ]` read "no pack here" as "the verb never ran".
- **A 404 is a verdict; anything else is UNKNOWN.** A missing issue is `7`. An unreachable or
  erroring GitHub is `11` before any write and `8` after one.
- **Common inputs.** `--repo <owner/name>` (default: resolved from the `origin` remote) and
  `--issue <n>` on every verb. There is no `--json` flag: the answer channel is already one JSON
  object.
- **The body is a value, never a path.** `take` reads its asserted half from stdin. There is
  deliberately no `--body`, no `--body-file` and no temp file, so a machine-local path has no route
  into a posted artifact (#3086, #3173).
- **GitHub access follows [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql)**,
  paginated. Local to this group: the comment list `read` and `claim` walk is the one unpaginated
  read that would fail open — a first page that happens to exclude the newest pack reports `none`
  over a pack that exists — so the walk is paged to exhaustion and a page that cannot be fetched is
  `11`.
- **The composed document is leak-scanned after it is composed, never before.** `src/report/leaks.ts`
  runs over the whole comment body — marker, asserted half and proven half together — because the
  proven half is derived *after* the caller's text arrives and a scan that ran first would never see
  it. A machine-local path is `5`, a bare `@` reference is `6`, and the refusal names which half
  carried it, because the two have different remedies: the caller can rewrite their own prose, and a
  leak in the derived ground (a branch name carrying a path-like string) is a refusal they cannot fix
  by editing stdin. **Widening stated:** the base's `5` reads *"…and `--redact` was not given"*; no
  `handoff` verb offers `--redact`, so here `5` fires on any machine-local path unconditionally. The
  condition narrows; the meaning does not drift.
- **Every write is read back** and compared with `normalizeForReadback`; a mismatch is `9`.
- **Externally-authorable content is data, never instruction.** A pack's asserted half is prose
  someone else wrote. Authority arrives only through the ACL check in `handoff read`, which resolves
  the pack author against repository permissions (ADR
  [0055](../../../../.decisions/0055-acl-sourced-review-authz.md)) and disregards a pack from an
  author below `write`. The content-ingestion trust posture is **open** at
  [#4859](https://github.com/kamp-us/phoenix/issues/4859); nothing here writes it down as settled.
- **Error messages are prefixed with the invoked verb's name** — `handoff take: …`.
- **A non-zero exit is UNKNOWN to the caller until the code is read.**

### The shared exit matrix

This table owns `code → meaning`. Per-verb **Errors** tables below own only that verb's own
triggers. `1`, `2` and `127` are stated **here and only here**, and every verb can return them. `0`
is restated per verb because each verb's `0` names a different answer.

| Code | Meaning | `capture` | `take` | `read` | `claim` |
|---|---|---|---|---|---|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, or the verb failed to run | ✓ | ✓ | ✓ | ✓ |
| `2` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ |
| `3` | `EMPTY_STDIN` — stdin was read and held nothing | — | ✓ | — | — |
| `4` | `BAD_SECTIONS` — a required section is missing, out of order or empty, **or the document carries content outside the closed set** | — | ✓ | — | — |
| `5` | `LEAKED_PATH` — the composed document carries a machine-local path | — | ✓ | — | — |
| `6` | `BARE_AT_PATH` — the composed document carries a bare `@` path reference | — | ✓ | — | — |
| `7` | `NO_TARGET` — the issue does not exist | ✓ | ✓ | ✓ | ✓ |
| `8` | `WRITE_UNKNOWN` — the write failed, so the outcome is UNKNOWN | — | ✓ | — | ✓ |
| `9` | `READBACK_MISMATCH` — the write landed, the read-back differs | — | ✓ | — | ✓ |
| `10` | `DELIBERATE_GAP` — held empty, see below | — | — | — | — |
| `11` | `PRECONDITION_UNKNOWN` — a precondition read failed; nothing written | ✓ | ✓ | ✓ | ✓ |
| `12` | `WORK_UNREACHABLE` — the work is proven unreachable by a successor and the loss was not declared | — | ✓ | — | — |
| `13` | `NO_PACK` — proven: the issue carries no sealed pack | — | — | — | ✓ |
| `14` | `PACK_MALFORMED` — a sealed pack exists and does not parse | — | — | ✓ | ✓ |
| `15` | `PACK_CLAIMED` — another nonce holds the latest pack's claim | — | — | — | ✓ |

**`3`–`11` are imported from
[`src/report/codes.ts`](../../../../packages/fabrika-cli/src/report/codes.ts)**, not restated as
numerals, so a drift is unrepresentable rather than merely detectable.

<!-- anchor: THE-FOUR-WIDENING --> **`4` is widened here, and the widening is the load-bearing
one.** The base's `BAD_SECTIONS` is *a required section is missing, out of order, or empty*; this
group adds **content outside the closed section set**, which is the whole injection defence. It is
declared rather than silent because an imported constant quietly carrying a second meaning is the
drift the import exists to stop. The seat keeps the base's name and number; only the trigger set
grows, and it grows in the fail-closed direction. (`review-ui` renames its seat to
`MALFORMED_DOCUMENT` for a comparable widening; keeping the base name here is deliberate, since the
condition is still "this document does not have the sections it must".)

`12`–`15` are the group's own and clear the base's occupied seats; they carry **no** cross-group
uniqueness obligation, so `build`'s `12 NOT_A_WORKTREE` and this group's `12` are two namespaces
rather than a collision. The governing rule is the shipped one at
[`src/plan/codes.ts`](../../../../packages/fabrika-cli/src/plan/codes.ts): *import a code when two
groups prove the same fact; allocate freely when they do not.* `build`'s `13 DIRTY_TREE` is the near
miss worth naming — this group's `12` proves a **different** fact (unreachable *to a successor*,
which is an unpushed head **or** a modified tracked file, and which `--declare-unreachable` waives),
so it is allocated rather than imported.

**`10` is a deliberate gap**, on the shipped `ui` precedent (`src/ui/codes.ts`, which holds seat `3`
the same way). The base's `10 CLASSIFIED` fires when a title or label carries a type or priority
classification; no `handoff` verb accepts a label flag, writes a label, or composes a title, so the
condition is unreachable rather than merely unused.

<!-- anchor: WHY-NO-PACK-IS-0-ON-READ-AND-13-ON-CLAIM --> **Why the same fact is exit `0` on `read`
and `13` on `claim`.** They are different questions. `read` **supplies an input**, and interface rule
4 makes an empty result a fact or a failed read once, in the header: zero packs on an issue is a
**fact** — most issues have none — so it is the `none` token at `0`, and a successor branches on the
token. `claim` **acts**, and asking to claim a pack that does not exist is a request that cannot be
honoured, so it refuses. Collapsing them either way costs something real: seating `read`'s answer on
`13` would hand a booting successor empty stdout on the ordinary case, and answering `claim` with `0`
would report a claim nobody holds.

**Registration burden the implementer inherits — five distinct edits beyond the group's own
`src/handoff/command.ts` and `src/handoff/codes.ts`, none implied by the others.**

1. `src/registry.ts` — add `handoffCommand` to `registeredGroups`.
2. `src/exit-code-alignment.ts` — add `handoff` to `ALIGNED_GROUPS` with a `HANDOFF_SEATS` constant
   authored in that same file. **The map holds only the seats this group genuinely shares with the
   base, keyed by this group's own export names, and the `10` gap seat is DELETED from it** — on the
   `UI_SEATS` precedent in that file, which removes its gap seat and lets `allocatedCodes` skip the
   gap export. Keying `10` as `DELIBERATE_GAP` instead would look up a name the base does not have,
   yield a `SeatDrift`, and red `exit-code-alignment.unit.test.ts`.
3. `src/exit-code-alignment.unit.test.ts` — add a `handoff` row to the hand-written `TABLES` map, or
   the on-disk-versus-registered coverage assertion reds the moment `src/handoff/codes.ts` exists.
   **That red is the intended order, not a mistake**: the scan is `existsSync` over
   `src/*/codes.ts`, so the file's creation is what arms the check.
4. The `handoff-pack` wire format: a schema module exporting `emitFromFields` / `readToLines`, its
   `src/wire/registry.ts` row carrying `fixtures` and `brands` (both required by `WireFormat`), and
   its `### handoff-pack` section in `docs/wire-formats.md` — without the last,
   `src/wire/index-doc.unit.test.ts` reds on key-set equality.
5. `packages/fabrika-cli/README.md` — add the group to the list and a `## The handoff group`
   section. This one is **convention, not enforcement**: `readme-guard` only checks that each
   workspace member has a README at all, and several shipped groups have no section today. Stated
   so an implementer does not skip it believing CI will catch it, and does not hunt for a job that
   would.

**One vocabulary this group is NOT a member of, stated because it bites the ship gate rather than
the code.** `src/eval/corpus.ts`'s `STAGES` is `["triage", "build", "review", "ship-it"]`, so there
is no stage under which a `handoff` eval entry can be decoded. That is a corpus-wide gap affecting
the whole quintet, open and unruled at [#5241](https://github.com/kamp-us/phoenix/issues/5241) and
owned by [#4649](https://github.com/kamp-us/phoenix/issues/4649)'s harness rather than by this
contract. It is recorded here so an implementer meets it as a known absence, and so the
skill-conventions §8 gate-3 leg is understood to be **blocked, not skipped**.

---

## `handoff capture`

**Invocation**

```
fabrika handoff capture --issue 5021 [--base main] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--issue` | integer | yes | — | the issue the work belongs to; its live state and any pull request on this branch are part of the ground |
| `--base` | string | no | the repository's default branch | the branch the work is measured against |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object, the ground state specified above:

```json
{"issue":5021,"repo":"kamp-us/phoenix","capturedAt":"2026-08-09T18:36:48Z","git":{"branch":"umut/fanout-helper","head":"4f1c8a2b9d3e5607182934abcdef5566778899aa","upstream":"origin/umut/fanout-helper","reachable":"pushed","aheadBy":0,"behindBy":2,"base":{"branch":"main","head":"11223344556677889900aabbccddeeff00112233"},"tree":{"state":"clean","trackedModified":0,"untracked":0}},"board":{"issue":{"state":"open","labels":["p2","type:chore"]},"pull":{"number":5290,"state":"open","head":"4f1c8a2b9d3e5607182934abcdef5566778899aa","checks":"failing"}},"groundDigest":"368842989186"}
```

**There is no empty answer.** A repository always has a git state and an issue always has a state,
so this verb either produces the object or refuses — the header decision interface rule 4 requires.
`board.pull` being `null` is a **fact** (no pull request has this head ref), not an absence;
`git.upstream` being `null` is likewise a fact.

**This verb writes nothing and reads no comments.** It is pure derivation, which is what makes it
safe for a successor to re-run against a pack it has not yet decided to trust.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the ground state is on stdout |
| `7` | `--issue` names no issue in the repository |
| `11` | a git read or a board read failed; the ground is UNKNOWN |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `handoff capture: #<n> does not exist in <repo>.` | 7 | refusal |
| `handoff capture: not inside a git working tree (<reason>) — the ground is UNKNOWN, never clean.` | 11 | refusal |
| `handoff capture: cannot read #<n>'s state: <reason> — the ground is UNKNOWN.` | 11 | refusal |
| `handoff capture: cannot list check runs for <sha>: <reason> — reporting checks as none would claim a read that failed.` | 11 | refusal |

**Scope** — the local git repository at the working directory's root, and the issue plus any pull
request on `git.branch` and that request's check runs, paginated. The scope line on stderr names the
branch, the base and the pull request number or `none`. **A git read that fails is `11`, never a
clean tree** — reporting `clean` over a failed `git status` is the zero-scope pass ADR 0092 forbids,
and here it would license a pack asserting reachable work that is not reachable.

**Examples**

```
$ fabrika handoff capture --issue 5021
{"issue":5021,"repo":"kamp-us/phoenix","capturedAt":"2026-08-09T18:36:48Z","git":{"branch":"umut/fanout-helper","head":"4f1c8a2b9d3e5607182934abcdef5566778899aa","upstream":"origin/umut/fanout-helper","reachable":"pushed","aheadBy":0,"behindBy":2,"base":{"branch":"main","head":"11223344556677889900aabbccddeeff00112233"},"tree":{"state":"clean","trackedModified":0,"untracked":0}},"board":{"issue":{"state":"open","labels":["p2","type:chore"]},"pull":{"number":5290,"state":"open","head":"4f1c8a2b9d3e5607182934abcdef5566778899aa","checks":"failing"}},"groundDigest":"368842989186"}
$ echo $?
0
```

```
$ fabrika handoff capture --issue 99999
handoff capture: #99999 does not exist in kamp-us/phoenix.
$ echo $?
7
```

**Grounding**

- #3330 — a pipeline baseline scan ran against a stale local checkout and spawned phantom no-op
  children. The whole reason a pack carries a derived ground state rather than a session's belief
  about it, and the reason `reachable` is computed rather than assumed.
- ADR 0092 — a failed `git status` is `11`, never `clean`. A guard that vouches for a tree it could
  not read is the zero-scope pass.
- v1 `wayfinder` has **no** equivalent: its cross-run story is *"the next WORK run resumes **cold**
  from the map's updated state"* (`wayfinder/SKILL.md:346`), so a run interrupted mid-investigation
  loses everything and the next one redoes it. This verb is what "not cold" is made of.

---

## `handoff take`

**Invocation**

```
fabrika handoff take --issue 5021 --nonce 7f3a9c21 [--base main] [--declare-unreachable] [--repo <owner/name>]
```

Reads the four asserted sections from stdin.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--issue` | integer | yes | — | the issue the pack is sealed onto |
| `--nonce` | string | yes | — | this run's nonce, matching `^[0-9a-f]{8}$`, authored by the caller; stamped into the marker so a later claim and a later pack are attributable. A value outside that grammar is a usage error (`1`) |
| `--base` | string | no | the repository's default branch | passed through to the capture; a compared field, so a later `read` must use the same value |
| `--declare-unreachable` | boolean | no | `false` | seal the pack even though the work is unreachable, recording the unreachability in the proven half as a stated loss |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object:

```json
{"issue":5021,"packComment":9234567891,"nonce":"7f3a9c21","sealedAt":"2026-08-09T18:36:48Z","groundDigest":"368842989186","reachable":"pushed","supersedes":null}
```

<!-- anchor: PACK-IS-A-TOKEN-PACKCOMMENT-IS-AN-ID --> **`packComment` is a comment id; the bare key
`pack` is reserved group-wide for `read`'s three-value state token.** One key never carries two
types across a group, or a caller diffing on it compares an integer with a word.

`supersedes` is the comment id of the previous sealed pack on this issue, or `null` when this is the
first. It is reported rather than acted on: nothing is edited or closed, and `read` resolves the
latest pack by ordering.

<!-- anchor: SUPERSEDING-ORPHANS-A-CLAIM --> **A second `take` on an issue whose current pack is
already claimed leaves that claim behind**, and the new pack reads `sealed`. That is deliberate — the
claim attests that someone took up the *old* pack, and a new pack is new information they have not
seen — but it is a real hazard, so `read` surfaces it: a claim naming a superseded pack appears in
`disregarded` with reason `superseded`, so a successor sees that somebody was working the previous
pack rather than inferring an empty field.

**What it checks before it writes, in this order.** Each refusing check is mechanical.

1. **Stdin held something.** Zero is `3`.
2. **The asserted half parses into exactly the four closed sections**, in order, each non-empty, with
   no content outside them. Otherwise `4`.
3. **The issue exists.** Otherwise `7`.
4. **A fresh capture is taken.** A failed derivation is `11`, and nothing is written.
5. **The work is reachable** — `git.reachable` is `pushed` and `git.tree.trackedModified` is `0`.
   Otherwise `12`, unless `--declare-unreachable` was given. **`git.tree.untracked` does not
   participate**: an untracked file is not work a pack points at, and blocking on one would refuse
   every session with a stray scratch file.
6. **The composed document — marker, asserted half and proven half — carries no machine-local path
   and no bare `@` reference.** `5` / `6`. This runs last because the proven half does not exist
   until step 4.

<!-- anchor: UNREACHABLE-WORK-IS-REFUSED --> **Why unreachability refuses rather than warns.** A
successor is a fresh session in a fresh worktree: an unpushed commit and a modified tracked file are
both literally invisible to it. A pack whose `## Next act` points at work in that state is
confidently wrong in the way #3330 is confidently wrong — a plausible record resting on state only
the writing machine can see. **The remedy is the caller's, outside this group**, which commits and
pushes nothing; the refusal names it. `--declare-unreachable` exists for the genuine case where the
diff is disposable, and it does not silence the fact: the proven half records `reachable` and the
counts verbatim, so the successor reads a **stated** loss instead of inheriting a silent one.

**Write order, and what a partial application leaves.** The capture is taken, the whole document is
composed in memory, leak-scanned, and posted as **one** comment; then it is read back. There is no
intermediate state to leave: a pack is one comment or it is nothing, which is why this verb has no
partial-application table. A post that fails is `8` with nothing on the issue; a post that lands and
reads back differently is `9`, naming the comment id so a human can inspect it.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the pack is sealed and its comment id is on stdout |
| `3` | stdin was read and held nothing |
| `4` | the asserted half is missing a section, has one out of order or empty, or carries content outside the closed set |
| `5` / `6` | the composed document carries a machine-local path, or a bare `@` reference |
| `7` | the issue does not exist |
| `8` / `9` | the comment write failed, or its read-back differs |
| `11` | the capture or a precondition read failed; nothing was written |
| `12` | the work is unreachable by a successor and `--declare-unreachable` was not given |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `handoff take: stdin was read and held nothing — a pack with no asserted half is a capture, not a handoff.` | 3 | refusal |
| `handoff take: the asserted half does not hold the four sections in order (<detail>) — nothing was written.` | 4 | refusal |
| `handoff take: ## Unsure is empty — a successor reads an empty Unsure as certainty. Write what you did not resolve, or say that you resolved everything.` | 4 | refusal |
| `handoff take: content outside the four sections (<heading>) — the section set is closed so a successor can tell the format's words from someone else's.` | 4 | refusal |
| `handoff take: the <asserted half\|derived ground state> carries a machine-local path (<detail>) — nothing was written.` | 5 | refusal |
| `handoff take: the <asserted half\|derived ground state> carries a bare @ path reference (<detail>) — nothing was written.` | 6 | refusal |
| `handoff take: #<n> does not exist in <repo>.` | 7 | refusal |
| `handoff take: the comment write to #<n> failed: <reason> — whether the pack landed is UNKNOWN. Read #<n> before re-taking.` | 8 | refusal |
| `handoff take: posted #<c> and the read-back differs — the pack may be truncated. Read #<c> before re-taking.` | 9 | refusal |
| `handoff take: cannot derive the ground state: <reason> — nothing was written and the pack would have asserted a ground it could not prove.` | 11 | refusal |
| `handoff take: <k> commit(s) are not pushed and <m> tracked file(s) are modified — a successor cannot see either. Commit and push outside this skill and re-run, or re-run with --declare-unreachable to record the loss.` | 12 | refusal |

**Scope** — the ground `capture` scans, plus the issue's existing comments to resolve `supersedes`,
paginated. The scope line on stderr names the comment count scanned. **Zero prior packs is a fact**
(the first handoff on an issue is the ordinary case); a comment read that could not complete is `11`,
and `supersedes` is never guessed.

**Examples**

```
$ printf '## Intent\nWiden the fanout guard.\n\n## Established\nThe guard reads one file only; a failing case is committed.\n\n## Next act\nFollow one level of local helper call, then re-run the case.\n\n## Unsure\nWhether one level is enough.\n' | fabrika handoff take --issue 5021 --nonce 7f3a9c21
{"issue":5021,"packComment":9234567891,"nonce":"7f3a9c21","sealedAt":"2026-08-09T18:36:48Z","groundDigest":"368842989186","reachable":"pushed","supersedes":null}
$ echo $?
0
```

```
$ printf '## Intent\nWiden the fanout guard.\n\n## Established\nA failing case is written.\n\n## Next act\nFollow one level of helper call.\n\n## Unsure\nHow deep the chains go.\n' | fabrika handoff take --issue 5021 --nonce 7f3a9c21
handoff take: 2 commit(s) are not pushed and 1 tracked file(s) are modified — a successor cannot see either. Commit and push outside this skill and re-run, or re-run with --declare-unreachable to record the loss.
$ echo $?
12
```

**Grounding**

- #3086 / #3173 — a machine-local path reached a posted artifact because the body was passed as a
  file reference. The body is a value here, and there is no flag that would take a path.
- #4133 / #4227 — a composed document inheriting its premise from the dispatcher, and a well-formed
  wrong classification propagating unchallenged. The two-half split is the structural answer: the
  caller cannot supply the proven half, and the asserted half is labelled as assertion.
- #4285 — an unvalidated value applied as a literal and reported as success. The nonce grammar and
  the closed section set are validated before the write, not after.
- `slice-handoff`'s closed section set — an artifact whose section set is open can steer its
  receiver past the artifact.
- v1's `add-frontier-ticket.sh` prints a refusal with bare `echo` to **stdout**, the channel carrying
  its answer, against its own library's stated contract that *"stdout is the ANSWER"*
  (`lib/common.sh:31`). Here every refusal is stderr and stdout is empty by construction.

---

## `handoff read`

**Invocation**

```
fabrika handoff read --issue 5021 [--base main] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--issue` | integer | yes | — | the issue to resolve the latest sealed pack from |
| `--base` | string | no | the repository's default branch | passed through to the live re-derivation; pass the value the pack was taken with, or `git.base.branch` reports drift the flag caused |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object. A `sealed` pack whose ground has moved:

```json
{"issue":5021,"pack":"sealed","comment":9234567891,"nonce":"7f3a9c21","sealedAt":"2026-08-09T18:36:48Z","author":"usirin","asserted":{"intent":"Widen the fanout guard.","established":"The guard reads one file only; a failing case is committed.","nextAct":"Follow one level of local helper call, then re-run the case.","unsure":"Whether one level is enough."},"ground":{"packed":"368842989186","live":"aa10b7c4d3e9"},"drift":{"state":"moved","fields":[{"field":"git.head","packed":"4f1c8a2b9d3e5607182934abcdef5566778899aa","live":"7ab3419e0c25d8f6041a2b3c4d5e6f7089abcdef","state":"moved"},{"field":"board.pull.checks","packed":"failing","live":"passing","state":"moved"}]},"claim":null,"disregarded":[],"scanned":{"comments":14}}
```

A `claimed` pack, which is the third token and needs its own shape shown:

```json
{"issue":5021,"pack":"claimed","comment":9234567891,"nonce":"7f3a9c21","sealedAt":"2026-08-09T18:36:48Z","author":"usirin","asserted":{"intent":"Widen the fanout guard.","established":"The guard reads one file only; a failing case is committed.","nextAct":"Follow one level of local helper call, then re-run the case.","unsure":"Whether one level is enough."},"ground":{"packed":"368842989186","live":"368842989186"},"drift":{"state":"none","fields":[]},"claim":{"nonce":"4b8e2f01","claimedAt":"2026-08-09T19:02:11Z","comment":9234599999,"by":"usirin"},"disregarded":[],"scanned":{"comments":15}}
```

**`pack` is a closed set of three, and all three exit `0`:**

| Token | Meaning |
|---|---|
| `none` | the issue carries no sealed pack this verb will honour — a **fact**, and the ordinary state of most issues |
| `sealed` | the latest pack parsed and carries no claim; `claim` is `null` |
| `claimed` | the latest pack parsed and a claim marker holds it; `claim` carries `nonce`, `claimedAt`, the claim's `comment` id, and the resolved `by` login |

When `pack` is `none`, `comment`, `nonce`, `sealedAt`, `author`, `asserted`, `ground`, `drift` and
`claim` are all `null`, and `disregarded` says whether anything was *nearly* a pack. `scanned` is
present on every answer and names the reads the verdict rests on.

**`drift.state` is a closed set of three**, and is the **worst** of the per-field states: `none` when
every field compared equal, `moved` when at least one differs, `unknown` when any field's live value
could not be derived — though in practice a failed re-derivation is `11` for the whole call, so
`unknown` is reachable only for a field a future derivation makes optional. `fields` lists **only**
the fields whose state is not `same`, each with `packed`, `live` and its own `state`. The compared
set is exactly the nineteen digest pre-image fields, so the drift and the digest can never disagree
about what counts.

<!-- anchor: DRIFT-IS-NEVER-OPTIONAL --> **There is no way to read a pack without its drift.** The
two were one verb from the start, because a caller who could skip the second call would sometimes
skip it, and a pack read as current while stale is the failure this whole group is built against.

<!-- anchor: THE-AUTHOR-IS-RESOLVED-NOT-TRUSTED --> **A pack's author is resolved against repository
permissions before the pack is honoured.** A comment carrying a well-formed marker is still a comment
anyone with a GitHub account can post, and its `## Next act` is a sentence a successor reads and then
acts on — the highest-leverage read-to-write path in the quintet. An author who does not resolve to
`write` or above lands in `disregarded` with reason `unauthorized` and the verb keeps looking at
older packs; a permission read that **fails** is `11` for the whole call, never a grant (ADR 0055).

**`disregarded`** is an array, empty when nothing was disregarded, of every marker-bearing comment
this verb did not honour as the current pack: `comment` (its id), `reason` (a closed set —
`unauthorized`, `superseded`), and `detail`, a human-readable string. It is **bounded by the walk**:
the verb reports only what it inspected on its way to the answer — packs newer than the one it
honoured, and any claim naming a superseded pack — never an unbounded history of every pack an issue
has ever carried.

<!-- anchor: A-MALFORMED-LATEST-PACK-REFUSES --> **A malformed pack is `14` and never `none`, and
never a `disregarded` row.** The `WireRead` three-valued read is what makes the distinction
available, and honouring it matters more here than anywhere else in the group: reporting `none` over
a pack that exists tells a successor nobody handed off, and it starts the work over. The scope is the
**latest** marker-bearing pack specifically — falling back to an older one would hand a successor a
stale pack believing it current, the same #3330 failure wearing a recovery's clothes. So the older
pack is not read, and the refusal names the comment a human must look at.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the pack state, its two halves and the drift are on stdout |
| `7` | the issue does not exist |
| `11` | a comment read, a permission read, or the live re-derivation failed |
| `14` | the latest sealed pack does not parse |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `handoff read: #<n> does not exist in <repo>.` | 7 | refusal |
| `handoff read: comment #<c> carries a handoff marker and does not parse (<detail>) — refusing to report no pack over a pack that exists. Read #<c>.` | 14 | refusal |
| `handoff read: cannot page #<n>'s comments: <reason> — whether a pack exists is UNKNOWN, never none.` | 11 | refusal |
| `handoff read: cannot resolve <login>'s permission: <reason> — a permission read that failed is UNKNOWN, never a grant.` | 11 | refusal |
| `handoff read: cannot re-derive the ground state: <reason> — the pack was found and the drift is UNKNOWN, so it is not reported as unchanged.` | 11 | refusal |

**Scope** — every comment on the issue, paged to exhaustion, plus one ACL read per distinct pack
author, plus the full ground re-derivation. The scope line on stderr names the comment count and the
number disregarded. **Zero comments is a fact** (`pack: "none"`); a page that could not be fetched is
`11`, never an empty comment list — an unpaginated read that missed the newest pack would report
`none` over a pack that exists, which is the fail-open direction.

**Examples**

```
$ fabrika handoff read --issue 5021
{"issue":5021,"pack":"none","comment":null,"nonce":null,"sealedAt":null,"author":null,"asserted":null,"ground":null,"drift":null,"claim":null,"disregarded":[],"scanned":{"comments":3}}
$ echo $?
0
```

```
$ fabrika handoff read --issue 5021
handoff read: comment #9234567891 carries a handoff marker and does not parse (## Next act is absent) — refusing to report no pack over a pack that exists. Read #9234567891.
$ echo $?
14
```

**Grounding**

- `pipeline-cli wayfinder-map` prints a malformed verdict and **returns normally**
  (`wayfinder-map/command.ts:76-79`), so exit status cannot separate a valid map from a broken one
  and a caller running `wayfinder-map N && proceed` proceeds on a broken map. Here a malformed pack
  is `14` and a valid one is `0`.
- The same tool disables its own dangling-reference check whenever the sub-issue read returns empty
  (`validate.ts:130`, `if (subIssues.length > 0)`), so a rate-limited call silently removes the check
  rather than refusing. Here an empty read that cannot be proven empty is `11`.
- `intake-dedup` exits `0` whether or not it found anything and writes its no-usable-keywords case to
  stderr before returning clean, so a caller reading only the status cannot tell "no duplicates" from
  "the check never ran". That is the shape this verb's `pack` token exists to avoid: the answer is a
  word on stdout, not an inference from an exit code.
- ADR 0055 — authority arrives through an ACL-checked verb, never from the presence of a marker.
- #4133 / #4227 — the `asserted` object is returned under a key that names it as assertion, so a
  consumer cannot mistake it for a derived fact.

---

## `handoff claim`

**Invocation**

```
fabrika handoff claim --issue 5021 --nonce 4b8e2f01 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--issue` | integer | yes | — | the issue whose latest sealed pack is being claimed |
| `--nonce` | string | yes | — | this run's nonce, matching `^[0-9a-f]{8}$`, authored by the caller — the claim key. A value outside that grammar is a usage error (`1`), so a human-readable label like `run-1`, which two runs would collide on, is refused rather than quietly shared |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository |

**Output** — machine. One JSON object:

```json
{"issue":5021,"packComment":9234567891,"nonce":"4b8e2f01","claim":"held","claimedAt":"2026-08-09T19:02:11Z","comment":9234599999}
```

`claim` is a closed set of two: `held` (this nonce now holds it) and `resumed` (this nonce already
held it — a re-run is not an error, and no second comment is posted, so `comment` names the original
claim).

<!-- anchor: CLAIM-KEY-IS-THE-RUN-NONCE --> **The claim key is the caller's run nonce, never a
session id and never a process id.** `$CLAUDE_CODE_SESSION_ID` is **pane-constant, not per-run**
(#5028), and sibling subagents of one parent share it (#4516), so two successors booted from one
parent would key onto one namespace and each would classify the other's claim as its own. The nonce
is authored once per run by the caller and passed explicitly, which is also what keeps it out of
session memory: no verb here reads any session variable for any purpose.

**This verb does not re-derive the ground state and does not report drift.** That is `read`'s, and
duplicating it here would be a second answer to one question. A caller claiming without having read
holds a pack it has not been told the drift of — which the skill's `PACK-CLAIMED` terminal requires
it to state, and which no verb can force.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the claim is held by this nonce |
| `7` | the issue does not exist |
| `8` / `9` | the claim write failed, or its read-back differs |
| `11` | a comment read or a permission read failed; nothing was written |
| `13` | the issue carries no sealed pack to claim |
| `14` | the latest sealed pack does not parse |
| `15` | another nonce holds the latest pack's claim |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `handoff claim: #<n> does not exist in <repo>.` | 7 | refusal |
| `handoff claim: the claim write to #<n> failed: <reason> — whether the claim holds is UNKNOWN. Read #<n> before working it.` | 8 | refusal |
| `handoff claim: posted the claim on #<n> and the read-back differs — whether the claim holds is UNKNOWN. Read #<n> before working it.` | 9 | refusal |
| `handoff claim: cannot page #<n>'s comments: <reason> — whether a pack is claimed is UNKNOWN, never free.` | 11 | refusal |
| `handoff claim: #<n> carries no sealed pack — there is nothing to claim. Work the issue from its artifacts.` | 13 | refusal |
| `handoff claim: #<n>'s latest pack (comment #<c>) does not parse (<detail>) — refusing to claim a pack whose contents are UNKNOWN.` | 14 | refusal |
| `handoff claim: pack #<c> is held by <other> since <iso> — refusing to open a second claim on one pack.` | 15 | refusal |

**Scope** — every comment on the issue, paged to exhaustion, plus one ACL read per distinct claim
author. A claim by an author who does not resolve to `write` or above is not a claim. **A permission
read that fails is `11` for the whole run**, never a demotion that would silently free someone else's
claim.

**Examples**

```
$ fabrika handoff claim --issue 5021 --nonce 4b8e2f01
{"issue":5021,"packComment":9234567891,"nonce":"4b8e2f01","claim":"held","claimedAt":"2026-08-09T19:02:11Z","comment":9234599999}
$ echo $?
0
```

Re-running the identical command is not an error — the same nonce resumes its own claim and posts
nothing:

```
$ fabrika handoff claim --issue 5021 --nonce 4b8e2f01
{"issue":5021,"packComment":9234567891,"nonce":"4b8e2f01","claim":"resumed","claimedAt":"2026-08-09T19:02:11Z","comment":9234599999}
$ echo $?
0
```

A *different* run is refused:

```
$ fabrika handoff claim --issue 5021 --nonce 9c14aa02
handoff claim: pack #9234567891 is held by 4b8e2f01 since 2026-08-09T19:02:11Z — refusing to open a second claim on one pack.
$ echo $?
15
```

**Grounding**

- #5283 — a retiring crew seat wrote a successor checkpoint with no findable home; a booting seat
  spent ten minutes on transcript archaeology and two recovered findings fired within the hour. The
  motivating incident: the claim is what tells a third seat that a second is already on it.
- #4516 / #5028 — a scratch namespace keyed on a session id collides across sibling lanes, and
  `(session, pid)` is pane-constant rather than per-run.
- `epic-lock`'s scars, designed out: it never reads back the presence stamp it writes
  (`epic-lock/github.ts:131`), so an abandoned lock wedges the issue forever, and it collapses
  several distinct refusals onto one exit code. Here the write is read back (`9`), and `13`, `14`,
  `15` and `11` are four seats with four remedies.
- #4060 — a classifier that read zero files under parallel invocation and defaulted to a plausible
  answer. A claim that cannot prove the pack is free refuses.

---

## Required repo files

The skill's run-level works-here checklist is [`SKILL.md`](SKILL.md)'s `## Required repo files`
table, and **front-door's detection parses that one**
([#4952](https://github.com/kamp-us/phoenix/issues/4952)). This table is the same shape and the same
four rows, scoped to the reads **these verbs** make; it adds no row the skill's table does not
already carry. When-missing vocabulary is the closed set **fail-loud** / **degrade** / **bootstrap**.

| Must exist | Why this group needs it | When missing |
| --- | --- | --- |
| A GitHub repository reachable over `gh` REST, with a token carrying `issues: write` | `take` and `claim` post the two comments; `read` and `capture` read the issue, its comments and its pull request | **fail-loud** — `11` before any write, `8` after one. `capture` is unaffected in its git half but still refuses, because a ground state missing its board half is not the shape a pack embeds |
| A git working tree — the repo root resolves, and `git status` / `git rev-parse` / `git rev-list` answer | `capture` derives every `git.*` field; `read` re-derives them to compare | **fail-loud** — `11` from `capture`, `take` and `read`. `claim` is unaffected: it touches no git state |
| A remote named `origin` the branch can be compared against | `git.reachable`, `aheadBy` and `behindBy` are computed against the upstream, and reachability is what `take`'s `12` rests on | **degrade** — with no upstream, `capture` reports `reachable: "unknown"` and both counts `null` at exit `0`; `take` then refuses `12` unless `--declare-unreachable` is given, because unknown reachability is not proven reachability |
| Readable collaborator permissions — `repos/<repo>/collaborators/<login>/permission` | `read` resolves a pack's author and `claim` resolves a claim's author before either is honoured (ADR 0055) | **fail-loud** — `11`. A permission read that fails is UNKNOWN, never a grant. The load-bearing row: degrading here would let any GitHub account author a document a successor acts on |

Nothing else is required. These verbs read no `.decisions/`, no `.patterns/`, no CODEOWNERS, no
design manifest, no label vocabulary and no merge-queue configuration — they open no pull request,
gate no merge, and apply no label. Stated explicitly, because an absent row reads as nobody checked.

**First-run behaviour in a fresh repository.** Every refusal above names a way forward, and none is a
first-run dead end: an issue with no pack is `read`'s ordinary `none` at exit `0` rather than a
refusal, there is no label to bootstrap, and the first `handoff take` on a repository that has never
seen one needs nothing that does not already exist. The only first-run friction is a repository with
no `origin`, which degrades rather than blocks.

## Self-test against the completeness test

1. **Every flag has a type and, if optional, a default** — the four Inputs tables.
2. **Every stdout shape is shown by an example** — four Examples blocks, plus the pack document
   above, plus a second `read` example for the `claimed` token so all three of its closed-set values
   are shown.
3. **Every non-zero exit code is enumerated with the condition that produces it** — the shared matrix
   owns `code → meaning`; each verb's Exit status owns its own triggers.
4. **Every error names its message, its stream and its code** — four Errors tables, all stderr,
   covering every non-universal code each verb's Exit-status table seats (`take` 3/4/5/6/7/8/9/11/12;
   `read` 7/11/14; `claim` 7/8/9/11/13/14/15; `capture` 7/11).
5. **Every judging verb states its scope and its zero-scope behaviour** — all four carry a Scope
   block naming what a failed read costs.
6. **No clause defers to a v1 script, another skill's prose, or the authoring session.** Every v1
   citation sits in a Grounding block as a scar. No sibling fabrika contract is depended on: this
   group borrows no verb from `map`, `grill` or `spike`, which is what keeps the four independently
   implementable while `graduate` is still unmerged.
7. **Every value an example prints is derivable from the spec** — the nineteen ground fields each
   name their derivation, the digest's pre-image is printed literally for the worked example so the
   digest is computable rather than asserted, and `drift` is a field-by-field comparison over that
   same nineteen. Nonces, comment ids and SHAs are declared in the header as grammar-conforming
   placeholders, which is the *no example value* branch of the rule rather than a claimed derivation.

**Every value a later verb needs arrives as an argument.** `--nonce` is authored by the caller and
passed to `take` and `claim`, never inferred; `--issue` addresses every verb; `--base` is threaded
explicitly because it is a compared field; and `read` re-derives the live ground itself rather than
being handed one. No verb depends on state that exists only in the calling session's memory — the one
property this group could least afford to get wrong, given what it is for.

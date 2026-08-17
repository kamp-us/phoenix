# `/check-epic-plan` — derived CLI contract

**Skill:** [`check-epic-plan`](SKILL.md) · **Authoring brief:** [#4948](https://github.com/kamp-us/phoenix/issues/4948) · **Date:** 2026-08-09

The verbs land in `packages/fabrika-cli/` under the **`plan`** subcommand group, registered in
`packages/fabrika-cli/src/registry.ts` like the shipped groups, every leaf declared via
`leafCommand` (`src/excess-operand.ts` — a bare `Command.make` silently opts out of the
excess-operand guard). The [CLI interface convention](../../docs/cli-interface-convention.md)
governs every verb; where this spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill** (ADR 0238). The v1 machinery
named below — under `packages/pipeline-cli/src/tools/`, `epic-ledger/`, `epic-lock/`,
`scratchpad/`, and the `claude-plugins/kampus-pipeline/skills/review-plan/` scripts — is prior art
**read** for semantics and scars; none is invoked, wrapped, or deferred to. Every v1 module name
cited anywhere in this spec is **non-normative**: the behavior it informs is restated here in full,
and an implementer needs none of those files to build these verbs.

**The group name.** `plan` is this gate's, following the one-group-per-skill precedent (`build-ui`
took `ui`, each reusing `build`'s verbs rather than sharing its group).
The planner `plan-epic` ([#4712](https://github.com/kamp-us/phoenix/issues/4712), unauthored) takes
its own group and may reuse these verbs the same way. **Nothing here allocates against the `epic`
group.** (When this was written `epic` was an unimplemented spec; it landed via
[#5092](https://github.com/kamp-us/phoenix/issues/5092) and was retired again with the epic
conductor, so the conclusion outlived both — `plan` is this gate's, and nothing else answers its
question.)

**What fabrika already ships, reused — never respecified.** The claim is the **`build` group's,
reused as landed verbs** ([`build`'s contract](../build/contract.md)) — the cross-contract shape
`build-ui` sanctioned: this gate claims the epic with `fabrika build claim --purpose gate`, releases
it with `fabrika build release`, and posts a successor note with `fabrika build note`. The purpose is
part of the reuse, not a detail of it: `build claim`'s audience axis asks whether an agent should
pick the issue up to *build*, and an epic earns `ready-for:agent` only after it has been planned and
gated, so a `gate` claim is admitted without it (founder ruling,
[#5175](https://github.com/kamp-us/phoenix/issues/5175)). The scope axis is unchanged by the purpose,
and `--override` stays the exception it was — it now has to name its lane as well as its reason.
**No second lock is
derived**, and v1's `epic-lock` is why: its `acquire` short-circuits on a held label *before* any
liveness probe, so a dead holder's lock is never reclaimed and a human clears it by hand — which is
also why the skill releases on every terminal where it holds the claim (§TERM), never only on the
ones that posted a verdict. `build confirm` alone is deliberately **not** in this gate's path: the
claim is single-phase here, won or lost at step 1, with no window that a separate confirm would
close. Modules reused by import:

- `packages/fabrika-cli/src/io/issues.ts` — `resolveRepo`, `getIssue` (three-way
  `Present` / `Absent` (404 only) / `Unknown`), `listComments` (typed JSON, never `--jq .body`),
  `pagedJson` (`--paginate`'s concatenated arrays, **a truncated read as a failure**), `addLabels`,
  `removeLabel` (**folds 404
  into success — removal is idempotent**, which is v1 scar F3 gone for free), `listLabels`.
- `packages/fabrika-cli/src/build/dependencies.ts` — `readTopology` (`Parsed` / `Absent` /
  `Unparseable{line,text}`) and `predecessorsOf`. **This spec adds no second `## Dependencies`
  grammar**; `lane emit` imports the same parser for the same reason.
- `packages/fabrika-cli/src/wire/acceptance-criteria.ts` — the total three-armed read
  (`Found` / `Absent` / `Malformed`), fence-aware, near-miss-admitting, refusing more than one
  conforming heading as undecidable. `plan read` imports it per child. The wire registry declares
  `triage` a producer of this format, so it is the pinned contract between a child's authored
  criteria and this gate's input.
- `packages/fabrika-cli/src/wire/verdict-marker.ts` — `emit` / `read` / `bindToHead` and the
  branded 7–40-hex slot. **Entirely pure — it binds any hex string, not only a commit**, which is
  what makes a scope digest bindable through it. Requires two additive edits, specified in
  §Scope digest.
- `packages/fabrika-cli/src/build/claim.ts` — `requireClaim` (this session holds it, proven now)
  and its four unfoldable outcomes. Both mutating verbs run it.
- `packages/fabrika-cli/src/report/leaks.ts` (`scanBody`, `isBareAtReference`) and
  `src/report/compose.ts` (`normalizeForReadback` — **three steps; read the body, the docblock
  understates it**). `plan verdict` imports both.
- `packages/fabrika-cli/src/triage/facet-writes.ts` — the per-issue label write decomposed into
  individually-observable calls **so the failure index is reportable**, never a replace-set `PUT`.
  `plan flip` fans this shape across children.
- `packages/fabrika-cli/src/build/target.ts` — `resolveTargetRepo`, `openIssue` (pre-seats the
  `7` / `11` refusals) and `scannedLine`.

A restatement of any of these would be a transcription, and a transcription drifts. The spec says
*import this*, with the path.

**Considered and deliberately not derived** — each already enforced or owned elsewhere (interface
convention rule 6; conventions §7 homes these in `.out-of-scope/`, unbootstrapped — tracked inline
as the sibling contracts do):

- **A planning lock.** The claim is `build claim` on the epic number. A second mutex would be the
  wrapper-verb shape ADR 0238 bans.
- **A re-plan convergence loop.** The defective path is terminal and hands back to `plan-epic`. v1
  exported `runConvergenceLoop` and registered it as no command at all — imported by nothing but
  its own unit test — so its stall test and its park were prose, not mechanism.
- **A pickability predicate.** Whether child `#C` is *ready* (its dependency edges satisfied) is
  `build`'s picker question, open on [#4920](https://github.com/kamp-us/phoenix/issues/4920). This
  gate makes children *eligible*; it computes no second answer to *pickable*. This is also why
  `build`'s `16 BLOCKED` seat is unreachable here — blocked-ness reaches this gate only as the
  dependency-shaped defects `DEP_CYCLE` / `DANGLING_DEP` / `ORPHAN_CHILD`, never as a per-child
  readiness verdict.
- **An epic-body writer.** This gate never edits an issue body. The planner owns splicing, with its
  round-trip scars ([#4879](https://github.com/kamp-us/phoenix/issues/4879)).
- **A gate-was-never-run detector.** [#4104](https://github.com/kamp-us/phoenix/issues/4104) is
  open and lane-scoped; a verb here would answer for one epic the question the lane asks across
  all of them.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `plan read` | fetch the epic and its children, parse the ledger, print it as one object | fetch + registered parses — no judgment; *what the plan is worth* stays in the skill |
| `plan check` | the deterministic floor: the thirteen hard defect types over the scanned child set | a total function from the ledger to a sorted defect list; the whole pass/fail decision, checkable by construction |
| `plan flip` | flip every `status:planned` child to `status:triaged` and the epic itself to `ready-for:agent`, re-gating first, reporting the **observed** result for each | a guarded batch write with a read-back — no judgment; *what a partial flip means* stays in the skill |
| `plan verdict` | post the gate's verdict comment, bound to the scope digest, and read it back | marker composition + a guarded write; the caveats are the skill's judgment, taken as input |

**Considered and not derived: a `plan defects --explain` verb.** A defect's *remedy* is the
planner's judgment, and a verb that authored one would be minting advice the floor cannot check.
The defect types are self-describing and `plan check --help` prints the table.

## The ledger grammar this gate reads

Stated here because three defect types and the scope digest all rest on it, and v1's equivalents
were silently permissive in ways that changed a plan's meaning without saying so.

**Sections are heading-anchored at any level and order-indifferent**, each consumed until the next
heading of the same or shallower level. **A section that appears more than once is a `4` refusal**,
not a first-match win — v1 read the first and ignored the rest, which makes a plan's meaning depend
on ordering nobody stated. **Fenced code blocks are not scanned** for any field or heading; v1 had
no fence awareness anywhere, so a documentation example inside a fence set a real child's data.

**`### Acceptance criteria`** — read through the imported wire format, whose three arms
(`Found` / `Absent` / `Malformed`) are carried as tokens and never flattened.

**`## Dependencies`** — read through the imported `readTopology`. An **edge is ordered
`[dependent, prerequisite]`**: `["#4302","#4301"]` reads *#4302 requires #4301*.

**`### User stories` (epic)** — an ordered list; each item's leading integer is the story id. A
list with at least one item must be **contiguous from 1 with no duplicates**; a gap or a repeat is
a `4` refusal, because v1 read list *positions* as ids, so a mis-numbered list silently renumbered
every story and the coverage defects then pointed at the wrong ones. **An absent section or an
empty list is not a `4`**: it reads as zero stories and feeds `MISSING_STORIES_SECTION`, which
would otherwise be unreachable — the contiguity rule applies only to a non-empty list.

**`**Stories:**` (child)** — the first such line outside a fence, and **a second such line is a `4`
refusal** on the same reasoning as a duplicated section: two declarations give the field no single
meaning. Its value must match `none` or a comma-separated list of bare integers
(`^(none|\d+(\s*,\s*\d+)*)$` after trimming). `none` reads as the empty list; a conforming list
reads as those ids; **no line at all reads as absent** (which is what `MISSING_STORY` tests); a
**non-conforming value reads as absent and is reported in `detail`**. v1 harvested every bare
integer anywhere in the value, so `**Stories:** 1, 3 (see #4021)` silently claimed story 4021.

**`**Containment:**` (child)** — the first such line outside a fence, with the same duplicate rule
and the same `4`. Leading keyword only, from the closed set `flag` · `exempt` · `none`. Anything
unrecognised reads as unset, which `MISSING_CONTAINMENT` treats identically to `none`; only `flag`
and `exempt` satisfy it.

## The floor — thirteen defect types

`plan check` derives a sorted `Defect[]` over this closed enum. The order below is the emission
order and the primary sort key; the secondary key is the lowest ref the defect names. Each defect
carries `{"type", "refs", "detail"}`, and **`detail` is a fixed template per type**, not free
prose — the templates are the third column.

| # | Type | Condition | `detail` template |
|---|---|---|---|
| 1 | `MISSING_DEPS_SECTION` | the epic body's `## Dependencies` read is `Absent` | `no ## Dependencies section` |
| 2 | `DEP_CYCLE` | the topology's edges contain a cycle, walked transitively; reported as the sorted member set, deduped | `cycle: #<a> → #<b> → #<a>` |
| 3 | `DANGLING_DEP` | a referenced ref is neither the epic, nor a child, nor an issue **proven present** by a 404-discriminating probe | `#<n> is referenced but is not a child and is proven absent` |
| 4 | `ORPHAN_CHILD` | the deps section parsed, and a linked child appears in no phase line and no `requires:` line | `#<n> appears in no phase or requires line` |
| 5 | `MISSING_STORIES_SECTION` | the epic body declares zero user stories | `the epic declares no user stories` |
| 6 | `UNCOVERED_STORY` | a story the epic declares that no child claims | `story <k> is claimed by no child` |
| 7 | `ZERO_AC` | a child's acceptance-criteria read is not `Found`, or is `Found` with zero criteria | `acceptance criteria read as <absent\|malformed\|empty>` |
| 8 | `MISSING_STORY` | the epic declares stories and the child's `**Stories:**` line is absent or non-conforming | `no **Stories:** line` / `**Stories:** value does not conform: "<value>"` |
| 9 | `MISSING_LABEL` | a child lacks a `type:` label, a `status:` label, or one of `p0` / `p1` / `p2` | `missing a <type:\|status:\|priority> label` |
| 10 | `MISSING_CONTAINMENT` | `cycleDoc` is `present`, the child is `type:feature`, and its containment is unset or `none` | `type:feature with containment <none\|unset>` |
| 11 | `NEEDS_TRIAGE_LABEL` | a child still carries `status:needs-triage` | `still carries status:needs-triage` |
| 12 | `UNVERIFIABLE_ASSIGNEE` | the child payload's `assignees` key was **not observed** — an unread field is UNKNOWN, never "unassigned is fine" | `the assignees field was not observed` |
| 13 | `HELD_CHILD_UNASSIGNED` | a child carries `ready-for:human` and its observed assignee list is empty | `ready-for:human with an empty assignee slot` |

**Grounded, and corrected against source.** [Brief #4948](https://github.com/kamp-us/phoenix/issues/4948)
names ten types; the live enum carries **fourteen names**, because the brief's list was copied from
v1's `review-plan/SKILL.md` prose, which is stale (that file's own validator calls it "the closed
7-type enum"). The four the brief omits are `ZERO_SCOPE`, `MISSING_CONTAINMENT`,
`UNVERIFIABLE_ASSIGNEE` and `HELD_CHILD_UNASSIGNED`. One of those four — `ZERO_SCOPE` — is seated
here as exit `7` rather than a defect, so **fourteen names, thirteen defects**. Derive the enum
from this table, never from a skill's prose.

**Why `ZERO_SCOPE` is exit `7` and not defect zero.** v1 made a childless epic defect #1 and
early-returned, so the ledger was never validated and the verdict reported exactly one thing wrong
about a plan it had not read. A refused scope is not a defect list of length one: `plan check`
refuses on `7`, derives nothing, and says so (ADR 0092).

**`p3` is not admitted.** The priority set is exactly `{p0, p1, p2}`; `p3` was ruled *retired*, not
widened ([#4101](https://github.com/kamp-us/phoenix/issues/4101),
[#2413](https://github.com/kamp-us/phoenix/issues/2413)).

**The two barrier defects are conservative by ruling, and their legacy cost is stated.** A
pre-existing `ready-for:human` child with an empty assignee slot fails the floor, and one such
child blocks the flip for every sibling. Back-fill versus grandfather is **unruled**
([#5026](https://github.com/kamp-us/phoenix/issues/5026)); this contract takes the refusing arm
because the permissive arm would flip a held child into the build pool, which is the exact outcome
the barrier exists to prevent ([#4637-C](https://github.com/kamp-us/phoenix/issues/4637)). The seam
a ruling lands at is this table's row 13.

**When a class cannot be derived, it is named, never dropped.** `MISSING_CONTAINMENT` rests on a
probe for `product-development-cycle.md`, which is three-valued: `present` (the class is derived),
`absent` (the class is derived and evaluates false — no cycle doc, no containment requirement), and
`unknown` (the probe failed to read). Only `unknown` puts the class in `skipped`. v1 fused `absent`
and `unknown` through a stderr substring match, so a transient probe failure silently switched the
whole class off for a run.

## The scope digest

Every verdict binds to a **scope digest**: the first **12 lowercase hex** of the SHA-256 of a
canonical serialization of the inputs the floor read. One line per child, ascending by number, then
one epic line, joined by `\n` with no trailing newline:

```
#<number>|labels=<names, ascending, comma-joined, EXCLUDING status:planned and status:triaged>|assignees=<logins ascending comma-joined, or "" observed-empty, or "?" unobserved>|ac=<count, or "?" when not Found>|stories=<ids ascending comma-joined, or "none", or "?" when absent or non-conforming>|containment=<flag|exempt|none|?>
epic=<number>|stories=<ids ascending comma-joined, or "" when the epic declares none>|cycleDoc=<present|absent|unknown>|deps=<"p<i>:<ref>,<ref>" segments ascending, joined by ";">|edges=<"<dependent>><prerequisite>" pairs ascending, joined by ";">
```

<a id="flip-neutral"></a>
**The flip is digest-neutral and floor-neutral by construction — this is the invariant the whole
gate rests on.** The only two labels `plan flip` writes on a **child** are `status:planned` and
`status:triaged`, and both are **excluded from the digest serialization**. Neither is a floor trigger
either: `MISSING_LABEL` requires *a* `status:` prefix, which both satisfy, and `NEEDS_TRIAGE_LABEL`
names `status:needs-triage`, which the flip never writes. The audience labels it writes on the
**epic** are neutral for a stronger reason: the epic line carries no labels field at all, and every
defect in the enum is derived from a child, so nothing about the epic's own labels reaches either the
digest or the floor. So a digest taken at check time still binds
after the flip, and a verdict posted after the flip attests **the scope the floor actually
scanned**. Without this exclusion the digest would be invalidated by the very write it guards, and
every clean verdict would bind a scope no floor had checked.

**The digest is threaded explicitly, never remembered.** `plan check` prints it; `plan flip` and
`plan verdict` **require** it as `--digest`. Each recomputes the digest from a fresh read and
compares: equal means the plan has not moved, different is exit `21`. That is the TOCTOU answer —
the gap between deciding and writing is closed by re-deciding against a value the caller carried,
not by trusting a cached decision. It is the same shape `build verdicts` uses when it re-reads a
gate's marker against the PR's live head rather than against the head the marker claimed.

**The two additive edits to `verdict-marker.ts` this gate needs landed in #5107**, recorded here
because the second one is easy to miss and stays load-bearing:

1. `NAMESPACE` is `/^(review|check-epic-plan)(-[a-z0-9]+)*$/`, widened from the `review`-only class.
2. **`read()` gates on the namespace prefix before `NAMESPACE` is ever tested**, and returns
   `Absent` when it fails. That gate widened with the regex (`NAMESPACE_PREFIXES = ["review",
   "check-epic-plan"]`) — had it not, the verb would emit a marker it can never read back, which
   collides head-on with its own `9` read-back guard.

The module's two diagnostic strings widened with them and already speak the plan gate's vocabulary.
`MARKER_LINE`'s `[A-Za-z0-9_-]+` class already admitted `check-epic-plan`, and the `HeadSha` brand's
7–40-hex bound already admits a 12-hex digest, so neither needed touching.

Both code edits were additive: no existing marker's reading changed, and the
`Absent`-versus-`Malformed` discrimination the module exists to protect is untouched. The plan gate keeps its **own**
namespace and **never** reuses `review` — a plan verdict wearing a review namespace is precisely the
family confusion the partition ruling removed (#4891).

`Current` / `Stale` / `Unbindable` are what a **later reader** of the posted marker resolves
through `bindToHead`; they are not this run's arms. This run's own drift check is the `--digest`
comparison above, seated on `21`.

**The digest never enters the `ledgerSignature` trap.** v1's signature collapses to the literal
`"clean"` on a PASS, so it cannot distinguish two clean plans and is useless as a drift key. The
digest is computed over the same fields on both arms.

## Shared conventions

Every `plan` verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries the answer only — one JSON object with named keys.
  Scope lines, refusal reasons and notices go to stderr. **A non-zero exit prints nothing on
  stdout** (`src/verb.ts`: `refuse()` hardcodes an empty stdout, `answer()` hardcodes code `0`).
  **The positive answer is always a positive token**: a clean floor prints
  `{"answer":"clean",…}`, never empty stdout — v1's back-off path left stdout empty, making
  "backed off" and "never ran" byte-identical.
- **A proven verdict is a state word at exit `0`, not a non-zero code.** `plan check` exits `0` on
  both arms and puts the discriminator in `answer` (`clean` / `defective`), per interface
  convention rule 3's pipe clause. This is **not** v1's scar: v1 had no machine channel at all and
  its only discriminator was a `✓`/`✗` glyph in prose, so `run-gate.sh && proceed` proceeded on a
  failure. Here the guard is at the **write**, not at the read — `plan flip` re-derives the floor
  itself and refuses on `20` rather than trusting any caller's reading of a prior exit code.
- **A 404 is a verdict; anything else is UNKNOWN.** Absence is decided by the HTTP status the API
  returned, never by matching text against `gh`'s stderr. v1 used `/404|not found/i.test(stderr)`,
  which reads an auth-hidden repo as a proven-absent issue and folds a spawn fault (a synthetic
  exit `-1` whose message may contain "not found") into a clean 404. No message in this contract is
  worded "does not exist, or is not readable".
- **Common inputs.** `--repo <owner/name>` (default: `resolveRepo`'s precedence — `--repo`,
  `$CLAUDE_PIPELINE_REPO`, `$GITHUB_REPOSITORY`, then the `origin` remote) on every verb. That
  variable name is **inherited from the shipped `io/issues.ts`**, not minted here; renaming it to a
  `FABRIKA_*` name is a package-wide change tracked outside this contract. GitHub access per
  [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql),
  paginated in full.
- **Bounded fan-out.** Child reads and child writes run at concurrency **8**, never `"unbounded"`.
  v1 issued one `gh api` per child unbounded, so a sixty-child epic spawned sixty concurrent
  processes and a rate-limit response aborted the whole read.
- **Preconditions.** Every verb runs `resolveTargetRepo` and refuses a non-`type:epic` target on
  `10`; every verb's `7` covers the same two facts (the epic is proven absent or closed, or it has
  zero children). The two mutating verbs additionally run the imported `requireClaim` on the
  **epic** number (`15`). No verb touches a tree, a branch, or the index.
- **Error-message prefix** is the invoked verb's name, contract-wide.
- **A non-zero exit is UNKNOWN** to the caller until the code is read.

### The shared exit matrix

This matrix owns `code → meaning`; the per-verb tables enumerate only that verb's own reachable
proven outcomes with triggers. `0`, `1`, `126`, `127` are the interface convention's reserved codes
(`src/verb.ts`, the exit-2 bootstrap in `src/bin.ts`), stated **only here**; every verb can return
them.

**Alignment.** `3`–`11` are `report`'s seats, **imported** from `src/report/codes.ts` under a
`REPORT_`-prefixed alias, code-for-code as `build`, `review`, `ship` and `triage` do. The group
registers **`BUILD_SEATS`** in `ALIGNED_GROUPS` (`src/exit-code-alignment.ts`) — *not*
`SHARED_SEATS`, which omits `BAD_SECTIONS`; `plan read` seats `4`, so under `SHARED_SEATS` the
checker would report `4` as a private code colliding with the `report` base. `EMPTY_STDIN` (`3`) is
re-exported from `plan/codes.ts` even though no verb reaches it, because `BUILD_SEATS` lists it and
an omitted seat reads to the checker as drift. **`15` is imported from `build`'s `codes.ts`
verbatim**, because this group holds a `build` claim and a caller driving both in one sweep must
read one meaning for it; `ship` importing `review`'s private band is the shipped precedent.
**`20`+ are this group's own.** Codes above the reserved band carry no cross-group *uniqueness*
obligation (interface convention rule 3), and the alignment this group opts into is checked
**base-only, never pairwise** (`exit-code-alignment.ts`: `occupied = allocatedCodes(base)`).

**The `20`/`21` overlap with `build`, settled ([#5107](https://github.com/kamp-us/phoenix/issues/5107)).**
This was written when `20`+ was free; the scope-admission fence has since taken `20` `OUT_OF_FOCUS`
and `21` `AUDIENCE_NOT_AGENT`, both reachable from `fabrika build claim` — step 1 of this gate's
skill. `21` is no longer among them: step 1 claims with `--purpose gate`, and the audience axis binds
build-purpose claims only (#5175), so the only admission refusal this gate can meet is `20`. The
overlap is therefore narrower than when it was settled, and it **stands**, on the same rule: *import
a code when two groups prove the same fact; allocate freely when they do not.* `15` is imported because `plan flip` and
`build claim` assert the identical fact (this session holds this issue's claim). `20`/`21` do not
overlap in fact at all — lane admission is never something a `plan` verb proves, and a defective
floor or a moved digest is never something a `build` verb proves — and an exit code is read off the
command that produced it: [SKILL.md](SKILL.md) step 1 is total (`any other non-zero ends STOPPED`)
and branches on `20`/`21` only off `plan flip` / `plan verdict`. Re-seating at `24`+ would also buy
nothing, since `epic` already seats `20`–`24` over the same two `build` codes.

| Code | Meaning | `read` | `check` | `flip` | `verdict` |
|---|---|---|---|---|---|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, or the verb failed to run | ✓ | ✓ | ✓ | ✓ |
| `126` | no implementation could be resolved (`src/bin.ts`) | ✓ | ✓ | ✓ | ✓ |
| `3` | stdin was read and held nothing | — | — | — | — |
| `4` | a required section is unparseable, duplicated, or mis-numbered in a document the verb derives from | ✓ | ✓ | ✓ | ✓ |
| `5` | the **authored** text carries a machine-local path | — | — | — | ✓ |
| `6` | the authored text is a bare `@` path reference — not redactable | — | — | — | ✓ |
| `7` | zero scope: the epic is proven absent (404) or closed, or it has zero children | ✓ | ✓ | ✓ | ✓ |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN | — | — | ✓ | ✓ |
| `9` | the write landed but the read-back does not match | — | — | — | ✓ |
| `10` | a value off its closed vocabulary — a semantic refusal, never a malformed-flag usage error | ✓ | ✓ | ✓ | ✓ |
| `11` | a required read failed — nothing was written, no outcome is proven | ✓ | ✓ | ✓ | ✓ |
| `15` | proven: this session does not hold the epic's claim (imported from `build`) | — | — | ✓ | ✓ |
| `20` | proven: the floor derived hard defects — refused as a **precondition to writing**, never as `plan check`'s own answer | — | — | ✓ | — |
| `21` | proven: the plan moved — the recomputed digest differs from the `--digest` the caller carried | — | — | ✓ | ✓ |
| `22` | proven: at least one child is `unchanged` — the flip did not fully apply; the observed set is on stderr | — | — | ✓ | — |
| `23` | proven: a label the flip must write is absent from the repository's taxonomy | — | — | ✓ | — |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ |

`3` is a seat no `plan` verb reaches: the only stdin-taking verb is `plan verdict`, whose stdin is
**optional** (a clean verdict with no caveats is an ordinary answer), so an empty stdin is a fact,
not a refusal. It stays re-exported for the alignment reason above. `13`, `14`, `16`, `17`,
`18`, `19` stay reserved with `build`'s meanings and are unreachable here, each for its own reason:
`13 DIRTY_TREE`, `14 WRONG_LANE` and `18 VALIDATION_RED` because this gate
holds no tree of its own, no branch and no validation surface; `17 REF_NOT_MOVED` and `19 UNSAFE_PUSH`
because it never pushes; and `16 BLOCKED` because pickability is deliberately not derived here
(see §Considered and deliberately not derived) — blocked-ness surfaces as dependency-shaped
defects, not as a per-child readiness verdict. All are deliberately not re-seated.

**`7` versus `11` versus `20`:** a 404 or a closed epic is a fact about the repository (`7`); an
unreachable GitHub or an unreadable probe is a fact about nothing (`11`); a plan that was fully
read and proved defective is a fact about the plan (`20`, and only where a write was about to
happen).

---

## `plan read`

**Invocation**

```
fabrika plan read 4300 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose ledger is read |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository read |

**Output** — machine. One JSON object:

```
{"answer": "read", "epic": 4300, "children": [
   {"number": 4301, "labels": ["p1","status:planned","type:feature"], "assignees": ["rmoreno"], "assigneesObserved": true,
    "criteria": "found", "criteriaCount": 3, "stories": [1,2], "containment": "flag"},
   {"number": 4302, "labels": ["p2","status:planned","type:chore"], "assignees": null, "assigneesObserved": false,
    "criteria": "malformed", "criteriaCount": 0, "stories": null, "containment": null}],
 "epicStories": [1,2], "cycleDoc": "present",
 "topology": {"phases": [["#4301"],["#4302"]], "edges": [["#4302","#4301"]]},
 "digest": "4d90e1bb27ac"}
```

The child set comes from the **native sub-issue link list** (`repos/{repo}/issues/{n}/sub_issues`,
paginated in full, typed-JSON decoded — not `--jq`, whose `-r` errors mid-stream on control
characters and reads back as an empty body). **No shipped module reads sub-issues today**; the
package's `getParent` walks child → parent only, so this read is genuinely new and lands as a
sibling of `io/issues.ts`'s paged readers, in their shape: a shape failure is a failure, never an
empty list.

Per child: labels via `getIssue`; the **three-state assignee slot** (`assigneesObserved: false`,
`assignees: null` when the payload carried no `assignees` key at all — the distinction
`UNVERIFIABLE_ASSIGNEE` rests on); the acceptance-criteria token carried through and never
flattened to a count alone; `stories` and `containment` per §The ledger grammar, `null` where
absent or non-conforming. `topology` is the imported `readTopology` parse. `cycleDoc` is
`present` / `absent` / `unknown`. `digest` is the scope digest over exactly this payload.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the epic body's `## Dependencies` is `Unparseable`; a ledger section appears more than once; a child's `**Stories:**` or `**Containment:**` field line appears more than once; or a **non-empty** `### User stories` list is not contiguous from 1 |
| `7` | the epic is proven absent (404) or closed, or it has zero sub-issue children |
| `10` | the issue is not a `type:epic` |
| `11` | the epic, the sub-issue list, or a child could not be read (when this was written this row also named the `product-development-cycle.md` probe, so the premise is stale and the conclusion is not — the probe is total and answers `unknown` on a failed read, which the output schema above carries and `plan check` names in `skipped`; `11` stays reachable by the three reads named here) |

An **absent** `## Dependencies` block is *not* `4` — it is defect `MISSING_DEPS_SECTION`, which
`plan check` derives. `4` is the unparseable, duplicated and mis-numbered cases only.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `plan read: #<n>'s ## Dependencies block is unparseable at line <l>: <text>` | 4 | refusal |
| `plan read: #<n> carries <k> "<heading>" sections — a ledger with two of one section has no single meaning.` | 4 | refusal |
| `plan read: #<n>'s child #<c> carries <k> "<field>" lines — a field declared twice has no single meaning.` | 4 | refusal |
| `plan read: #<n>'s user stories are numbered <list> — a story list must run from 1 with no gaps or repeats.` | 4 | refusal |
| `plan read: issue #<n> is proven absent or closed.` | 7 | refusal |
| `plan read: #<n> has zero sub-issue children — there is no ledger to read (ADR 0092).` | 7 | refusal |
| `plan read: #<n> is not a type:epic — refusing to read it as one.` | 10 | refusal |
| `plan read: cannot read <what>: <reason> — the ledger is UNKNOWN.` | 11 | refusal |

**Scope** — one epic, its sub-issue children, one repo-file probe. The stderr `scannedLine` counts
children fetched and names them, so a caller can see the set the digest was taken over. Zero
children is `7`, never an empty answer.

**Examples**

```
$ fabrika plan read 4300
{"answer":"read","epic":4300,"children":[{"number":4301,"labels":["p1","status:planned","type:feature"],"assignees":["rmoreno"],"assigneesObserved":true,"criteria":"found","criteriaCount":3,"stories":[1,2],"containment":"flag"}],"epicStories":[1,2],"cycleDoc":"present","topology":{"phases":[["#4301"]],"edges":[]},"digest":"4d90e1bb27ac"}
```

```
$ fabrika plan read 4300
plan read: #4300 has zero sub-issue children — there is no ledger to read (ADR 0092).
$ echo $?
7
```

**Grounding**

- ADR 0092 — zero scope reds; an empty child set is a refusal, not a clean read.
- v1 scar (`markdown.ts`): heading sections were first-match-wins with no fence awareness, story
  ids were list positions, and a `Stories:` value donated every bare integer it contained. §The
  ledger grammar refuses all three.
- v1 scar (`github.ts`): `is404` matched `gh` stderr text; this verb branches on HTTP status.
- The three-state assignee slot is #4693's landed shape — unread is UNKNOWN, never permissive.

---

## `plan check`

**Invocation**

```
fabrika plan check 4300 [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose ledger is gated |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository read |

**Output** — machine. Two arms, **both exit `0`**, discriminated by `answer` (`clean` /
`defective`). `skipped` is orthogonal to the arm and present on both; `defective` outranks
everything — a plan with defects is `defective` however many classes were skipped.

Clean:

```
{"answer": "clean", "epic": 4300, "scanned": [4301,4302], "digest": "4d90e1bb27ac", "skipped": [], "defects": []}
```

Clean with a class that could not be derived:

```
{"answer": "clean", "epic": 4300, "scanned": [4301,4302], "digest": "7b2e09c4a18f", "skipped": ["MISSING_CONTAINMENT"], "defects": []}
```

Defective:

```
{"answer": "defective", "epic": 4300, "scanned": [4301,4302], "digest": "81c7a30f5e42", "skipped": [], "defects": [{"type":"ZERO_AC","refs":[4302],"detail":"acceptance criteria read as malformed"}]}
```

`skipped` names any defect class **not derived** and therefore not asked — today only
`MISSING_CONTAINMENT`, and only when `cycleDoc` is `unknown` (an `absent` cycle doc derives the
class and evaluates it false). A skipped class never makes the floor clean by omission; it is
visible on the answer and the skill's terminal names it.

This verb re-runs `plan read`'s fetch itself rather than taking a ledger on stdin — a floor that
trusted a caller-supplied ledger would grade a document the caller could edit.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the ledger grammar refused, exactly as `plan read` |
| `7` | zero scope — the epic is proven absent or closed, or it has zero children |
| `10` | the issue is not a `type:epic` |
| `11` | any read the floor depends on failed — nothing is graded, and no verdict is implied |

There is no `20` here: a defective floor is this verb's **answer**, not its refusal.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `plan check: #<n> has zero children — refusing to answer over zero scope (ADR 0092).` | 7 | refusal |
| `plan check: #<n> is not a type:epic — refusing to gate it.` | 10 | refusal |
| `plan check: the ledger grammar refused: <reason>` | 4 | refusal |
| `plan check: cannot read <what>: <reason> — the floor is UNKNOWN, not clean.` | 11 | refusal |

**Scope** — every child of the epic, no sampling and no cap. The stderr `scannedLine` names the
scanned set on **both** arms, so a clean answer states the scope it rests on. Zero scope is `7`.
On the `defective` arm the scope line is followed by one diagnostic — `plan check: <k> hard
defect(s) over <n> child(ren) — see stdout.` — which is a **notice on an exit-`0` answer**, not an
error, which is why it is not in the table above.

**Examples**

```
$ fabrika plan check 4300
{"answer":"clean","epic":4300,"scanned":[4301,4302],"digest":"4d90e1bb27ac","skipped":[],"defects":[]}
$ echo $?
0
```

```
$ fabrika plan check 4300
{"answer":"defective","epic":4300,"scanned":[4301,4302],"digest":"81c7a30f5e42","skipped":[],"defects":[{"type":"HELD_CHILD_UNASSIGNED","refs":[4302],"detail":"ready-for:human with an empty assignee slot"}]}
$ echo $?
0
```

**Grounding**

- Interface convention rule 3's pipe clause — the discriminator is a stdout state word; the
  destructive verb re-derives the floor rather than reading an exit code.
- v1's gate exited `0` on FAIL *and* printed only a `✓`/`✗` glyph, so a shell caller proceeded on a
  failure. The machine channel plus `plan flip`'s own `20` refusal is that hole closed.
- ADR 0047 D2 / #4894 — this verb is the *whole* pass/fail decision; the advisory layer above it
  cannot change the answer.
- ADR 0092 — zero scope reds, and the scanned set is stated on both arms.
- #4101 / #2413 — the priority set is `{p0,p1,p2}`; `p3` is retired, not admitted.

---

## `plan flip`

**Invocation**

```
fabrika plan flip 4300 --digest 4d90e1bb27ac
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic whose planned children are flipped, and whose own audience label is flipped with them |
| `--digest` | string, 12 lowercase hex | yes | — | the scope digest `plan check` printed; the flip refuses if the plan has moved since |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository written |

**Output** — machine. The **observed** result per child and for the epic, never the intended one:

```
{"answer": "flipped", "epic": 4300, "digest": "4d90e1bb27ac", "terminal": "flipped-all",
 "children": [{"number": 4301, "observed": ["p1","status:triaged","type:feature"], "result": "flipped"},
              {"number": 4302, "observed": ["p2","status:triaged","type:chore"], "result": "already"}],
 "flipped": 1, "already": 1,
 "audience": {"result": "flipped", "observed": ["ready-for:agent","type:epic"]}}
```

`audience` is the epic's own result, on the same observed-not-intended discipline: `flipped` (the
epic did not carry `ready-for:agent` alone, the labels moved, and the re-read proves it) · `already`
(it carried `ready-for:agent` and no `ready-for:human` before the run — nothing was written) ·
`unchanged` is unreachable on this channel, because it forces exit `22`. There is no `not-planned`
arm: an epic carrying no audience label at all is still owed `ready-for:agent`, so absence is a
write, not an exemption.

`children` enumerates **every** child of the epic, not only the planned ones, so the answer states
the whole set the flip considered. `result` is closed and **total over that set**: `flipped` (the
child carried `status:planned`, the labels moved, and the re-read proves it) · `already` (observed
`status:triaged` with no `status:planned` — an idempotent no-op, outside the write scope) ·
`unchanged` (the child carried `status:planned` and the write did not take) · `not-planned` (the
child carried neither label — a clean floor permits this, since `MISSING_LABEL` requires only *a*
`status:` prefix and `NEEDS_TRIAGE_LABEL` bars only `status:needs-triage`, so a child may sit on
some other `status:` value; the flip does not consider it and does not touch it).

`terminal` is a closed token the skill reads rather than deriving from counters, and **it has
exactly two values, because it only ever appears on the answer channel**: `flipped-all` (at least
one `flipped`, no `unchanged`) · `nothing-to-flip` (no child carried `status:planned` **and** the
epic's audience was `already` — a run that wrote one label is not a run that changed nothing). A partial
flip has no token here at all — any `unchanged` child forces exit `22`, and a non-zero exit prints
nothing on stdout, so the unchanged refs are named on **stderr** and the caller reads them there.
There is deliberately no `unchanged` counter in the answer object: it could only ever be `0`.

**The flip is unconditional over every `status:planned` child** — ruled, with no per-child
predicate and no opt-out hook (#4693 AC4). The barrier keeping a held child out of the build pool
is the assignee slot, which this verb never touches and `plan check` checks instead.

<a id="gate-owns-the-audience-flip"></a>
**The epic's audience flip has exactly one owner, and it is this verb** (#5832). Under the single-PR
model the operator picks the **epic** up, so the epic's own `ready-for:agent` decides whether the
epic is pickable at all — and before #5832 nobody wrote it, leaving planned-and-gated epics sitting
at `ready-for:human` (#5680). The other two candidates are both wrong for the same reason, that
neither has proven a clean floor: the **planner** never flips, because an ungated plan would become
pickable; the **operator** never flips, because it would be admitting itself. The gate re-derives the
floor at the moment of writing, so the gate is the seat. It writes the epic **last**, after every
child's re-read proves it moved, so an epic never becomes pickable over a half-flipped ledger.

Order of operations, each guard designed against a named v1 failure:

1. **Re-gate.** Re-run the floor and recompute the digest. Any defect refuses on `20`; a digest
   differing from `--digest` refuses on `21`. The gap between deciding and writing is closed by
   re-deciding, not by trusting. Neither refusal writes anything.
2. **Vocabulary precondition.** Confirm every label this run would **POST** exists in the
   repository's label list: `status:triaged` and `status:planned` when there is at least one
   `status:planned` child, and `ready-for:agent` when the epic is owed it. `POST .../labels`
   **creates** an unknown label rather than rejecting it (#4285), so an absent label would be
   silently minted; refuse on `23` instead. Only posted labels are guarded — a `DELETE` of a label
   the repository never defined removes nothing and mints nothing. With nothing to write the check is
   skipped entirely — a `nothing-to-flip` success must not refuse over a label it was never going to
   touch.
3. **Write, bounded and per-child, add before remove.** Concurrency 8, decomposed into
   individually-observable calls so the failure index is reportable — never a replace-set `PUT`.
   **`status:triaged` is added first and `status:planned` removed second, always.** That order is
   load-bearing, not stylistic: it is what keeps the [floor-neutral invariant](#flip-neutral) true
   *mid-write*. A child caught between the two calls carries **both** labels, which still satisfies
   `MISSING_LABEL`'s "a `status:` prefix" and neither of which is in the digest; under the reverse
   order a child between the calls carries **no** `status:` label, `MISSING_LABEL` flips true, and
   `plan verdict` would then re-derive a defective floor on a run the gate believes clean. Label
   removal is 404-benign through the imported `removeLabel`. **A failing child does not abort its
   siblings**; every child is attempted.
4. **Re-read every child** and report its observed labels. v1 asserted the flip from its
   pre-mutation intent list and re-read nothing, so a child left carrying both labels — the ADD
   landing and the DELETE failing — was reported as pickable.
5. **Then flip the epic, add before remove, and read it back.** `ready-for:agent` is added, then
   `ready-for:human` removed, so an epic caught between the two calls is over-labelled rather than
   audience-less. This step runs only once step 4 proves every child moved: any `unchanged` child
   refuses on `22` with the epic untouched. The read-back decides the result — `ready-for:agent`
   present and `ready-for:human` absent, or it is `unchanged` and refuses on `22` in turn. An epic
   that cannot be re-read after a write is exit `8`, never an assumed flip.

Because the flip is [digest-neutral and floor-neutral](#flip-neutral), step 1's recomputation is
comparable to `plan check`'s directly, and a verdict posted afterwards binds the same digest.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the ledger grammar refused during the re-gate |
| `7` | zero scope — the epic is proven absent or closed, or it has zero children |
| `8` | a write was attempted and no re-read could prove its outcome — UNKNOWN |
| `10` | the issue is not a `type:epic`, or `--digest` is not 12 lowercase hex |
| `11` | a read the flip depends on failed — **nothing is written** |
| `15` | proven: this session does not hold the epic's claim |
| `20` | proven: the re-gate derived hard defects — the floor is not clean, nothing is written |
| `21` | proven: the recomputed digest differs from `--digest` — the plan moved since the check |
| `22` | proven: at least one child is `unchanged`, or the epic did not reach `ready-for:agent` — the refs are on stderr |
| `23` | proven: a label this run would post — `status:triaged`, `status:planned` or `ready-for:agent` — is absent from the repository's labels |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `plan flip: the floor is not clean (<k> defect(s)) — refusing to flip.` | 20 | refusal |
| `plan flip: the plan moved since the check (digest <a> → <b>) — re-check before flipping.` | 21 | refusal |
| `plan flip: <a> of <n> children flipped; <b> unchanged (#<x>, #<y>) — the epic is half-flipped and needs a human.` | 22 | refusal |
| `plan flip: every child flipped but epic #<n> does not carry ready-for:agent alone — the epic is half-flipped and needs a human.` | 22 | refusal |
| `plan flip: label "<name>" is absent from <repo>'s taxonomy — refusing to create it (#4285).` | 23 | refusal |
| `plan flip: wrote <n> label change(s) and could not re-read <what> — the outcome is UNKNOWN.` | 8 | refusal |
| `plan flip: this session does not hold #<n>'s claim.` | 15 | refusal |
| `plan flip: --digest must be 12 lowercase hex — got "<v>".` | 10 | refusal |
| `plan flip: #<n> is not a type:epic — refusing to flip its children.` | 10 | refusal |
| `plan flip: #<n> has zero children — refusing to act over zero scope (ADR 0092).` | 7 | refusal |
| `plan flip: cannot read <what>: <reason> — nothing was written.` | 11 | refusal |
| `plan flip: the ledger grammar refused during the re-gate: <reason>` | 4 | refusal |

**Scope** — the verb *reads* every child of the epic and reports each one; it *writes* those carrying
`status:planned`, plus the epic's own audience labels. Zero children carrying `status:planned` is
**not** zero scope: with the epic already `ready-for:agent` it is the answer with
`terminal: "nothing-to-flip"` at exit `0`, because a gate that finds its work already done has
succeeded — and with the epic still owed its label, that one write is the whole of the run. Zero
*children at all* is `7`.

**Examples**

```
$ fabrika plan flip 4300 --digest 4d90e1bb27ac
{"answer":"flipped","epic":4300,"digest":"4d90e1bb27ac","terminal":"flipped-all","children":[{"number":4301,"observed":["p1","status:triaged","type:feature"],"result":"flipped"}],"flipped":1,"already":0,"audience":{"result":"flipped","observed":["ready-for:agent","type:epic"]}}
```

```
$ fabrika plan flip 4300 --digest 4d90e1bb27ac
plan flip: 2 of 3 children flipped; 1 unchanged (#4303) — the epic is half-flipped and needs a human.
$ echo $?
22
```

**Grounding**

- #4693 AC4 — the flip stays unconditional; a per-child exception hook is the escape hatch the gate
  deliberately lacks.
- v1 scars: unbounded `Effect.forEach` aborting on the first failure, a two-call flip leaving both
  labels, the PASS comment posted only after every write so a partial flip posted nothing, and
  `discard: true` erasing the per-child record. Steps 3 and 4 answer all four.
- #4285 — `POST .../labels` creates unknown labels; the vocabulary check is a precondition.
- #5832 / #5680 — the gate owns the epic's audience flip; before it, a planned-and-gated epic sat at
  `ready-for:human` and the operator could never pick it up.
- ADR 0058's shape — the re-gate is a relation checked at write time, not a cached decision.

---

## `plan verdict`

**Invocation**

```
fabrika plan verdict 4300 --digest 4d90e1bb27ac <<'EOF'
caveat: ac-not-checkable #4302 — "works well" states no observable outcome
EOF
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<number>` | positional integer | yes | — | the epic the verdict is posted on |
| `--digest` | string, 12 lowercase hex | yes | — | the scope digest `plan check` printed; the verdict binds it and refuses if the plan has moved |
| `--polarity` | enum: `PASS` \| `FAIL` | no | derived from the floor | an optional cross-check — when supplied and it disagrees with the floor this verb derives, the verb refuses on `10` rather than posting either. No step in [SKILL.md](SKILL.md) supplies it; it exists for an operator driving the verb by hand, and its absence from the skill is deliberate, not a missing step |
| `--repo` | string | no | `resolveRepo`'s precedence | the repository written |
| stdin | markdown | no | empty | advisory caveats, one per line, each `caveat: <kind> #<ref> — <text>`; empty is an ordinary answer |

**Output** — machine.
`{"answer": "posted", "epic": 4300, "polarity": "PASS", "digest": "4d90e1bb27ac", "skipped": [], "comment": 5230661234, "caveats": 1}`

**This verb derives its own polarity by re-running the floor**, for the same reason `plan check`
re-fetches: a caller-supplied verdict would let the caller grade the document. `PASS` is the floor's
`clean` arm, `FAIL` its `defective` arm. `--polarity` exists only as a cross-check, and a
disagreement is a `10` refusal — the caller's opinion never becomes the posted verdict.

The comment's first non-blank line is the marker, composed by the imported `emit`. The clause is a
**fixed template**, not free prose: `<n> children scanned, floor <clean|N defect(s)>` followed by
`, <k> class(es) skipped` when `skipped` is non-empty.

```
check-epic-plan: PASS @ 4d90e1bb27ac — 2 children scanned, floor clean
```

Below the marker the verb renders the scanned set, the derived defect list on a `FAIL`, the
`skipped` classes when non-empty, and the caveats verbatim under their kinds.

**Caveat kinds are a closed set** — `ac-not-checkable` · `brief-fidelity` · `slice-too-broad` ·
`dependency-implied-not-declared`. An off-set kind refuses on `10`. Caveats are **advisory**: they
are recorded beside the verdict and the verb has no path by which a caveat changes the polarity
(ADR 0047 D2). The caveat's trailing text is model-authored free prose, which is a deliberate,
bounded exception to the closed-vocabulary rule: the *kind* is closed, the tail is advisory, and
**no verb reads a caveat back as input** — it is a note for a human, never a signal a lane consumes.

Guards, in order: `--digest` well-formed (`10`); the floor re-derived (`4` / `7` / `10` / `11` as
`plan check`); the recomputed digest equals `--digest` (`21`); `--polarity`, when supplied, agrees
with the derived polarity (`10`); every caveat kind on-enum and every caveat naming a ref in the
scanned set (`10`); the authored text leak-scanned (`5` / `6`) — the caveat text is model-authored,
which is exactly the surface those seats exist for; post, then **re-read the posted comment** and
compare through `normalizeForReadback` (`8` on an unprovable write, `9` on a mismatch). The verb is
the only emit path; a hand-posted marker is how v1's corpus carried a fake-looking PASS for weeks.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the ledger grammar refused while deriving the floor |
| `5` | the authored caveat text carries a machine-local path |
| `6` | the authored caveat text is a bare `@` path reference |
| `7` | zero scope — the epic is proven absent or closed, or it has zero children |
| `8` | the comment was posted and no re-read could prove it — UNKNOWN |
| `9` | the comment posted but the read-back does not match |
| `10` | `--digest` malformed; the issue is not a `type:epic`; `--polarity` disagrees with the derived floor; a caveat kind off the closed set; a caveat naming a ref outside the scanned set |
| `11` | a read the verdict depends on failed — nothing is posted |
| `15` | proven: this session does not hold the epic's claim |
| `21` | proven: the recomputed digest differs from `--digest` — the plan moved since the check |

There is no `20` here. A defective floor is not a refusal for this verb — it posts the `FAIL`
verdict, which is the deliverable. **Every** `--polarity` disagreement, in either direction, is a
`10`: a supplied value that contradicts the derived floor is a value off its closed vocabulary,
which is what `10` means.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `plan verdict: --digest must be 12 lowercase hex — got "<v>".` | 10 | refusal |
| `plan verdict: --polarity <v> disagrees with the derived floor (<derived>) — a verdict relays the floor, it does not form one.` | 10 | refusal |
| `plan verdict: caveat kind "<v>" is not in the closed set (ac-not-checkable, brief-fidelity, slice-too-broad, dependency-implied-not-declared).` | 10 | refusal |
| `plan verdict: caveat names #<n>, which is not in the scanned set.` | 10 | refusal |
| `plan verdict: #<n> is not a type:epic — refusing to post a plan verdict on it.` | 10 | refusal |
| `plan verdict: the plan moved since the check (digest <a> → <b>) — re-check before posting.` | 21 | refusal |
| `plan verdict: the authored caveats carry a machine-local path (<masked>).` | 5 | refusal |
| `plan verdict: the authored caveats carry a bare @ path reference — it cannot be redacted.` | 6 | refusal |
| `plan verdict: the comment posted and could not be re-read — the outcome is UNKNOWN.` | 8 | refusal |
| `plan verdict: the comment posted but does not read back — the verdict needs a human eye.` | 9 | refusal |
| `plan verdict: #<n> has zero children — there is no scope to attest.` | 7 | refusal |
| `plan verdict: cannot read <what>: <reason> — nothing was posted.` | 11 | refusal |
| `plan verdict: this session does not hold #<n>'s claim.` | 15 | refusal |
| `plan verdict: the ledger grammar refused: <reason>` | 4 | refusal |

**Scope** — one epic and **every one of its children**, because deriving the floor and recomputing
the digest both read the whole set; one comment written. The stderr `scannedLine` names that set.
Zero children is `7`.

**Examples**

```
$ fabrika plan verdict 4300 --digest 4d90e1bb27ac <<'EOF'
caveat: ac-not-checkable #4302 — "works well" states no observable outcome
EOF
{"answer":"posted","epic":4300,"polarity":"PASS","digest":"4d90e1bb27ac","skipped":[],"comment":5230661234,"caveats":1}
```

```
$ fabrika plan verdict 4300 --digest 81c7a30f5e42 <<'EOF'
caveat: vibes #4302 — feels thin
EOF
plan verdict: caveat kind "vibes" is not in the closed set (ac-not-checkable, brief-fidelity, slice-too-broad, dependency-implied-not-declared).
$ echo $?
10
```

**Grounding**

- #5096 — an unmarked verdict is invisible to any drift check; the marker plus the scope digest is
  what makes gate state checkable by a later reader.
- ADR 0058 via `bindToHead` — a later reader resolves `Current` / `Stale` / `Unbindable` against
  the posted marker; `Unbindable` never renders as `Current`.
- ADR 0047 D2 — caveats annotate, never block; there is no code path from a caveat to a polarity.
- `report/leaks.ts` — the caveat text is model-authored prose reaching a public surface, which is
  the seat `5` / `6` exist for.
- v1 hand-posted a gate verdict at least once and it read as genuine; the single emit path plus the
  read-back is that hole closed.

---

## Required repo files (verb-level)

The skill's own table ([SKILL.md](SKILL.md)) carries the run-level rows; these are the reads and
writes this contract's verbs make, so an implementer sees the dependency set in one place.
Vocabulary: **fail-loud** / **degrade** / **bootstrap** (front-door, #4952).

| Must exist | Why | When missing |
| --- | --- | --- |
| The epic issue: `type:epic`, native sub-issue links to its children | `plan read` derives the whole ledger from it | **fail-loud** — exit `7` / `10` naming the gap. |
| A `## Dependencies` block in the epic body | the topology the three dependency defects rest on | **fail-loud**, two ways: *absent* is defect `MISSING_DEPS_SECTION` (a `defective` floor); *unparseable or duplicated* is `plan read`'s `4`. |
| Child issues carrying `### Acceptance criteria` blocks | the imported wire read supplies `ZERO_AC`'s input | **fail-loud** — the read's `absent` / `malformed` token becomes a defect; no criterion is invented. |
| Labels `status:planned`, `status:triaged`, `status:needs-triage`, `ready-for:human`, `type:*`, `p0`/`p1`/`p2` | the floor reads them; the flip writes two | **fail-loud** — `plan flip` exits `23` rather than creating a label (#4285); taxonomy creation is the front door's. |
| `product-development-cycle.md` at the repo root | gates whether `MISSING_CONTAINMENT` is derived | **degrade** — an *absent* file derives the class and evaluates it false; an *unreadable* probe puts the class in `skipped`, named on the answer and in the marker. Never silently dropped. |
| Repository permissions readable | `build claim`'s ACL-sourced ownership resolution (ADR 0055) | **fail-loud** — as declared in [`build`'s contract](../build/contract.md); an unreadable permission is `Unknown`, never a demotion. |

---

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag carries a
type and default; every stdout shape has a literal example (including the `skipped`-non-empty arm);
every non-zero code is enumerated with its trigger (the shared matrix owns each code's single
meaning, the per-verb tables own the triggers, and the universal `0`/`1`/`126`/`127` are stated
exactly once); every enumerated code has an Errors row; every judging verb states its scope and its
zero-scope behavior; no clause defers to a v1 script, another skill's prose, or the authoring
session — every cross-reference is to a **landed sibling fabrika contract or a shipped module by
path**, and every value a later verb needs arrives as an explicit `--digest` argument rather than
as remembered state.

The three hand-checks, which the presence tests above cannot perform:

1. **Every reachable outcome has a code or a state word.** Walked per verb, including the modes v1
   had no name for: a partial flip (`22`), a plan that moved under the gate (`21`), a label the
   repo does not carry (`23`), and a defect class that could not be derived (the `skipped` array —
   an *answer field*, deliberately not a code, because the floor still answered). The one
   deliberate non-seat is `3`: `plan verdict`'s stdin is optional, so an empty stdin is a fact.
2. **Every example value is derivable.** The digest from §The scope digest's serialization (and the
   four examples use four different literals, because they are taken over four different scopes);
   the defect `type` and `detail` values from the thirteen-row table's third column; `result` and
   `terminal` from their closed sets; the marker line from `emit`'s template plus the fixed clause
   grammar; `containment`, `stories` and the edge orientation from §The ledger grammar. `comment`
   is server-assigned and named as such.
3. **Sibling verbs guard shared preconditions identically.** All four run `resolveTargetRepo`, the
   `type:epic` check (`10`) and the same `7` trigger; both mutating verbs run the imported
   `requireClaim` and take `--digest` with the same `21` refusal; `flip` states its one documented
   divergence — zero *planned* children is an answer, not a refusal — with its reason.

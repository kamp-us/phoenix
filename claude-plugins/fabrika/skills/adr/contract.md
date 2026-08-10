# `/adr` — derived CLI contract

**Skill:** [`adr`](SKILL.md) · **Authoring brief:** [#4704](https://github.com/kamp-us/phoenix/issues/4704) · **Date:** 2026-08-01

**The seed package.** These are fabrika's first derived verbs, so this spec is where the verb package
lands — [#4648](https://github.com/kamp-us/phoenix/issues/4648) Resolved question 2 defers the
decision to the first derived contract, which is this one. The package is `packages/fabrika-cli/`,
its binary is `fabrika`, and this skill's verbs sit under an `adr` subcommand group. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs all six; where this spec
and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill.** fabrika is self-contained
by construction: every verb this skill needs is implemented in `packages/fabrika-cli/`, and no fence
in `SKILL.md` invokes anything else. That is the [isolation rule](../../docs/cli-interface-convention.md);
it is a hard constraint on every fabrika skill, not a preference of this one.

The reason is the deletion test. A fabrika that calls `pipeline-cli` can never be the thing that
replaces it — every call is a tether that keeps the old tree alive. Isolation costs a duplicated
ranking during the transition; a tether costs the ability to ever delete anything.

**`adr classify` was considered and deliberately not derived.** The control-plane question is settled
at the merge gate, and that gate is the authority. A fabrika copy of it could tell an author
"ordinary" while the gate says "control-plane" — two answers to a merge-gating question, which is
worse than either a tether or a drifted ranking. That reasoning holds under either model, and the two
differ: v1's `cp-classify` classifies an ADR **by content** (its ADR-0164 probe, reached because no
`.decisions/**` path matches its path pattern), while fabrika's ruled model is CODEOWNERS-only,
three-valued, and has **no semantic detection**, so under it an ADR is not control plane — see
[§CP classification](../../docs/control-plane-classification.md). Either way the skill states the
expectation, never rewords to dodge the gate, and leaves the verdict where it is enforced. The
incidents behind it, #4386 and #3416, were the *gate* misclassifying, so an author-side predictor
would not have caught them anyway.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `adr next` | the next unused ADR id, against a fetched base ref unioned with open ADR PRs | fetch, parse ids, take the max, add one — no judgment anywhere in it |
| `adr new` | scaffold `.decisions/NNNN-slug.md` from the canonical template | the file's *shape* is fixed text with substitutions; only its content is judgment |
| `adr resolve` | resolve an id to its real filename and state against a fetched base ref | a lookup with a defined answer; whether the result may be cited stays in the skill |
| `adr supersede` | rewrite an older ADR's `status:` line to `superseded by [NNNN](…)` | *deciding* to supersede is judgment; the one-line edit and its link are mechanical |
| `adr amend-in-part` | append this ADR to an older one's `amended-in-part by` list | as above, plus the list-append and refusal rules an author gets wrong by hand |
| `adr sweep` | rank the uncited live-accepted ADRs this one may contradict | ranking is deterministic — scan, score, sort; only *judging* the hits is the skill's |

**Considered and not derived.** A verb for step 3's dated `## Amendments` note. It is mechanical, but
the note's *content* is judgment and its shape is one line the skill already carries, so a verb would
move one line and add a block. Recorded here so it is not silently re-proposed as a gap.

## Shared conventions

Every verb below obeys these; they are stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else. Scope lines, refusal
  reasons and progress go to stderr.
- **Common inputs.** `--dir <path>` (default `.decisions`) is the record directory. `--base <ref>`
  (default `origin/main`) is the base ref, **fetched before it is read** — reading a stale local ref
  is the whole defect class this contract exists to close. `--repo <owner/name>` (default: resolved
  from the `origin` remote) is the repository whose open pull requests form the in-flight set.
  `--json` swaps the line grammar for one JSON object with the named keys given per verb.
- **Reserved exit codes.** `0` = the answer is on stdout. `1` = usage error, or the verb failed to
  run. `127` = the verb never ran. `3` and up are each verb's own proven outcomes.
- **A non-zero exit is UNKNOWN.** No verb prints a partial or permissive answer on a non-zero exit;
  a caller reads the status before the bytes.
- **GitHub access follows [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql)**
  — REST, paginated. The reason lives there, not here. What is local to this group: a pull request
  that adds its `.decisions/` file past file #100 still claims its number (#725), so the paginate
  half is load-bearing for `adr next`.

---

## `adr next`

**Invocation**

```
fabrika adr next [--dir <path>] [--base <ref>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--dir` | string | no | `.decisions` | the directory of `NNNN-slug.md` decision records to scan |
| `--base` | string | no | `origin/main` | the base ref to fetch and read the merged set from |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository whose open pull requests form the in-flight set |
| `--json` | boolean | no | `false` | emit the full allocation record instead of the bare id |

**Output** — one line, the zero-padded four-digit id, newline-terminated. With `--json`, one object
with keys `id`, `mergedMax`, `inFlight` (array of ids, ascending), `baseRef`, `baseSha`. There is no
empty answer: see Scope.

**The id is the maximum of the union, plus one — never the first free number in it.** A gap below
the maximum is a number some pull request claimed and never merged, and re-issuing it points every
citation of the abandoned ADR at a different decision. The worked example below is chosen to
discriminate the two rules: `mergedMax 0236` with `inFlight [0237, 0239]` answers `0240`, where
first-free would answer `0238`.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the id was produced on stdout |
| `1` | usage error, or the verb failed to run |
| `3` | `--base` could not be fetched, so the merged set is UNKNOWN |
| `4` | the open pull requests could not be enumerated, so the in-flight set is UNKNOWN |
| `6` | `--dir` could not be read at the fetched `--base`, so the merged set is UNKNOWN |

`5` is a **vacated** seat, not a free one: it meant "read and empty — refusing" until #5254 made that
state an answer, and re-seating a new meaning on it would hand a caller pinned to the old reading a
wrong answer under a familiar number.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `adr next: cannot fetch <ref>: <reason> — the merged set is UNKNOWN. Re-run; do not answer from the local tree.` | 3 | refusal |
| `adr next: cannot enumerate open pull requests in <repo>: <reason> — the in-flight set is UNKNOWN, never "nothing reserved". Re-run; do not fall back to the on-disk id.` | 4 | refusal |
| `adr next: cannot read PR #<n>'s file list: <reason> — the in-flight set is INCOMPLETE, so it is UNKNOWN.` | 4 | refusal |
| `adr next: cannot read <dir> at <ref>: <reason> — the merged set is UNKNOWN, never "0 records".` | 6 | refusal |
| `adr next: <dir> holds a record with an unparseable id: <name>` | 1 | refusal |

**Scope** — every `NNNN-slug.md` under `--dir` **as of the fetched `--base`**, plus every open pull
request in `--repo` that *adds* a `.decisions/NNNN-*.md` file. The scope line goes to stderr on every
run, naming the base SHA, the record count and the in-flight count, so a caller can audit which half
produced the answer.

The two halves fail differently, and the difference is load-bearing:

- **An empty merged set is a fact, and the answer is `0001`.** The read itself proves the directory:
  the merged set is read as `git ls-tree <base-sha>:<dir>`, which fails outright when `<dir>` is not
  in the tree, so a listing that comes back empty is a directory that **exists and holds nothing** —
  a repo adopting fabrika on day one. Only a directory that could not be read is UNKNOWN, and that is
  exit `6`. The two states never share a code (#5254).
- **An empty in-flight set is a fact — but only on exit 0.** No open ADR pull request is a normal
  state. An in-flight set that could not be read is exit 4 and prints nothing on stdout, because a
  caller that reads an empty set as "nothing reserved" silently falls back to the on-disk id, which
  is exactly the collision this verb removes.

**Examples**

```
$ fabrika adr next
0240
```

```
$ fabrika adr next --json
{"id":"0240","mergedMax":"0236","inFlight":["0237","0239"],"baseRef":"origin/main","baseSha":"49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82"}
```

An adopting repo whose `.decisions/` exists and holds no records — the merged set is empty, no open
pull request claims an id, so `max(∅ ∪ ∅) + 1` is the first id:

```
$ fabrika adr next
0001
```

```
$ fabrika adr next --repo kamp-us/nonexistent
adr next: cannot enumerate open pull requests in kamp-us/nonexistent: HTTP 404 — the in-flight set is UNKNOWN, never "nothing reserved". Re-run; do not fall back to the on-disk id.
$ echo $?
4
```

**Grounding**

- #3779 — two lanes both minted ADR 0198 and both PRs went green; 0114 and 0123 were the same
  collision earlier. The fetched base ref closes the stale-local-tree half.
- ADR 0074 — the in-flight reservation lock: an open PR adding `.decisions/NNNN-*.md` *is* the
  reservation for `NNNN`. **This verb follows 0074's union and departs from its allocation rule.**
  0074's Decision says "reserve the first integer free in the union"; every implementation since —
  `decisions-index next` in code, help text and unit tests, and the v1 skill's own Step 1 — computes
  `max(union) + 1`. This spec follows the implementations, because #4296 (a citation to an ADR that
  never landed) postdates 0074 and makes re-issuing an abandoned number strictly worse than leaving
  a gap. Measured 2026-08-01, the two rules are 75 apart: first-free answers `0163` — an id absent
  from `main`, absent from every open pull request, and never added in any commit in history — while
  `max(union) + 1` answers `0238`. **The divergence is real and needs an ADR that amends 0074 rather
  than a spec that quietly outvotes it** — an implementer should not resolve this alone. Tracked on
  #3779.
- ADR 0092 — zero scope reds **for a gate**, whose empty scan means it checked nothing. An allocator
  is not a gate, and 0092's own Consequences ask a legitimately-empty scope to be made explicit
  rather than refused. A repo adopting fabrika has an empty `.decisions/` by definition, and refusing
  there left its first ADR unmintable on the documented path (#5254, against the #4776 ruling that
  working in a foreign repo is a release criterion).
- **The residual race is real and this verb does not close it.** Two authors between the same pair of
  invocations still collide. CI's `decisions-index validate` job reds the second-to-merge PR in
  CI, and the skill's step 6 re-check catches it for the caller's own id before the PR opens. A verb
  that claimed to close it would be lying; state the residual in `--help`.
- #4208 / #4219 — a proven refusal never shares an exit code with a failure to invoke.

---

## `adr new`

**Invocation**

```
fabrika adr new 0240 only-landed-adrs-may-be-cited [--dir <path>] [--status <text>] [--date <YYYY-MM-DD>] [--title <text>] [--tags <a,b>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<id>` | positional string | yes | — | the four-digit zero-padded id this ADR claims |
| `<slug>` | positional string | yes | — | the kebab-case slug, at most 5 words |
| `--dir` | string | no | `.decisions` | the directory to write the record into |
| `--status` | string | no | `accepted` | the frontmatter `status:` value |
| `--date` | string | no | today, `YYYY-MM-DD` | the frontmatter `date:` value |
| `--title` | string | no | the slug, de-hyphenated | the frontmatter `title:` value and the H1 |
| `--tags` | string | no | empty | comma-separated frontmatter tags |

**Output** — one line, the path written, newline-terminated. With `--json`, one object with keys
`path`, `id`, `slug`.

The file's bytes are the canonical template, and **this block is that template's single home** — the
skill does not carry a copy to drift against:

```markdown
---
id: NNNN
title: <one decision-carrying clause, ≤ ~12 words — this is the compact-map row>
status: accepted
date: YYYY-MM-DD
tags: []
---

# NNNN — <Title, verbatim from the frontmatter title>

**What this decides:** <one plain sentence a non-author parses cold.>

## Context

<Why this came up — situation, constraint, prior pain. Name any ADR this supersedes or amends.>

## Decision

**<One bolded declarative sentence.>**

<Then the mechanics, declarative. No hedging.>

## Consequences

<What this makes easier / harder. Any migration cost.>
```

Two terminal sections are **not** scaffolded, because an empty one invites filler: `## Records` for
merge-time bookkeeping (`Closes #N`, blocks cleared, the vocabulary-impact outcome) and
`## Amendments` for dated forward notes. The skill adds them when it has content for them.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the file was written and its path is on stdout |
| `1` | usage error, or the verb failed to run |
| `3` | the target path already exists — refused, never overwritten |
| `4` | `<id>` is not four digits, or `<slug>` is not kebab-case |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `adr new: <path> already exists — refusing to overwrite.` | 3 | refusal |
| `adr new: id "<id>" is not four zero-padded digits.` | 4 | usage error |
| `adr new: slug "<slug>" is not kebab-case (lowercase letters, digits and single hyphens).` | 4 | usage error |
| `adr new: cannot write <path>: <reason>` | 1 | refusal |

**Scope** — not a judging verb. It writes exactly one file and never edits another. It does not check
whether the id is claimed; that is `adr next` and `adr resolve`.

**Examples**

```
$ fabrika adr new 0240 only-landed-adrs-may-be-cited
.decisions/0240-only-landed-adrs-may-be-cited.md
```

```
$ fabrika adr new 0126 ambient-adr-discovery
adr new: .decisions/0126-ambient-adr-discovery.md already exists — refusing to overwrite.
$ echo $?
3
```

**Grounding**

- The template is the v1 skill's, trimmed. It lives here rather than in `SKILL.md` because a template
  in two places is a template that drifts, and the skill's job is the judgment the template cannot
  carry.
- The `**What this decides:**` line is required on every ADR: the founder ratifies ADRs (ADR 0078)
  and reads that line, not the dense agent-facing prose beneath it.

---

## `adr resolve`

**Invocation**

```
fabrika adr resolve 0164 [--dir <path>] [--base <ref>] [--repo <owner/name>] [--json]
```

One or more ids may be given; each produces one line, in argument order. One fetch serves them all.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<id>...` | positional string, repeatable | yes | — | the four-digit ids to resolve |
| `--dir` | string | no | `.decisions` | the directory of decision records to resolve against |
| `--base` | string | no | `origin/main` | the base ref to fetch and resolve against |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository whose open pull requests form the in-flight set |
| `--json` | boolean | no | `false` | emit one object per id instead of the line grammar |

**Output** — one **tab-separated** line per id: `<state>`, `<file>`, `<detail>`.

| `state` | `file` | `detail` |
|---|---|---|
| `live` | the record's filename under `--dir`, at `--base` | the frontmatter `status:` value, verbatim |
| `landed` | the record's filename — present on the base ref, but not live | the frontmatter `status:` value, verbatim |
| `in-flight` | the filename the open pull request adds | `PR #<n>` |
| `absent` | `-` | `-` |

**`live` and `landed` split presence from authority, and the split is the point.** Presence alone is
what a caller wrongly reads as "citable": 36 of the 233 records on `main` today are present and
*not* live — 20 `superseded`, 9 `proposed`, 2 `superseded-in-part`, plus `retired`, `moot` and
`reference`. A verb that answered `landed` for all 233 would license citing every one of them.

fabrika owns this predicate; it does not import one. The semantics: `accepted` is live, and so is
`amended-in-part`, whose unamended remainder still stands. `proposed` is not yet live and
`superseded` is no longer. v1's `isLiveAccepted` is a **reference for what the words mean**, never a
dependency — read it to check the semantics agree, then implement fabrika's own.

With `--json`, a **JSON array** — one object per id, in argument order, with keys `id`, `state`,
`file`, `detail`, `baseRef`, `baseSha`. An array rather than JSON-lines, so a single id and many ids
parse identically and a caller never has to branch on the count.

**All four states are answers, and each is a positive token.** `absent` on exit 0 means *proven
absent against a current tree*: the fetch succeeded, the records were read, the open pull requests
were enumerated, and no one holds this id. It is never what a failed read prints.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | a state line was produced for every id given |
| `1` | usage error, or the verb failed to run |
| `3` | `--base` could not be fetched, so every state is UNKNOWN |
| `4` | the open pull requests could not be enumerated, so `absent` cannot be distinguished from `in-flight` |
| `6` | `--dir` could not be read at the fetched `--base`, so every state is UNKNOWN |

`5` is vacated here for the same reason it is under `adr next`.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `adr resolve: cannot fetch <ref>: <reason> — every state is UNKNOWN, never "absent".` | 3 | refusal |
| `adr resolve: cannot enumerate open pull requests in <repo>: <reason> — "absent" is indistinguishable from "in-flight", so it is UNKNOWN.` | 4 | refusal |
| `adr resolve: cannot read <dir> at <ref>: <reason> — every state is UNKNOWN, never "absent".` | 6 | refusal |
| `adr resolve: id "<id>" is not four zero-padded digits.` | 1 | usage error |
| `adr resolve: <dir> at <ref> holds two records for id <id>: <a>, <b>` | 1 | refusal |

**Scope** — every `NNNN-slug.md` under `--dir` at the fetched `--base`, plus every open pull request
in `--repo` that adds a `.decisions/NNNN-*.md` file. Zero records is a fact and answers `absent` for
every id no open pull request holds, for the same reason it answers in `adr next`. The scope line
goes to stderr, naming the base SHA and both counts.

**Examples**

```
$ fabrika adr resolve 0164
landed	0164-guard-relaxing-adr-cp-gate.md	proposed
```

```
$ fabrika adr resolve 0023 0240
live	0023-live-views-sse-livedo.md	amended-in-part by [0025](0025-split-livedo-connection-topic.md), [0028](0028-effect-durable-object-model.md), [0037](0037-unified-void-aligned-live-do.md)
absent	-	-
```

```
$ fabrika adr resolve 0239
in-flight	0239-campaign-milestones-close-with-their-arc.md	PR #4711
```

```
$ fabrika adr resolve 0164 --base origin/nonexistent
adr resolve: cannot fetch origin/nonexistent: couldn't find remote ref — every state is UNKNOWN, never "absent".
$ echo $?
3
```

**Grounding**

- #4296 — PR #4293 cited unlanded ADR 0219 and every gate passed on the dead citation. `in-flight` is
  a distinct state precisely so a caller can refuse to cite it.
- #4163 — a review gate declared a merged ADR nonexistent. A stale tree must exit 3, never print
  `absent`.
- #4338 — a stale checkout applied a withdrawn ADR 86 minutes after the withdrawal landed. The
  `detail` field carries the frontmatter `status:` verbatim, so a withdrawn or superseded ADR reads
  as such at the moment of citation.
- #1777 — a guessed slug is a dead link. A slug is not derivable from a title (0048 is
  `ship-it-merge-actor`, not `single-merge-authority`), so this verb prints the real filename and the
  caller uses it verbatim.
- ADR 0092 — zero scope reds for a gate; see `adr next`'s Grounding for why this verb is not one.

---

## `adr supersede` and `adr amend-in-part`

One mechanic, two relationships. Both rewrite the **frontmatter `status:` line of the older ADR and
nothing else**.

**Invocation**

```
fabrika adr supersede 0126 --by 0240 [--dir <path>]
```

```
fabrika adr amend-in-part 0023 --by 0240 [--dir <path>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<id>` | positional string | yes | — | the four-digit id of the older ADR whose status line changes |
| `--by` | string | yes | — | the four-digit id of the ADR doing the superseding or amending |
| `--dir` | string | no | `.decisions` | the directory both records live in |
| `--json` | boolean | no | `false` | emit the edit record instead of the line grammar |

**Output** — one **tab-separated** line: the path edited, then the new `status:` value. With
`--json`, one object with keys `path`, `id`, `by`, `statusBefore`, `statusAfter`.

The written value resolves `--by`'s slug **off disk**, never from its title:

- `supersede` → `superseded by [NNNN](NNNN-slug.md)`, replacing whatever was there.
- `amend-in-part` → `amended-in-part by [NNNN](NNNN-slug.md)`. When the target already carries an
  `amended-in-part by` list, the new link is **appended** to it, comma-separated, in id order; a
  duplicate link is a no-op edit that still exits 0. ADR 0023 carries three such links today, and a
  verb that overwrote instead of appending would silently drop two live relationships.

**The one-line invariant, enforced in code.** The verb reads the file, rewrites exactly the
`status:` line, and asserts before writing that the resulting text differs from the original on that
line alone. A diff of any other line is a bug and aborts the write with exit 6. An accepted ADR's
decision text is immutable; the relationship is named in the *newer* ADR's `## Context`, which this
verb never touches. This assertion is the deterministic test the implementation owes.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the status line was rewritten and the result is on stdout |
| `1` | usage error, or the verb failed to run |
| `3` | `<id>` has no record under `--dir` |
| `4` | `--by` has no record under `--dir` — the link would be dead on arrival |
| `5` | `<id>`'s frontmatter has no single rewritable `status:` line |
| `6` | the rewrite would have changed a line other than `status:` — aborted before writing |
| `7` | `<id>` is already `superseded by …`, so it is not amendable or re-supersedable |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `adr supersede: no record for id <id> under <dir>.` | 3 | refusal |
| `adr supersede: no record for --by id <by> under <dir> — refusing to write a dead link.` | 4 | refusal |
| `adr supersede: <path> has no single frontmatter status: line to rewrite.` | 5 | refusal |
| `adr supersede: rewrite would have changed <n> line(s) beyond status: — aborted, nothing written.` | 6 | refusal |
| `adr amend-in-part: <path> is already "superseded by …" — a superseded ADR is not amendable.` | 7 | refusal |

Each message is prefixed with the invoked verb name, so `adr amend-in-part` says `adr amend-in-part`.

**Scope** — not a judging verb. It reads and writes exactly one file, the record for `<id>`, and
reads one more, the record for `--by`, to resolve its slug.

**Examples**

```
$ fabrika adr supersede 0126 --by 0240
.decisions/0126-ambient-adr-discovery.md	superseded by [0240](0240-only-landed-adrs-may-be-cited.md)
```

```
$ fabrika adr amend-in-part 0023 --by 0240
.decisions/0023-live-views-sse-livedo.md	amended-in-part by [0025](0025-split-livedo-connection-topic.md), [0028](0028-effect-durable-object-model.md), [0037](0037-unified-void-aligned-live-do.md), [0240](0240-only-landed-adrs-may-be-cited.md)
```

```
$ fabrika adr supersede 0126 --by 9999
adr supersede: no record for --by id 9999 under .decisions — refusing to write a dead link.
$ echo $?
4
```

**Grounding**

- #1777 — the recurring dead-link FAIL. Resolving `--by`'s slug off disk, and refusing when it has no
  record, is why exit 4 exists.
- ADR 0023's live status line — three appended `amended-in-part by` links prove the list is real and
  the append is not hypothetical.
- The immutability rule: never edit an accepted ADR's decision text; supersede it, or amend it in
  part on the status line alone. Exit 6 is that rule made mechanical rather than remembered.

---

## `adr sweep`

Ranks the uncited live-accepted ADRs whose decision domain the subject touches. **Implemented in
`fabrika`, calling nothing** — the lexical/rarity ranking is fabrika's own.

**Invocation**

```
fabrika adr sweep --new 0240 [--dir <path>] [--limit <n>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--new` | string | yes | — | the ADR to sweep: a four-digit id already in `--dir`, or a path to the draft file |
| `--dir` | string | no | `.decisions` | the corpus to sweep against |
| `--limit` | integer | no | `8` | how many shortlist entries to emit |
| `--json` | boolean | no | `false` | emit the sweep result as one JSON object on **stdout** |

**Ranking** — the score is a computation, and this is it. Two implementers who read this section
compute the same number to the last printed digit; nothing below is left to judgment.

1. **The corpus and the two populations.** Every `NNNN-slug.md` file under `--dir` is read, and that
   count is `scanned`. The **live-accepted corpus** `L` is every scanned record whose frontmatter
   `status:` is live (`accepted` or `amended-in-part …`, per the shared conventions), minus the
   subject's own record when the subject sits in `--dir`. `N = |L|`. The **in-scope** set is `L`
   minus every record whose id the subject already cites, a citation being any four-digit token
   anywhere in the subject's file text. `L` is the rarity denominator **and** the population the
   rarity floor of 10 counts — the whole live-accepted corpus, *before* citations are excluded. The
   in-scope set is only what gets ranked, and it is what `inScope` reports.
2. **Decision-bearing text**, taken the same way for the subject and for each record in `L`: the
   frontmatter `title:`, the `**What this decides:**` gloss up to its first blank line, and the
   `## Decision` section — frontmatter stripped, and nothing from `## Context` or `## Consequences`.
   Those two narrate why a decision was taken and what it costs; two ADRs contradict each other in
   what they *decide*, so ranking on decision text is what stops a shared war story scoring as a
   shared ruling. A record with no `## Decision` heading contributes its whole body instead, so a
   nonstandard record is rankable rather than silently invisible.
3. **Tokenizer.** Lowercase the text, split it on every run of characters outside `[a-z0-9]`, and
   keep the tokens of length ≥ 3 that are neither purely numeric (a bare number is an id, not a
   term) nor a stopword. Each document's terms are a **set**: a term counts once per record however
   often it occurs, so the score carries no term-frequency component.
4. **Stopwords** — exactly this list, and nothing domain-specific. Repo jargon needs no list: a term
   every record uses has a rarity weight near zero and contributes nothing on its own.

   ```
   a about above after again against all also although always am an and any are as at be because
   been before being below between both but by can cannot could did do does doing done down during
   each either else even ever every few for from further had has have having her here hers him his
   how however if in instead into is it its itself just less let like made make makes many may
   might more most much must never new no nor not now of off on once one only or other our out over
   own per rather same shall she should since so some still such than that the their them then
   there these they this those though through thus to too two under until up upon use used uses
   using very was way we well were what when where whether which while who whom whose why will with
   within without would yet you your
   ```

5. **Rarity.** `df(t)` is how many records of `L` carry term `t`. For each subject term `t` with
   `df(t) < N`, the weight is `idf(t) = ln(N / max(df(t), 1))`. A term with `df(t) = N` is dropped:
   carried by every record, it discriminates nothing. A term with `df(t) = 0` is kept at `ln(N)` —
   maximally rare, scoring against nobody, which is what separates the two silent outcomes below.
6. **Score.** Each in-scope record scores the sum of `idf(t)` over the subject terms it carries.
   A record scoring `0` is dropped rather than shortlisted at zero.
7. **Order and cut.** Descending score, ties broken by ascending numeric id; `--limit` then takes
   the first `n` of that order.
8. **Rounding.** A score is rounded to two decimals as `round(score × 100) / 100` (halves away from
   zero) and printed with exactly two decimals, so `2.3` prints `2.30`.

**This ratifies the shipped function rather than replacing it.**
[`packages/fabrika-cli/src/adr/sweep.ts`](../../../../packages/fabrika-cli/src/adr/sweep.ts) already
computes exactly the above; the spec was unspecified and the implementation was not, so the
implementation is what got written down (ADR
[0247](../../../../.decisions/0247-a-spec-example-value-is-derivable-or-absent.md)). Where the two
ever disagree, this section is the contract and the implementation is the bug.

**The three outcomes, disjoint by construction.**

- **`indeterminate`** — the run carries no information: either `N` is below the rarity floor of 10,
  or the subject yielded no distinctive term at all. **Distinctiveness is a property of the subject
  against the corpus, never of its overlap**: a subject term is distinctive when at least one record
  of `L` lacks it (`df(t) < N`). So a subject whose every term is *absent* from the corpus is
  maximally distinctive and never lands here — it reaches `no-overlap`.
- **`no-overlap`** — the subject had distinctive terms and no uncited live-accepted record shares
  one, so every in-scope record scored `0`. Never read as a clearance.
- **`shortlist`** — at least one in-scope record scored above `0`.

**Output** — the first line is the outcome token alone: `shortlist`, `no-overlap` or `indeterminate`.
On `shortlist`, one tab-separated line per entry follows — `<id>`, `<score>`, `<file>`, `<title>`.
The reason for a `no-overlap` or `indeterminate`, and the scope line, go to stderr.

**All three outcomes are answers, and all three exit 0.** The outcome is this verb's own verdict, and
a caller must never read its own shortlist as a failed run — which is precisely the mistake v1's
`adr-sweep` makes by exiting `1` on the one case it was asked to produce.

With `--json`, one object on stdout with keys `outcome` (the token), `entries` (an array of
`{id, score, file, title}`, empty unless `outcome` is `shortlist`), `reason` (the string below, or
`null`), `scanned`, `inScope` and `cited`.

**The `reason` string is fixed text, byte for byte** — a caller may grep it, so it is pinned to the
same precision as every stderr message in the Errors table. `<N>` is the live-accepted count.

| Outcome | `reason` |
|---|---|
| `indeterminate`, below the floor | `the live-accepted corpus holds <N> record(s), below the rarity floor of 10 — every term looks common, so a clean sweep here is degenerate rather than clean` |
| `indeterminate`, no distinctive terms | `the subject yielded no distinctive terms against the live-accepted corpus — nothing to rank, so the run carries no information` |
| `no-overlap` | `no uncited live-accepted record shares a distinctive term with the subject — this is not a clearance: an ADR that disagrees about what a label means shares no vocabulary and never appears here` |
| `shortlist` | `null` |

The same sentence is what reaches stderr on either channel, as `adr sweep: <reason>.` — the verb's
prefix and a terminating period, and no other rewording.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | an outcome token was produced on stdout |
| `1` | usage error, or the verb failed to run |
| `3` | the corpus could not be read, so the outcome is UNKNOWN |
| `4` | `--new` names an id or path with no readable ADR |

`5` is vacated here for the same reason it is under `adr next`.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `adr sweep: cannot read <dir>: <reason> — the outcome is UNKNOWN, never "no-overlap".` | 3 | refusal |
| `adr sweep: no readable ADR for --new <value>.` | 4 | refusal |

**Scope** — every live-accepted record under `--dir` that `--new` does not already cite. The scope
line goes to stderr naming the corpus size and the in-scope count, because the outcome is only
readable against them: `indeterminate` fires when the live-accepted corpus is below the rarity floor
of 10 — the floor counts that corpus, not the in-scope subset — and a caller that cannot see the
count cannot tell that from a clean sweep.

**A readable-but-empty `--dir` is that floor at its limit and answers `indeterminate`**, with the
below-the-floor `reason` reading `0 record(s)`. It needs no case of its own: a corpus of nothing
carries no information for the same reason a corpus of three does not. Only a corpus that could not
be read is UNKNOWN, and that is exit `3`. Note `--new` still has to name a readable ADR — against an
empty `--dir` an `NNNN` id form resolves to nothing and refuses `4`, so a fresh adopter passes the
path to their draft.

**Examples**

A score is relative to the corpus it was computed against, so an example that prints one names a
**committed** corpus rather than the live `.decisions/`, whose scores would be stale the next time a
record lands (ADR [0247](../../../../.decisions/0247-a-spec-example-value-is-derivable-or-absent.md)).
Both examples run against fixtures in this skill's tree and reproduce byte for byte; the scope line
each writes to stderr is not shown.

```
$ fabrika adr sweep --new claude-plugins/fabrika/skills/adr/evals/fixtures/0240-only-landed-adrs-may-be-cited.md --dir claude-plugins/fabrika/skills/adr/evals/fixtures/sweep-corpus
shortlist
0101	17.03	0101-citations-resolve-against-the-base-ref.md	A citation resolves against the fetched base ref, never the local working tree
0103	11.74	0103-an-unmerged-pull-request-leaves-no-record.md	A pull request that never merges leaves no record behind
0102	9.43	0102-a-reviewer-resolves-every-reference.md	A reviewer resolves every reference in the pull request under review
0104	4.61	0104-superseded-records-keep-their-file.md	A superseded record keeps its file and gains a status line
0107	2.30	0107-every-push-runs-the-test-suite.md	Every push runs the whole test suite
0110	2.30	0110-diagnostics-go-to-stderr.md	Diagnostics go to stderr, answers to stdout
$ echo $?
0
```

Four of that corpus's ten records — `0105`, `0106`, `0108`, `0109` — are absent, and the absence is
the ranking working: each shares exactly one term with the subject, `decision`, which all ten records
carry (`df = N`), so its weight is dropped and the record scores `0`. The tail is the arithmetic in
the open: `0107` shares only `time` and `0110` only `lands`, each held by one record of ten, so both
score `ln(10 / 1) = 2.302…` → `2.30` and tie, and the tie breaks toward the lower id.

```
$ fabrika adr sweep --new 0240 --dir claude-plugins/fabrika/skills/adr/evals/fixtures/small-corpus
indeterminate
$ echo $?
0
```

That corpus holds three live-accepted records, so it is below the rarity floor and the run is
indeterminate rather than clean. With `--json` the same run carries the pinned `reason`:

```
$ fabrika adr sweep --new 0240 --dir claude-plugins/fabrika/skills/adr/evals/fixtures/small-corpus --json
{"outcome":"indeterminate","entries":[],"reason":"the live-accepted corpus holds 3 record(s), below the rarity floor of 10 — every term looks common, so a clean sweep here is degenerate rather than clean","scanned":4,"inScope":3,"cited":0}
$ echo $?
0
```

**Grounding**

- ADR 0092 — zero scope reds for a gate; see `adr next`'s Grounding for why this verb is not one.
- v1's `adr-sweep` is worth reading before implementing this, for two scars it already carries: it
  exits `1` whenever it *has* a shortlist (so a caller reads its informative case as a failure), and
  its `--json` payload goes to stderr leaving stdout empty (#4723). fabrika repeats neither — all
  three outcomes exit `0` here, and `--json` goes to stdout per rule 2. Read it as a list of mistakes
  already made, not as an implementation to copy.
- The ranking is a lexical/rarity score over decision-bearing text, capped at 8, excluding the
  subject's own citations — written out step by step under **Ranking** above, because the earlier
  one-line gloss printed example scores nobody could re-derive from it
  ([#4735](https://github.com/kamp-us/phoenix/issues/4735)).
- ADR [0247](../../../../.decisions/0247-a-spec-example-value-is-derivable-or-absent.md) — an
  example value is derivable or absent, and this verb's shipped ranking is ratified as the spec.

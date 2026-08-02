# `/adr` — derived CLI contract

**Skill:** [`adr`](SKILL.md) · **Authoring brief:** [#4704](https://github.com/kamp-us/phoenix/issues/4704) · **Date:** 2026-08-01

**The seed package.** These are fabrika's first derived verbs, so this spec is where the verb package
lands — [#4648](https://github.com/kamp-us/phoenix/issues/4648) Resolved question 2 defers the
decision to the first derived contract, which is this one. The package is `packages/fabrika-cli/`,
its binary is `fabrika-cli`, and this skill's verbs sit under an `adr` subcommand group. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs all five; where this spec
and that doc disagree, the doc wins and this spec is the bug.

**`fabrika-cli` delegates to `pipeline-cli`; it does not absorb it.** `adr sweep` and `adr classify`
shell out to `pipeline-cli adr-sweep shortlist` and `pipeline-cli guard-content-probe classify` and
relay their answers. fabrika may call that substrate and never grows into it — neither verb
reimplements the ranking or the vocabulary match, and a second implementation of either would be
strictly worse, because two adjacency rankers drifting apart is a failure nobody would notice.

The delegation is a wrapper rather than a raw call in the skill for two reasons, and both are
mechanical rather than stylistic:

- **There is no legal way for a fabrika skill to invoke `pipeline-cli` directly.** The harness's
  isolation verifier refuses a `$VAR`-rooted invocation (skill conventions §4), and
  `cli-invocation-guard` reds a bare `pipeline-cli` inside a runnable fence anywhere under
  `claude-plugins/`. The canonical `PCLI="…"` form that satisfies the guard is exactly what §4 bans.
- **Both upstream verbs carry exit contracts a caller gets wrong.** `adr-sweep shortlist` exits `1`
  whenever it *has* a shortlist — its normal, informative case. `guard-content-probe classify` exits
  `0` on the §CP hold and `3` on proven-ordinary, inverted from intuition, and its own README says to
  read the stdout word and never the status. Normalising both onto this contract's uniform "`0` means
  the answer is on stdout" is the wrapper's whole job, and it is testable in one place instead of
  remembered at every call site.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `adr next` | the next unused ADR id, against a fetched base ref unioned with open ADR PRs | fetch, parse ids, take the max, add one — no judgment anywhere in it |
| `adr new` | scaffold `.decisions/NNNN-slug.md` from the canonical template | the file's *shape* is fixed text with substitutions; only its content is judgment |
| `adr resolve` | resolve an id to its real filename and state against a fetched base ref | a lookup with a defined answer; whether the result may be cited stays in the skill |
| `adr supersede` | rewrite an older ADR's `status:` line to `superseded by [NNNN](…)` | *deciding* to supersede is judgment; the one-line edit and its link are mechanical |
| `adr amend-in-part` | append this ADR to an older one's `amended-in-part by` list | as above, plus the list-append and refusal rules an author gets wrong by hand |
| `adr sweep` | rank the uncited live-accepted ADRs this one may contradict | the ranking is upstream and deterministic; only *judging* the hits is the skill's, and this verb normalises an exit contract the caller misreads |
| `adr classify` | answer whether this ADR is control-plane by content | a fixed vocabulary match with an inverted exit code; the judgment left over is whether to dispute it, not how to compute it |

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
- **GitHub reads go through `gh api` REST, never GraphQL** — the org's Projects-classic integration
  breaks GraphQL — and every list read pages. A pull request that adds its `.decisions/` file past
  file #100 still claims its number (#725).

---

## `adr next`

**Invocation**

```
fabrika-cli adr next [--dir <path>] [--base <ref>] [--repo <owner/name>] [--json]
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
| `5` | `--dir` was read and held zero `NNNN-slug.md` records — zero scope |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `adr next: cannot fetch <ref>: <reason> — the merged set is UNKNOWN. Re-run; do not answer from the local tree.` | 3 | refusal |
| `adr next: cannot enumerate open pull requests in <repo>: <reason> — the in-flight set is UNKNOWN, never "nothing reserved". Re-run; do not fall back to the on-disk id.` | 4 | refusal |
| `adr next: cannot read PR #<n>'s file list: <reason> — the in-flight set is INCOMPLETE, so it is UNKNOWN.` | 4 | refusal |
| `adr next: scanned <dir> at <ref>, 0 decision records — refusing to answer (ADR 0092).` | 5 | refusal |
| `adr next: <dir> holds a record with an unparseable id: <name>` | 1 | refusal |

**Scope** — every `NNNN-slug.md` under `--dir` **as of the fetched `--base`**, plus every open pull
request in `--repo` that *adds* a `.decisions/NNNN-*.md` file. The scope line goes to stderr on every
run, naming the base SHA, the record count and the in-flight count, so a caller can audit which half
produced the answer.

The two halves fail differently, and the difference is load-bearing:

- **Zero records is a failed read, not an answer.** This repo always has decision records, so an
  empty scan means the wrong directory or a broken read, and answering `0001` would collide with
  every existing record.
- **An empty in-flight set is a fact — but only on exit 0.** No open ADR pull request is a normal
  state. An in-flight set that could not be read is exit 4 and prints nothing on stdout, because a
  caller that reads an empty set as "nothing reserved" silently falls back to the on-disk id, which
  is exactly the collision this verb removes.

**Examples**

```
$ fabrika-cli adr next
0240
```

```
$ fabrika-cli adr next --json
{"id":"0240","mergedMax":"0236","inFlight":["0237","0239"],"baseRef":"origin/main","baseSha":"49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82"}
```

```
$ fabrika-cli adr next --repo kamp-us/nonexistent
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
- ADR 0092 — zero scope reds; an empty record scan is a refusal, not `0001`.
- **The residual race is real and this verb does not close it.** Two authors between the same pair of
  invocations still collide. `pipeline-cli decisions-index validate` reds the second-to-merge PR in
  CI, and the skill's step 6 re-check catches it for the caller's own id before the PR opens. A verb
  that claimed to close it would be lying; state the residual in `--help`.
- #4208 / #4219 — a proven refusal never shares an exit code with a failure to invoke.

---

## `adr new`

**Invocation**

```
fabrika-cli adr new 0240 only-landed-adrs-may-be-cited [--dir <path>] [--status <text>] [--date <YYYY-MM-DD>] [--title <text>] [--tags <a,b>]
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
$ fabrika-cli adr new 0240 only-landed-adrs-may-be-cited
.decisions/0240-only-landed-adrs-may-be-cited.md
```

```
$ fabrika-cli adr new 0126 ambient-adr-discovery
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
fabrika-cli adr resolve 0164 [--dir <path>] [--base <ref>] [--repo <owner/name>] [--json]
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

The predicate is `isLiveAccepted`, already implemented and named in
[`adr-sweep`](../../../../packages/pipeline-cli/src/tools/adr-sweep/adr-sweep.ts) — reuse that
notion rather than minting a second one, because two definitions of "live" drifting apart is worse
than either definition being wrong. `accepted` is live; so is `amended-in-part`, whose unamended
remainder still stands. `proposed` is not yet live and `superseded` is no longer.

With `--json`, one object per id with keys `id`, `state`, `file`, `detail`, `baseRef`, `baseSha`.

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
| `5` | `--dir` was read and held zero `NNNN-slug.md` records — zero scope |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `adr resolve: cannot fetch <ref>: <reason> — every state is UNKNOWN, never "absent".` | 3 | refusal |
| `adr resolve: cannot enumerate open pull requests in <repo>: <reason> — "absent" is indistinguishable from "in-flight", so it is UNKNOWN.` | 4 | refusal |
| `adr resolve: scanned <dir> at <ref>, 0 decision records — refusing to answer (ADR 0092).` | 5 | refusal |
| `adr resolve: id "<id>" is not four zero-padded digits.` | 1 | usage error |
| `adr resolve: <dir> at <ref> holds two records for id <id>: <a>, <b>` | 1 | refusal |

**Scope** — every `NNNN-slug.md` under `--dir` at the fetched `--base`, plus every open pull request
in `--repo` that adds a `.decisions/NNNN-*.md` file. Zero records is a failed read and reds, for the
same reason it does in `adr next`. The scope line goes to stderr, naming the base SHA and both counts.

**Examples**

```
$ fabrika-cli adr resolve 0164
landed	0164-guard-relaxing-adr-cp-gate.md	proposed
```

```
$ fabrika-cli adr resolve 0023 0240
live	0023-live-views-sse-livedo.md	amended-in-part by [0025](0025-split-livedo-connection-topic.md), [0028](0028-effect-durable-object-model.md), [0037](0037-unified-void-aligned-live-do.md)
absent	-	-
```

```
$ fabrika-cli adr resolve 0239
in-flight	0239-campaign-milestones-close-with-their-arc.md	PR #4711
```

```
$ fabrika-cli adr resolve 0164 --base origin/nonexistent
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
- ADR 0092 — zero scope reds.

---

## `adr supersede` and `adr amend-in-part`

One mechanic, two relationships. Both rewrite the **frontmatter `status:` line of the older ADR and
nothing else**.

**Invocation**

```
fabrika-cli adr supersede 0126 --by 0240 [--dir <path>]
```

```
fabrika-cli adr amend-in-part 0023 --by 0240 [--dir <path>]
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
$ fabrika-cli adr supersede 0126 --by 0240
.decisions/0126-ambient-adr-discovery.md	superseded by [0240](0240-only-landed-adrs-may-be-cited.md)
```

```
$ fabrika-cli adr amend-in-part 0023 --by 0240
.decisions/0023-live-views-sse-livedo.md	amended-in-part by [0025](0025-split-livedo-connection-topic.md), [0028](0028-effect-durable-object-model.md), [0037](0037-unified-void-aligned-live-do.md), [0240](0240-only-landed-adrs-may-be-cited.md)
```

```
$ fabrika-cli adr supersede 0126 --by 9999
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

Delegates to `pipeline-cli adr-sweep shortlist` and relays its answer on this contract's exit terms.
It reimplements no ranking.

**Invocation**

```
fabrika-cli adr sweep --new 0240 [--dir <path>] [--limit <n>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--new` | string | yes | — | the ADR to sweep: a four-digit id already in `--dir`, or a path to the draft file |
| `--dir` | string | no | `.decisions` | the corpus to sweep against |
| `--limit` | integer | no | `8` | how many shortlist entries to emit |
| `--json` | boolean | no | `false` | emit the sweep result as one JSON object on **stdout** |

**Output** — the first line is the outcome token alone: `shortlist`, `no-overlap` or `indeterminate`.
On `shortlist`, one tab-separated line per entry follows — `<id>`, `<score>`, `<file>`, `<title>`.
The reason for a `no-overlap` or `indeterminate`, and the scope line, go to stderr.

**All three outcomes are answers, and all three exit 0.** Upstream exits `1` on a shortlist, which is
its normal informative case; relaying that status would make every caller read its own results as a
failed run. Nothing else is transformed — the outcome token is upstream's, verbatim.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | an outcome token was produced on stdout |
| `1` | usage error, or the verb failed to run |
| `3` | the underlying sweep could not run, so the outcome is UNKNOWN |
| `4` | `--new` names an id or path with no readable ADR |
| `5` | `--dir` was read and held zero `NNNN-slug.md` records — zero scope |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `adr sweep: the underlying sweep failed: <reason> — the outcome is UNKNOWN, never "no-overlap".` | 3 | refusal |
| `adr sweep: no readable ADR for --new <value>.` | 4 | refusal |
| `adr sweep: scanned <dir>, 0 decision records — refusing to answer (ADR 0092).` | 5 | refusal |

**Scope** — every live-accepted record under `--dir` that `--new` does not already cite. The scope
line goes to stderr naming the corpus size and the in-scope count, because the outcome is only
readable against them: `indeterminate` fires when the live-accepted corpus is below the rarity floor
of 10, and a caller that cannot see the count cannot tell that from a clean sweep.

**Examples**

```
$ fabrika-cli adr sweep --new 0240
shortlist
0233	15.11	0233-decision-shell-enforcement-review-skill-criterion.md	New decision-computing shell is caught by a review-skill criterion row
0160	13.46	0160-ref-transaction-guard-refuses-diverging-primary-main.md	A git reference-transaction guard refuses a diverging refs/heads/main ref-move
$ echo $?
0
```

```
$ fabrika-cli adr sweep --new 0240 --dir claude-plugins/fabrika/skills/adr/evals/fixtures/small-corpus
indeterminate
$ echo $?
0
```

**Grounding**

- `adr-sweep shortlist` exits `1` whenever it has a shortlist — exit 0 only on `no-overlap`. Relaying
  that status makes the informative case byte-indistinguishable from a failure.
- ADR 0092 — zero scope reds.
- #4723 — upstream's `--json` payload currently goes to **stderr**, leaving stdout empty. This verb's
  `--json` puts it on stdout per rule 2, so the wrapper must move it until #4723 lands.

---

## `adr classify`

Delegates to `pipeline-cli guard-content-probe classify` and relays its verdict on this contract's
exit terms. It reimplements no vocabulary match.

**Invocation**

```
fabrika-cli adr classify 0240 [--dir <path>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<id>` | positional string | yes | — | the four-digit id of the ADR to classify, resolved under `--dir` |
| `--dir` | string | no | `.decisions` | the directory holding the record |

**Output** — one line, `guard-touching` or `not-guard-touching`, newline-terminated. The human reason
naming the matched vocabulary goes to stderr.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | a verdict was produced on stdout |
| `1` | usage error, or the verb failed to run |
| `3` | the probe could not run, so the verdict is UNKNOWN |
| `4` | `<id>` has no record under `--dir` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `adr classify: the probe failed: <reason> — the verdict is UNKNOWN. Treat this ADR as control plane.` | 3 | refusal |
| `adr classify: no record for id <id> under <dir>.` | 4 | refusal |

**Scope** — one record, so ADR 0092's zero-scope clause does not apply. The fail-closed direction
here is the *verdict*, not the scope: any non-zero exit obliges the caller to treat the ADR as §CP,
because a false §CP costs one approval while a false ordinary is #4386.

**Examples**

```
$ fabrika-cli adr classify 0092
guard-touching
```

```
$ fabrika-cli adr classify 0023
not-guard-touching
```

**Grounding**

- ADR 0164 — `.decisions/**` matches no control-plane *path*, so a guard-governing ADR is §CP by
  content alone. **The binding fact is the enforcement, not the ADR's status field:** `cp-classify`
  and `guard-content-probe` implement this today and stamp `(§CP, ADR 0164)` into their output, while
  0164 itself has read `proposed` throughout — the mismatch is #4388, which carries a founder ruling
  to accept it that has not landed. Neither this spec nor the skill asserts 0164's status, because a
  status claim about another record is exactly the thing that rots; `adr resolve` is how a caller
  learns it at the moment of citing.
- #4386 / #3416 — a guard-touching ADR routed as ordinary reaches `main` with zero approvals.
- Upstream's exit codes are inverted — `0` is guard-touching, `3` is not-guard-touching — and its own
  README says to read the stdout word and never the status. The inversion must not leak through this
  wrapper; normalising it is half the reason the wrapper exists.
- #2617 — 196 of 233 ADRs currently classify `guard-touching`, an 84% rate. This verb relays that
  calibration rather than correcting it; re-tuning the vocabulary is #2617's call, not this spec's.

# `campaign` — derived CLI contract

**Skill:** [`campaign`](SKILL.md) · **Authoring brief:** [#6347](https://github.com/kamp-us/phoenix/issues/6347) · **Date:** 2026-08-20

Three verbs under a `campaign` group in `packages/fabrika-cli/`. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs all three; where this spec
and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill.** v1's `campaign`,
`roadmap` and `roadmap-guard` tools were read for their semantics and their scars and are cited
below as grounding; nothing here invokes them, nothing under `claude-plugins/kampus-pipeline/` or
`packages/pipeline-cli/` is reached, and no v1 script is ported. Both trees are deleted from the
working tree in any case — the deletion test is the reason that is a feature (#4638, ADR 0238).

**What the roadmap guard already owns is not re-derived here.** `fabrika guard roadmap-guard check`
([`guard/roadmap.ts`](../../../../packages/fabrika-cli/src/guard/roadmap.ts)) judges I1–I5: every row
pins an existing milestone by number, exactly one arc is active, every open milestone is claimed,
zero scope fails closed, and a row's state agrees with its milestone's open/closed reality. So no
verb below checks that a milestone exists, that it is open, or that the table is in sync — a second
answer to a merge-gating question is the failure mode, and the skill states the expectation instead
(criterion 6 of the brief; ADR 0238's "ask whether the skill needs the answer, or only needs to
expect it").

**Dispatch permission is likewise read, never computed.**
[`build/scope-admission.ts`](../../../../packages/fabrika-cli/src/build/scope-admission.ts) decides
whether an issue is admitted on the scope axis, off the same `State` cell these verbs write. No verb
here answers "may a lane open against this milestone".

**One parser, not a third.** `guard/roadmap.ts` already parses `## Campaigns` into
`{name, milestone, state}` rows and `triage/roadmap.ts` parses the name→milestone join. `campaign
list` and the two write verbs read through the `guard/roadmap.ts` parser rather than a new one, so
the reporting surface and the judging surface cannot disagree about what a row says. The write half
is new — nothing in the tree writes this table today.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `campaign list` | the `## Campaigns` rows, parsed, optionally narrowed to one state | parse a fixed, documented table grammar and print it — judging the rows is `roadmap-guard`'s, and choosing what to do about them is the skill's |
| `campaign open` | append a new `paused` row pinning a milestone, past the approval trace | the row's bytes, its insertion point and the trace check are fixed; *which* campaign to name is the founder's, and it arrives as an argument |
| `campaign state` | rewrite one row's `State` cell, past the approval trace | a one-cell rewrite with a closed value set, a duplicate-write refusal and a read-back; deciding to flip is the ruling this verb demands a citation for |

`open` and `state` are deliberately **not** fused into one upsert. ADR 0304's whole ruling is that
naming a campaign and granting it dispatch are separate acts; a verb that did both on one call would
re-open in code exactly what the ruling closed in the grammar.

## Shared conventions

- **Answer channel: machine.** Stdout carries the answer and nothing else. Notices, scope lines and
  refusal reasons go to stderr.
- **Common inputs.** `--file <path>` is the roadmap file; absent, it resolves `.fabrika.jsonc`'s
  `roadmapFile` (`config/keys/paths.ts`), itself defaulting to `ROADMAP.md` at the repo root. A repo
  that writes `null` there keeps no roadmap, and every verb here refuses on `22`. `--repo
  <owner/name>` (default: resolved from the env then the `origin` remote) is the repository a cited
  comment must belong to. `--json` swaps the line grammar for one JSON object with the keys named per
  verb.
- **Row line grammar.** Every verb that prints a row prints it as
  `#<milestone>\t<state>\t<name>`, one row per line, newline-terminated, in table order. This is the
  single shape; `open` and `state` print the row they just read back in it.
- **Reserved exit codes.** `0` = the answer is on stdout. `1` = usage error, or the verb failed to
  run. `126` = no implementation resolved. `127` = the verb never ran. `2` is allocated by nothing.
  `3`+ are proven outcomes.
- **One exit table for the whole group.** Every verb allocates from `campaign/codes.ts`.

  | Code | Meaning | list | open | state |
  |---|---|:--:|:--:|:--:|
  | `0` | the answer is on stdout | ✓ | ✓ | ✓ |
  | `1` | usage error, or the verb failed to run | ✓ | ✓ | ✓ |
  | `7` | the selector names no row on the table | | | ✓ |
  | `11` | the roadmap file could not be read, so the outcome is UNKNOWN | ✓ | ✓ | ✓ |
  | `12` | the `## Campaigns` table holds a row that will not parse — the whole table is unreadable | ✓ | ✓ | ✓ |
  | `13` | the cited comment could not be fetched, so authority is UNKNOWN | | ✓ | ✓ |
  | `14` | the cited comment carries no `campaign-approve:` marker | | ✓ | ✓ |
  | `15` | the marker is malformed, or names another milestone or another state | | ✓ | ✓ |
  | `16` | the cited comment's author is not in `campaignAuthors` | | ✓ | ✓ |
  | `17` | `campaignAuthors` is empty or absent — nobody may declare in this repo | | ✓ | ✓ |
  | `18` | the selector names more than one row | | | ✓ |
  | `19` | the table already holds a row for this campaign or this milestone | | ✓ | |
  | `20` | the row already holds the state `--to` names — nothing written | | | ✓ |
  | `21` | the read-back after writing did not match, so the write is UNKNOWN | | ✓ | ✓ |
  | `22` | `.fabrika.jsonc` declines `roadmapFile` — this repo keeps no roadmap | ✓ | ✓ | ✓ |

  `7` and `11` hold the meanings `report`'s table gives them — *the target is not there*, and *the
  read that would have proven it failed* — and the group **imports those two constants from
  `report/codes.ts`** rather than restating numerals, exactly as `triage` and `review` do. The group
  registers in
  [`exit-code-alignment.ts`](../../../../packages/fabrika-cli/src/exit-code-alignment.ts) as aligning
  on those two seats; `3`, `5`, `6`, `8`, `9` and `10` are left **unallocated** so alignment stays
  cheap, and this group's private band starts at `12`. A private code carries no cross-group
  obligation: `12` here is *the campaigns table is unreadable*, and `triage`'s and `review`'s `12`
  are two other namespaces, not a collision.
- **A non-zero exit is UNKNOWN.** No verb prints a partial or permissive answer on a non-zero exit.
- **GitHub access follows [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql)**,
  paginated. What is local to this group: team membership for a `@org/team` entry in
  `campaignAuthors` is `gh api orgs/<org>/teams/<team>/memberships/<login>`, and a non-`200` that is
  not a `404` is `13`, never a "no".
- **Nothing here writes to GitHub.** Every verb's only write is to the roadmap file; the board is
  read at most.

## The `## Campaigns` table grammar

Pinned in `ROADMAP.md` itself, restated here only as the shape the writers bind to; where the two
differ, `ROADMAP.md` is the source and this is the bug.

Columns are `Campaign | Milestone | State`, in that order. `Campaign` is the founder-voice name.
`Milestone` is `#<number>` — the join key, never the title. `State` is one of `active`, `paused`,
`done`, lowercase.

**A row counts only when its second cell matches `^#(\d+)$`**, which drops the header and the
`|---|` separator without matching on their text, so a header rename cannot silently admit a row.
That is `triage/roadmap.ts`'s existing rule and the writers keep it.

**A row whose second cell is `#<number>` and whose third cell is not one of the three states makes
the whole table unreadable** (`12`). A fence never falls back to the rows it could parse (ADR 0304),
so a partial answer is the one thing no verb here may return.

**An absent table, a table with no rows, and a table whose every row is `paused` or `done` are one
well-formed default, and they are a fact rather than a failed read.** `campaign list` answers `none`
at exit `0`. This is the deliberate exception to ADR 0092's fail-closed-on-zero-scope rule, and it is
ruled: nothing declared means the fence is off, not closed (founder ruling on #5011, carried onto
this surface by ADR 0304). A judging verb would red here; `list` supplies an input and its empty
answer is a fact, which is the distinction the interface convention's rule 4 asks every verb to
settle in its header.

## The approval trace

The single source for what `--cites` proves. Both write verbs run it before touching the file.

**The artifact** is one GitHub issue or pull-request comment, named by its URL, whose **first line**
is the marker:

```
campaign-approve: #47 active · 2026-08-20T04:11:09Z
```

**Grammar.** The comment body is split on `\r?\n` and only the **first** element is matched:

```
/^\s*\*{0,2}\s*campaign-approve:\s*#(?<milestone>\d+)\s+(?<state>active|paused|done)\s*·\s*(?<ts>\S+?)\s*\*{0,2}\s*$/i
```

Emphasis-tolerant at both ends (`**campaign-approve: #47 active · …**` matches), keyword
case-insensitive, separator the middle dot `·` (U+00B7). `<ts>` must additionally match
`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/` **and** parse: `Number.isFinite(Date.parse(ts))`.
A regex-shaped but calendar-invalid date (`2026-02-30T00:00:00Z`) is malformed.

**Why the first line and nothing else.** v1 matched the marker anywhere in the body, so a founder who
wrote their approval and then explained it read as `malformed` (#3831). Anchoring to line one fixes
that *and* closes the inverse: a marker quoted inside somebody else's comment is a quotation, never a
grant. Both directions are load-bearing; the anchor is not a tightening to relax.

**Binding.** `<milestone>` must equal the milestone of the row being written and `<state>` must equal
the state the write produces — `paused` for `campaign open`, the `--to` value for `campaign state`.
An approval of one campaign never authorizes another, and an approval to pause never authorizes a
start. That state binding is this contract's own derivation, not v1's: v1's marker named a wave label
and a direction was implicit, which under ADR 0304 would let one grant re-start a campaign any number
of times.

**Authority.** The comment's author login is resolved against `.fabrika.jsonc`'s `campaignAuthors`
(below), case-insensitively for a `@user` entry, by REST membership for a `@org/team` entry. This is
the ADR 0055 idiom: authority arrives through an ACL-checked verb, and the marker's presence is
evidence, never permission.

**Repository binding.** The cited URL must resolve under `--repo`. A comment in another repository is
`15`.

**Precedence when more than one thing is wrong** is most-informative-first, so the caller is told the
furthest thing they got: `16` (a well-formed, correctly-bound marker by an unauthorized author) >
`15` (malformed or misbound) > `14` (no marker at all). `17` outranks all three — with nobody
declared, no comment could have carried authority, so reporting `absent` would send the caller
hunting for a marker that could not have helped.

**What it cannot prove, stated so no reader assumes it.** That the founder meant this grant for this
write. A comment re-cited from months ago, or one whose marker was written without reading what it
authorized, passes every check above. The skill carries that as judgment; the verb carries the
checks.

### `campaignAuthors`

A new `.fabrika.jsonc` key, modelled on
[`capClearAuthors`](../../../../packages/fabrika-cli/src/config/keys/cap-clear-authors.ts) and
sharing its decoder shape: an array of `@user` or `@org/team` strings, **shipped default `[]`**.

The empty default is the only one this key can have. A set that filled itself in on an absent file
would hand founder authority over the dispatch permission to whoever the fallback named, in every
repo that never declared it. Empty means nobody may declare, every write refuses on `17`, and the
remedy is a founder writing the key.

JSON-schema description: *"Who may declare a campaign or flip its lifecycle state
(`fabrika campaign open` / `fabrika campaign state`). Each entry is a GitHub `@user` or `@org/team`,
`@`-prefixed. Empty (or absent) means nobody may declare."*

---

## `campaign list`

**Split test:** deterministic. Read the file, run the existing parser, print the rows. No judgment.

**Invocation**

```
fabrika campaign list [--state <active|paused|done>] [--file <path>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--state` | `active \| paused \| done` | no | *(unset — every row)* | print only the rows holding this state |
| `--file` | string | no | `.fabrika.jsonc`'s `roadmapFile`, itself `ROADMAP.md` | the roadmap file to read |
| `--json` | boolean | no | `false` | print one JSON object instead of the line grammar |

**Output** — machine channel. The row line grammar, one row per line, in table order. When no row
survives (an absent table, an empty one, or a `--state` that matches nothing) stdout is the single
line `none` — a positive token, because empty stdout is byte-identical to a verb that never ran.
Under `--json`: `{"rows":[{"milestone":47,"state":"active","name":"fabrika everywhere"}],"file":"ROADMAP.md"}`,
with `rows: []` for the `none` case.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the rows, or `none`, are on stdout |
| `1` | usage error (an unknown flag, or a `--state` outside the three values), or the verb failed to run |
| `11` | the roadmap file could not be read |
| `12` | a row under `## Campaigns` pins a milestone and carries a state outside the three values |
| `22` | `.fabrika.jsonc` declines `roadmapFile` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `campaign list: cannot read <file>: <reason> — UNKNOWN, nothing was parsed.` | 11 | refusal |
| `campaign list: <file> row "<name>" holds state "<cell>" — the whole ## Campaigns table is unreadable (ADR 0304).` | 12 | refusal |
| `campaign list: .fabrika.jsonc sets roadmapFile to null — this repo keeps no roadmap.` | 22 | refusal |
| `campaign list: --state "<value>" is not one of active, paused, done.` | 1 | usage error |

**Scope** — every row under `## Campaigns` in `--file`. Zero rows is a **fact, not a failed read**:
see the table-grammar section. The scope line goes to stderr:
`campaign list: read <file> — <n> campaign row(s), <k> active.`

**Examples**

Both examples run against a `ROADMAP.md` whose `## Campaigns` table holds exactly these two rows:

```
| Taste-Skill Library | #42 | paused |
| fabrika everywhere | #47 | active |
```

```
$ fabrika campaign list
#42	paused	Taste-Skill Library
#47	active	fabrika everywhere
```

```
$ fabrika campaign list --state done
none
$ echo $?
0
```

**Grounding**

- ADR 0304 — the three states; one unreadable row makes the whole table unreadable; nothing active
  means the fence is off, not closed.
- Founder ruling on #5011 — the empty declaration admits everything, which is why zero rows here is
  `0` and not ADR 0092's red.
- `guard/roadmap.ts` — the parser this verb reads through, so report and verdict cannot disagree.

---

## `campaign open`

**Split test:** deterministic. The row's bytes, its insertion point and the trace check are fixed;
the campaign's name and milestone arrive as arguments, and deciding to declare one is the ruling
`--cites` demands.

**Invocation**

```
fabrika campaign open <name> --milestone <n> --cites <url> [--file <path>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<name>` | string (positional) | yes | — | the founder-voice campaign name, written verbatim into the first cell |
| `--milestone` | integer | yes | — | the GitHub milestone number this campaign pins |
| `--cites` | string (URL) | yes | — | the comment URL whose first line carries the `campaign-approve:` marker |
| `--file` | string | no | `.fabrika.jsonc`'s `roadmapFile`, itself `ROADMAP.md` | the roadmap file to write |
| `--repo` | string | no | resolved from the env, then the `origin` remote | the repository the cited comment must belong to |
| `--json` | boolean | no | `false` | print one JSON object instead of the line grammar |

**Behaviour.** The row is appended as the **last** row of the `## Campaigns` table, immediately after
the current last row, formatted `| <name> | #<n> | paused |`. The state is always `paused` and there
is no flag to change it: a row that could be written `active` is a write that grants dispatch in the
same stroke that names the campaign, which is the shape ADR 0304 forbids. Nothing outside the table
is touched — the `## Dependency graph` block is the caller's edit, for the reason in *Considered and
deliberately not derived*.

Order of operations: resolve config → read and parse the file → refuse a duplicate → check the trace
→ write → read back. The trace check runs before the write and the duplicate check before the trace,
so a caller with a bad selector is never told their citation is fine.

A `<name>` containing `|` or a newline is a usage error: it cannot be written into a table cell.

**Output** — machine channel. The written row, read back, in the row line grammar. There is no empty
answer: a run that wrote nothing exits non-zero. Under `--json`:
`{"row":{"milestone":47,"state":"paused","name":"fabrika everywhere"},"file":"ROADMAP.md"}`.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the row was appended and read back, and is on stdout |
| `1` | usage error (unknown flag, missing required flag, a `--milestone` that is not a positive integer, a `<name>` holding `\|` or a newline), or the verb failed to run |
| `11` | the roadmap file could not be read, or could not be written |
| `12` | the `## Campaigns` table holds a row that will not parse |
| `13` | the cited comment could not be fetched, or a team membership could not be resolved |
| `14` | the cited comment's first line carries no `campaign-approve:` marker |
| `15` | the marker is malformed, names a milestone other than `--milestone`, names a state other than `paused`, or the cited URL is outside `--repo` |
| `16` | the cited comment's author is not in `campaignAuthors` |
| `17` | `campaignAuthors` is empty or absent |
| `19` | a row already holds this `<name>`, or already pins `--milestone` |
| `21` | the file was written and the read-back does not hold the row — UNKNOWN |
| `22` | `.fabrika.jsonc` declines `roadmapFile` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `campaign open: --milestone must be a positive integer, got "<value>".` | 1 | usage error |
| `campaign open: <name> holds "\|" or a newline — a campaign name must fit one table cell.` | 1 | usage error |
| `campaign open: cannot read <file>: <reason> — UNKNOWN, nothing was written.` | 11 | refusal |
| `campaign open: cannot write <file>: <reason> — UNKNOWN, the table may be half-written; re-read it.` | 11 | refusal |
| `campaign open: <file> row "<name>" holds state "<cell>" — the whole ## Campaigns table is unreadable (ADR 0304). NOTHING was written.` | 12 | refusal |
| `campaign open: cannot fetch <url>: <reason> — authority is UNKNOWN, NOTHING was written.` | 13 | refusal |
| `campaign open: cannot resolve membership of <login> in @<org>/<team>: <reason> — authority is UNKNOWN, NOTHING was written.` | 13 | refusal |
| `campaign open: <url> has no campaign-approve: marker on its first line — NOTHING was written.` | 14 | refusal |
| `campaign open: <url> marker is malformed: <reason> — NOTHING was written.` | 15 | refusal |
| `campaign open: <url> approves #<marker-milestone> <marker-state>, not #<n> paused — NOTHING was written.` | 15 | refusal |
| `campaign open: <url> is not a comment in <repo> — NOTHING was written.` | 15 | refusal |
| `campaign open: <url> was authored by @<login>, who is not in campaignAuthors (<declared>) — NOTHING was written.` | 16 | refusal |
| `campaign open: campaignAuthors is empty in .fabrika.jsonc — nobody may declare a campaign in this repo. NOTHING was written.` | 17 | refusal |
| `campaign open: <file> already holds "<name>" at #<m> — NOTHING was written.` | 19 | refusal |
| `campaign open: <file> already pins #<n> to "<other>" — NOTHING was written.` | 19 | refusal |
| `campaign open: wrote <file> but the read-back holds no row for #<n> — the write is UNKNOWN; re-read the file before retrying.` | 21 | refusal |
| `campaign open: .fabrika.jsonc sets roadmapFile to null — this repo keeps no roadmap.` | 22 | refusal |

Every refusal past the read states what did **not** happen. That is v1's discipline and it is kept:
a refusal line that leaves the caller guessing whether a row landed is the one that makes them write
a second.

**Scope** — this verb judges nothing; it writes. Its stderr notice names the two things a reader
needs: `campaign open: cited <url> by @<login> (campaignAuthors: <declared>); appended "<name>" #<n>
paused to <file> — dispatches nothing until it is flipped to active.`

**Examples**

Against the same two-row fixture, with `.fabrika.jsonc` declaring `"campaignAuthors": ["@usirin"]`,
and `https://github.com/kamp-us/phoenix/issues/6289#issuecomment-5337663028` a comment by `usirin`
whose first line is `campaign-approve: #52 paused · 2026-08-20T04:11:09Z`:

```
$ fabrika campaign open "Mecmua reading layout" --milestone 52 --cites https://github.com/kamp-us/phoenix/issues/6289#issuecomment-5337663028
#52	paused	Mecmua reading layout
```

```
$ fabrika campaign open "fabrika everywhere" --milestone 52 --cites https://github.com/kamp-us/phoenix/issues/6289#issuecomment-5337663028
campaign open: ROADMAP.md already holds "fabrika everywhere" at #47 — NOTHING was written.
$ echo $?
19
```

**Grounding**

- ADR 0304 / founder ruling on #6289 — a new row is `paused`; there is no flag to write it `active`.
- ADR 0055 — authority is resolved by the verb against repo configuration and fails closed.
- ADR 0300 — a cited ruling comment is what makes a founder decision actionable by an agent; this
  verb applies the same citation idiom to a roadmap write.
- #3831 — the marker is anchored to the comment's first line, so an approval carrying rationale
  beneath it is not malformed, and a quoted approval is not a grant.
- v1's `create-milestone.sh` shipped an unchecked POST whose failure surfaced only as an empty
  number. Nothing here creates a milestone at all, and every write is read back.
- `roadmap-guard` I1/I3 own whether the pinned milestone exists and whether every open milestone is
  claimed. This verb does not check either.

---

## `campaign state`

**Split test:** deterministic. Select one row, refuse a no-op, rewrite one cell, read it back. The
decision to flip is judgment, and it enters as a citation rather than as a verb's opinion.

**Invocation**

```
fabrika campaign state <selector> --to <active|paused|done> --cites <url> [--file <path>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<selector>` | string (positional) | yes | — | `#<milestone>`, or a campaign name matched exactly against the first cell |
| `--to` | `active \| paused \| done` | yes | — | the state to write into the row's third cell |
| `--cites` | string (URL) | yes | — | the comment URL whose first line carries the `campaign-approve:` marker |
| `--file` | string | no | `.fabrika.jsonc`'s `roadmapFile`, itself `ROADMAP.md` | the roadmap file to write |
| `--repo` | string | no | resolved from the env, then the `origin` remote | the repository the cited comment must belong to |
| `--json` | boolean | no | `false` | print one JSON object instead of the line grammar |

**Behaviour.** Selection is exact, never fuzzy: a `#<n>` selector matches the row whose second cell
pins `<n>`; anything else is matched character-for-character against the first cell after trimming.
Two rows matching is `18` rather than a first-wins pick — a lifecycle flip aimed at the wrong campaign
grants dispatch on a milestone nobody named.

Order of operations: resolve config → read and parse → select → refuse a no-op → check the trace →
rewrite the third cell → read back. Only the third cell of the selected row changes; the row's
spacing, its name cell and every other line of the file are byte-identical afterwards.

**Output** — machine channel. The rewritten row, read back, in the row line grammar. Under `--json`:
`{"row":{"milestone":47,"state":"active","name":"fabrika everywhere"},"from":"paused","file":"ROADMAP.md"}`.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the cell was rewritten and read back, and the row is on stdout |
| `1` | usage error (unknown flag, missing required flag, a `--to` outside the three values), or the verb failed to run |
| `7` | the selector matches no row |
| `11` | the roadmap file could not be read, or could not be written |
| `12` | the `## Campaigns` table holds a row that will not parse |
| `13` | the cited comment could not be fetched, or a team membership could not be resolved |
| `14` | the cited comment's first line carries no `campaign-approve:` marker |
| `15` | the marker is malformed, names a milestone other than the selected row's, names a state other than `--to`, or the cited URL is outside `--repo` |
| `16` | the cited comment's author is not in `campaignAuthors` |
| `17` | `campaignAuthors` is empty or absent |
| `18` | the selector matches more than one row |
| `20` | the selected row already holds `--to` — nothing written |
| `21` | the file was written and the read-back does not hold `--to` — UNKNOWN |
| `22` | `.fabrika.jsonc` declines `roadmapFile` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `campaign state: --to "<value>" is not one of active, paused, done.` | 1 | usage error |
| `campaign state: <file> has no campaign row matching "<selector>" — NOTHING was written.` | 7 | refusal |
| `campaign state: cannot read <file>: <reason> — UNKNOWN, nothing was written.` | 11 | refusal |
| `campaign state: cannot write <file>: <reason> — UNKNOWN, the row may be half-written; re-read it.` | 11 | refusal |
| `campaign state: <file> row "<name>" holds state "<cell>" — the whole ## Campaigns table is unreadable (ADR 0304). NOTHING was written.` | 12 | refusal |
| `campaign state: cannot fetch <url>: <reason> — authority is UNKNOWN, NOTHING was written.` | 13 | refusal |
| `campaign state: cannot resolve membership of <login> in @<org>/<team>: <reason> — authority is UNKNOWN, NOTHING was written.` | 13 | refusal |
| `campaign state: <url> has no campaign-approve: marker on its first line — NOTHING was written.` | 14 | refusal |
| `campaign state: <url> marker is malformed: <reason> — NOTHING was written.` | 15 | refusal |
| `campaign state: <url> approves #<marker-milestone> <marker-state>, not #<n> <to> — NOTHING was written.` | 15 | refusal |
| `campaign state: <url> is not a comment in <repo> — NOTHING was written.` | 15 | refusal |
| `campaign state: <url> was authored by @<login>, who is not in campaignAuthors (<declared>) — NOTHING was written.` | 16 | refusal |
| `campaign state: campaignAuthors is empty in .fabrika.jsonc — nobody may flip a campaign in this repo. NOTHING was written.` | 17 | refusal |
| `campaign state: "<selector>" matches <k> rows (<names>) — NOTHING was written.` | 18 | refusal |
| `campaign state: "<name>" #<n> already holds <to> — NOTHING was written.` | 20 | refusal |
| `campaign state: wrote <file> but the read-back holds <cell> for #<n>, not <to> — the write is UNKNOWN; re-read the file before retrying.` | 21 | refusal |
| `campaign state: .fabrika.jsonc sets roadmapFile to null — this repo keeps no roadmap.` | 22 | refusal |

`20` is a refusal and not a quiet `0`. A flip to `active` is the grant of dispatch permission, so a
caller who reads "done" over a cell nobody moved cannot tell a grant they made from a grant somebody
else made first.

**Scope** — this verb judges nothing; it writes one cell. Its stderr notice:
`campaign state: cited <url> by @<login> (campaignAuthors: <declared>); "<name>" #<n> <from> → <to>
in <file>.` When `<to>` is `active` the notice appends ` — lanes may now open against #<n>.`

**Examples**

Against the same two-row fixture, with `"campaignAuthors": ["@usirin"]` and
`https://github.com/kamp-us/phoenix/issues/6289#issuecomment-5337663028` a comment by `usirin` whose
first line is `campaign-approve: #42 active · 2026-08-20T04:11:09Z`:

```
$ fabrika campaign state '#42' --to active --cites https://github.com/kamp-us/phoenix/issues/6289#issuecomment-5337663028
#42	active	Taste-Skill Library
```

```
$ fabrika campaign state 'fabrika everywhere' --to active --cites https://github.com/kamp-us/phoenix/issues/6289#issuecomment-5337663028
campaign state: "fabrika everywhere" #47 already holds active — NOTHING was written.
$ echo $?
20
```

**Grounding**

- ADR 0304 — the flip to `active` is the dispatch permission; resuming a paused campaign is that same
  flip.
- ADR 0055 — the ACL check is the verb's, and it fails closed.
- v1's `open-roadmap-pr.sh` hard-validated its state argument (`case "$STATE" in active|done`) and
  refused anything else; the closed value set survives, widened to the three ADR 0304 states.
- v1 paired closing the milestone with the flip to `done` and refused to flip over an open milestone.
  Here that check is `roadmap-guard`'s I5 and is **not** repeated: the skill states the expectation
  and the guard holds the verdict, per ADR 0238.
- v1's `git switch -c` was deliberately kept out of its scripts, because a script that branches
  mutates whichever checkout the caller happens to sit in. Nothing here branches, commits or pushes
  either.

---

## Considered and deliberately not derived

One entry per rejected proposal, so none is re-proposed from zero
([skill conventions §7](../../docs/skill-conventions.md#7-the-scope-law--recording-a-rejection)).

**A `campaign verify-trace` verb.** v1 shipped one, and the skill called it as a separate gate before
mutating. Folding the check into both write verbs removes the window where a caller verifies and then
writes something else — or verifies, is interrupted, and writes without checking again. There is
nothing a standalone verb answers that `--cites` does not answer at the moment it matters.

**A campaign drift or sync check.** `fabrika guard roadmap-guard check` already judges I1–I5 over the
same table and the live milestone projection, and it runs at CI. A second answer to a merge-gating
question can contradict the gate, which is worse than no answer at all — the reasoning that dropped
`adr classify` from the `/adr` contract, applied here.

**A "may a lane open against this milestone" verb.** `build/scope-admission.ts` is the fence, and ADR
0245's rule that one predicate answers both `build` seams is exactly what a second reader would
break. This skill writes the cell; the fence reads it.

**A milestone creator, and a wave-homing verb.** v1's campaign ritual created the milestone and then
PATCHed it onto every issue carrying the wave label. Creating a milestone is board work, and homing
issues onto one is `triage`'s (`triage homes`). Folding either in here would put two skills on one
board mutation.

**A priority normalizer.** v1's step 3 deleted `p0`/`p2` and posted `p1` on every open wave issue,
under ADR 0214. **ADR 0219 superseded that**: campaign membership confers a *home*, never a priority
band, and 0219 records the measured skew the old rule produced — all 19 open `p0`s were factory work
with zero product among them, and two sibling issues triaged six minutes apart came out `p1` and
`p0` from the same ADR. Priority is triage's band, set per issue. A campaign verb that re-priced a
milestone would re-seed exactly that skew.

**A `## Dependency graph` regenerator.** The mermaid block is generated content whose generator was
deleted with the v1 verb package (#6100); `ROADMAP.md` records that it is hand-maintained until a
fabrika verb owns it again. Writing half of that generator here — a node appended on `open`, a class
restyled on `state` — would put a second partial writer on a block that needs one whole one, and the
partial writer would look authoritative. The skill carries the node-id grammar and the author makes
the edit, until the generator is rebuilt.

**A wave-label-bound trace.** v1 bound approval to an audit wave's label and scanned every issue
carrying it for a marker. fabrika's campaigns are not audit waves — #46 and #47 carry no wave label —
so the wave is not an identifier this repo's campaigns have. The milestone number is, and ADR 0304
makes it the single link to the operational projection, so the marker binds to `#<milestone>` and the
caller cites the comment directly. That also deletes v1's whole scan, with its zero-scope refusal and
its "earliest founder approval wins" tie-break, neither of which has anything left to order.

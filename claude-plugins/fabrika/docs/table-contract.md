# `table` — derived CLI contract

The `table` group has no skill of its own, so this page is its contract: how each verb derives what
it writes, why each check exists and the conditions behind each exit. Caller facts — invocation,
flags, the answer shape, a one-line meaning per exit and an example — are in each leaf's `--help`,
which ends on a pointer to its section here, per the
[leaf help size and shape](interface-convention.md#leaf-help-size-and-shape) rule. Read one section
by its heading:

`fabrika wire doc-section --heading "table prep" < <plugin-root>/docs/table-contract.md`

The table is a GitHub project (Projects v2) per repository where control-plane owners decide what
gets bet on. Every verb here needs the token's `project` scope; a token without it exits `20`, whose
fix is `gh auth refresh -h github.com -s project`. `lane brief`, `lane record`, `build pick` and the
pitch guard read the table too; with no `table` block in `.fabrika.jsonc` they carry on when that
read fails.

## Readers outside the group

Four callers outside this group read the table. Any `table` block in `.fabrika.jsonc`, even one that
sets only the cadence, marks the table adopted, and adoption decides what a failed read does
(`src/table/adoption.ts`):

| Reader | Why it reads | A failed read, `table` block declared | A failed read, no `table` block |
|---|---|---|---|
| `lane brief` | the size stop (`src/table/size-stop.ts`) | exit `11`, UNKNOWN | briefs, printing `size stop NOT checked` |
| `build pick` | to offer bets first | exit `11`, UNKNOWN | keeps its own order |
| `lane record` | runs `table sync` after it posts | the record stands; the sync failure is reported | the same |
| `pitch-guard` | a `bet` row approves a pitch | approves nothing through the table | the same |

A missing `project` scope is one more failed read here, not the `20` this group's own verbs exit on.
A repository with no table project at all is never stopped by `lane brief`.

## table setup

Creates or reconciles the repository's betting table on GitHub Projects (v2).

**Finding the project.** With no `table` block in `.fabrika.jsonc` it finds the open project titled
`<repo name> table` linked to the repository, else under the repository's owner (and links it), else
creates one under the owner and links it. `table.project.owner` / `table.project.number` point it at
another.

**What it adds.** It then adds whatever the table lacks:

- the fields Stage, Section, Size, Spent $, Asks, Origin, Rec, In plain words and Outcome (worked,
  didn't, can't tell — a person's answer to a check);
- the Week iteration field, created with its first 12 weeks from the most recent table day, so a
  `table prep` right after finds the next table's week;
- the views Agenda, Outside the bets, Lanes, Group members and Inbox (filter `is:open no:label`),
  with their filters and visible fields;
- the README explaining the table and every column.

It never deletes or renames anything and never rewrites an existing field's options. It reports as
drift instead an option a field lacks, or one whose description differs from the table's, so a
changed `appetiteSizes` rewrites the README and names each stale Size option for a person to edit.
Idempotent: a project already in shape answers `unchanged` with nothing written.

**The on-call board.** With a `boards.onCall` block it then does the same for the on-call board: the
open project titled `<repo name> on-call` (or `boards.onCall.project`), with a Response target field
(one option per `boards.onCall.responseTargets` target) where the table has Size, an In plain words
field, a Queue view (`is:open`) and a README. With no `boards` block it touches one project and its
answer carries no `onCall` key.

stdout is `{"answer":"created"|"reconciled"|"unchanged","repo":"…","project":{"number":n,"title":"…","url":"…"},"changes":[…],"drift":[…],"manualSteps":[…],"onCall":{"answer":…,"project":{…},"changes":[…],"drift":[…],"manualSteps":[]}}`,
with `onCall` only under a `boards` block. stderr repeats the three manual steps GitHub's API cannot
take, which the README's by-hand section also lists: set the Agenda view's grouping to Section and
the Lanes board's columns to Stage; turn on the "Auto-add to project" workflow with filter
`is:issue is:open no:label`; and add the coming weeks under Week before the 12 planned ones run out.

### Exit status

- `7` — `table.project.number`, or `boards.onCall.project.number`, names no project under its owner.
  A refusal on the on-call board names it and says the table itself is set up.
- `8` — a write did not land. UNKNOWN; re-run to finish.
- `9` — the project does not read back as the table after the writes.
- `11` — the repository or project could not be read. UNKNOWN.
- `12` — the `table`, `appetiteSizes` or `boards` block in `.fabrika.jsonc` does not decode.
- `20` — the token lacks the `project` scope.
- `21` — a field the table needs exists under its name with another type; nothing was changed for
  it.
- `22` — two open projects linked to the repository, or two under its owner, carry the table's
  title. Set `table.project.number`.

## table sync

Joins the `lane-record` comments on the named issues (none: every issue already on the table) to the
table project, which `table setup` must have made. Sync never creates or links one.

**Groups.** It walks up from each issue to the rows that sum it (the epic it hangs under, what it
blocks) and down to each group row's members: an epic row stands for its open sub-issues, and a
chain row for its open `blocked_by` issues followed transitively, both read off the native graph each
run. An open issue with no row gets one: always a real issue item, never a draft, and never a closed
issue.

**What it writes per row.**

- Stage `in lane`, or `shipped` once a pull request its records name has merged, but only over an
  unset, `proposed`, `in lane` or `shipped` Stage. `bet`, `not now` and `check` are never
  overwritten.
- Origin, from the latest record.
- Spent $ and Asks, summed over each lane's latest record. A group head sums itself and its members,
  and a `bet` row counts only lanes ending at or after the moment its Stage became `bet`, starting
  at 0. Spent $ is left empty while any counted lane is unmeasured, and a figure already standing
  there is cleared, so no row reads a spend nobody measured.
- A group head with no Section, no `bet` Stage and at least one lane gets Section "Outside the
  bets"; a member's Section is cleared.

Idempotent: a second run answers `unchanged` with nothing written. `lane record` runs it for the
lane's issue after posting.

stdout is `{"answer":"synced"|"unchanged","repo":"…","project":{"number":n,"title":"…","url":"…"},"issues":[n…],"groups":[{"head":n,"kind":"epic"|"chain","members":[n…]}],"changes":[…],"skipped":[{"issue":n,"reason":"…"}]}`.

### Exit status

- `7` — no table project (run `table setup`), or a named number is no issue.
- `8` — a write did not land. UNKNOWN; re-run to finish.
- `9` — the rows do not read in step after the writes.
- `11` — the project, an issue, its comments or a pull request could not be read. UNKNOWN; also past
  2000 issues in one run.
- `12` — the `table` block in `.fabrika.jsonc` does not decode.
- `20` — the token lacks the `project` scope.
- `22` — two open projects carry the table's title. Set `table.project.number`.
- `23` — the project lacks a field or option sync writes. Run `table setup`.
- `24` — an issue carries a lane record that does not read.

## table flags

Reads the table and names what needs a person, each flag with a one-line rec. Read-only: it writes
no field and reverts no value.

**Row flags.** Per group row, judged once on the head over the sums of the head and every member
(the same sums `table sync` writes, and a `bet` row counts only lanes ending at or after it became
`bet`), and only while the head or a member is `bet` or `in lane`:

- `over-size` — Spent $ passes `table.flagMultiple` (1 shipped) times the Size's `appetiteSizes`
  dollars, where an epic row's size counts once per sub-issue. The lane keeps going, and the flag
  reads `stopped` at `table.stopMultiple` (2 shipped) times the size, where `lane brief` stops the
  lane (exit `71`, park cause `size-stop`). `flagMultiple` is at least 1, `stopMultiple` is above 1,
  and `flagMultiple` is below `stopMultiple`, or the `table` block does not decode (`12`). Spend is
  a floor: a row whose measured spend alone reaches the stop reads `stopped` even with an unmeasured
  lane. A row short of the stop on measured spend with an unmeasured lane is never stopped: the lane
  goes on and `lane brief` names the unmeasured lanes.
- `asks` — at `table.asksFlag` asks or more, whatever the size.
- `stuck` — nothing happened on any of the group's issues (a lane record ending, or the Stage being
  set) for `table.stuckDays` days, naming the wait or park it knows of. Never while a lane record
  declares a wait (`lane wait`) until a date still to come.

Per `bet` row: `unknown-decider`, when the account that set Stage `bet` is not in the control-plane
set `.github/CODEOWNERS` names. The bet stands as set.

**Table-wide checks.** With no issue named it also asks two:

- `campaigns` — ROADMAP's `## Campaigns` table has more `active` rows than
  `table.activeCampaignFlag`.
- `fabrika-share` — lanes on issues carrying a `table.fabrikaShare.labels` label took more of the
  current Week iteration's spend than `table.fabrikaShare.percent` for the first `forTables` tables,
  then `thenPercent`.

**The on-call board.** With a `boards.onCall` block the whole-table run also reads the on-call
board:

- `past-target` — per open on-call item whose Response target was set longer ago than the `hours` of
  that target (the target is set when the item arrives, so the wait counts from arrival), carrying
  `issue`.
- `on-call-share` — lanes on issues on the on-call board took more of the spend in the current Week
  iteration than `boards.onCall.spendShare` percent.

A check it could not answer — a lane unmeasured, a set or roadmap that would not read, no label
declared, no current iteration, an on-call board that would not read, an item with no target or one
the config no longer names — is named under `unread`, never passed.

stdout is `{"answer":"flagged"|"clear","repo":"…","project":{"number":n,"title":"…","url":"…"},"scope":"table"|"issues","rows":[n…],"flags":[{"flag":"over-size"|"asks"|"stuck"|"unknown-decider"|"campaigns"|"fabrika-share"|"past-target"|"on-call-share",…,"rec":"…"}],"unread":[{"check":"…","issue":n|null,"reason":"…"}]}`;
row flags carry `head`, `group` (`epic`|`chain`|`null`) and `covers`.

### Exit status

- `7` — no table project (run `table setup`), or a named number is no issue.
- `11` — the project, an issue or its comments could not be read. UNKNOWN.
- `12` — the `table`, `appetiteSizes` or `boards` block in `.fabrika.jsonc` does not decode.
- `20` — the token lacks the `project` scope.
- `22` — two open projects carry the table's title. Set `table.project.number`.
- `24` — an issue carries a lane record that does not read.

## table prep

Run before each table. It prepares the Week iteration the next table day (`table.day`) falls in,
which must already exist. `table setup` creates the Week field with its first 12 weeks; after those
run out, add the coming weeks under the Week field in the project's settings, because GitHub's API
adds an iteration only by rewriting the whole list, which empties every row's Week.

**Agenda.** It proposes up to `table.agendaCap` rows (25 by default) in `table.sections` order, each
a real, open issue, never a draft:

- Tails — running bets with a `table flags` row flag, then open sub-issues of closed epics;
- Customers — issues filed by someone whose `author_association` is not OWNER, MEMBER or
  COLLABORATOR, and only once triaged;
- New bets — `type:epic` issues with a pitch.

A row already `bet`, `not now`, `in lane`, `shipped` or `check` is never proposed again, except a
flagged running bet, which moves to Tails with its Stage and Size untouched. Each proposed row gets
Stage `proposed`, its Section, the Week, a Size (only when unset: an epic is L, otherwise the
smallest size covering its issues' pitch sizes, an unpitched issue counting as S), a Rec and an In
plain words line — the issue's `## In plain words` summary, else its title.

A candidate with open `blocked_by` issues is one chain row over them (followed transitively), and an
epic one row over its open sub-issues. The row counts once toward the cap, its Size and Rec cover
every issue in it, its members are added as rows with no Section so they show only in the Group
members view, and a chosen row a later chain covers moves inside it. A row where any issue carries
`ready-for:human` gets the Rec "needs your pick" with the options the issue lists (under an Options
heading, or as "Option A: …" lines), never "yes".

An untriaged Customers report (`status:needs-triage` or no label) is never proposed: it is listed
under `triageFirst` for the driver to triage and proposed on the next run, and one on
`status:needs-info` is listed there marked waiting on filer.

**Rollover.** Every other open `bet` row moves to the Week with its Rec cleared, so it continues
without an agenda row. A `proposed` row whose issue has closed is taken off the project.

**Checks.** A bet — a row whose Origin reads `bet` — whose Stage has read `shipped` for
`table.checkDelayDays` days (14 by default, timed from the Stage value's last change) moves to Stage
`check` under the first agenda section, in the Week, with a Rec asking "did it work?" and an In plain
words line, whatever its issue's state, and outside the agenda cap. A shipped row whose Origin is
anything else, such as an Outside the bets row sync moved to `shipped`, keeps its Stage and Section
and gets no comment. Its evidence is posted once as a comment on the issue:

- the pitch's `**Success:**` line, or a note that it has none;
- the GitHub signals since it shipped: issues filed since that mention a pull request its lane
  records name, revert pull requests referencing one, its issues reopened since, and its open
  sub-issues;
- fabrika's land rate and spend per lane in the delay before it shipped against since, when the
  issue carries a `table.fabrikaShare.labels` label;
- the standard output of each `table.evidenceSources` command, run as an argv in the repository root
  with PATH, HOME, LANG, LC_ALL, TZ and TMPDIR plus FABRIKA_CHECK_REPO, FABRIKA_CHECK_ISSUE,
  FABRIKA_CHECK_PRS and FABRIKA_CHECK_SHIPPED_AT, stopped at its `timeoutSeconds` and cut at 4000
  bytes. A source that exits non-zero, times out or cannot start is reported on the check and on
  stderr, and prep goes on.

A person answers on the Outcome field; prep never writes it and never re-asks a `check` row.

**Health.** It then posts one project status update: land rate, stale lanes, spend and the share of
lanes that needed a founder over the week before the iteration; the Outside the bets tally (running
un-bet lanes, their origins and cost); the bets continuing; and the Inbox count (open issues with no
labels). It reads `AT_RISK` while a row flag stands or any flag check could not be read — each such
check is named under "Could not check", and an on-call past-target count it could not read is said
in words, never as a number — else `ON_TRACK`. The update names its iteration; once it stands, a
re-run adds no row, carries nothing and posts nothing, and only takes closed `proposed` rows off.

**On-call.** With a `boards.onCall` block, every open issue `boards.onCall.route` sends to on-call
(the Origin on its table row, else `customer` when its filer only uses the product; any `type:` in
`route.types`; any label in `route.labels`) — except one whose table row reads `bet`, `not now` or
`check`, or a shipped bet this run brings back as a check — is never proposed at the table. It is
added to the on-call board (`table setup` must have made it) in issue order, with its Response target
set once, while unset, to the first `responseTargets.byLabel` target whose labels it carries, else
`otherwise`, and its In plain words line. This runs on every prep, the second one in an iteration
included. Its issues are left out of the Outside the bets tally, and the status update gains one
On-call section: open items, how many are past their target, and the share of the spend that week
that went to on-call, against `boards.onCall.spendShare`. An item past its target or spend over the
share makes the update `AT_RISK`.

The Agenda view shows this Week's rows with a Section and a Rec, open or closed so a check shows, so
run `table setup` once to align its filter.

stdout is `{"answer":"prepped"|"unchanged","repo":"…","project":{…},"iteration":{"id":"…","title":"…","startDate":"…"},"agenda":[{"issue":n,"section":"…","kind":"epic"|"chain"|null,"members":[n…],"size":"…","rec":"…","plainWords":"…"}],"overflow":[n…],"rollover":{"continuing":[n…],"flagged":[n…]},"removed":[n…],"checks":[{"issue":n,"shippedAt":"…","success":"…"|null,"signals":{"prs":[n…],"mentions":[…],"reverts":[…],"reopened":[n…],"followUps":[n…]},"fabrika":{…}|null,"sources":[…],"rec":"…","comment":"posted"|"standing"}],"triageFirst":[{"issue":n,"waitingOnFiler":bool}],"outside":{"count":n,"kinds":{…},"spentUsd":n,"unmeasured":n},"health":{"posted":bool,"alreadyPosted":bool,…},"changes":[…],"onCall":{"project":{…},"items":[{"issue":n,"target":"…"|null}],"pastTarget":[n…],"spend":{"_tag":"Measured","percent":n,"onCallUsd":n,"totalUsd":n}|{"_tag":"Unmeasured","lanes":n}|{"_tag":"Nothing"},"share":n,"changes":[…]}}`,
with `onCall` only under a `boards` block.

### Exit status

- `7` — no table project, or no on-call board with a `boards` block. Run `table setup`.
- `8` — a write, a check comment or the status update did not land. UNKNOWN; re-run to finish.
- `9` — the rows or the update do not read back after the writes.
- `11` — the project, the open issues, an issue, its comments, edges or timeline could not be read.
  UNKNOWN.
- `12` — the `table`, `appetiteSizes` or `boards` block in `.fabrika.jsonc` does not decode.
- `20` — the token lacks the `project` scope.
- `22` — two open projects carry the table's title. Set `table.project.number`.
- `23` — the table or the on-call board lacks a field or option prep writes. Run `table setup`.
- `24` — an issue carries a lane record that does not read.
- `25` — no Week iteration covers the next table day. Add the coming weeks in the project's
  settings.

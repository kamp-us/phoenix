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

**A row's table is its Table day.** Every row the table dates carries its table's day, `YYYY-MM-DD`,
in the `Table day` DATE field. Every week the verbs reason about is date math over that day: the
next table is the `table.day` weekday on or after today, the table in force is the one on or before
today, and a table's week is the 7 days that end where its day begins. Today is read in
`table.timeZone` (default `UTC`), because GitHub reads a view's `@today` in the viewer's zone, not
UTC: on a throwaway project at 2026-09-28T01:20Z, `table-day:@today` matched the row dated
2026-09-27, the Pacific day. Set `table.timeZone` to the zone the people at the table use, or on a
Saturday evening in California prep dates rows for the next Saturday while the Agenda view still
shows today's table. No week needs setting up ahead: a date field holds any day.

## Readers outside the group

Four callers outside this group read the table. Any `table` block in `.fabrika.jsonc`, even one that
sets only the cadence, marks the table adopted, and adoption decides what a failed read does
(`src/table/adoption.ts`):

| Reader | Why it reads | A failed read, `table` block declared | A failed read, no `table` block |
|---|---|---|---|
| `lane brief` | the size stop (`src/table/size-stop.ts`) | exit `11`, UNKNOWN; on a missing `project` scope, briefs, printing `size stop NOT checked` | briefs, printing `size stop NOT checked` |
| `build pick` | to offer bets first | exit `11`, UNKNOWN; on a missing `project` scope, keeps its own order | keeps its own order |
| `lane record` | runs `table sync` after it posts | the record stands; the sync failure is reported | the same |
| `pitch-guard` | a `bet` row approves a pitch | approves nothing through the table | the same |

A missing `project` scope degrades here instead of refusing, `table` block or not: the reader goes
on without the table and prints one stderr line naming `gh auth refresh -h github.com -s project`.
It is not the `20` this group's own verbs exit on. A token nobody refreshed is no real failure, so
only the other failed reads refuse.
A repository that declares no `table.project.number` and has no table project is never stopped by
`lane brief`. A declared `table.project.number` that names no project is a failed read with a
`table` block declared, so `lane brief` refuses at `11`.

## table setup

Creates or reconciles the repository's betting table on GitHub Projects (v2).

**Finding the project.** With no `table` block in `.fabrika.jsonc` it finds the open project titled
`<repo name> table` linked to the repository, else under the repository's owner (and links it), else
creates one under the owner and links it. `table.project.owner` / `table.project.number` point it at
another.

**What it adds.** It then adds whatever the table lacks:

- the fields Stage, Section, Size, Spent $, Asks, Origin, Rec, In plain words and Outcome (worked,
  didn't, can't tell — a person's answer to a check);
- the `Table day` DATE field;
- the views Agenda (filter `table-day:@today..@today+6d has:section -section:"Outside the bets"
  has:rec`, grouped by Section), Outside the bets, Lanes (a board in columns by Stage), Group members
  and Inbox (filter `is:open no:label`), with their filters and visible fields;
- fabrika's section of the README, explaining the table and every column.

**The README and short description stay a person's.** Setup owns only its own section of the
project README: the text between the lines `<!-- fabrika:table:start -->` and
`<!-- fabrika:table:end -->` (`fabrika:on-call:…` on the on-call board). GitHub hides HTML comments
when it renders Markdown, so a reader sees the section and not the markers. Setup keeps a person's
README text byte for byte, and each change line says which case it met:

- an empty README gets the marked section alone;
- a README holding the markers gets only the text between them replaced;
- a README fabrika wrote before sections existed, unmarked and exactly the text it would render, is
  replaced by the marked form, not appended to;
- any other README keeps its text as is, with the marked section appended below it.

Markers that are not one start line followed by one end line leave the README untouched and are
reported under `drift`. Setup writes the short description only when it is empty; one that differs
from the table's is reported under `drift` for a person to change by hand, never overwritten.

**Views are created over REST.** A missing view is created through
`POST /orgs/{login}/projectsV2/{number}/views` (or `/users/{login}/…` for a user's project), because
only REST takes a grouping on create: Agenda's `group_by` is Section and Lanes'
`vertical_group_by` is Stage. REST names fields by their numeric `databaseId`, which setup reads
with each field. A user's path takes the login; the numeric user id answers 404. A view that already
stands keeps the grouping it has: setup aligns its layout, filter and visible fields and never
regroups, recreates or deletes it.

**Options on a field that already stands.** Setup adds the options the table names and a
single-select field lacks, and fills each blank description of the table's options with the table's
text. A description a person wrote stays as written, even where it differs from the table's, so a
changed `appetiteSizes` rewrites fabrika's README section and leaves a written Size description alone. Neither is
reported as something for a person to fix: nothing is left to add by hand. GitHub replaces a field's
whole option list on update, and an option sent without its id loses every row's value on it, so
setup sends every option the field holds back with its own id, name, color and description, then
the new ones.

It never deletes, renames or recolors anything, and keeps an option the table does not name, such as
a `founder idea` on Origin. Idempotent: a project already in shape answers `unchanged` with nothing
written.

**The legacy Week field.** A table set up before Table day has a `Week` iteration field. Setup
leaves it exactly as it is and names it under `legacy`; the table no longer reads or writes it.
`table migrate-week` copies its dates into Table day once.

**The on-call board.** With a `boards.onCall` block it then does the same for the on-call board: the
open project titled `<repo name> on-call` (or `boards.onCall.project`), with a Response target field
(one option per `boards.onCall.responseTargets` target) where the table has Size, an In plain words
field, a Queue view (`is:open`) and a README. With no `boards` block it touches one project and its
answer carries no `onCall` key.

stdout is `{"answer":"created"|"reconciled"|"unchanged","repo":"…","project":{"number":n,"title":"…","url":"…"},"changes":[…],"drift":[…],"legacy":[…],"manualSteps":[…],"onCall":{"answer":…,"project":{…},"changes":[…],"drift":[…],"legacy":[],"manualSteps":[]}}`,
with `onCall` only under a `boards` block. stderr repeats the two manual steps, which the README's
by-hand section also lists: on an Agenda or Lanes view that stood before setup, set its grouping by
hand (Group by Section, Column by Stage); and turn on the "Auto-add to project" workflow with filter
`is:issue is:open no:label`, which GitHub's API cannot create.

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

A row whose Stage is `bet` is a member of no other row's group. An epic row leaves a `bet` sub-issue
out, and a chain stops at a `bet` blocker without following that blocker's own blockers. The `bet`
row keeps its Section and heads its own group, so its spend is counted once, on the bet, and the row
it blocks or hangs under does not sum it. `table prep`, `table flags` and pitch-guard's bet arm read
the same groups.

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

**Dry run.** `--dry-run` makes every read a live run makes and sends no write. Each write is
recorded and folded into what the later reads answer, so an issue added in the run reads back as a
row under a stand-in item id and its cells still plan. The answer is `dry-run` with `changes` empty
and a `planned` list of every write in the order a live run would send it:
`{"_tag":"Add","project":n,"issue":n}`, `{"_tag":"Set","project":n,"issue":n,"field":"…","value":"…"|n}`
or `{"_tag":"Clear","project":n,"issue":n,"field":"…"}`. The exit is `0` once the plan is built; a
read that fails keeps its code.

stdout is `{"answer":"synced"|"unchanged"|"dry-run","repo":"…","project":{"number":n,"title":"…","url":"…"},"issues":[n…],"groups":[{"head":n,"kind":"epic"|"chain","members":[n…]}],"changes":[…],"skipped":[{"issue":n,"reason":"…"}]}`,
plus `planned` under `--dry-run`.

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

Per row, live or not: `not-rendered`, when a lane on one of the group's issues last passed a review
namespace on a route the repo's `reviewUi.whenNoPreview` rules admitted rather than on a render —
an owner's hand-check or a skip. It carries `issue`, `namespace`, `basis` (`hand-check`|`skip`) and
`pr`. It reads the `routedBasis` field `lane report` writes on the proven `PASS` line; per task the
newest `PASS` decides, so a later rendered pass clears it. A lane log line that does not parse is
named under `unread` as `not-rendered`.

**Table-wide checks.** With no issue named it also asks two:

- `campaigns` — ROADMAP's `## Campaigns` table has more `active` rows than
  `table.activeCampaignFlag`.
- `fabrika-share` — lanes on issues carrying a `table.fabrikaShare.labels` label took more of the
  spend in the 7 days ending at the next table day than `table.fabrikaShare.percent` for the first
  `forTables` tables, then `thenPercent`. Which table that is counts the distinct Table day dates on
  the board before it, plus one: a count needs no config and survives the migration, whose rows
  carry their old weeks' dates. An empty `table.fabrikaShare.labels`, the shipped default, turns
  this check off: it raises no flag and is never named under `unread`.

**The on-call board.** With a `boards.onCall` block the whole-table run also reads the on-call
board:

- `past-target` — per open on-call item that has waited longer than the `hours` of the target its
  labels pick now (the first `responseTargets.byLabel` target whose labels it carries, else
  `otherwise`), carrying `issue`, `target`, `hours`, `since` and `waitedHours`. The wait counts from
  the issue's creation, or from the on-call board's creation for an issue filed before the board
  existed, so a new board does not open with its whole backlog late. Neither fact is read off the
  Response target cell: a relabel moves the target on the next run, and no verb's schedule moves the
  clock.
- `on-call-share` — lanes on issues on the on-call board took more of the spend in the same 7 days
  than `boards.onCall.spendShare` percent.

A check it could not answer — a lane unmeasured, a set, roadmap or label that would not read, an
on-call board or open-issue list that would not read — is named under `unread`, never passed. A
check the config turns off is neither.

stdout is `{"answer":"flagged"|"clear","repo":"…","project":{"number":n,"title":"…","url":"…"},"scope":"table"|"issues","rows":[n…],"flags":[{"flag":"over-size"|"asks"|"stuck"|"unknown-decider"|"not-rendered"|"campaigns"|"fabrika-share"|"past-target"|"on-call-share",…,"rec":"…"}],"unread":[{"check":"…","issue":n|null,"reason":"…"}]}`;
row flags carry `head`, `group` (`epic`|`chain`|`null`) and `covers`.

### Exit status

- `7` — no table project (run `table setup`), or a named number is no issue.
- `11` — the project, an issue or its comments could not be read. UNKNOWN.
- `12` — the `table`, `appetiteSizes` or `boards` block in `.fabrika.jsonc` does not decode.
- `20` — the token lacks the `project` scope.
- `22` — two open projects carry the table's title. Set `table.project.number`.
- `24` — an issue carries a lane record that does not read.

## table prep

Run before each table. It prepares the next table: the `table.day` weekday on or after today in
`table.timeZone`. Every row it writes is dated with that day in Table day, so nothing needs setting
up ahead of it.

**Agenda.** It proposes up to `table.agendaCap` rows (25 by default) in `table.sections` order, each
a real, open issue, never a draft:

- Tails — running bets with a `table flags` row flag, then ruled issues nobody has built (oldest
  ruling first), then open sub-issues of closed epics. A ruled issue is an open `type:decision`
  carrying `ready-for:agent` and a `decision-ruled` marker from an account on the control-plane
  roster; its Rec reads "yes: you ruled on it YYYY-MM-DD and it is not built yet.";
- Customers — issues filed by someone whose `author_association` is not OWNER, MEMBER or
  COLLABORATOR, and only once triaged;
- New bets — `type:epic` issues with a pitch.

A row already `bet`, `not now`, `in lane`, `shipped` or `check` is never proposed again, except a
flagged running bet, which moves to Tails with its Stage and Size untouched. Each proposed row gets
Stage `proposed`, its Section, the table's Table day, a Size (only when unset: an epic is L,
otherwise the smallest size covering its issues' pitch sizes, an unpitched issue counting as S), a
Rec (only into an empty cell; see **Rec**) and an In plain words line — the issue's
`## In plain words` summary, else its title.

A candidate with open `blocked_by` issues is one chain row over them (followed transitively), and an
epic one row over its open sub-issues. The row counts once toward the cap, its Size and Rec cover
every issue in it, its members are added as rows with no Section so they show only in the Group
members view, and a chosen row a later chain covers moves inside it. A `bet` row is never such a
member (see **Groups** under `table sync`), so prep leaves its Section as it reads. For a row where
any issue carries `ready-for:human`, the Rec prep writes into an empty cell is "needs your pick"
with the options the issue lists (under an Options heading, or as "Option A: …" lines), never "yes";
a Rec the row already holds stays as it reads (see **Rec**).

An untriaged Customers report (`status:needs-triage` or no label) is never proposed: it is listed
under `triageFirst` for the driver to triage and proposed on the next run, and one on
`status:needs-info` is listed there marked waiting on filer.

**Rollover.** Every other open `bet` row is dated the next table, so it continues without an agenda
row, and its Rec is left as it reads. A `proposed` row whose issue has closed is taken off the
project.

**Rec.** Prep writes Rec only into an empty cell. The board cannot say whose text a Rec holds, so
prep never clears a non-empty Rec and never replaces one, on an agenda, rollover or check row alike.
Each row whose Rec it left and that differs from what prep would write is listed under `recsKept`
with the text it holds and prep's own (`null` on a carried bet) and named on stderr. A Rec prep
wrote for an earlier table stays too, until a person clears it.

**Checks.** A bet — a row whose Origin reads `bet` — whose Stage has read `shipped` for
`table.checkDelayDays` days (14 by default, timed from the Stage value's last change) moves to Stage
`check` under the first agenda section, dated the next table, with a Rec asking "did it work?" (into
an empty Rec) and an In plain words line, whatever its issue's state, and outside the agenda cap. A
shipped row whose Origin is anything else, such as an Outside the bets row sync moved to `shipped`,
keeps its Stage and Section and gets no comment. Its evidence is posted once as a comment on the
issue:

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
lanes that needed a founder over the 7 days before the table day; the Outside the bets tally (running
un-bet lanes, their origins and cost); the bets continuing; the Inbox count (open issues with no
labels); and every ruled issue nobody has built, oldest ruling first with its ruling date, so one the
agenda cap left off is still named. It reads `AT_RISK` while a row flag stands or any flag check could not be read — each such
check is named under "Could not check", and an on-call past-target count it could not read is said
in words, never as a number — else `ON_TRACK`. Prep asks neither table-wide check, `campaigns` nor
`fabrika-share`, so neither is named there, and an empty `table.fabrikaShare.labels` turns the
share check off everywhere. The update names its table day in a
`<!-- fabrika:table-health table-day=YYYY-MM-DD -->` marker; once one stands for that day, a re-run
adds no row, carries nothing and posts nothing, and only takes closed `proposed` rows off. A row
already dated that day is left as it reads, so a re-run writes no Table day.

**On-call.** With a `boards.onCall` block, every open issue [`table route`](#table-route) sends to
on-call is never proposed at the table, and its table row stays as it reads. Prep writes nothing
to the on-call board and takes no routed row off: it reads the board, and placing the issues and
taking their rows off is route's, so an issue routed by its row's Origin is never on neither board.
Those issues are left out of the Outside the bets tally, and the status update gains one
On-call section: the open items (those on the board and those route has yet to place), how many are
past their target, timed the way [`past-target`](#table-flags) times them, and the share of the
spend that week that went to on-call, against `boards.onCall.spendShare`. An item past its target or
spend over the share makes the update `AT_RISK`.

The Agenda view shows the rows dated today through six days on (`table-day:@today..@today+6d`),
which is the next table's, with a Section and a Rec, open or closed so a check shows. `@current`
matches only iteration fields, so a date needs the range. Run `table setup` once to align the filter
of an Agenda view that stood before.

**Dry run.** `--dry-run` runs every phase over a board that records its writes, the same way
[`table sync --dry-run`](#table-sync) does, so the cells of a row added in the run, the checks and
the status update all plan. The answer is `dry-run`; `changes` are empty, `health.posted` is false,
a check's `comment` reads `planned`, and `planned` lists every write: sync's three kinds plus
`{"_tag":"Delete","project":n,"issue":n}`, `{"_tag":"Comment","issue":n,"body":"…"}` and
`{"_tag":"Post","project":n,"status":"…","body":"…"}`. The exit is `0` once the plan is built; a read
that fails keeps its code.

stdout is `{"answer":"prepped"|"unchanged"|"dry-run","repo":"…","project":{…},"tableDay":"YYYY-MM-DD","agenda":[{"issue":n,"section":"…","kind":"epic"|"chain"|null,"members":[n…],"size":"…","rec":"…","plainWords":"…"}],"overflow":[n…],"rollover":{"continuing":[n…],"flagged":[n…]},"removed":[n…],"checks":[{"issue":n,"shippedAt":"…","success":"…"|null,"signals":{"prs":[n…],"mentions":[…],"reverts":[…],"reopened":[n…],"followUps":[n…]},"fabrika":{…}|null,"sources":[…],"rec":"…","comment":"posted"|"standing"|"planned"}],"triageFirst":[{"issue":n,"waitingOnFiler":bool}],"outside":{"count":n,"kinds":{…},"spentUsd":n,"unmeasured":n},"health":{"posted":bool,"alreadyPosted":bool,…},"recsKept":[{"issue":n,"rec":"…","wanted":"…"|null}],"changes":[…],"onCall":{"project":{…},"items":[{"issue":n,"target":"…"}],"pastTarget":[n…],"spend":{"_tag":"Measured","percent":n,"onCallUsd":n,"totalUsd":n}|{"_tag":"Unmeasured","lanes":n}|{"_tag":"Nothing"},"share":n}}`,
with `onCall` only under a `boards` block and `planned` only under `--dry-run`. An agenda row's
`rec` is the Rec the row holds after prep, a kept one included.

### Exit status

- `7` — no table project, or no on-call board with a `boards` block. Run `table setup`.
- `8` — a write, a check comment or the status update did not land. UNKNOWN; re-run to finish.
- `9` — the rows or the update do not read back after the writes.
- `11` — the project, the open issues, an issue, its comments, edges or timeline could not be read,
  or the control-plane roster could not be read while a ruled issue needed it. UNKNOWN.
- `12` — the `table`, `appetiteSizes` or `boards` block in `.fabrika.jsonc` does not decode.
- `20` — the token lacks the `project` scope.
- `22` — two open projects carry the table's title. Set `table.project.number`.
- `23` — the table lacks a field or option prep writes, the Table day field included. Run
  `table setup`.
- `24` — an issue carries a lane record that does not read.

## table route

Run as often as on-call needs: it closes no agenda, dates no row and posts no update, so a daily or
hourly run never moves the table. With a `boards.onCall` block, every open issue
`boards.onCall.route` sends to on-call (the Origin on its table row, else `customer` when its filer
only uses the product; any `type:` in `route.types`; any label in `route.labels`) goes to the
on-call board, except one whose table row reads `bet`, `not now` or `check`, a member of a group
whose head reads one, or a bet shipped long enough ago that prep brings it back as a check. These
are the same issues prep leaves off the agenda, read by the same rule.

Each one is added to the on-call board (`table setup` must have made it) in issue order, with the
Response target its labels pick now (the first `responseTargets.byLabel` target whose labels it
carries, else `otherwise`) and its In plain words line. A relabel rewrites the target on the next
run. The cell shows the target; [`past-target`](#table-flags) never reads it. The on-call board is
written first and the table second: each routed issue's table row is taken off, so a run that stops
between the two leaves an issue on both boards, never on neither.

The writes run like prep's: adds, a re-read, the cells, and a last read whose plan must be empty, so
a second run over the same issues writes nothing and answers `unchanged`. With no `boards` block
there is no on-call board: it reads nothing from GitHub and answers `unchanged` with `onCall`
`null`.

**Dry run.** `--dry-run` runs both boards over a board that records its writes, the same way
[`table sync --dry-run`](#table-sync) does, so the cells of an issue added to the on-call board in
the run still plan and the table's last read folds the rows it planned to take off. The answer is
`dry-run`; `changes` are empty, and `planned` lists every write in the order a live run would send
it: the on-call `{"_tag":"Add","project":n,"issue":n}`s, then the Response target and In plain words
`{"_tag":"Set","project":n,"issue":n,"field":"…","value":"…"}`s, then the table's
`{"_tag":"Delete","project":n,"issue":n}`s. With no `boards` block `planned` is empty. The exit is
`0` once the plan is built; a read that fails keeps its code.

stdout is `{"answer":"routed"|"unchanged"|"dry-run","repo":"…","onCall":{"number":n,"title":"…","url":"…"}|null,"routed":[n…],"changes":[…]}`,
plus `planned` under `--dry-run`.

### Exit status

- `7` — no table project, or no on-call board with a `boards` block. Run `table setup`.
- `8` — a write did not land. UNKNOWN; re-run to finish.
- `9` — the rows do not read back in step after the writes.
- `11` — the project, the open issues, an issue or its comments or edges could not be read. UNKNOWN.
- `12` — the `table` or `boards` block in `.fabrika.jsonc` does not decode.
- `20` — the token lacks the `project` scope.
- `22` — two open projects carry the table's title. Set `table.project.number`.
- `23` — the on-call board lacks the Response target field, one of its options, or the In plain
  words field. Run `table setup`.
- `24` — an issue carries a lane record that does not read.

## table migrate-week

Run once, on a table set up with the `Week` iteration field, after `table setup` has added Table
day. It dates every row whose Week cell names an iteration and whose Table day is empty with that
iteration's start date: an iteration starts on its table's day, so the start is the row's table. A
row already dated is left as it is, since prep or a person dated it after Week stopped mattering, so
a second run writes nothing. A row in an iteration the field no longer lists is left undated and
named under `unresolved`.

It reads the Week field and each item, and its only write is an item's Table day value. It never
writes an iteration field: GitHub's API changes one only by rewriting its whole iteration list,
which empties every row's Week. A table with no Week field answers `unchanged`.

stdout is `{"answer":"migrated"|"unchanged","repo":"…","project":{"number":n,"title":"…","url":"…"},"dated":[{"issue":n|null,"tableDay":"YYYY-MM-DD"}],"unresolved":[{"issue":n|null,"iteration":"…"}]}`.

### Exit status

- `7` — no table project. Run `table setup`.
- `8` — a write did not land. UNKNOWN; re-run to finish.
- `9` — a row dated this run does not read back dated.
- `11` — the project, its Week field or its items could not be read. UNKNOWN.
- `12` — the `table` block in `.fabrika.jsonc` does not decode.
- `20` — the token lacks the `project` scope.
- `22` — two open projects carry the table's title. Set `table.project.number`.
- `23` — the project has no Table day date field. Run `table setup`.

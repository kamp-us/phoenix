# Adopt fabrika in a repo you already have

Steps to get fabrika running on an existing repo — one with a board, a history and its own
conventions. Everything below is what the verbs do at the commit this page was written against; each
step names the file or issue the claim was read from, and the two steps that hit an open bug say what
to do about it today.

If you have never run fabrika at all, do [`getting-started.md`](getting-started.md) first on a repo
you do not mind experimenting on. This page assumes you know what the stages are.

## 1. Install

The tool is one global install; the skills are a Claude Code plugin.

```bash
pnpm add --global @kampus/fabrika-cli
```

```
/plugin marketplace update kampus
/plugin install fabrika@kampus
```

**You do not need `@kampus/fabrika-cli` in your repo's own `package.json`.** A repo-local install
pins the version and is worth having for that reason, but a repo without one is not broken: the
global runs and prints a warning naming both versions. The one invocation that refuses outright is a
copy run from a *different* repository's checkout. The whole resolution table is in
[`delegation.md`](delegation.md); do not reason about it from first principles, the outcomes are
non-obvious.

## 2. Find out what your repo is missing

```bash
fabrika status settings --surfaces
```

Every key on the config surface lists with its resolved value and whether that came from your file or
the shipped default; `--surfaces` expands `surfaceDispositions` into one row per repo surface, each
naming what the surface *is* — without it that key prints as one raw id-to-word value. Each row's
disposition is what a missing surface costs you: `fail-loud` makes a verb refuse and name the
surface, `degrade` continues with a narrower answer and says so, and `bootstrap` marks a surface you
have not adopted yet — those are the ones the CLI can create for you, which is step 3. The registry
itself,
[`packages/fabrika-cli/src/config/keys/surface-dispositions.ts`](../../../packages/fabrika-cli/src/config/keys/surface-dispositions.ts),
says in one line what each surface is.

**A `read-back conformed` from `status bootstrap` means one surface landed — it does not mean the
setup is finished**, and nothing in that verb's output says so.

The dispositions are yours to change: a repo that runs no design system declares
`"surfaceDispositions": {"design-manifest": "degrade"}` and stops being told to build one; every key
you do not name keeps its shipped value.

## 3. Create the surfaces the CLI can create

Nine surface ids are buildable today. Read them off the verb rather than off any prose:

```bash
fabrika status bootstrap --help
```

```
surface-id string    one id from the buildable-surface registry: design-manifest, roadmap-focus, gitignore-row, claude-md-section, label-taxonomy, issue-shape-markers, readout-artifact, settings-patch, dep-pin
```

The registry is `BUILDABLE_SURFACES` in
[`packages/fabrika-cli/src/status/bootstrap-verb.ts`](../../../packages/fabrika-cli/src/status/bootstrap-verb.ts).
One id per invocation; a target already present is `exists` at exit 0 and nothing is written or
overwritten. `design-manifest` and `roadmap-focus` take their content on stdin. `gitignore-row`
and `claude-md-section` append their own row/block and read no stdin. `settings-patch` merges the
`kampus` marketplace registration and the `fabrika@kampus` flip into a `.claude/settings.json`
that is already there — unknown keys preserved, unparseable bytes refused unwritten — and creates
the file when it is absent; it reads no stdin either way. `dep-pin` pins the `@kampus/fabrika-cli`
dependency row to the version npm's registry publishes at run time — same merge law over the
repo's `package.json`, an unreachable registry refused unwritten — and prints the exact install
command; it never runs a package manager or touches a lockfile. `label-taxonomy`,
`issue-shape-markers` and `readout-artifact` write to GitHub and need a resolvable repo —
`--repo`, `$CLAUDE_PIPELINE_REPO`, `$GITHUB_REPOSITORY`, or an `origin` remote.

## 4. Create the labels

```bash
fabrika status bootstrap label-taxonomy
fabrika status bootstrap issue-shape-markers
```

Both sets are derived, not listed here: `TAXONOMY` in
[`bootstrap-verb.ts`](../../../packages/fabrika-cli/src/status/bootstrap-verb.ts) composes the label
vocabularies and widens on its own when one grows, and `issue-shape-markers` adds the shape markers
declared beside it in the same file.

Where some labels are present the verb creates only the missing ones and reports what it created;
a label already there under another colour is left alone.

## 5. Ignore fabrika's run state

fabrika writes a per-run ledger into your working tree: `.fabrika/lanes/<n>/` for an issue lane and
`.fabrika/chores/` for a chore lane, each holding a `workflow.json` and an `events.jsonl`
([`packages/fabrika-cli/src/lane/key.ts`](../../../packages/fabrika-cli/src/lane/key.ts)). That is
one machine's log and never belongs in shared history.

```bash
fabrika status bootstrap gitignore-row
```

It appends its own block to `.gitignore` and rewrites nothing already there; the collision guard is
the row `/.fabrika/` appearing anywhere in the file, so a row you added by hand with the same
spelling reads as `exists`. Commit the change before running a lane.

## 6. Write a `ROADMAP.md`

**Write one even though the config calls it optional.** `roadmapFile` resolves to `ROADMAP.md`
unless you say otherwise, and an absent file means no arc and no campaign is declared.

An absent roadmap does not stop you — `triage homes` degrades on it — but without the file nothing
homes to an arc, so writing it is a first-triage quality step, not a blocker.

The grammar is a parse contract, not a convention
([`packages/fabrika-cli/src/triage/roadmap.ts`](../../../packages/fabrika-cli/src/triage/roadmap.ts)),
and two facts carry this recipe: headings exactly `## Arcs` and `## Campaigns`, and each row's second
cell naming the pinned milestone as `#<number>` — the arc's name is never matched on. Zero campaign
rows is legal and zero arc rows refuses. A campaign row groups work under a theme and a milestone;
its `State` cell says whether the theme is being worked, and it never refuses a lane.

Draft it and hand it to the verb, which reports what its own parser joined out of the bytes it wrote:

```bash
fabrika status bootstrap roadmap-focus <<'EOF'
## Arcs

| Arc | Milestone | State |
|---|---|---|
| First arc | #1 | active |
EOF
```

```
status bootstrap: created ROADMAP.md for roadmap-focus, read-back conformed — 1 arc, 0 campaigns.
```

`0 arcs` there means the table did not parse. Fix it before moving on, or the join is silently
empty.

## 7. Open at least one milestone

`triage homes` offers only **open** milestones joined to a roadmap row, and zero open milestones is a
refusal (exit 7), not an empty answer. It creates none — curating the milestone set is a human act.
Open one on GitHub, then pin it from a `## Arcs` row by its number.

```bash
fabrika triage homes
```

Your milestone should appear as a `milestone` row. If it does not, the roadmap row's second cell does
not match `^#(\d+)$`.

## 8. The `lane` rows, if you get any

`triage homes` also prints a `lane` row per **standing lane** — a label that is a home in its own
right, for work no milestone owns. You get one only where your repo both declares the lane and
carries its label. A fresh repo declares both — the CLI ships a pair of defaults — but carries
neither label, so you get none, and stderr says so:

```
triage homes: standing lanes: 0 of 2 declared carry a label in you/your-repo — not offered: wayfinder:backlog, axis:pipeline-hardening.
```

That is the correct answer, not a gap to fix. Home everything to a milestone and skip `--lane`.

If you do want a standing lane: create the label on your board, then declare it under
`boardVocabulary.standingLanes` in `.fabrika.jsonc` (next section). Both halves are required — a
declared lane whose label does not exist is not offered, which is what stops `triage apply --lane`
from failing a write at the end of a full triage run.

If you want none at all, say so: `"standingLanes": []` under `boardVocabulary`. Then `triage homes`
reads no labels, offers no lane, and prints `standing lanes: this repo declares none.` — every issue
homes on a milestone, and `triage apply --lane` refuses. Leaving the key out is a different answer:
it falls to the shipped pair, which then gets filtered against your board.

Standing lanes come from your repo, never from a CLI literal. The shipped default is still there
until a later change evicts it, and it reaches no board that has not created the labels, so the
empty declaration above is how you opt out of it entirely.

## 9. Add the config file

`.fabrika.jsonc` at your repo root carries the keys the CLI reads — one `register(...)` line per key
in
[`packages/fabrika-cli/src/config/registry.ts`](../../../packages/fabrika-cli/src/config/registry.ts).
Every key is fail-closed — an absent file, an absent key, an empty array and a malformed entry all
give the narrowest behaviour, never the permissive one — and a key you leave out falls back to the
shipped default, which is what every repo ran on before these keys existed.

Add the file only when a default does not fit your repo. The repo that authors fabrika keeps its own
`.fabrika.jsonc` as the worked example, with the reasoning for each value in comments.

## 10. Re-run the front door

```bash
fabrika status open
```

Six fields: the installed skill roster, what this repo declares from step 2, whether the plugin
carrying the skills is enabled here, your board's counts, the decision digest, and any lanes on this
machine.

**Read the `wiring` field first.** It is the only one that answers about the plugin rather than
about something the CLI reads, so it is the only one that catches a repo where every verb answers
and no fabrika skill can load in a session. `unwired` means `.claude/settings.json` does not enable
`fabrika@<marketplace>`, and until it does nothing in this guide's pipeline can start.
`status bootstrap settings-patch` is the remedy: it merges the marketplace registration and the flip
into a settings file that is already there, and creates the file whole when it is absent.

The `readout` field reads `absent` with the detail
`no readout artifact` until you run `fabrika status bootstrap readout-artifact`, which opens the
durable issue the digest is upserted into, and then `absent` with `no digest block` until
`fabrika governance readout` writes one. Both are facts, not failed reads.

Then file something with `/fabrika:report`, triage it with `/fabrika:triage`, and you are running.

## 11. Set up the betting table

The table is a GitHub project where your control-plane owners decide what fabrika bets on. It works
with no config: `fabrika table setup` looks for an open project titled `<repo name> table`, first
among the projects linked to your repo, then among all of the repo owner's projects. It reuses the
one it finds and links it to your repo if it isn't already. If there is none, it creates one under
the repo's owner and links it. It adds the fields, the
weekly iteration, the five views (Agenda, Outside the bets, Lanes, Group members and Inbox) and a
README that explains every column. Run it again any time: a project already in shape answers
`unchanged` and nothing is written.

```bash
fabrika table setup
```

**The token needs the `project` scope.** GitHub Projects (v2) refuses a token without it, and
`table setup` stops with this fix:

```bash
gh auth refresh -h github.com -s project
```

Use that exact line. A plain `gh auth refresh` fails in a non-interactive shell. With `GITHUB_TOKEN`
or `GH_TOKEN` set, give that token the scope instead. Only the `table` verbs need it.

**Two steps are yours, once.** GitHub's API cannot take them, so setup prints both and the project
README's "One-time setup" section lists them:

1. Grouping: in the Agenda view, set *Group by: Section* and save the view; in the Lanes view, set
   *Column by: Stage* and save it.
2. Inbox auto-add: in the project's **Workflows**, turn on *Auto-add to project* for your repo with
   the filter `is:issue is:open no:label`, and save it. Every issue nobody labeled then lands in the
   Inbox view (filtered `is:open no:label`), so nothing sits where triage can't see it.

To tune the table, add a `table` block to `.fabrika.jsonc`: cadence and day, the agenda sections and
their order, the agenda cap and every flag threshold. Leave out what you don't change. The size
dollars are not in that block: set them in `appetiteSizes`, the key pitch-guard reads. A new Size
field and the project README then show the same amounts your pitches are approved against. If you
change `appetiteSizes` after the Size field exists, re-run setup: it rewrites the README but never
an existing field's options, so it prints a `drift:` line naming each Size option whose description
still shows the old amount. Edit those descriptions by hand in the field's settings. To point
setup at a project you already have, set `table.project.number` (and `table.project.owner` if it
lives under another account). `fabrika config schema` documents each key.

**The columns fill themselves.** When a lane ends, `fabrika lane record` posts its record to the
issue and then runs `fabrika table sync` for it. Sync adds the issue as a row if it has none, sets
Stage to `in lane` (or `shipped` once its pull request merged), and fills Asks and Origin from the
records. Spent $ stays empty while any lane it counts has no measured spend, which is every lane until
a rate card exists. It never changes a Stage of `bet`, `not now` or `check`. A lane nobody bet on,
with no Section yet, lands under Outside the bets; a row already under another Section keeps it. An
epic, or a row with open blockers, shows as one group row that sums its members; the members show
only in the Group members view. Run `fabrika table sync` with no issue to refresh every row.

**Flags bring work back to the table; nothing refuses it.** `fabrika table flags` reads the table and
names what needs a person, each with a one-line rec. A live row is flagged when it spends past its
size, reaches the asks threshold, or goes quiet for the stuck days (a lane that ran `lane wait` is
left alone until its date). A `bet` set by someone outside the CODEOWNERS control-plane set is
flagged and left as set. The whole-table run also flags more active campaigns than the cap, and
fabrika's own work taking more than its share of the week's spend. That share counts only issues
carrying a label you name in `table.fabrikaShare.labels`, so it stays unread until you name one.
The one stop: a lane whose row has spent `table.stopMultiple` times its size (2 by default) gets no
next shell. `lane brief` refuses at exit 71 and the driver parks the lane with cause `size-stop`.
The stop needs the `project` scope on the driver's token. Without it, a repo whose `.fabrika.jsonc`
has no `table` block is not stopped: `lane brief` goes on and prints `size stop NOT checked`. Once
you declare `table.project.number`, a missing scope refuses the brief at 11 instead.

**Prep fills the agenda before each table.** Run `fabrika table prep` before the table meets. It
readies the Week iteration your next table day falls in. That iteration must already exist, so keep
the coming weeks added under the Week field in the project's settings: GitHub's API can only add one
by rewriting the whole list, which empties every row's Week, so prep stops at exit 25 instead. Prep
proposes up to `table.agendaCap` rows (25 by default), section by section: Tails, Customers, then
New bets. Every row is a real, open issue with a Size, a Rec and an In plain words line taken from
the summary triage writes. A row with open blockers comes as one chain row with them. A row that
waits on a ruling reads "needs your pick" with its options. A customer report nobody triaged is
listed for triage first instead of proposed. Running bets move into the new week: a flagged one
comes back under Tails, the rest keep going with no agenda row. Prep then posts the week's health as
the project's status update, Inbox count included. Once that update stands, a second run adds
nothing. The Agenda view shows only rows with a Rec, so re-run `fabrika table setup` once after
upgrading to align its filter.

**Shipped bets come back as checks.** When prep runs, a bet that has been `shipped` for
`table.checkDelayDays` days (14 by default) moves to Stage `check` on the agenda. Prep counts a row
as a bet only when its Origin reads `bet`. Sync rewrites Origin from the latest lane record, so
boot a bet's lane with `--origin bet` (`fabrika lane open` and `fabrika lane emit` both take it).
Sync never moves a `bet` row forward, so set its Stage to `shipped` yourself once its work has
merged. A row that ran without a bet, such as one under Outside the bets that sync moved to
`shipped`, stays as it is and gets no check. Prep posts its evidence as a comment on the issue: the pitch's `**Success:**` line, what happened on GitHub since
(new issues mentioning its pull requests, reverts, reopens, open follow-ups), and fabrika's land rate
and spend before and after it shipped when the issue carries a `table.fabrikaShare.labels` label.
Answer on the row's Outcome field: `worked`, `didn't` or `can't tell`. Prep never changes that answer
and never asks again. To attach your own numbers, declare commands under `table.evidenceSources`:

```jsonc
{
  "table": {
    "evidenceSources": [
      {"name": "error rate", "command": ["pnpm", "metrics:errors"], "timeoutSeconds": 30}
    ]
  }
}
```

Each command runs in the repo root as an argv, not through a shell. It gets only PATH, HOME, LANG,
LC_ALL, TZ and TMPDIR, plus `FABRIKA_CHECK_REPO`, `FABRIKA_CHECK_ISSUE`, `FABRIKA_CHECK_PRS` and
`FABRIKA_CHECK_SHIPPED_AT`. Its output is attached to the check as text, cut at 4000 bytes. A
command that fails, times out or cannot start is reported on the check, and prep goes on. The
Outcome field is new, so re-run `fabrika table setup` once after upgrading to add it.

**Split off an on-call board if you want one.** With no `boards` block there is one board: the
table, with its Customers section. Declare `"boards": {"onCall": {}}` and the work splits in two.
The table stays the product board. A second project, `<repo name> on-call`, holds continuous work
such as customer reports, crashes and CI breakage. Nothing there is bet on; it is pulled in the
order it arrives. `boards.onCall.route` decides which board an issue lands on: an issue whose
origin, `type:` label or any label matches goes to on-call, and everything else stays on the table.
By default that is origin `customer` or type `bug`. An issue whose table row reads `bet`, `not now`
or `check` stays on the table whatever the rule says.

```jsonc
{
  "boards": {
    "onCall": {
      "route": {"origins": ["customer"], "types": ["bug"], "labels": ["ci-broken"]},
      "responseTargets": {
        "byLabel": [{"name": "same day", "hours": 24, "labels": ["p0"]}],
        "otherwise": {"name": "this week", "hours": 168}
      },
      "spendShare": 20
    }
  }
}
```

Re-run `fabrika table setup` to create the on-call project. It has a Response target field where
the table has Size, and a Queue view. Prep then adds each routed issue there with its target, and
never proposes it at the table. An open item past its target is flagged, and so is on-call spend
over `boards.onCall.spendShare` percent of the week (20 by default). The status update covers both
boards; the table reads on-call as one section of it, not row by row. Set
`boards.onCall.project.number` to point setup at a project you already have.

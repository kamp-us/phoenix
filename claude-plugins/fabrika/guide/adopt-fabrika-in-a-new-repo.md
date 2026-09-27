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
its `State` cell says whether the theme is being worked. An `active` row marks its milestone
`running` in `triage homes`, and triage then homes only `p0`, `p1` and blocker work there.

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

The table is a GitHub project where your control-plane owners decide what fabrika bets on each week.
It is optional. The steps below set it up and keep it running; what each verb reads, writes, prints
and exits on is its `--help` (`fabrika table setup --help`, and the same for `sync`, `flags` and
`prep`), written in
[`packages/fabrika-cli/src/table/command.ts`](../../../packages/fabrika-cli/src/table/command.ts).

### 11.1 Give the token the `project` scope

```bash
gh auth refresh -h github.com -s project
```

Use that exact line: a plain `gh auth refresh` fails in a non-interactive shell. With
`GITHUB_TOKEN` or `GH_TOKEN` set, give that token the scope instead. The `table` verbs stop at exit
20 without it.

The `table` verbs are not the only readers. `lane brief` reads the table for the size stop,
`lane record` runs `fabrika table sync` after it posts, `build pick` reads it to put bets first, and
`pitch-guard` reads it because a `bet` row approves a pitch. So give the scope to every token that
drives lanes, not only yours.

**Declaring a `table` block turns a failed read into a refusal.** Any `table` block in
`.fabrika.jsonc` counts, even one that only sets the cadence. With one, a table that `lane brief` or
`build pick` cannot read, a missing scope included, stops them at exit 11. With none, any failed
read lets them go on and say what they could not read: `lane brief` briefs and prints
`size stop NOT checked`, and `build pick` keeps its own order. `lane record` and `pitch-guard`
never refuse for the table: a sync that fails leaves the record standing, and an unread table
approves no pitch. Sources:
[`src/table/adoption.ts`](../../../packages/fabrika-cli/src/table/adoption.ts) and
[`src/table/size-stop.ts`](../../../packages/fabrika-cli/src/table/size-stop.ts).

### 11.2 Create the project

```bash
fabrika table setup
```

It reuses an open project titled `<repo name> table`, first among your repo's linked projects, then
among the owner's, and links it. Failing that, it creates one under the owner. It then adds the
fields, the Week field with its first 12 weeks (six two-week iterations for a biweekly table), the
five views and a README that explains every column. Run it again any time, and once after each
fabrika upgrade: a project already in shape answers `unchanged`.

### 11.3 Take the three steps the API cannot

Setup prints all three, and the project README's "By hand" section lists them.

1. Grouping: in the Agenda view, set *Group by: Section* and save the view. In the Lanes view, set
   *Column by: Stage* and save it.
2. Inbox auto-add: in the project's **Workflows**, turn on *Auto-add to project* for your repo with
   the filter `is:issue is:open no:label`, and save it. Issues nobody labeled then land in the Inbox
   view, where triage sees them.
3. Weeks: before the last of the 12 planned weeks starts, add the coming weeks in the project's
   settings under the Week field. Setup never adds them to a Week field that already exists, because
   GitHub's API adds an iteration only by rewriting the whole list, which empties every row's Week.

### 11.4 Tune it, if the defaults do not fit

Add a `table` block to `.fabrika.jsonc` with only the keys you change: cadence and day, sections,
the agenda cap, and the flag and stop points. A `sections` list may reorder and add sections, but it
must keep Tails, Customers, New bets and Outside the bets, or the config is refused. Remember 11.1:
the block also makes table reads fail closed. Every key and its default is in
[`src/config/keys/table.ts`](../../../packages/fabrika-cli/src/config/keys/table.ts).

- To point setup at a project you already have, set `table.project.number`, and
  `table.project.owner` if it lives under another account.
- Set the size dollars in `appetiteSizes`, the key pitch-guard reads, not in the `table` block. If you
  change them after the Size field exists, re-run setup: it rewrites the README and prints a
  `drift:` line for each Size option whose description still shows the old amount. Edit those
  descriptions by hand in the field's settings.

### 11.5 Boot bets with `--origin bet`

When you start a lane for a row the table bet on, pass `--origin bet` to `fabrika lane open` or
`fabrika lane emit`. Sync writes a row's Origin from its latest lane record, and prep brings a shipped
row back as a check only when that Origin reads `bet`.

Everything else about a row fills itself: `lane record` syncs the issue when the lane ends. Spent $
stays empty while any lane counted on the row went unmeasured, and sync clears a figure already
standing there. Sync never moves a `bet` row, though, so set its Stage to `shipped` yourself once
its work has merged.

### 11.6 Run prep before each table

```bash
fabrika table prep
```

It fills the agenda for the Week your next table day falls in, carries running bets into it, brings
shipped bets back as checks, and posts the week's health as the project's status update. Each row's
In plain words line is the issue's `## In plain words` summary, or its title when it has none
([`src/table/agenda.ts`](../../../packages/fabrika-cli/src/table/agenda.ts)), so triage an issue
before you want it read well at the table.

Then act on what it printed:

- **Exit 25:** the planned weeks ran out, so no Week iteration covers your next table day. Add the
  coming weeks by hand (11.3, step 3), then prep again.
- **An `AT_RISK` status update:** a row flag stands, or a flag check could not be read. Its "Could
  not check" line names each check it could not read; it never reads `ON_TRACK` over one.
- **`triageFirst`:** customer reports nobody triaged yet. Triage them; the next prep proposes them.
- **A second run in the same Week** adds no row, carries no bet and posts nothing. It still takes a
  `proposed` row whose issue closed off the table, and with an on-call board it still routes new
  issues there ([`src/table/prep-verb.ts`](../../../packages/fabrika-cli/src/table/prep-verb.ts)).

### 11.7 Answer the checks

A bet that has read `shipped` for `table.checkDelayDays` days comes back at Stage `check`, with its
evidence posted as a comment on the issue. Answer on the row's Outcome field: `worked`, `didn't` or
`can't tell`. Prep never changes that answer and never asks again.

To attach your own numbers to that evidence, declare commands under `table.evidenceSources`.
`fabrika table prep --help` lists what each command gets and how its output is cut.

```jsonc
{
  "table": {
    "evidenceSources": [
      {"name": "error rate", "command": ["pnpm", "metrics:errors"], "timeoutSeconds": 30}
    ]
  }
}
```

### 11.8 Read the flags between tables

```bash
fabrika table flags
```

It names the rows that need a person, each with a one-line rec, and changes nothing. Bring those
rows to the next table. A row is flagged over size once it spends past `table.flagMultiple` times
its size (1 by default; at least 1 and below `table.stopMultiple`), and its lane keeps going. The
one flag that acts on its own is the size stop: when a row has spent `table.stopMultiple` times its
size, `lane brief` stops that lane at exit 71 and the driver parks it with cause `size-stop`.

The fabrika-share flag counts only issues carrying a label you name in `table.fabrikaShare.labels`,
so name one if you want it read.

### 11.9 Split off an on-call board, if you want one

Continuous work, such as customer reports, crashes and CI breakage, is not bet on. To give it its
own board, declare `boards.onCall`, then re-run `fabrika table setup` to create the
`<repo name> on-call` project:

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

`route` decides what leaves the table for on-call. Each issue lands on exactly one board: a match on
any one origin, type or label sends it to on-call. A row the table already reads as `bet`,
`not now` or `check` stays put. From then on prep fills the on-call board and flags reads it. Set
`boards.onCall.project.number` to point setup at a project you already have.

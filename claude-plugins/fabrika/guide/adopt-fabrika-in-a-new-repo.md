# Adopt fabrika in a repo you already have

Steps to get fabrika running on an existing repo — one with a board, a history and its own
conventions. The commands and outputs below describe the CLI at the version this page ships with.
After an upgrade, re-check a verb against its own `--help`.

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
have not adopted yet — those are the ones the CLI can create for you, which is step 3. Each
`surface` row's last column says in one line what that surface is.

**A `read-back conformed` from `status bootstrap` means one surface landed — it does not mean the
setup is finished**, and nothing in that verb's output says so.

The dispositions are yours to change: a repo that runs no design system declares
`"surfaceDispositions": {"design-manifest": "degrade"}` and stops being told to build one; every key
you do not name keeps its shipped value.

## 3. Create the surfaces the CLI can create

Ten surface ids are buildable today. Read them off the verb rather than off any prose:

```bash
fabrika status bootstrap --help
```

```
surface-id string    one id from the buildable-surface registry: design-manifest, roadmap-focus, gitignore-row, claude-md-section, label-taxonomy, issue-shape-markers, readout-artifact, settings-patch, dep-pin, hand-check-rule
```

One id per invocation; a target already present is `exists` at exit 0 and nothing is written or
overwritten. `design-manifest` and `roadmap-focus` take their content on stdin. `gitignore-row`
and `claude-md-section` append their own row/block and read no stdin. `settings-patch` merges the
`kampus` marketplace registration and the `fabrika@kampus` flip into a `.claude/settings.json`
that is already there — unknown keys preserved, unparseable bytes refused unwritten — and creates
the file when it is absent; it reads no stdin either way. `dep-pin` pins the `@kampus/fabrika-cli`
dependency row to the version npm's registry publishes at run time — same merge law over the
repo's `package.json`, an unreachable registry refused unwritten — and prints the exact install
command; it never runs a package manager or touches a lockfile. That install is not small: it
brings in Playwright, adds a few hundred lockfile lines, and the package's `postinstall` downloads a
headless Chromium (~130MB) for `fabrika ui render`. pnpm 10 skips that `postinstall` until you
approve it: run `pnpm approve-builds` and pick `@kampus/fabrika-cli`, or add it to
`onlyBuiltDependencies` and run `pnpm rebuild @kampus/fabrika-cli`. Skip the approval and `ui render`
refuses with exit `11` until the browser is set up. `hand-check-rule` writes one
`reviewUi.whenNoPreview` rule into `.fabrika.jsonc` and reads no stdin;
[If your app has no preview deploys](#if-your-app-has-no-preview-deploys) says when to run it.
`label-taxonomy`,
`issue-shape-markers` and `readout-artifact` write to GitHub and need a resolvable repo —
`--repo`, `$CLAUDE_PIPELINE_REPO`, `$GITHUB_REPOSITORY`, or an `origin` remote.

## 4. Create the labels

**Writes to GitHub:** both commands create labels in your repo.

```bash
fabrika status bootstrap label-taxonomy
fabrika status bootstrap issue-shape-markers
```

Both sets are derived, not listed here: the CLI composes the label list from its board
vocabularies, so it widens on its own when one grows, and `issue-shape-markers` adds the shape
markers `wayfinding:map`, `prototyping:spike` and `grilling:session`. The
[`status bootstrap` contract](../skills/front-door/contract.md#status-bootstrap) spells out the
current label set.

Where some labels are present the verb creates only the missing ones and reports what it created;
a label already there under another colour is left alone.

## 5. Ignore fabrika's run state

fabrika writes a per-run ledger into your working tree: `.fabrika/lanes/<n>/` for an issue lane and
`.fabrika/chores/` for a chore lane, each holding a `workflow.json` and an `events.jsonl`. That is
one machine's log and never belongs in shared history.

```bash
fabrika status bootstrap gitignore-row
```

It appends its own block to `.gitignore` and rewrites nothing already there; the collision guard is
the row `/.fabrika/` appearing anywhere in the file, so a row you added by hand with the same
spelling reads as `exists`. Commit the change before running a lane.

## 6. Open at least one milestone

**Writes to GitHub:** you create a milestone in your repo, by hand. No fabrika verb does this, so a
permission tool that asks before outside writes will ask here.

`triage homes` offers only **open** milestones joined to a roadmap row, and zero open milestones is a
refusal (exit 7), not an empty answer. It creates none — curating the milestone set is a human act.
Open one on GitHub and note its number: the roadmap you write next pins it.

## 7. Write a `ROADMAP.md`

**Write one even though the config calls it optional.** `roadmapFile` resolves to `ROADMAP.md`
unless you say otherwise, and an absent file means no arc and no campaign is declared.

An absent roadmap does not stop you — `triage homes` degrades on it — but without the file nothing
homes to an arc, so writing it is a first-triage quality step, not a blocker.

The grammar is a parse contract the CLI enforces, not a convention, and two facts carry this
recipe: headings exactly `## Arcs` and `## Campaigns`, and each row's second
cell naming the pinned milestone as `#<number>` — the arc's name is never matched on. Zero campaign
rows is legal. Zero arc rows makes `triage homes` refuse; the bootstrap verb below accepts the table
and reports `0 arcs`. A campaign row groups work under a theme and a milestone;
its `State` cell says whether the theme is being worked. An `active` row marks its milestone
`running` in `triage homes`, and triage then homes only `p0`, `p1` and blocker work there.

Draft it with the milestone number from step 6 in the arc row, and hand it to the verb. It writes a
local file only. It reports what its own parser joined out of the bytes it wrote, then checks each
arc's pin against your repo's open milestones:

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
status bootstrap: pin check — every arc pin is an open milestone in you/your-repo (scanned 1 open milestone).
```

`0 arcs` there means the table did not parse. Fix it before moving on, or the join is silently
empty. A `warning` line names each arc pin that is not an open milestone: open it, or fix the
number. `pin check unknown` means the pins are unchecked, not fine. It has two causes: the
milestone read failed, or no target repo resolved. For the second, pass `--repo` or set
`$CLAUDE_PIPELINE_REPO`, the same chain step 3 lists. The warning and the unknown line both
still exit 0.

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

If you do want a standing lane: create the label on your board (**writes to GitHub**: a label you
create by hand), then declare it under
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

`.fabrika.jsonc` at your repo root carries the keys the CLI reads; `fabrika status settings` lists
every one with its resolved value and whether it came from your file or the shipped default. A key
you leave out falls back to its shipped default. An absent file, an absent key, an empty array
and a malformed entry all give the narrowest behaviour, never the permissive one. **Narrowest is
safe, but it is not always enough to finish a lane.** For the rows below, the default makes a verb
refuse partway through real work, so write them before your first lane:

| Key or file | What happens without it | Exit | A first value |
|---|---|---|---|
| `codeValidators` | `lane integrate` merges the child into `epic/<n>`, then refuses and resets the branch. `build check --surface code` refuses too. | `11` from both | `[{"command": ["pnpm", "typecheck"]}, {"command": ["pnpm", "lint"]}]`, with your own script names |
| `dependencyReconciler` | No verb refuses. `lane integrate` skips the install and says so on stderr, so a child that changes the lockfile is validated against the old install and can fail there. | none; `44` from `lane integrate` when a validator then fails | `{"command": ["pnpm", "install", "--frozen-lockfile"]}` |
| `.github/CODEOWNERS` | `plan approve` refuses every account. `ship cp-approval` answers `stop zero-owners`, so every PR waits for an approval nobody can give. | `24` from `plan approve`; `ship cp-approval` exits `0` with the stop | `/.github/ @your-login` and `/.fabrika.jsonc @your-login`. A row that owns everything (`*`) is a hold, not an owner. |
| a CI workflow in `.github/workflows/`, or `"ci": {"noProducer": "degrade"}` | `ship checks` and `review ci` refuse. | `7` from both | a `ci.yml` that runs your validators on `pull_request`; `degrade` only for a repo that runs no Actions on purpose |
| `uiSurfaces` | No verb refuses in review: no path raises the `ui` class, so a rendered change is reviewed as text only. `review scope` and `ship scope` print one stderr line saying so. `ui render` refuses, and `review-ui route` answers `none` because there is nothing to route. | `19` from `ui render`; `review-ui route` exits `0` with `"answer":"none"` | one row per app: `{"name": "web", "prefix": "src/", "mount": "/", "command": "pnpm dev --port {{port}}"}`; `[]` for a repo that renders nothing |

A workflow that exists but never runs on a PR's head is a different refusal: `ship checks` exits `20`
and `review ci` exits `16`. The exit codes above are the ones each verb's `--help` prints; after an
upgrade, re-read them there rather than here.

The repo that authors fabrika keeps its own `.fabrika.jsonc` as the worked example, with the
reasoning for each value in comments.

### If your app has no preview deploys

A PR that changes a declared `uiSurfaces` path cannot ship until the `review-ui` gate is resolved at
its head. There are two ways to resolve it:

1. **A preview deploy.** Your CI posts a `preview-deploy` comment on the PR with the deployed URL and
   head. The ui reviewer renders that and posts a PASS or FAIL. It never runs the PR's code itself.
2. **A route instead of a render.** The ui reviewer posts a `routed-elsewhere` record with
   `fabrika review-ui route`, which `ship gate` reads as `routed`. With no preview, what the route
   needs depends on the path's `reviewUi.whenNoPreview` mode, below: under `require-render` and
   `hand-check`, a hand-verification at the PR's head and a `review-code` PASS at that same head;
   under `skip`, neither.

Which hand-verification counts is yours to say, by path, with `reviewUi.whenNoPreview`:

```jsonc
"reviewUi": {
  "whenNoPreview": [
    {"paths": ["apps/admin/**"], "mode": "hand-check"},
    {"paths": ["docs/site/**"], "mode": "skip"}
  ]
}
```

- `require-render` is what every file no rule matches gets. The only hand-verification it takes is
  the builder's own run of the app at the head, which the ui reviewer routes with
  `review-ui route --verified-at <head>`.
- `hand-check` lets your own comment on the PR stand in for the render: screenshots, naming the PR's
  exact head, from an account on your control-plane `CODEOWNERS` row.
- `skip` means no rendered review is owed for those files.

**A repo with no rule yet gets its first one from one command.** Run it when your app has a screen
and nothing puts up a preview for each PR:

```bash
fabrika status bootstrap hand-check-rule
```

It writes one rule, `{"paths": ["**"], "mode": "hand-check"}`, and keeps every other key and
comment in the file. The rule is read only over a PR's `uiSurfaces` files, so `**` covers each app
you declare. Once any rule is there the command answers `exists` and writes nothing, so narrower
paths are yours to edit by hand. Commit the file to your default branch before the first build.

A PR takes the strictest mode across its files. The route checks that the PR really has no preview,
so a rule never stands in for a render that could run. Both looser outcomes are flagged on the PR,
in `ship gate` and on the table as `not-rendered` (`fabrika table flags`), so nobody mistakes them
for a render.

**With neither a preview nor the hand-verification its mode asks for,** the ui reviewer ends
`CANT-SEE` with cause `no-preview-render` and the lane parks. `fabrika recipe unpark` has no recipe
for that cause, so the park does not clear on its own. The way through is to post the
hand-verification at the PR's current head and run the ui reviewer again. Do not post a `review-ui`
verdict by hand. The rules for each route, and their exit codes, are in
[`review-ui`'s skill](../skills/review-ui/SKILL.md).

## 10. Re-run the front door

**Writes to GitHub:** `status open` only reads. The follow-ups below write:
`status bootstrap readout-artifact` creates an issue, `/fabrika:report` files one, and
`/fabrika:triage` labels it.

### Read the fields

```bash
fabrika status open
```

Seven fields: the installed skill roster, what this repo declares from step 2, whether the plugin
carrying the skills is enabled here, your board's counts, the decision digest, any lanes on this
machine, and the trunk every verb resolved, with whether this clone's `origin/HEAD` agrees.

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

### File the issue before the work

Every code or skill PR needs an issue, filed before the work starts. Review fails a code or skill PR
with no linked issue: without the issue's acceptance criteria there is nothing to grade the diff
against. Agent lanes learn this early, because `build claim` refuses without an issue. Work done by
hand, or by an agent outside a lane, meets it only at review.

One exemption: a doc written from a conversation, or a `.glossary/**` change, may land without an
issue. Review grades it on its own rubric.

So file the issue first, and build after it. An issue written after the diff exists describes that
diff instead of stating the goal ahead of it. Your first lane starts the same way: file the issue
with `/fabrika:report`, triage it with `/fabrika:triage`, and you are running.

## 11. Set up the betting table

The table is a GitHub project where your control-plane owners decide what fabrika bets on each week.
It is optional. The steps below set it up and keep it running. What each verb reads and writes is
in [`table-contract.md`](../docs/table-contract.md); its `--help` (`fabrika table setup --help`, and
the same for `sync`, `flags`, `prep`, `route` and `migrate-week`) carries only the answer it prints
and its exit codes.

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

A token without the scope never stops a lane: `lane brief` and `build pick` go on without the
table and print the fix above. Other failed reads differ: until a `table` block (11.4) is declared
they let lanes go on and say so; after it, they stop them. What
each reader does on a failed read is the "Readers outside the group" section of
[`table-contract.md`](../docs/table-contract.md).

### 11.2 Create the project

**Writes to GitHub:** it creates or links a GitHub project and adds its fields, views and README.

```bash
fabrika table setup
```

It reuses an open project titled `<repo name> table`, first among your repo's linked projects, then
among the owner's, and links it. Failing that, it creates one under the owner. It then adds the
fields, the Table day date field every row is dated in, the five views (Agenda grouped by Section,
Lanes in columns by Stage) and a README section that explains every column. A README or short
description your team already wrote stays: setup adds its section below your text and lists a
differing short description under `drift`. Run it again any time, and once after each fabrika
upgrade: a project already in shape answers `unchanged`.

A project set up before Table day keeps its Week iteration field, and setup lists it under
`legacy`. Run `fabrika table migrate-week` once to copy each row's week into Table day; it never
writes the Week field.

### 11.3 Take the steps the API cannot

Setup prints them, and the project README's "By hand" section lists them.

1. Grouping, only on an Agenda or Lanes view that stood before setup: set *Group by: Section* on
   Agenda and *Column by: Stage* on Lanes. Setup creates the views it adds already grouped.
2. Inbox auto-add: in the project's **Workflows**, turn on *Auto-add to project* for your repo with
   the filter `is:issue is:open no:label`, and save it. Issues nobody labeled then land in the Inbox
   view, where triage sees them.

### 11.4 Tune it, if the defaults do not fit

Add a `table` block to `.fabrika.jsonc` with only the keys you change: cadence and day, the time
zone, sections, the agenda cap, and the flag and stop points. Set `table.timeZone` to the zone the
people at the table live in, such as `America/Los_Angeles`: GitHub shows the Agenda by the viewer's
today, and prep matches it only when it reads today in the same zone. A `sections` list may reorder and add sections, but it
must keep Tails, Customers, New bets and Outside the bets, or the config is refused. Remember 11.1:
the block also makes table reads fail closed. `fabrika status settings` prints the `table` key's
resolved value, every sub-key included; before you add the block, that value is the shipped
default.

- To point setup at a project you already have, set `table.project.number`, and
  `table.project.owner` if it lives under another account.
- Set the size dollars in `appetiteSizes`, the key pitch-guard reads, not in the `table` block. If you
  change them after the Size field exists, re-run setup: it rewrites its README section, fills each blank
  Size description with the new amount, and keeps a description someone already wrote as it is.

### 11.5 Boot bets with `--origin bet`

When you start a lane for a row the table bet on, pass `--origin bet` to `fabrika lane open` or
`fabrika lane emit`. Sync writes a row's Origin from its latest lane record, and prep brings a shipped
row back as a check only when that Origin reads `bet`.

Everything else about a row fills itself: `lane record` syncs the issue when the lane ends. Spent $
stays empty while any lane counted on the row went unmeasured, and sync clears a figure already
standing there. Sync never moves a `bet` row, though, so set its Stage to `shipped` yourself once
its work has merged.

### 11.6 Run prep before each table

**Writes to GitHub:** it adds and updates project rows, comments on issues and posts a project
status update.

```bash
fabrika table prep
```

It fills the agenda for your next table day, dates every row it touches with that day, carries
running bets to it, brings shipped bets back as checks, and posts the week's health as the project's status update. Each row's
In plain words line is the issue's `## In plain words` summary, or its title when it has none
([the `table prep` contract](../docs/table-contract.md#table-prep)), so triage an issue
before you want it read well at the table.

Then act on what it printed:

- **An `AT_RISK` status update:** a row flag stands, or a flag check could not be read. Its "Could
  not check" line names each check it could not read; it never reads `ON_TRACK` over one.
- **`triageFirst`:** customer reports nobody triaged yet. Triage them; the next prep proposes them.
- **A second run for the same table** adds no row, carries no bet and posts nothing. It still takes a
  `proposed` row whose issue closed off the table
  ([the `table prep` contract](../docs/table-contract.md#table-prep)).

### 11.7 Answer the checks

A bet that has read `shipped` for `table.checkDelayDays` days comes back at Stage `check`, with its
evidence posted as a comment on the issue. Answer on the row's Outcome field: `worked`, `didn't` or
`can't tell`. Prep never changes that answer and never asks again.

To attach your own numbers to that evidence, declare commands under `table.evidenceSources`.
What each command gets and how its output is cut is the "table prep" section of
[`table-contract.md`](../docs/table-contract.md#table-prep).

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
rows to the next table. A row flagged over size keeps its lanes going. Only the size stop acts on its
own: a row that reaches it parks its lanes until the table extends, re-shapes or drops the bet. Where
the flag and the stop fall, and how a stopped lane parks, are the "table flags" section of
[`table-contract.md`](../docs/table-contract.md).

The fabrika-share flag counts only issues carrying a label you name in `table.fabrikaShare.labels`,
so name one if you want it read.

### 11.9 Split off an on-call board, if you want one

Continuous work, such as customer reports, crashes and CI breakage, is not bet on. To give it its
own board, declare `boards.onCall`, then re-run `fabrika table setup` to create the
`<repo name> on-call` project (**writes to GitHub**: a new project):

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
`not now` or `check` stays put. From then on `fabrika table route` fills the on-call board and flags
reads it. Route touches no agenda, so run it as often as you want new reports placed
([the `table route` contract](../docs/table-contract.md#table-route)). Its first run moves every
routed open issue at once, so read that plan with `fabrika table route --dry-run` before it lands. An item's wait counts from
when its issue was filed, against the target its labels pick now. Set
`boards.onCall.project.number` to point setup at a project you already have.

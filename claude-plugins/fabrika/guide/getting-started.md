# Getting started with fabrika

In this lesson you stand fabrika up on a GitHub repo you own, then drive one issue from filing to an
open pull request. It takes about half an hour. Nothing here is throwaway — the repo you set up is
the repo you keep using.

Use a repo you are happy to add labels and a milestone to. This lesson creates nineteen labels and
one milestone on its board.

You need:

- Claude Code, signed in.
- Node 24 or newer.
- `gh` logged in to an account with write access to the repo.
- A clone of that repo on disk, with an `origin` remote pointing at it.

Every command below is run from the root of that clone unless it starts with `/`, which means you
type it into Claude Code rather than a shell.

## 1. Install the command-line tool

fabrika's skills call a command-line tool for everything they read and write. Install it once, on
your machine, not in the repo:

```bash
pnpm add --global @kampus/fabrika-cli
```

Check it answers:

```bash
fabrika --version
```

```
fabrika v0.3.0
```

Your version may be higher. Anything that prints a version is fine.

## 2. Install the plugin

The skills arrive as a Claude Code plugin. In Claude Code, type:

```
/plugin marketplace update kampus
/plugin install fabrika@kampus
```

Update first. The install reads a cached catalog, and a stale cache refuses by name rather than
saying it is out of date.

## 3. Look at the front door

Back in your shell, at the root of your clone:

```bash
fabrika status open
```

```
status open: roster claude-plugins/fabrika/skills (repo); repo kamp-us/phoenix; 6 field(s) rendered, 0 unknown.
open	6
field	menu	ready	25 skills	claude-plugins/fabrika/skills	2026-08-19T03:23:01Z
field	settings	resolved	15 keys, 4 declared	.fabrika.jsonc	2026-08-19T03:23:01Z
field	wiring	wired	fabrika@kampus is enabled — sessions in this repo load fabrika's skills	.claude/settings.json	2026-08-19T03:23:01Z
field	board	counted	3 needs-triage, 367 triaged	kamp-us/phoenix	2026-08-19T03:23:02Z
field	readout	absent	no digest block in kamp-us/phoenix#5616	kamp-us/phoenix#5616	unknown
field	lanes	empty	no lanes on disk	.fabrika/lanes,.fabrika/chores	2026-08-19T03:23:01Z
```

That output is from a repo already set up, so yours will differ — the `board` row will report a
board with no fabrika labels on it yet, and the `readout` row will say `absent`. Read the six
fields as: which skills are installed, what this repo declares, whether the plugin carrying the
skills is switched on here, what is on the board, whether the decision digest exists, and which runs
are in flight on this machine.

**Watch the `wiring` row first.** `unwired` means the CLI works and no fabrika skill can load in a
session in this repo — every other row can read green while that one does, which is how a repo ran
half-adopted for two days.

## 4. Create the labels

fabrika's stages write their state onto issues as labels, so the labels have to exist before
anything can move. Create them:

```bash
fabrika status bootstrap label-taxonomy
```

On a fresh board that reports `created` and names all sixteen. On a board that already has them it
reports `exists` and writes nothing:

```
status bootstrap: status:needs-triage,status:triaged,status:needs-info,status:planned,status:awaiting-release,p0,p1,p2,type:bug,type:feature,type:chore,type:decision,type:investigation,type:epic,ready-for:human,ready-for:agent is already present for label-taxonomy — nothing written.
bootstrap	exists	label-taxonomy	status:needs-triage,status:triaged,status:needs-info,status:planned,status:awaiting-release,p0,p1,p2,type:bug,type:feature,type:chore,type:decision,type:investigation,type:epic,ready-for:human,ready-for:agent	-
```

Three more labels mark what an issue *is* rather than where it sits:

```bash
fabrika status bootstrap issue-shape-markers
```

## 5. Keep fabrika's run state out of git

fabrika writes a per-run ledger under `.fabrika/` in your clone. That is one machine's log, not
shared history, so it is ignored rather than committed:

```bash
fabrika status bootstrap gitignore-row
```

```
status bootstrap: appended /.fabrika/ to .gitignore for gitignore-row, read-back conformed.
bootstrap	created	gitignore-row	.gitignore	ok
```

Commit that `.gitignore` change now, before anything writes a lane.

## 6. Give the board a home to put work in

Triage refuses to classify an issue with nowhere to put it, so the repo needs one open milestone and
a `ROADMAP.md` that pins it. Create the milestone:

```bash
gh api repos/:owner/:repo/milestones -f title='First arc' --jq '.number'
```

It prints the milestone's number. Write a roadmap pinning it — substitute that number for `1`:

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
bootstrap	created	roadmap-focus	ROADMAP.md	ok
```

The `1 arc` on the end is the file's own parser reporting what it joined out of the bytes just
written. If it says `0 arcs`, the table did not parse and nothing downstream will see your
milestone. Check the homes:

```bash
fabrika triage homes
```

```
triage homes: scanned 5 open milestones in kamp-us/phoenix.
triage homes: standing lanes: 2 of 2 declared carry a label in kamp-us/phoenix.
triage homes: campaigns: 2 active — fabrika fast follows (#46), fabrika everywhere (#47).
homes
milestone	24	Geçit
milestone	25	Mecmua v2 — PARKED (reading-experience arc, unstarted)
milestone	42	Taste-Skill Library
milestone	46	fabrika fast follows	running: p0/p1 or blocker
milestone	47	fabrika everywhere	running: p0/p1 or blocker
lane	wayfinder:backlog	fog — uncharted work upstream of any arc
lane	axis:pipeline-hardening	the standing pipeline and reliability lane
```

That output is from a repo already set up, so yours will differ: one `milestone` row, the one you
just created, and a line reading `campaigns: none active — scope fence inert.` because your roadmap
has no campaigns table. You get no `lane` rows either — those are phoenix's own standing lanes, and a
lane is offered only where your board carries its label
([the how-to](adopt-fabrika-in-a-new-repo.md) covers them).

Your milestone should be in that list. Commit `ROADMAP.md`.

## 7. See what is still missing

```bash
fabrika status settings --surfaces
```

One row per config key, with its resolved value and whether that value is yours or the shipped
default. `--surfaces` is what you want here: it expands `surfaceDispositions` into one row per repo
surface, each naming what the surface is and what happens when it is absent — `fail-loud`, `degrade`
or `bootstrap`. Without the flag that key prints as one raw id-to-word value and none of the notes. A `created` from
step 4 says one surface landed, not that the repo is ready.

Plenty of surfaces will still be absent. That is fine for now — every one of them belongs to a skill
this lesson does not use.

## 8. File your first issue

Now leave the shell. In Claude Code, in this repo:

```
/fabrika:report the README has no install section
```

It files one issue labelled `status:needs-triage` and prints its number. That label is the intake
queue, and it is the only way work enters the pipeline.

## 9. Triage it

```
/fabrika:triage <the number it printed>
```

Triage reads the issue, gives it a type, a priority and a home, rewrites the body into something a
builder can pick up cold, and stamps it `status:triaged` plus `ready-for:agent`. Read what it wrote
on the issue before you go on — the acceptance criteria it left there are the contract everything
after this is graded against.

## 10. Build it

```
/fabrika:build <the same number>
```

This is the long one. The builder claims the issue, cuts a branch, writes the change, validates it
in your tree, commits, pushes and opens a pull request. When it finishes it prints one word:
`SHIPPED-PR`, and the pull request's URL.

## 11. Review and merge it

```
/fabrika:review <the pull request number>
```

The reviewer judges the pull request against the acceptance criteria triage wrote, and lands a
PASS or FAIL verdict on the pull request itself. On a PASS:

```
/fabrika:ship <the pull request number>
```

The shipper walks the merge guards and merges. On a FAIL, hand the pull request back to the builder
— `/fabrika:build <the pull request number>` enters repair mode on the same branch, fixes what the
verdict named, and answers it.

## You are done

You have a repo with fabrika's labels on it, a roadmap the pipeline can read, and one issue that
went from a sentence you typed to a merged pull request without you editing a file.

Where to go next:

- [`adopt-fabrika-in-a-new-repo.md`](adopt-fabrika-in-a-new-repo.md) — the same setup as a checklist
  for a repo that already has a board, a history and its own conventions.
- [`how-fabrika-works.md`](how-fabrika-works.md) — why the stages are separate actors, and why a run's
  state lives on disk.
- [`delegation.md`](delegation.md) — which copy of `fabrika` served a command, and what each refusal
  means.
- [`../../../packages/fabrika-cli/docs/verb-reference.md`](../../../packages/fabrika-cli/docs/verb-reference.md)
  — every verb, its flags and its exit codes.

# Getting started with fabrika

In this lesson you stand fabrika up on a GitHub repo you own, then take one issue from a sentence
you type to a merged pull request. It takes about half an hour.

Use a repo you are happy to experiment on. The lesson adds labels, one milestone, one issue and one
pull request to it, and pushes one small commit to its default branch.

You need:

- Claude Code, signed in.
- Node 22.12 or newer, and pnpm.
- `gh` logged in to the account that owns the repo.
- A clone of the repo on disk, with an `origin` remote pointing at it and a `README.md` in it.
- GitHub Actions switched on for the repo, which is how a new repo starts.

Run every command from the root of that clone. A command that starts with `/` is typed into Claude
Code, opened in that clone, not into a shell.

The samples below come from one run of this lesson. Yours will show your own repo in place of
`you/your-repo`, and your own times. The skill count on the `menu` row will differ too: it is the
number of skills in the plugin version you install, and this run's plugin had 28.

## 1. Install the command-line tool

fabrika's skills call a command-line tool for everything they read and write. Install it once, on
your machine:

```bash
pnpm add --global @kampus/fabrika-cli
```

Check it answers:

```bash
fabrika --version
```

```
fabrika v0.9.0
```

Yours may be higher. It must not be lower than the `minimum` in
[`cli-floor.json`](../cli-floor.json), the oldest version the skills run against.

## 2. Install the plugin

The skills arrive as a Claude Code plugin. Tell Claude Code where the plugin lives, then install it:

```bash
claude plugin marketplace add kamp-us/phoenix
```

```
✔ Successfully added marketplace: kampus (declared in user settings)
```

```bash
claude plugin install fabrika@kampus
```

```
✔ Successfully installed plugin: fabrika@kampus (scope: user)
```

If the install says `Plugin "fabrika" not found in marketplace "kampus"`, the first command did not
run. The plugin's [install notes](../README.md#install) cover a machine that already has the
marketplace.

## 3. Look at the front door

```bash
fabrika status open
```

```
status open: roster fabrika/skills (cache); repo you/your-repo; 7 field(s) rendered, 0 unknown.
open	7
field	menu	ready	28 skills	fabrika/skills	2026-10-03T21:14:56Z
field	settings	resolved	35 keys, 0 declared	.fabrika.jsonc	2026-10-03T21:14:56Z
field	wiring	unwired	no .claude/settings.json — no fabrika skill can load in a session here	.claude/settings.json	2026-10-03T21:14:56Z
field	board	absent	missing status:needs-triage,status:triaged,p0,p1,p2 — create them with fabrika status bootstrap label-taxonomy	you/your-repo	2026-10-03T21:14:58Z
field	readout	absent	no readout artifact	you/your-repo	unknown
field	lanes	empty	no lanes on disk	.fabrika/lanes,.fabrika/chores	2026-10-03T21:14:56Z
field	trunk	agrees	origin/main; origin/HEAD agrees	you/your-repo	2026-10-03T21:14:56Z
```

Seven fields: `menu`, `settings`, `wiring`, `board`, `readout`, `lanes` and `trunk`. Two of them
need you now. `wiring` says `unwired`, which step 4 fixes, and `board` says `absent`, which step 5
fixes. The `readout` row stays `absent` for this whole lesson.

Inside Claude Code the `front-door` skill gives you this same readout: type `/fabrika:front-door`.

## 4. Switch the plugin on in this repo

```bash
fabrika status bootstrap settings-patch
```

```
status bootstrap: created .claude/settings.json for settings-patch, read-back conformed.
bootstrap	created	settings-patch	.claude/settings.json	ok
```

Check the row changed:

```bash
fabrika status wiring
```

```
status wiring: read .claude/settings.json; plugin fabrika is wired.
wiring	wired	fabrika@kampus	kampus	fabrika@kampus is enabled — sessions in this repo load fabrika's skills	2026-10-03T21:15:48Z
```

## 5. Create the labels

fabrika's stages write their state onto issues as labels, so the labels have to exist before
anything can move. Create them:

```bash
fabrika status bootstrap label-taxonomy
```

```
status bootstrap: created status:needs-triage,status:triaged,status:needs-info,status:planned,status:awaiting-release,p0,p1,p2,type:bug,type:feature,type:chore,type:decision,type:investigation,type:epic,ready-for:human,ready-for:agent,class:code,class:doc,class:skill,class:ui,closed-by-triage for label-taxonomy, read-back conformed.
bootstrap	created	label-taxonomy	status:needs-triage,status:triaged,status:needs-info,status:planned,status:awaiting-release,p0,p1,p2,type:bug,type:feature,type:chore,type:decision,type:investigation,type:epic,ready-for:human,ready-for:agent,class:code,class:doc,class:skill,class:ui,closed-by-triage	ok
```

A second set marks what kind of thing an issue is:

```bash
fabrika status bootstrap issue-shape-markers
```

```
status bootstrap: created wayfinding:map,prototyping:spike,grilling:session for issue-shape-markers, read-back conformed.
bootstrap	created	issue-shape-markers	wayfinding:map,prototyping:spike,grilling:session	ok
```

## 6. Keep fabrika's run state out of git

fabrika keeps a log of each run under `.fabrika/` in your clone. It belongs to this machine, so git
should ignore it:

```bash
fabrika status bootstrap gitignore-row
```

```
status bootstrap: appended /.fabrika/ to .gitignore for gitignore-row, read-back conformed.
bootstrap	created	gitignore-row	.gitignore	ok
```

## 7. Give the board a home to put work in

Triage puts every issue somewhere, so the repo needs one open milestone and a `ROADMAP.md` that
names it. Create the milestone:

```bash
gh api repos/:owner/:repo/milestones -f title='First arc' --jq '.number'
```

```
1
```

That is the milestone's number. Write a roadmap that names it. If your number is not `1`, put yours
after the `#`:

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
bootstrap	created	roadmap-focus	ROADMAP.md	ok
```

Look for `1 arc` and the `pin check` line. Then ask triage where it can put work:

```bash
fabrika triage homes
```

```
triage homes: scanned 1 open milestone in you/your-repo.
triage homes: standing lanes: 0 of 2 declared carry a label in you/your-repo — not offered: wayfinder:backlog, axis:pipeline-hardening.
triage homes: campaigns: none active.
homes
milestone	1	First arc
```

Your milestone is the `milestone` row. The `standing lanes` line is expected on a new repo; the
adoption guide says [what a standing lane is](adopt-fabrika-in-a-new-repo.md#8-the-lane-rows-if-you-get-any).

## 8. Name an owner and add a CI check

The merge step needs two things from the repo: an owners file, and one CI run on the pull request.

Make the directories:

```bash
mkdir -p .github/workflows
```

Create `.github/CODEOWNERS` with these nine rows, with your GitHub login in place of `your-login`:

```
/.github/ @your-login
/.claude/ @your-login
/.claude-plugin/ @your-login
/packages/ci-required/ @your-login
/packages/fabrika-cli/src/ci/ @your-login
/biome.jsonc @your-login
/biome-plugins/ @your-login
**/lefthook* @your-login
**/.lefthook* @your-login
```

Some of those rows name paths your repo does not have. Keep them anyway: the builder's check in
step 11 reads this file and stops unless all nine are there.

Check the file:

```bash
fabrika guard codeowners-cp check --root .
```

```
guard codeowners-cp check: all 9 §CP path(s) are covered by .github/CODEOWNERS (9 owned rows)
```

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
jobs:
  readme:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: test -s README.md
```

The adoption guide covers
[what each of these files is for](adopt-fabrika-in-a-new-repo.md#9-add-the-config-file).

## 9. Commit the setup

```bash
git add .gitignore ROADMAP.md .claude/settings.json .github
git commit -m "Set up fabrika"
```

Push that commit to your default branch with `git push`. The builder starts from what is on GitHub,
so the setup has to be there first.

Now look at the front door again:

```bash
fabrika status open
```

```
status open: roster fabrika/skills (cache); repo you/your-repo; 7 field(s) rendered, 0 unknown.
open	7
field	menu	ready	28 skills	fabrika/skills	2026-10-03T21:17:14Z
field	settings	resolved	35 keys, 0 declared	.fabrika.jsonc	2026-10-03T21:17:14Z
field	wiring	wired	fabrika@kampus is enabled — sessions in this repo load fabrika's skills	.claude/settings.json	2026-10-03T21:17:14Z
field	board	counted	0 needs-triage, 0 triaged	you/your-repo	2026-10-03T21:17:14Z
field	readout	absent	no readout artifact	you/your-repo	unknown
field	lanes	empty	no lanes on disk	.fabrika/lanes,.fabrika/chores	2026-10-03T21:17:14Z
field	trunk	agrees	origin/main; origin/HEAD agrees	you/your-repo	2026-10-03T21:17:14Z
```

`wiring` reads `wired` and `board` reads `counted`. The repo is ready for work.

## 10. File your first issue

Open Claude Code in the clone and type:

```
/fabrika:report the README has no install section
```

```
Filed: #1 https://github.com/you/your-repo/issues/1
```

The issue carries the label `status:needs-triage`, which puts it in the queue triage reads. Use the
number it printed in the next step.

## 11. Triage it, then build it

```
/fabrika:triage 1
```

Triage reads the issue, gives it a type, a priority and your milestone, and rewrites the body so a
builder can pick it up cold. In this run the issue ended with the labels `status:triaged`,
`type:chore`, `p2`, `ready-for:agent` and `class:doc`. Yours may get a different type or priority.

Open the issue on GitHub and read the acceptance criteria triage wrote. Everything after this is
graded against them.

```
/fabrika:build 1
```

This is the long step, about two minutes. The builder claims the issue, cuts a branch, writes the
change, checks it in your clone, commits, pushes and opens a pull request. Its last line is one
word:

```
SHIPPED-PR
```

Above that word it prints the pull request's URL. Use the pull request's number in the next step.

## 12. Review it, then merge it

```
/fabrika:review 2
```

The reviewer waits for your CI check, judges the pull request against the acceptance criteria, and
posts its verdict as a comment on the pull request. In this run its answer began:

```
**Terminal: verdict PASS**
```

If it says FAIL instead, type `/fabrika:build 2`. Given a pull request's number, the builder fixes
what the verdict named on the same branch. Then review again.

On a PASS, merge it:

```
/fabrika:ship 2
```

In this run it answered:

```
**LANDED.** PR #2 is merged: https://github.com/you/your-repo/pull/2
```

The shipper mentions an exit `33` and restarts itself on the way. It needs nothing from you.

The builder left your clone on its own branch. Go back to yours and pull the merge:

```bash
git switch main
git pull
```

Open `README.md`. The install section is there.

## You are done

You set up a repo with fabrika's labels, a roadmap, an owners file and a CI check. Then one issue
went from a sentence you typed to a merged pull request, and the pipeline wrote that change.

Where to go next:

- [`adopt-fabrika-in-a-new-repo.md`](adopt-fabrika-in-a-new-repo.md): the same setup as a
  checklist for a repo that already has a board, a history and its own conventions. Its
  [step 2](adopt-fabrika-in-a-new-repo.md#2-find-out-what-your-repo-is-missing) shows what your
  repo still lacks, and
  [Read the fields](adopt-fabrika-in-a-new-repo.md#read-the-fields) says how to read each
  `status open` field.
- [`how-fabrika-works.md`](how-fabrika-works.md): why the stages are separate actors, and why a
  run's state lives on disk.
- [`delegation.md`](delegation.md): which copy of `fabrika` served a command, and what each refusal
  means.
- `fabrika --help`: every command group. `fabrika <group> --help` lists that group's verbs, and
  `fabrika <group> <verb> --help` gives one verb's flags and exit meanings.

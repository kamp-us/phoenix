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
setup is finished**, and nothing in that verb's output says so
([#5772](https://github.com/kamp-us/phoenix/issues/5772)).

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
spelling reads as `exists`. Commit the change before running a lane
([#5777](https://github.com/kamp-us/phoenix/issues/5777)).

## 6. Write a `ROADMAP.md`

**Write one even though the config calls it optional.** `roadmapFile` resolves to `ROADMAP.md`
unless you say otherwise, and an absent file means no focus is declared and the scope fence is
inert.

An absent roadmap no longer stops you — `triage homes` degrades on it
([#5773](https://github.com/kamp-us/phoenix/issues/5773)) — but without the file nothing homes to an
arc and the scope fence never fires, so writing it is a first-triage quality step, not a blocker.

The grammar is a parse contract, not a convention
([`packages/fabrika-cli/src/triage/roadmap.ts`](../../../packages/fabrika-cli/src/triage/roadmap.ts)),
and two facts carry this recipe: headings exactly `## Arcs` and `## Campaigns`, and each row's second
cell naming the pinned milestone as `#<number>` — the arc's name is never matched on. Zero campaign
rows is legal and zero arc rows refuses; the campaigns table is parsed a second time by the build
fence, stricter because a row's `State` cell is its dispatch permission
([ADR 0304](../../../.decisions/0304-campaign-active-is-the-dispatch-permission.md)).

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

`0 arcs` there means the table did not parse. Fix it before moving on, or the join is silently empty
([#5778](https://github.com/kamp-us/phoenix/issues/5778)).

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
carries its label. A fresh repo declares both — phoenix's pair is the shipped default — but carries
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
it falls to phoenix's pair, which then gets filtered against your board.

[ADR 0286](../../../.decisions/0286-standing-lanes-come-from-config.md) rules that lanes come from
your repo, never from a CLI literal. Until
[#6469](https://github.com/kamp-us/phoenix/issues/6469) evicts the shipped default, it reaches no
board that has not created the labels, and the empty declaration above is how you opt out of it
entirely.

## 9. Add the config file

`.fabrika.jsonc` at your repo root carries the keys the CLI reads — one `register(...)` line per key
in
[`packages/fabrika-cli/src/config/registry.ts`](../../../packages/fabrika-cli/src/config/registry.ts).
Every key is fail-closed — an absent file, an absent key, an empty array and a malformed entry all
give the narrowest behaviour, never the permissive one — and a key you leave out falls back to
phoenix's value, which is what every repo ran on before these keys existed.

Add the file only when a default does not fit your repo. phoenix's own file at
[`.fabrika.jsonc`](../../../.fabrika.jsonc) is the worked example, with the reasoning for each value
in comments.

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

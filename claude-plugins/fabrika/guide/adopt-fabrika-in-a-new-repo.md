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

Every key on the config surface, with what it resolves to here and whether that came from your file
or the shipped default. `--surfaces` is what expands `surfaceDispositions` into one row per repo
surface with a note saying what each surface *is*; without it you get the raw id-to-word value,
which does not tell you what you are missing. **A `read-back conformed` from `status bootstrap` means one surface landed —
it does not mean the setup is finished**, and nothing in that verb's output says so
([#5772](https://github.com/kamp-us/phoenix/issues/5772)).

The `surfaceDispositions` key is the list of every repo surface fabrika reads, each with what happens
when it is missing:

- **fail-loud** — a verb refuses and names the surface. Build these for the skills you will use.
- **degrade** — fabrika continues with a narrower answer and says so. Optional by declaration.
- **bootstrap** — the verb answers `bootstrap` at exit 0: you have not adopted that surface yet.

**A `fail-loud` surface can still be one the CLI builds for you.** The two are separate questions —
what happens to a run, and who can create the thing — and step 3 below is the answer to the second.

The dispositions are yours to change. A repo that runs no design system declares
`"surfaceDispositions": {"design-manifest": "degrade"}` and stops being told to build one; every key
you do not name keeps its shipped value. The registry itself is
[`packages/fabrika-cli/src/config/keys/surface-dispositions.ts`](../../../packages/fabrika-cli/src/config/keys/surface-dispositions.ts),
which says in one line what each surface is.

## 3. Create the surfaces the CLI can create

Six surface ids are buildable today. Read them off the verb rather than off any prose:

```bash
fabrika status bootstrap --help
```

```
surface-id string    one id from the buildable-surface registry: design-manifest, roadmap-focus, gitignore-row, label-taxonomy, issue-shape-markers, readout-artifact
```

The registry is `BUILDABLE_SURFACES` in
[`packages/fabrika-cli/src/status/bootstrap-verb.ts`](../../../packages/fabrika-cli/src/status/bootstrap-verb.ts).
One id per invocation; a target already present is `exists` at exit 0 and nothing is written or
overwritten. `design-manifest` and `roadmap-focus` take their content on stdin. `gitignore-row`
appends its own row and reads no stdin. `label-taxonomy`, `issue-shape-markers` and
`readout-artifact` write to GitHub and need a resolvable repo — `--repo`, `$CLAUDE_PIPELINE_REPO`,
`$GITHUB_REPOSITORY`, or an `origin` remote.

## 4. Create the labels

```bash
fabrika status bootstrap label-taxonomy
fabrika status bootstrap issue-shape-markers
```

**The `label-taxonomy` set is derived, not listed** — read it off `TAXONOMY` in
[`bootstrap-verb.ts`](../../../packages/fabrika-cli/src/status/bootstrap-verb.ts), which composes
four closed vocabularies:

| Vocabulary | Where it is declared | Count |
|---|---|---|
| `STATUSES` | [`packages/fabrika-cli/src/labels.ts`](../../../packages/fabrika-cli/src/labels.ts) | 5 |
| `PRIORITIES` | [`packages/fabrika-cli/src/triage/facets.ts`](../../../packages/fabrika-cli/src/triage/facets.ts) | 3 |
| `TYPES` (as `type:<x>`) | same file | 6 |
| `AUDIENCES` (as `ready-for:<x>`) | same file | 2 |

Sixteen, and it widens on its own when a vocabulary grows — which is why the number is not worth
writing down anywhere. `issue-shape-markers` adds three more (`wayfinding:map`,
`prototyping:spike`, `grilling:session`), declared as `ISSUE_SHAPE_MARKERS` in the same file. They
are a separate surface because nothing ranks or counts them.

Partial existence is not existence here: where some labels are present the verb creates only the
missing ones and reports what it created. A label already there under another colour is left alone.

This is the step that used to cost the most. Until
[#5772](https://github.com/kamp-us/phoenix/issues/5772) landed, the verb minted 5 of the 16 and the
other 11 had to be reverse-engineered off skill tables and created by hand.

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

An absent roadmap no longer stops you: `triage homes` degrades on it
([#5773](https://github.com/kamp-us/phoenix/issues/5773)). A file proven not to exist is a proven
negative, so every open milestone lists with no arc name, any standing lane your board carries lists
beside them, and stderr says so:

```
triage homes: no roadmap at ROADMAP.md — every milestone lists with no arc name.
```

The campaigns fence reads the absent file as an empty document, so its scope line is
`campaigns: none active — scope fence inert.` The two refusals that remain are narrower: a roadmap
that *exists* and parses to zero arc rows is a grammar drift and refuses, and a filesystem probe or
a read that could not be performed is exit `11`. Writing the file is still what you want — without
it nothing is homed to an arc and the scope fence never fires — but it is a first-triage quality
step, not a blocker.

The file's grammar is a real parse contract, not a convention
([`packages/fabrika-cli/src/triage/roadmap.ts`](../../../packages/fabrika-cli/src/triage/roadmap.ts)):

- Headings exactly `## Arcs` and `## Campaigns`. A section ends at the next `## ` heading.
- Each table row's **second cell** is the join key and must match `^#(\d+)$` — the milestone's
  number. The row's title is never matched on, so an arc named anything at all can pin any milestone.
- The first cell is the row's name and must be non-empty. A `State` column is allowed and is not read.
- Zero `## Campaigns` rows is legal. **Zero `## Arcs` rows is a refusal** — `triage homes` exits 7
  rather than answer over a roadmap it could not join, on the reading that an empty parse means the
  table grammar drifted.

The `## Campaigns` table is read a second time, by a stricter parser
([`packages/fabrika-cli/src/build/scope-admission.ts`](../../../packages/fabrika-cli/src/build/scope-admission.ts)),
because a row's `State` cell is the build fence's dispatch permission (ADR 0304). There, the columns
are exactly `Campaign | Milestone | State`, the milestone is `#<int>`, and the state is one of
`active` / `paused` / `done`. `build` opens lanes against the `active` rows' milestones only, and one
unreadable row makes the whole table malformed — there is no fallback to the rows that parsed.

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
carries its label. In a fresh repo that is neither, so you get none, and stderr says so:

```
triage homes: standing lanes: 0 of 2 declared carry a label in you/your-repo — not offered: wayfinder:backlog, axis:pipeline-hardening.
```

That is the correct answer, not a gap to fix. Home everything to a milestone and skip `--lane`.

If you do want a standing lane: create the label on your board, then declare it under
`boardVocabulary.standingLanes` in `.fabrika.jsonc` (next section). Both halves are required — a
declared lane whose label does not exist is not offered, which is what stops `triage apply --lane`
from failing a write at the end of a full triage run.

[ADR 0286](../../../.decisions/0286-standing-lanes-come-from-config.md) rules that lanes come from
your repo, never from a CLI literal. `boardVocabulary.standingLanes` still ships phoenix's pair as
its default, which 0286 says it should not; evicting that default is
[#5785](https://github.com/kamp-us/phoenix/issues/5785). Until then the default reaches no board that
has not created the labels.

## 9. Add the config file

`.fabrika.jsonc` at your repo root carries the keys the CLI reads — the whole surface is one
`register(...)` line per key in
([`packages/fabrika-cli/src/config/registry.ts`](../../../packages/fabrika-cli/src/config/registry.ts)).
Every key is fail-closed: an absent file, an absent key, an empty array and a malformed entry all
give the narrowest behaviour, never the permissive one.

- `capClearAuthors` — the GitHub accounts and teams that may clear one extra repair round on a pull
  request. Declare none and nobody can.
- `docLeakExempt` — repo-relative path suffixes of docs whose subject *is* path hygiene, skipped by
  the prose leak scan. Declare none and nothing is exempt.
- `workflowValidators` — your repo's own commands that machine-read `.github/workflows/**`. Declare
  none and that surface stands on `actionlint` alone.
- `unreadableCodeowners` — `"ship"` or `"refuse"`. **Nothing reads it.** A §CP read that fails is
  exit `11` in every repo and an absent `.github/CODEOWNERS` is the `unknown` hold, whatever you
  declare here: the founder reverted the per-repo policy on #5631, back to ADR 0220 §4.

The path keys say where your repo keeps the files fabrika reads by name. **Leave a key out and you
get phoenix's value**, which is what every repo ran on before these keys existed:

- `governedRoots` — the roots a diff derives the `governance` namespace over. Default:
  `.decisions/`, `.claude/`, `.github/`, `claude-plugins/` and `.fabrika.jsonc` itself. An empty
  list is refused rather than read as "nothing is governed", and a list that does not cover
  `.fabrika.jsonc` is refused too — a config cannot un-govern itself.
- `decisionsDir` — your decision corpus. Default `.decisions`. **Write `null` to say your repo keeps
  none**: `adr` then refuses to write, and `governance` runs only its weakens-a-guard half
  (`governance guards`) and says so, rather than reporting a clean contradiction check over a corpus
  that is not there.
- `roadmapFile` — the file whose `## Arcs` / `## Campaigns` tables the scope fence reads. Default
  `ROADMAP.md`.
- `cycleDoc` — the doc the containment class is gated on. Default `product-development-cycle.md`.
- `designHarness` — your headless render config. Default `design-harness.json`.

An absent key and a declined one are different answers: absent is "this repo said nothing", declined
is "this repo has no such surface". Only `decisionsDir` can be declined; the other paths name files
whose absence the filesystem already reports.

phoenix's own file at [`.fabrika.jsonc`](../../../.fabrika.jsonc) is a worked example, with the
reasoning for each value in comments.

## 10. Re-run the front door

```bash
fabrika status open
```

Five fields: the installed skill roster, the config gaps from step 2, your board's counts, the
decision digest, and any lanes on this machine. The `readout` field reads `absent` with the detail
`no readout artifact` until you run `fabrika status bootstrap readout-artifact`, which opens the
durable issue the digest is upserted into, and then `absent` with `no digest block` until
`fabrika governance readout` writes one. Both are facts, not failed reads.

Then file something with `/fabrika:report`, triage it with `/fabrika:triage`, and you are running.

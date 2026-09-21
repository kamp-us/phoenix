---
id: 0402
title: Tuval's saved state lives under the home dir keyed by the checkout's absolute path, never in the project
status: accepted
date: 2026-09-20
tags: [tuval, config, state, portability]
---

# 0402 — Tuval's saved state lives under the home dir keyed by the checkout's absolute path, never in the project

**What this decides:** Tuval writes nothing into the project it opens. The process manifest, the
checkpoints and the Pi session files all live under the home-dir `.tuval`, in one directory per
project named from that checkout's absolute path. A project needs zero files to be a project, and
`<project>/.tuval/tuval.config.ts` stays a supported config layer that holds config and no state.

## Context

Today the answer is fixed in code. `apps/tuval/src/boot.ts` defines
`projectDir = (project) => join(project, ".tuval")` and `projectConfig` beside it, and `boot` sets
`stateDir = projectDir(options.project)`. So the manifest, the checkpoints and the process rows are
written into the project whether or not that project has a config module —
`apps/tuval/.tuval/` in this repo holds `manifest.json` and `processes/` beside its
`tuval.config.ts`. `projectDir`'s docblock calls that directory gitignored, which is true of this
repo (root `.gitignore` carries `apps/tuval/.tuval/*` with the config module re-included) and of no
other. `apps/tuval/src/pi/server/AgentSessionHost.ts` writes session JSONLs to
`defaultSessionDir = (cwd) => join(cwd, ".tuval", "pi-sessions")`, resolved against the *session's*
`cwd`, so since [#9464](https://github.com/kamp-us/phoenix/issues/9464) let a session name any cwd,
a session opened against a foreign repo writes into that repo too.

The founder wants Tuval on a work repository where adding files to the checkout is not an option.
Every repo the operator does not own has that shape: a client checkout, an open-source clone, a
read-only mount. The workaround that exists — point `--project` at a folder the operator owns and
set each session's cwd by hand — costs a manual step per session and gives the desk a "project"
that is not the code.

[#9515](https://github.com/kamp-us/phoenix/issues/9515) carried the question, and the founder ruled
it in four comments on 2026-09-20 PT. Rules 1 to 6 below are those rulings written down.

**Rule 7 is not.** #9515 asked whether state already sitting under `<project>/.tuval` is migrated,
still honoured where it is found, or dropped, and none of the four rulings picks one of the three.
The pick to migrate, and the Banned bullet that forbids a read fallback afterwards, are this
record's own call on the logic of ruling 2 — flagged for veto here the way ruling 3's derived
consequence was flagged and then confirmed. Read rule 7 as the record's, not the founder's, until
he says otherwise.

> That flag is now answered, in part. The founder ruled the move's scope on
> [#9566](https://github.com/kamp-us/phoenix/issues/9566) — see the Amendment at the end of this
> record. The move itself and its scope are his; the Banned read-fallback bullet is still this
> record's own call.

- [Ruling 1](https://github.com/kamp-us/phoenix/issues/9515#issuecomment-5752393670): *"yes but it
  should also allow project config as well. i basically wanna be able to use my home folder config
  on my work computer, but my personal projects should and will have their own program setups. so
  both should be supported for maximum portability."*
- [Ruling 2](https://github.com/kamp-us/phoenix/issues/9515#issuecomment-5752402420): *"i think imo
  the state should always live in the home folder"*
- [Ruling 3](https://github.com/kamp-us/phoenix/issues/9515#issuecomment-5752403867), on whether two
  worktrees of one repo share a desk: *"very similar to how claude code does it"*
- [Ruling 4](https://github.com/kamp-us/phoenix/issues/9515#issuecomment-5752418546), confirming the
  consequence ruling 3 was read to carry: *"moved checkout starting fresh is fine"*

Ruling 3's model is observable. Claude Code keeps one directory per project under a `projects`
directory in its own home-dir tree, each named from that project's absolute path with the
separators and dots substituted for dashes. That is the shape this record adopts: the path is the
key, and the key is a folder name.

Nothing in the corpus rules where Tuval's state lives. ADR
[0363](0363-tuval-feature-flags-in-config-file.md) and ADR
[0375](0375-a-program-row-flag-is-read-off-its-own-config-layer.md) govern the config layers — a
feature flag is a key in `.tuval/tuval.config.ts`, merged across layers, and a program row's flag is
read off the layer that owns the row. Both are about config, both survive this record unchanged, and
neither is superseded or amended. ADR [0345](0345-tuval-lives-under-apps.md) places the app and is
untouched.

## Decision

**Tuval writes saved state only under the home-dir `.tuval`, in one directory per project keyed by
the checkout's absolute path; a project directory holds a config module or nothing at all.**

1. **A project needs zero files.** The home-dir config alone boots a full desk. Pointing `--project`
   at a directory with nothing in it is a supported, first-class case.

2. **A project config module stays supported and layers over the home-dir config.** Neither layer is
   a fallback for the other. `<project>/.tuval/` is a config directory: it may hold
   `tuval.config.ts` and nothing else.

3. **All saved state lives under the home-dir `.tuval`.** That is the process manifest, the process
   checkpoints and the Pi session files — every artifact Tuval writes to survive a restart. A
   session's `cwd` says where the agent works and never selects a state directory, so a session
   opened against a foreign repo writes nothing into it.

4. **The key is the project checkout's absolute path, encoded into one folder name.** One directory
   per path, the way Claude Code keys its projects. The encoding is the implementation's to pick
   under one constraint: two distinct absolute paths never resolve to one directory, and the
   directory records the path it was derived from so an operator can read the key back.

5. **Two worktrees of one repository are two paths, so they are two projects with two desks.** No
   state is shared between them, and no repository identity is consulted.

6. **A moved or renamed checkout is a new key and starts with an empty desk.** The old state stays
   under the old key. Nothing follows the move, and nothing tries to detect one.

7. **Existing in-project state owes a one-time move, per machine.** Where boot finds state under
   `<project>/.tuval`, it moves it once into that project's home-dir key and leaves the config
   module behind. After that lands, this repository's `.gitignore` rule for `apps/tuval/.tuval/*`
   goes, because no repository needs an ignore rule for Tuval state any more. **The move and what
   it takes are the founder's, ruled on
   [#9566](https://github.com/kamp-us/phoenix/issues/9566#issuecomment-5754129508) and written down
   in the Amendment below** — the move lifts `manifest.json`, `processes/` and `pi-sessions/` and
   nothing else. The Banned read-fallback bullet below is still the record's own call, open to veto
   the way this rule was.

**Banned.**

- Writing any state under a project directory, including under a session's `cwd`.
- A read fallback that keeps honouring in-project state after rule 7's move, which would make the
  ban unobservable and the ignore rule permanent.
- Keying state by anything other than the absolute path — a repository remote, a config-declared
  name, or an operator-supplied id — or following a checkout across a move.
- An ignore rule for Tuval state in any repository.

## Consequences

- Tuval runs against a repository the operator cannot write to. The work repo gets nothing; the
  desk's project is the code.
- The founder's desk runs from a worktree today, so under rule 5 it keeps a desk distinct from the
  primary checkout's. Two worktrees that used to be interchangeable no longer are, and that is the
  ruled behaviour rather than a defect to file.
- A renamed or relocated checkout loses its desk. Rule 6 accepts that cost: the old state is still
  on disk under the old key, so nothing is destroyed, but nothing reattaches either.
- `boot`'s `stateDir`, `projectDir`'s docblock and `AgentSessionHost`'s `defaultSessionDir` all
  change, and the root `.gitignore`'s Tuval block is deleted once rule 7's move lands.
- Home-dir state is per machine and outside the repository, so it is never reviewed, never shipped
  and never in a diff. A desk that misbehaves is debugged from a directory nobody else can see,
  which is why rule 4 requires the key's source path to be recorded inside it.

### What this does to #9375 and #8105

- [**#9375**](https://github.com/kamp-us/phoenix/issues/9375) (a project with no
  `.tuval/tuval.config.ts` boots no shell, and the page hangs) is **re-scoped, not absorbed**. It
  parked on a direction call between a built-in default config and a `tuval init` that writes a
  starter file. Rule 1 answers it: a project needs zero files, so boot must produce an attaching
  desk with no project config, and the `tuval init` branch is closed. What remains in #9375 is its
  own bug — the page must never sit silently at "Attaching to the Tuval kernel…" — plus the
  zero-config boot this record now mandates. It is no longer a human ruling's to make.
- [**#8105**](https://github.com/kamp-us/phoenix/issues/8105) (Tuval's Pi sessions are unreachable
  outside the one project root) is **re-scoped, not absorbed**. Its own founder ruling stands and
  this record does not deliver it: reaching sessions across roots is still work nobody has done.
  What changes is the ground it stands on. Every project's sessions are now sibling directories
  under one home-dir tree rather than scattered inside checkouts, so the discovery it asks for is a
  walk of that tree; and the single-root rule stated in `AgentSessionHost.ts`'s docblock is replaced
  by rule 3 here rather than by #8105's build. Its criteria read against the home-dir layout from
  now on.

## Amendment (2026-09-20, [#9566](https://github.com/kamp-us/phoenix/issues/9566)) — rule 7's move takes a named set

Rule 7 said the move lifts in-project state and "leaves the config module behind", which is a move
by exclusion: every entry but `tuval.config.ts` goes. The record flagged rule 7 as its own call, and
[#9566](https://github.com/kamp-us/phoenix/issues/9566) carried the veto to the founder, naming two
directions — today's exclusion, or a named set — plus a third nobody had proposed, an opt-in prompt.

Founder ruling, 2026-09-20 PT:
[the ruling comment on #9566](https://github.com/kamp-us/phoenix/issues/9566#issuecomment-5754129508).
*"The one-time move takes only what Tuval itself wrote into `<project>/.tuval`: `manifest.json`,
`processes/` and `pi-sessions/`. Every other file or folder an operator left there stays where it
is, untouched, next to `tuval.config.ts`. Why: a tool moves only the files it wrote. Relocating an
operator's own notes or scripts without saying so is the kind of surprise that costs trust. Accepted
tradeoff: the list is closed, so a future kind of Tuval state file has to be added to it or it is
left behind. The boot line keeps naming exactly what moved."*

**So rule 7's move takes `manifest.json`, `processes/` and `pi-sessions/`, and nothing else.** An
entry under `<project>/.tuval` whose name is not one of those three stays where it is, and the
boot's `left` line names it. The list is closed: a new kind of Tuval state file is moved only once
it is added here and in the code, and until then a project's copy of it is left behind — the cost
the ruling accepts.

The rest of rule 7 is unchanged: the move is one-time and per machine, boot code runs it, the config
module stays, and the repository's `.gitignore` rule for `apps/tuval/.tuval/*` goes once the move
lands. The Banned list is unchanged too, including the read-fallback bullet, which stays this
record's own call rather than the founder's.

This differs from the code that shipped. `adoptInProjectState` in `apps/tuval/src/state-dir.ts`
skips the one name `tuval.config.ts` and lifts every other entry, so the change to a closed set is
owed: it is [#9611](https://github.com/kamp-us/phoenix/issues/9611), and no other record or issue
carries it.

## Records

Coined: **Tuval project** — a directory Tuval opens as a desk, identified by its absolute path,
needing zero files in it. The row lands in [`.glossary/TERMS.md`](../.glossary/TERMS.md) in this
pull request.

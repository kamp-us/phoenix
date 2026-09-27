---
id: 0419
title: One Tuval desk opens and closes many projects, and no project row ever replaces a global row
status: accepted
date: 2026-09-27
tags: [tuval, config, projects, trust, keys]
---

# 0419 — One Tuval desk opens and closes many projects, and no project row ever replaces a global row

**What this decides:** one running Tuval desk holds many projects at once. A project is a folder,
its `.tuval/tuval.config.ts` and its saved state, and the desk opens and closes it without a
restart. The desk supplies its own shell. A project's rows run as `<project>/<id>` beside the
global rows and never replace one. The rest of the model — trust per folder, one SDK copy, keys
that follow focus, global-only flags, subprojects, reopening on restart and the `tuval` command —
hangs off that project.

## Context

Until epic [#9679](https://github.com/kamp-us/phoenix/issues/9679) the desk ran one project per
process. `apps/tuval/src/bin.ts` booted one folder, and `loadLayeredConfig` merged that folder's
config over the home config by replacing rows and graph nodes by id. The desk had one state dir,
one flat program id space, a registry frozen at boot, and desk-wide keys and flags. Research
[#9663](https://github.com/kamp-us/phoenix/issues/9663) listed those single-project assumptions
with file and line.

The founder ruled the model on map [#9662](https://github.com/kamp-us/phoenix/issues/9662), through
grilling session [#9668](https://github.com/kamp-us/phoenix/issues/9668) (2026-09-22). Each ruling
below is a relayed founder ruling on #9668, quoting his words on the ticket it came from (ADR 0400
counts that shape as a quoted authorization):

- R1.1, a project is a program source:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5789588584>
- R2.1, trust per folder:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5789698662>
- R2.2, one SDK copy with a declared range:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5789699294>
- R3.1, which folder a program and a session run in:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5789750847>
- R4.1, connection scoping and no replace-by-id:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5789957470>
- R4.2, reserved desk keys, focus-owned key tables, global-only flags:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5789963570>
- R4.3, subprojects and their boundary:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5789969610>
- R5.1, reopen on restart:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5789975860>
- R6.1, npm, the `tuval` command, "Open project…" and the author loop:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5790076060>
- R6.2, `recommends` asks and never installs:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5790082314>
- R6.3, one folder per session:
  <https://github.com/kamp-us/phoenix/issues/9668#issuecomment-5790088700>

The desk supplying its own shell is not one of those rulings. Plan grill
[#9682](https://github.com/kamp-us/phoenix/issues/9682) R1.1 found that phoenix's project config
declared the shell row, so scoping project rows would have turned the desk itself into a project
row. Child [#9683](https://github.com/kamp-us/phoenix/issues/9683) moved the shell into a layer the
desk supplies, which also delivers ADR 0402's zero-file project (#9375).

This record amends three live records in part, and each keeps the rest of what it decides:

- ADR [0402](0402-tuval-state-lives-under-home.md) rule 2 says a project config "layers over the
  home-dir config", its Records coin a Tuval project as "a directory Tuval opens as a desk", and
  rule 5 gives two worktrees "two desks". Under this record a project layer sits beside the global
  layer and replaces nothing, a desk holds many projects, and two worktrees are two projects that one
  desk can hold at once. Its state rules — home-dir state keyed by absolute path, zero files in the
  project, the one-time move — stand unchanged, and so does the key itself, which this record reuses
  as the `<project>` in a scoped id.
- ADR [0363](0363-tuval-feature-flags-in-config-file.md) says a flag is "merged across the config
  layers". Under this record only the global config states flags. A flag is still a config key read
  at boot, with no flag service and no runtime toggle.
- ADR [0375](0375-a-program-row-flag-is-read-off-its-own-config-layer.md) says a row's gate reads
  its own module's `features` block. That still holds for the global config. A project config may
  not state `features` at all, so a project row names the flags it needs on `needsFeatures` and is
  refused when the global config leaves one off.

## Decision

**A Tuval project is a folder, its `.tuval/tuval.config.ts` and its saved state, which one running
desk opens and closes beside other projects; its rows run as `<project>/<id>` and never replace a
global row.**

1. **A project is only a program source (R1.1).** Opening one starts its programs in the desk
   process, and closing it stops them. It owns no workspace. Workspaces stay the user's own and can
   mix windows from any project, and tiles and windows carry the project's label.
2. **The desk supplies its own shell (#9683).** The config layers are the desk's own layer, then
   the global config under the home `.tuval`, then one layer per open project. The desk layer is
   code, not a file. A file layer that declares the shell's row or node id is refused at load. A
   folder with no config, or a desk with no config at all, still boots a working desk.
3. **No layer replaces another's row (R4.1).** A row from the global config is a **global
   program** and keeps its bare id. A project's rows and graph nodes run under a **project-scoped
   id**, `<project>/<id>`, where `<project>` is the folder's ADR 0402 state key. A same-named project
   row sits beside the global one, and only its own project's connections use it.
4. **A project connects to its own programs and to global programs, never to another project's
   (R4.1).** A bare id in a project's graph names that project's row or node first and the global
   one second. A connection to another project is refused at config load with an error naming both
   ends. A global program reaches into a project only through a connection that project declares.
   Closing a project drops the connections it declared, and reopening restores them.
5. **A first open asks "Trust this folder?" (R2.1).** No means nothing from that folder runs,
   because a TypeScript config cannot be half-loaded. Yes is remembered per folder path, making it
   a **trusted folder**. The home config and the desk's own layer never ask. There is no restricted
   mode.
6. **The desk holds one copy of `@kampus/tuval-sdk` (R2.2, with the name from #9646).** Every
   program gets the desk's copy. A row declares the SDK versions it supports on its `sdk` field as a
   semver range. The desk refuses a row outside that range, naming the range and its own version,
   and the rest of that config runs.
7. **Keys follow focus (R4.2).** A **reserved desk key** — the prefix and at least the chords that
   switch workspace, open the picker, show the board and close a window — works in every window, and
   a project config that binds one is refused at load. Otherwise whatever has focus owns the key
   table, like vim modes and tmux key tables: the board has its own bindings, a project's window has
   its project's, and a project's keys never fire on the board. A harness window's own bindings
   belong to its program and follow it into any project.
8. **Flags are global only (R4.2).** Only the global config states `features`, and a project
   config that states them is refused. A project row that needs a flag the global config leaves off
   is refused at load, naming the row and the flag, and the rest of its layer runs.
9. **A program runs in its project's folder (R3.1, R6.3).** What it starts inherits that folder
   unless the program hands it another. A hand-started session takes its folder from the picker
   entry, one per harness per open project ("Claude · phoenix"), or "Claude · home" with nothing
   open. A session's folder is set at start and never changes, and one session has one folder.
10. **A subproject is a project nested under another and opened by a program (R4.3).** Worktrees
    are one case, and so is a monorepo folder with its own `.tuval` config. A subproject inherits its
    parent's trust and grouping ("phoenix › lane-9650") but keeps its own config, state and
    programs. Closing the parent closes it. Only the program that opened it crosses the boundary: a
    subproject's config cannot connect up to its parent, and the parent's other programs cannot
    reach down.
11. **A restart reopens the projects that were open (R5.1).** A subproject comes back only when its
    opener restores it. A deleted or no-longer-trusted folder is skipped with a notice.
12. **One saved list of open projects drives the rest (R6.1).** It lives under the home `.tuval`
    beside project state and records open projects, trust answers and `recommends` answers. The
    picker entries, tile labels and reopening read it.
13. **`tuval` is the command (R6.1).** The desk ships to npm as `@kampus/tuval`. `tuval` starts the
    desk or brings the running one forward, and `tuval open <folder>` adds a project, like `code .`.
    The picker's "Open project…" and a program opening a subproject are the other two ways in. The
    author loop is: `npm i @kampus/tuval-sdk`, write a program, add it to `.tuval/tuval.config.ts`,
    `tuval open .`, trust the folder, and edit with hot reload.
14. **`recommends` asks and never installs (R6.2).** A project config may list
    `recommends: ["<package>"]`. On open the desk asks once per package and remembers the answer for
    that project. The installer behind a yes is later work.

**Banned.**

- A config layer replacing another layer's row or graph node by id.
- A connection from one project to another, or from the global config into a project the project
  did not declare.
- Running anything from an untrusted folder, or a restricted-trust mode.
- A second copy of the SDK in the desk process.
- A project config that states feature flags or binds a reserved desk key.
- A session whose folder changes after it starts, or a session spanning several folders.
- The desk installing a recommended package without the user's yes.

## Consequences

- Two projects that each declare a program `counter` and a graph node `main` run in one desk at
  once, each with its own state dir and checkpoints. An old checkpoint saved under a bare id is
  moved onto its scoped id once, on the first boot of a build with scoping.
- A project can no longer override a global program. A person who relied on that writes the row
  under a new id, or changes the global config.
- phoenix's harness rows moved into a committed global layer (`apps/tuval/global/tuval.config.ts`)
  that `pnpm dev` passes as `--config`, because a harness row names no folder any more (#9694).
- Opening a folder runs its code once the user says yes, and the desk has no sandbox for it.
  Programs stay in the desk process (#9663); isolating outside code is not part of this record.
- Known gap: the folder the desk boots with (`--project`, or the folder `tuval open` starts a new
  desk with) is imported without the trust question. That breaks rule 5, and
  [#9884](https://github.com/kamp-us/phoenix/issues/9884) tracks closing it.

## Records

Coined or redefined, with rows in [`.glossary/TERMS.md`](../.glossary/TERMS.md) in this change:
**Tuval project** (redefined: many per desk), **subproject**, **global program**,
**project-scoped id**, **reserved desk key** and **trusted folder**.
